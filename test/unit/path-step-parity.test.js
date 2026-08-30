'use strict';

/**
 * Path-step semantics that the vendored conformance suite does not cover, all
 * found by differentially sweeping expression shapes against the reference
 * `jsonata` interpreter (`128/143` -> `143/143` on that sweep). Every expected
 * value below was taken from the reference, not from our own output.
 *
 * Three rules are pinned here:
 *
 * 1. A generic expression step FLATTENS its per-element array result
 *    (`o.(p^(v))`, `o.($map(…))`), except for a *syntactically bare* array
 *    constructor, which jsonata marks `consarray` and never flattens
 *    (`o.[q,q]`). Parenthesizing the constructor removes the marking, so
 *    `o.([q,q])` flattens — which is why `optimizer.js#visitParenthesized`
 *    keeps the wrapper around an `ArrayConstructor`.
 * 2. A TERMINAL expression step keeps the same "a single raw array result
 *    passes through verbatim" rule as a terminal field step
 *    (`$data.$zip(one, two)` stays `[[1,5]]`).
 * 3. A stage (`[n]`/`[cond]`) whose `.source` is a mid-path expression is a
 *    per-element step over the incoming stream, so `[n]` stays scoped to each
 *    sibling group (`o.(p^(v))[0].v` is the first per `o`), and the source is
 *    NOT re-evaluated against the ambient context.
 */

const assert = require('assert');
const j2js = require('../../src/index');

const data = {
  o: [{ p: [{ v: 2 }, { v: 1 }], q: 5 }, { p: [{ v: 4 }, { v: 3 }], q: 6 }],
  nums: [3, 1, 2],
  single: { p: [{ v: 9 }, { v: 8 }] },
  zipped: { one: [1], two: [5] },
};
const ev = (expr, input = data) => j2js.compile(expr).evaluate(input);

describe('path steps: expression-step flattening', () => {
  it('flattens an array result from a parenthesized expression step', () => {
    assert.deepStrictEqual(ev('o.(p^(v))'), [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }]);
    assert.deepStrictEqual(ev('o.($map(p, function($x){$x.v}))'), [2, 1, 4, 3]);
    assert.deepStrictEqual(ev('o.($filter(p, function($x){$x.v>1}))'), [{ v: 2 }, { v: 4 }, { v: 3 }]);
    assert.deepStrictEqual(ev('o.($reverse(p))'), [{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }]);
    assert.deepStrictEqual(ev('o.($append(p, p))'),
      [{ v: 2 }, { v: 1 }, { v: 2 }, { v: 1 }, { v: 4 }, { v: 3 }, { v: 4 }, { v: 3 }]);
  });

  it('does not flatten a bare array-constructor step, but does flatten a parenthesized one', () => {
    assert.deepStrictEqual(ev('o.[q, q]'), [[5, 5], [6, 6]]);
    assert.deepStrictEqual(ev('o.([q, q])'), [5, 5, 6, 6]);
    assert.deepStrictEqual(ev('nums.[$, $]'), [[3, 3], [1, 1], [2, 2]]);
    assert.deepStrictEqual(ev('nums.([$, $])'), [3, 3, 1, 1, 2, 2]);
    assert.deepStrictEqual(ev('o.p.[v, v]'), [[2, 2], [1, 1], [4, 4], [3, 3]]);
    assert.deepStrictEqual(ev('o.p.([v, v])'), [2, 2, 1, 1, 4, 4, 3, 3]);
  });

  it('passes a single raw array result through verbatim (terminal step)', () => {
    // one source element, one array result -> no flattening, no collapse
    assert.deepStrictEqual(ev('single.(p)'), [{ v: 9 }, { v: 8 }]);
    assert.strictEqual(ev('zipped.$zip(one, two) ~> $map($sum)'), 6);
    assert.deepStrictEqual(ev('zipped.($zip(one, two))'), [[1, 5]]);
  });
});

describe('path steps: stage over a mid-path expression source', () => {
  it('scopes [n] to each sibling group and evaluates the source per element', () => {
    assert.deepStrictEqual(ev('o.(p^(v))[0].v'), [1, 3]);
    assert.deepStrictEqual(ev('o.(p[v>0])[0].v'), [2, 4]);
    assert.deepStrictEqual(ev('o.([q,q])[0]'), [5, 6]);
    assert.deepStrictEqual(ev('nums.([$,$])[0]'), [3, 1, 2]);
  });

  it('still treats a stage at the head of a path as establishing the sequence', () => {
    assert.strictEqual(ev('($x := nums; $x[0])'), 3);
    assert.strictEqual(ev('(o.p)[0].v'), 2);
    assert.strictEqual(ev('$[1][0]', [[1, 2], [3, 4]]), 3);
  });

  it('keeps the whole-sequence stage semantics for a sorted path with a following subscript', () => {
    assert.strictEqual(ev('o.p^(v)[0].v'), 1);
    assert.deepStrictEqual(ev('o.p^(v).v'), [1, 2, 3, 4]);
  });
});
