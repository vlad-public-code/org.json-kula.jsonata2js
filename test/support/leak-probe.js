'use strict';

/**
 * Heap-growth probe for `test/unit/concurrency-and-leaks.test.js`. Run in its
 * own process under `--expose-gc`, so the measurement is not perturbed by the
 * test runner's own allocations and the GC can actually be forced.
 *
 *   node --expose-gc leak-probe.js reuse   <iterations>
 *   node --expose-gc leak-probe.js distinct <iterations>
 *
 * Prints one JSON line: `{ mode, iterations, baseline, samples: [...] }`, all
 * heap figures in bytes after a forced collection.
 *
 * `reuse`    — one compiled expression, evaluated `iterations` times. Nothing
 *              may be retained between evaluations.
 * `distinct` — `iterations` DIFFERENT expression sources, each compiled and
 *              evaluated once and then dropped. This is the harder case: the
 *              compile pipeline must not accumulate anything keyed by source
 *              text, and neither may `vm.compileFunction`'s host-side state.
 */

const j2js = require('../../src/index');

const mode = process.argv[2];
const iterations = Number(process.argv[3] || 20000);

function heap() {
  global.gc();
  global.gc(); // a second pass collects what the first one's finalizers freed
  return process.memoryUsage().heapUsed;
}

const INPUT = { items: [{ n: 1, t: 'a' }, { n: 2, t: 'b' }, { n: 3, t: 'a' }], k: 'a' };

/** One expression, many evaluations. */
function reuseRun(n, expr) {
  let sink = 0;
  for (let i = 0; i < n; i++) sink += j2js.compile === null ? 0 : Object.keys(expr.evaluate(INPUT)).length;
  return sink;
}

/**
 * A distinct expression per iteration. The literal changes, so no two sources
 * are equal and nothing can be served from a source-keyed cache.
 */
function distinctRun(from, to) {
  let sink = 0;
  for (let i = from; i < to; i++) {
    const src = `( $x := items[n > ${i % 1000}]; { "c": $count($x), "s": $sum($x.n), "i": ${i} } )`;
    sink += Object.keys(j2js.compile(src).evaluate(INPUT)).length;
  }
  return sink;
}

const CHUNKS = 5;
const per = Math.max(1, Math.floor(iterations / CHUNKS));
const samples = [];
let sink = 0;

if (mode === 'reuse') {
  const expr = j2js.compile('( $x := items[t = k]; { "c": $count($x), "s": $sum($x.n), "m": $max($x.n) } )');
  sink += reuseRun(per, expr);          // warm up: let the JIT and the pools settle
  const baseline = heap();
  for (let c = 0; c < CHUNKS; c++) {
    sink += reuseRun(per, expr);
    samples.push(heap());
  }
  process.stdout.write(JSON.stringify({ mode, iterations: per * CHUNKS, baseline, samples, sink }) + '\n');
} else if (mode === 'distinct') {
  sink += distinctRun(0, per);
  const baseline = heap();
  for (let c = 0; c < CHUNKS; c++) {
    sink += distinctRun((c + 1) * per, (c + 2) * per);
    samples.push(heap());
  }
  process.stdout.write(JSON.stringify({ mode, iterations: per * CHUNKS, baseline, samples, sink }) + '\n');
} else {
  throw new Error(`unknown mode "${mode}"`);
}
