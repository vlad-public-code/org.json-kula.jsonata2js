'use strict';

/**
 * Sequence scan fusion (`translator/scan-fusion.js`): a block that binds a
 * sequence once and interrogates it many times compiles to ONE pass that reads
 * each distinct field once per element.
 *
 * Two things have to be true of every case here, and both are asserted: the
 * answer must be unchanged, and — for the cases the pass is supposed to fire
 * on — a fused helper must actually have been emitted. A test that passes
 * because nothing was fused proves nothing.
 *
 * Every expected value was measured against `jsonata` 2.2.2.
 */

const assert = require('assert');
const j2js = require('../../src/index');
const { parse } = require('../../src/parser/parser');
const { optimize } = require('../../src/optimizer/optimizer');
const { Translator } = require('../../src/translator/translator');
const { buildRegistry } = require('../../src/runtime/builtins');

const BUILTINS = new Set(Object.keys(buildRegistry()));
const generate = (src) => new Translator(BUILTINS).translate(optimize(parse(src))).body;
/** The emitted scan helper is the only thing that opens with `P.vSeed` at factory scope. */
const fused = (src) => /=> \{\nconst \w+ = P\.vSeed\(/.test(generate(src));

const data = {
  emp: [{ n: 'a', s: 10, lv: 'x', ok: true }, { n: 'b', s: 20, lv: 'y', ok: false }, { n: 'c', s: 30, lv: 'x', ok: true }],
  bad: [{ s: 10 }, { s: 'oops' }, { s: 30 }],
  bad2: [{ s: 10, t: 'no' }, { s: 'oops', t: 5 }],
  mixed: [{ s: 1 }, 5, 'str', null, [{ s: 2 }], { s: [3, 4] }],
  one: [{ s: 7, lv: 'x' }],
  empty: [],
};
const ev = (src) => j2js.compile(src).evaluate(data);

describe('sequence scan fusion', () => {
  it('fuses aggregates and filters over one bound sequence', () => {
    const src = '($e := emp; $a := $sum($e.s); $b := $max($e.s); $c := $count($e[lv="x"]); [$a,$b,$c])';
    assert.ok(fused(src));
    assert.deepStrictEqual(ev(src), [60, 30, 2]);
  });

  it('reads a field once for every aggregate kind over it', () => {
    const src = '($e := emp; $a := $sum($e.s); $b := $average($e.s); $c := $max($e.s); $d := $min($e.s); [$a,$b,$c,$d])';
    assert.ok(fused(src));
    // one accumulator, four readings of it
    assert.strictEqual((generate(src).match(/H\.scanAcc\(\)/g) || []).length, 1);
    assert.strictEqual((generate(src).match(/H\.scanAgg\(/g) || []).length, 4);
    assert.deepStrictEqual(ev(src), [60, 20, 30, 10]);
  });

  it('reads a field once for every predicate over it', () => {
    const src = '($e := emp; $x := $count($e[lv="x"]); $y := $count($e[lv="y"]); $z := $count($e[ok=true]); [$x,$y,$z])';
    assert.ok(fused(src));
    assert.strictEqual((generate(src).match(/P\.fieldOne\(/g) || []).length, 2); // lv, ok
    assert.deepStrictEqual(ev(src), [2, 1, 2]);
  });

  it('absorbs a filter used as a value, and one used only for its count', () => {
    const src = '($e := emp; $x := $e[lv="x"]; $n := $count($e[lv="x"]); $s := $sum($e.s); [$n,$s,$count($x)])';
    assert.ok(fused(src));
    assert.deepStrictEqual(ev(src), [2, 60, 2]);
  });

  it('absorbs `!=`, `and` and `or` predicates', () => {
    for (const [src, want] of [
      ['($e := emp; $a := $sum($e.s); $b := $max($e.s); $c := $count($e[lv!="x"]); [$a,$b,$c])', [60, 30, 1]],
      ['($e := emp; $a := $sum($e.s); $b := $max($e.s); $c := $count($e[lv="x" or lv="y"]); [$a,$b,$c])', [60, 30, 3]],
      ['($e := emp; $a := $sum($e.s); $b := $max($e.s); $c := $count($e[ok=true and lv="x"]); [$a,$b,$c])', [60, 30, 2]],
    ]) {
      assert.ok(fused(src), src);
      assert.deepStrictEqual(ev(src), want, src);
    }
  });

  it('absorbs from an argument, an operand and an array element', () => {
    for (const [src, want] of [
      ['($e := emp; $a := $round($average($e.s),1); $b := $max($e.s); $c := $min($e.s); [$a,$b,$c])', [20, 30, 10]],
      ['($e := emp; $a := $sum($e.s) + $max($e.s) + $min($e.s); $a)', 100],
      ['($e := emp; [$sum($e.s), $max($e.s), $count($e[lv="x"])])', [60, 30, 2]],
    ]) {
      assert.ok(fused(src), src);
      assert.deepStrictEqual(ev(src), want, src);
    }
  });

  it('keeps the answer for element shapes the loop must survive', () => {
    const tail = '$a := $sum($e.s); $b := $max($e.s); $c := $count($e[s=1]); [$a,$b,$c])';
    assert.deepStrictEqual(ev(`($e := mixed; ${tail}`), [10, 4, 1]);
    assert.deepStrictEqual(ev(`($e := empty; ${tail}`), [0]);
    assert.deepStrictEqual(ev(`($e := one; ${tail}`), [7, 7, 0]);
  });

  it('raises an aggregate error at ITS statement, not at the scan', () => {
    // The scan runs at the first absorbed statement, so a recorded type error
    // must surface where the result is READ, not where the pass met the bad
    // element: `$max` still throws, and still only at its own statement.
    assert.throws(() => ev('($e := bad; $a := $count($e[s=10]); $b := $max($e.s); $a)'),
      (e) => e.code === 'T0412' && /"max"/.test(e.message));
    assert.throws(() => ev('($e := bad; $a := $sum($e.s); $b := $max($e.s); $c := $count($e[s=10]); [$a,$b,$c])'),
      (e) => e.code === 'T0412');
    // `$sum` is bound first, so `$sum`'s error wins even though `$max` and
    // `$sum` meet the same bad element in the same pass.
    assert.throws(() => ev('($e := bad2; $a := $sum($e.s); $b := $sum($e.t); $c := $count($e[s=10]); [$a,$b,$c])'),
      (e) => e.code === 'T0412' && /"sum"/.test(e.message));
    // an unrelated error between the scan and the aggregate still comes first
    assert.throws(() => ev('($e := bad; $a := $count($e[s=10]); $z := $error("boom"); $b := $sum($e.s); $c := $max($e.s); $b)'),
      (e) => e.code === 'D3137');
  });

  it('absorbs an ordering comparison as the whole predicate', () => {
    const src = '($e := emp; $a := $count($e[s > 15]); $b := $count($e[s <= 20]); [$a,$b])';
    assert.ok(fused(src));
    assert.deepStrictEqual(ev(src), [2, 2]);
    assert.deepStrictEqual(ev('($e := emp; $a := $count($e[s >= 20]); $b := $sum($e.s); [$a,$b])'), [2, 60]);
    // Either way round, and as a filter used for its value.
    assert.deepStrictEqual(ev('($e := emp; $a := $count($e[15 < s]); $b := $count($e[s < 15]); [$a,$b])'), [2, 1]);
    assert.deepStrictEqual(ev('($e := emp; $a := $e[s > 15].n; $b := $count($e[s > 15]); [$a,$b])'), ['b', 'c', 2]);
  });

  it('leaves an ordering comparison unabsorbed under `and`/`or`', () => {
    // A deferred throw underneath a short-circuit has no single place to land.
    const src = '($e := emp; $a := $count($e[s > 15 and lv = "x"]); $b := $count($e[lv = "x"]); [$a,$b])';
    assert.deepStrictEqual(ev(src), [1, 2]);
    assert.ok(!/cmpSafe/.test(generate(src)));
  });

  it('raises a comparison error at ITS statement, not at the scan', () => {
    // `bad` holds a string where the comparison wants a number: the loop keeps
    // the operand pair and `H.cmpCheck` rebuilds the identical error at the read.
    assert.throws(() => ev('($e := bad; $a := $count($e[s = 10]); $b := $count($e[s > 5]); $b)'),
      (e) => e.code === 'T2009');
    assert.throws(() => ev('($e := mixed; $a := $count($e[s = 1]); $b := $count($e[s > 1]); $b)'),
      (e) => e.code === 'T2010' || e.code === 'T2009');
    // An unrelated error between the scan and the read still comes first.
    assert.throws(() => ev('($e := bad; $a := $count($e[s = 10]); $z := $error("boom"); $b := $count($e[s > 5]); $b)'),
      (e) => e.code === 'D3137');
    // ...and a comparison that never goes bad reads clean.
    assert.deepStrictEqual(ev('($e := emp; $a := $count($e[s > 5]); $b := $count($e[s > 25]); [$a,$b])'), [3, 1]);
  });

  it('declines a sequence that is rebound in the block', () => {
    const src = '($e := emp; $e := bad; $a := $sum($e.s); $b := $max($e.s); $c := $count($e[s=10]); $c)';
    assert.ok(!fused(src));
    // reads `bad`, not `emp` - so it still throws, from `$sum`
    assert.throws(() => ev(src), (e) => e.code === 'T0412' && /"sum"/.test(e.message));
    assert.strictEqual(ev('($e := bad; $e := emp; $a := $sum($e.s); $b := $max($e.s); $c := $count($e[s=10]); $a)'), 60);
  });

  it('declines a shadowed built-in', () => {
    const src = '($sum := function($x){999}; $e := emp; $a := $sum($e.s); $b := $count($e[lv="x"]); [$a,$b])';
    assert.deepStrictEqual(ev(src), [999, 2]);
    const src2 = '($count := function($x){-1}; $e := emp; $a := $count($e[lv="x"]); $b := $count($e[lv="y"]); [$a,$b])';
    assert.deepStrictEqual(ev(src2), [-1, -1]);
  });

  it('declines a conditionally-evaluated position', () => {
    // `$sum` would throw on `bad`; it must not run, because the branch is not taken.
    assert.deepStrictEqual(ev('($e := bad; $a := false ? $sum($e.s) : 0; $b := $count($e[s=10]); [$a,$b])'), [0, 1]);
    assert.deepStrictEqual(ev('($e := bad; $a := false and $sum($e.s) > 1; $b := $count($e[s=10]); [$a,$b])'), [false, 1]);
    assert.deepStrictEqual(ev('($e := bad; $f := function($x){ $sum($x.s) }; $b := $count($e[s=10]); $b)'), 1);
  });

  it('declines a sequence not bound earlier in this block', () => {
    assert.ok(!fused('($a := $sum($e.s); $e := emp; $a)'));
    assert.ok(!fused('($a := $sum(emp.s); $b := $max(emp.s); $c := $min(emp.s); [$a,$b,$c])'));
  });

  it('applies the payoff guard', () => {
    // three operations, or two that share a field, pay for the helper
    assert.ok(fused('($e := emp; $a := $sum($e.s); $b := $max($e.s); [$a,$b])'));
    assert.ok(fused('($e := emp; $a := $sum($e.s); $b := $max($e.s); $c := $count($e[lv="x"]); [$a,$b,$c])'));
    // two on different fields save only the passes, which does not pay
    assert.ok(!fused('($e := emp; $a := $sum($e.s); $b := $count($e[lv="x"]); [$a,$b])'));
    assert.ok(!fused('($e := emp; $a := $sum($e.s); $a)'));
  });

  it('composes with the postfix operators', () => {
    // `[]` after `$count(...)` is a no-op: a call that returns no sequence
    assert.strictEqual(ev('($e := emp; $a := $sum($e.s); $b := $max($e.s); $c := $count($e[lv="x"])[]; $c)'), 2);
    assert.deepStrictEqual(ev('($e := one; $a := $sum($e.s); $b := $max($e.s); $c := $e[lv="x"]; $c)'), { s: 7, lv: 'x' });
    assert.deepStrictEqual(ev('($e := emp; $a := $sum($e.s); $b := $max($e.s); $c := $e[lv="x"]^(s); $c.s)'), [10, 30]);
  });

  it('fuses an inner block independently of its parent', () => {
    const src = '($e := emp; $a := $sum($e.s); $b := $max($e.s); '
      + '$c := ($f := emp; $sum($f.s) + $max($f.s) + $min($f.s)); [$a,$b,$c])';
    assert.deepStrictEqual(ev(src), [60, 30, 100]);
    assert.strictEqual((generate(src).match(/=> \{\nconst \w+ = P\.vSeed\(/g) || []).length, 2);
  });
});
