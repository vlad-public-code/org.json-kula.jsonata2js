'use strict';

/**
 * Regression cover for the findings in the 2026-09-18 review
 * (`review/jsonata2js.md`) and for the cross-port conformance list checked
 * against `jsonata` 2.2.2 alongside it.
 *
 * Every expected value in this file was produced by RUNNING the expression
 * against the reference implementation (`jsonata` 2.2.2), not derived by
 * reading the spec — the two diverge often enough that guessing is useless.
 */

const assert = require('assert');
const j2js = require('../../src/index');

/** Constructed objects use a null prototype; rebuild before deep-comparing. */
const plain = (v) => {
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = plain(v[k]);
    return out;
  }
  return v;
};

const evalOf = (src, input, bindings) => j2js.compile(src).evaluate(input, bindings);

describe('review JS-1: $eval sees the caller environment', () => {
  it('sees an enclosing block local', () => {
    // reference: 6
    assert.strictEqual(evalOf('( $x := 5; $eval("$x + 1") )'), 6);
  });

  it('sees a per-evaluation binding', () => {
    // reference: 42
    assert.strictEqual(evalOf('$eval("$y + 1")', {}, { y: 41 }), 42);
  });

  it('sees an assign()ed binding', () => {
    // reference: 9
    const e = j2js.compile('$eval("$z")');
    e.assign('z', 9);
    assert.strictEqual(e.evaluate({}), 9);
  });

  it('sees a registerFunction()ed function', () => {
    // reference: 20
    const e = j2js.compile('$eval("$mine(2)")');
    e.registerFunction('mine', (x) => x * 10);
    assert.strictEqual(e.evaluate({}), 20);
  });

  it('sees a lambda parameter', () => {
    // reference: [21]
    assert.deepStrictEqual(plain(evalOf('( $f := function($a){ [$eval("$a")] }; $f(21) )')), [21]);
  });

  it('sees the innermost shadowing binding', () => {
    // reference: 2
    assert.strictEqual(evalOf('( $x := 1; ( $x := 2; $eval("$x") ) )'), 2);
  });

  it('keeps block locals visible inside a per-element closure', () => {
    // reference: [6,7]
    assert.deepStrictEqual(plain(evalOf('( $x := 5; [1,2].$eval("$x + $") )')), [6, 7]);
  });

  it('still defaults the 1-argument form context to the current $', () => {
    // reference: 7
    assert.strictEqual(evalOf('$eval("$.a")', { a: 7 }), 7);
  });

  it('still honours an explicit 2-argument context, and a local stays visible under it', () => {
    // reference: 3 / 5
    assert.strictEqual(evalOf('$eval("a", {"a": 3})'), 3);
    assert.strictEqual(evalOf('( $x := 5; $eval("$x", {"q": 1}) )'), 5);
  });

  it('propagates the environment through a nested $eval', () => {
    // reference: 3
    assert.strictEqual(evalOf('( $x := 3; $eval("$eval(\'$x\')") )'), 3);
  });

  it('still reports D3120 for a syntax error and D3121 for a runtime one', () => {
    assert.throws(() => evalOf('$eval("1+")'), (e) => e.code === 'D3120');
    assert.throws(() => evalOf('$eval("$foo()")'), (e) => e.code === 'D3121');
  });
});

