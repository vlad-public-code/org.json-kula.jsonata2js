'use strict';

/**
 * Concurrency and retention.
 *
 * All three run in their own processes: the leak probes need `--expose-gc` and
 * a heap the test runner is not also churning, and the concurrency probe needs
 * real `worker_threads`. Each spawned script prints one JSON line, which is all
 * this file asserts on — see `test/support/`.
 *
 * The re-entrancy case is the one that has actually caught a bug: the runtime
 * keeps two module-level flags (`path.js#stagePlain`, `values.js#sawArrayValue`)
 * that are written by a helper and read by its caller. Writing either one on
 * the way IN left it exposed to whatever a stage's condition evaluated in
 * between - including another staged path - and
 * `a.[[5]][$exists($$.b.[[9]][0])]` came out `[[5]]` instead of `[5]`. Both are
 * now assigned on the way out only.
 */

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { Worker } = require('worker_threads');
const j2js = require('../../src/index');

const SUPPORT = path.join(__dirname, '..', 'support');

/** Runs a support script in a child process and parses its single JSON line. */
function probe(script, args, nodeArgs = []) {
  const out = execFileSync(process.execPath, [...nodeArgs, path.join(SUPPORT, script), ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('concurrency', () => {
  it('evaluates two expressions across four worker threads', function (done) {
    this.timeout(60000);
    const WORKERS = 4;
    const ROUNDS = 400;
    const results = [];
    let settled = false;
    const finish = (err) => { if (!settled) { settled = true; done(err); } };

    for (let id = 0; id < WORKERS; id++) {
      const w = new Worker(path.join(SUPPORT, 'concurrency-worker.js'), { workerData: { id, rounds: ROUNDS } });
      w.on('message', (m) => {
        if (m.error) { finish(new Error(m.error)); return; }
        results.push(m);
        if (results.length === WORKERS) {
          try {
            assert.strictEqual(results.length, WORKERS);
            for (const r of results) assert.strictEqual(r.checked, ROUNDS * 2, `worker ${r.id}`);
            assert.deepStrictEqual([...results.map((r) => r.id)].sort(), [0, 1, 2, 3]);
            finish();
          } catch (e) { finish(e); }
        }
      });
      w.on('error', finish);
      w.on('exit', (code) => { if (code !== 0 && !settled) finish(new Error(`worker ${id} exited ${code}`)); });
    }
  });

  it('is re-entrant: a nested evaluation cannot disturb one in progress', () => {
    // The runtime's two scan flags are written by a helper and read by its
    // caller; a stage condition, a predicate or a registered function can run a
    // whole other evaluation in between.
    const data = { a: { z: 1 }, b: { z: 1 }, w: { e: [], f: { g: 9 } } };
    assert.deepStrictEqual(j2js.compile('a.[[5]][true]').evaluate(data), [5]);
    assert.deepStrictEqual(j2js.compile('a.[[5]][$exists($$.b.[[9]][0])]').evaluate(data), [5]);
    assert.deepStrictEqual(j2js.compile('a.[[5]][$count($$.b.[[9]][0]) > 0]').evaluate(data), [5]);

    // ... and through a registered function that compiles and evaluates its own
    // expression in the middle of the outer one.
    const outer = j2js.compile('a.[[5]][$probe($$)]');
    outer.registerFunction('probe', (root) => {
      const inner = j2js.compile('b.[[9]][0]');
      assert.deepStrictEqual(inner.evaluate(root), [9]);
      assert.deepStrictEqual(j2js.compile('w.*').evaluate(root), [{ g: 9 }]);
      return true;
    });
    assert.deepStrictEqual(outer.evaluate(data), [5]);
  });

  it('shares one compiled expression across interleaved evaluations', () => {
    // A compiled expression is immutable and holds no per-evaluation state, so
    // the same instance must be reusable while one of its own evaluations is on
    // the stack.
    const expr = j2js.compile('( $x := items[n > $min]; { "c": $count($x), "s": $sum($x.n) } )');
    // a constructed object is `Object.create(null)`, so compare by value
    const run = (min, n) => JSON.stringify(
      expr.evaluate({ items: Array.from({ length: n }, (_, k) => ({ n: k })) }, { min })
    );
    const want = JSON.stringify({ c: 3, s: 12 });
    const reenter = j2js.compile('$nested($)');
    reenter.registerFunction('nested', () => run(2, 6));
    assert.strictEqual(run(2, 6), want);
    assert.strictEqual(reenter.evaluate({}), want);
    assert.strictEqual(run(2, 6), want);
  });
});

describe('retention', () => {
  /**
   * Heap after a forced GC must not trend upward across chunks. The threshold
   * is per-iteration rather than absolute so it scales with the workload, and
   * generous enough (relative to the measured ~25 bytes/iteration) that normal
   * allocator drift cannot trip it.
   */
  const assertFlat = (r, bytesPerIterationLimit) => {
    const growth = r.samples[r.samples.length - 1] - r.baseline;
    const per = growth / r.iterations;
    assert.ok(
      per < bytesPerIterationLimit,
      `${r.mode}: heap grew ${(growth / 1e6).toFixed(2)} MB over ${r.iterations} iterations `
      + `(${per.toFixed(0)} B each, limit ${bytesPerIterationLimit}); samples ${r.samples.join(', ')}`
    );
  };

  it('does not retain anything when one expression is evaluated many times', function () {
    this.timeout(120000);
    const r = probe('leak-probe.js', ['reuse', '20000'], ['--expose-gc']);
    assert.strictEqual(r.iterations, 20000);
    assertFlat(r, 40);
  });

  it('does not retain anything per compiled expression', function () {
    this.timeout(120000);
    // The harder case: every source is different, so nothing can be served
    // from - or accumulated in - a cache keyed by source text. This is what
    // `vm.compileFunction` was doing, at ~2 KB per expression forever; see
    // `loader.js#loadFunction`.
    const r = probe('leak-probe.js', ['distinct', '4000'], ['--expose-gc']);
    assert.strictEqual(r.iterations, 4000);
    assertFlat(r, 300);
  });
});
