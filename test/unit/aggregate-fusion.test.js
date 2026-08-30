'use strict';

/**
 * `$count/$sum/$average/$max/$min(<value-mode path>)` are emitted as fused
 * single-pass calls over the path's value stream (`H.aggField`, `H.aggOf`,
 * `H.countField`, `H.countOf`) instead of materializing the path's terminal
 * value and reducing it. The fused helpers therefore have to reproduce
 * `path.js#finalizeRaw`'s collapse rule exactly — including its asymmetry: a
 * SINGLE raw field result that is an array passes through verbatim (keeping
 * `undefined` elements, which a numeric aggregate then rejects), while two or
 * more raw results flatten with `undefined` dropped.
 *
 * These tests are differential against the unfused pipeline, plus end-to-end
 * through the compiler, and cover the error path (T0412) in both directions.
 */

const assert = require('assert');
const P = require('../../src/runtime/path');
const H = require('../../src/runtime/hof');
const j2js = require('../../src/index');

const KINDS = ['sum', 'average', 'max', 'min'];

function unfusedAgg(values, name, kind) {
  const value = P.vFieldFinal(values, name, false);
  switch (kind) {
    case 'sum': return H.sumAgg(value);
    case 'average': return H.averageAgg(value);
    case 'max': return H.maxAgg(value);
    default: return H.minAgg(value);
  }
}

/** Runs `fn`, returning either `{ value }` or `{ code }` for a thrown JSONata error. */
function outcome(fn) {
  try {
    return { value: fn() };
  } catch (e) {
    if (!e.code) throw e;
    return { code: e.code, token: e.token };
  }
}

const FIELD_STREAMS = [
  [],                                        // no items
  [{}],                                      // item without the field
  [{ n: 5 }],                                // single scalar raw
  [{ n: -2.5 }],
  [{ n: [1, 2, 3] }],                        // single array raw -> verbatim
  [{ n: [] }],                               // single empty array raw
  [{ n: [1, undefined] }],                   // verbatim keeps the hole -> T0412
  [{ n: 1 }, { n: 2 }],                      // two scalar raws
  [{ n: 1 }, {}, { n: 4 }],                  // gap in the middle
  [{ n: [1, 2] }, { n: 3 }],                 // mixed array/scalar raws
  [{ n: [1, undefined] }, { n: 3 }],         // >=2 raws -> hole dropped
  [{ n: [] }, { n: [] }],                    // >=2 raws, nothing left
  [{ n: 'x' }],                              // non-numeric -> T0412
  [{ n: 1 }, { n: 'x' }],
  [{ n: [1, 'x'] }, { n: 2 }],
];

describe('fused aggregates: aggField / countField', () => {
  for (const kind of KINDS) {
    it(`H.aggField matches ${kind} over vFieldFinal for every stream shape`, () => {
      for (const values of FIELD_STREAMS) {
        assert.deepStrictEqual(
          outcome(() => H.aggField(values, 'n', kind)),
          outcome(() => unfusedAgg(values, 'n', kind)),
          `${kind} diverged for ${JSON.stringify(values)}`
        );
      }
    });
  }

  it('H.countField matches $count over vFieldFinal for every stream shape', () => {
    for (const values of FIELD_STREAMS) {
      assert.deepStrictEqual(
        outcome(() => H.countField(values, 'n')),
        outcome(() => H.countAgg(P.vFieldFinal(values, 'n', false))),
        `count diverged for ${JSON.stringify(values)}`
      );
    }
  });
});

describe('fused aggregates: aggOf / countOf', () => {
  const STREAMS = [[], [5], [[1, 2, 3]], [[]], [1, 2, 3], [1, 'x'], [[1], [2]]];

  for (const kind of KINDS) {
    it(`H.aggOf matches ${kind} over RT.collapse for every stream shape`, () => {
      for (const values of STREAMS) {
        const collapsed = require('../../src/runtime/values').collapse(values, false);
        assert.deepStrictEqual(
          outcome(() => H.aggOf(values, kind)),
          outcome(() => unfusedAggValue(collapsed, kind)),
          `${kind} diverged for ${JSON.stringify(values)}`
        );
      }
    });
  }

  it('H.countOf matches $count over RT.collapse for every stream shape', () => {
    for (const values of STREAMS) {
      const collapsed = require('../../src/runtime/values').collapse(values, false);
      assert.strictEqual(H.countOf(values), H.countAgg(collapsed), `count diverged for ${JSON.stringify(values)}`);
    }
  });

  function unfusedAggValue(value, kind) {
    switch (kind) {
      case 'sum': return H.sumAgg(value);
      case 'average': return H.averageAgg(value);
      case 'max': return H.maxAgg(value);
      default: return H.minAgg(value);
    }
  }
});

describe('fused aggregates: end to end', () => {
  const data = {
    e: [{ s: 10, lvl: 'a' }, { s: 20, lvl: 'b' }, { s: 30, lvl: 'b' }],
    one: { s: 7 },
    nested: [{ s: [1, 2] }, { s: [3] }],
    txt: [{ s: 'x' }],
  };
  const ev = (expr, input = data) => j2js.compile(expr).evaluate(input);

  it('aggregates fields, filters and nested arrays', () => {
    assert.strictEqual(ev('$sum(e.s)'), 60);
    assert.strictEqual(ev('$average(e.s)'), 20);
    assert.strictEqual(ev('$max(e.s)'), 30);
    assert.strictEqual(ev('$min(e.s)'), 10);
    assert.strictEqual(ev('$count(e)'), 3);
    assert.strictEqual(ev('$count(e[lvl = "b"])'), 2);
    assert.strictEqual(ev('$sum(e[lvl = "b"].s)'), 50);
    assert.strictEqual(ev('$sum(one.s)'), 7);
    assert.strictEqual(ev('$count(one.s)'), 1);
    assert.strictEqual(ev('$sum(nested.s)'), 6);
    assert.strictEqual(ev('$count(nested.s)'), 3);
    assert.strictEqual(ev('$count(e[lvl = "zzz"])'), 0);
    assert.strictEqual(ev('$sum(e[lvl = "zzz"].s)'), undefined);
    assert.strictEqual(ev('$max(missing.s)'), undefined);
  });

  it('still reports T0412 for a non-numeric element', () => {
    assert.throws(() => ev('$sum(txt.s)'), (e) => e.code === 'T0412' && e.token === 'sum');
    assert.throws(() => ev('$max(txt.s)'), (e) => e.code === 'T0412' && e.token === 'max');
  });

  it('does not fuse when the aggregate name is lexically rebound', () => {
    assert.strictEqual(ev('($sum := function($x) { 99 }; $sum(e.s))'), 99);
  });
});