describe('review JS-3: the evaluation timeout covers iterative expressions', () => {
  const timesOut = (src) => {
    const e = j2js.compile(src).setTimeout(20);
    assert.throws(() => e.evaluate(undefined), (err) => err.code === 'U1001', src);
  };

  it('fires inside $map over a huge sequence', () => {
    timesOut('$sum($map([1..3000000], function($x){$x*2}))');
  });

  it('fires inside $reduce', () => {
    timesOut('$reduce([1..3000000], function($a,$b){$a+$b})');
  });

  it('fires inside $sort with a user comparator', () => {
    timesOut('$sort([1..300000], function($a,$b){$a>$b})');
  });

  it('fires inside a per-element path step', () => {
    timesOut('$count([1..3000000].($*2))');
  });

  it('fires while materializing a huge range', () => {
    const e = j2js.compile('$count([1..10000000])').setTimeout(5);
    assert.throws(() => e.evaluate(undefined), (err) => err.code === 'U1001');
  });

  it('fires for non-tail recursion (which never reaches the trampoline)', () => {
    timesOut('( $f := function($n){ $n <= 0 ? 0 : $f($n - 1) + 0 }; $f(400000) )');
  });

  it('leaves an untimed evaluation alone', () => {
    assert.strictEqual(evalOf('$sum($map([1..10], function($x){$x*2}))'), 110);
  });
});

describe('review JS-4/M-2: group-by accumulates in one pass', () => {
  // Every expectation below is the reference's own output for the same input.
  it('appends repeated keys with fn.append semantics', () => {
    const d = [{ k: 'a', v: 1 }, { k: 'a', v: [2, 3] }, { k: 'b', v: 4 }, { k: 'a', v: 5 }];
    assert.deepStrictEqual(plain(evalOf('${k: v}', d)), { a: [1, 2, 3, 5], b: 4 });
  });

  it('keeps a lone array-valued item un-nested', () => {
    assert.deepStrictEqual(plain(evalOf('${k: v}', [{ k: 'a', v: [1, 2] }])), { a: [1, 2] });
  });

  it('keeps a lone scalar a scalar, and skips undefined items', () => {
    assert.deepStrictEqual(plain(evalOf('${k: v}', [{ k: 'a', v: 1 }])), { a: 1 });
    assert.deepStrictEqual(plain(evalOf('${k: v}', [{ k: 'a' }, { k: 'a', v: 2 }])), { a: 2 });
    assert.deepStrictEqual(plain(evalOf('${k: v}', [{ k: 'a', v: 1 }, { k: 'a' }])), { a: 1 });
  });

  it('concatenates array items across a bucket ($zip case)', () => {
    assert.deepStrictEqual(plain(evalOf('$zip([1,2,3],[1,2,3]){"k":$}')), { k: [1, 1, 2, 2, 3, 3] });
  });

  it('appends per-tuple bindings across a repeated key', () => {
    const d = { items: [{ k: 'a' }, { k: 'b' }, { k: 'a' }] };
    assert.deepStrictEqual(plain(evalOf('items#$i{k: $i}', d)), { a: [0, 2], b: 1 });
    const d2 = { items: [{ k: 'a' }, { k: 'a' }, { k: 'a' }] };
    assert.deepStrictEqual(plain(evalOf('items#$i{k: [$i]}', d2)), { a: [0, 1, 2] });
  });

  it('does not mutate the first item of a bucket', () => {
    const shared = [1, 2];
    const d = [{ k: 'a', v: shared }, { k: 'a', v: 3 }];
    assert.deepStrictEqual(plain(evalOf('${k: v}', d)), { a: [1, 2, 3] });
    assert.deepStrictEqual(shared, [1, 2]);
  });

  it('scales linearly in bucket size', function () {
    this.timeout(20000);
    const e = j2js.compile('${k: v}');
    const run = (n) => {
      const data = Array.from({ length: n }, (_, i) => ({ k: 'same', v: i }));
      const t0 = Date.now();
      const r = e.evaluate(data);
      assert.strictEqual(r.same.length, n);
      return Date.now() - t0;
    };
    run(20000); // warm up
    const small = run(20000);
    const big = run(160000);
    // Quadratic would be ~64x; linear is ~8x. A generous 20x bound keeps the
    // assertion stable on a loaded machine while still failing the O(n^2)
    // shape (which took 11 s at 80,000 before this fix).
    assert.ok(big <= Math.max(200, small * 20), `160k bucket took ${big}ms vs ${small}ms for 20k`);
  });
});
