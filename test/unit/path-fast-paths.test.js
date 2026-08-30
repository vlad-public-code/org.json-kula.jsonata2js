'use strict';

/**
 * The translator compiles a path in "value mode" — plain values, no `{v,p,b}`
 * tuples — whenever the tuple representation is provably unobservable (see
 * `Translator#pathValueModeSteps` and the header block in `runtime/path.js`).
 * Each value-mode helper is the twin of a tuple-mode helper:
 *
 *   `P.fieldOne`/`fieldOneSingle`  for `fieldFinal(seed(v), …)` (lone field step)
 *   `P.vFieldFinal`               for `fieldFinal`
 *   `P.vStepField`                for `stepField`
 *   `P.vFilter`                   for `stepPredicate(…, global)`
 *   `P.vSubscript`                for `stepSubscript(…, global)`
 *
 * The equivalences are arguments, not measurements, so these tests are
 * differential: they run both twins over the value shapes where they could
 * plausibly diverge (missing value, scalar, array root, array-valued field,
 * keepSingleton, numeric/negative index predicates) and require identical
 * results. A future "optimization" that breaks an equivalence fails here
 * rather than silently changing results for one expression shape.
 */

const assert = require('assert');
const P = require('../../src/runtime/path');
const RT = require('../../src/runtime/values');
const j2js = require('../../src/index');

const FIELD_CASES = [
  undefined,
  null,
  42,
  'scalar',
  {},
  { a: 1 },
  { a: [1] },
  { a: [] },
  { a: null },
  { b: 2 },
  [{ a: 1 }],
  [{ a: 1 }, { a: 2 }],
  [{ a: [1, 2] }, { a: 3 }],
  [{ a: [1] }],
  [{ b: 1 }, { a: 2 }],
  [],
  [1, 2],
];

describe('path fast paths: fieldOne / fieldOneSingle', () => {
  for (const keepSingleton of [false, true]) {
    it(`matches fieldFinal(seed(v)) for every value shape (keepSingleton=${keepSingleton})`, () => {
      for (const v of FIELD_CASES) {
        assert.deepStrictEqual(
          P.fieldOne(v, 'a', keepSingleton),
          P.fieldFinal(P.seed(v), 'a', undefined, keepSingleton),
          `fieldOne diverged for ${JSON.stringify(v)}`
        );
        assert.deepStrictEqual(
          P.fieldOneSingle(v, 'a', keepSingleton),
          P.fieldFinal(P.seedSingle(v), 'a', undefined, keepSingleton),
          `fieldOneSingle diverged for ${JSON.stringify(v)}`
        );
      }
    });
  }

  it('does not expose inherited properties as fields', () => {
    assert.strictEqual(P.fieldOne({ a: 1 }, 'constructor', false), undefined);
    assert.strictEqual(j2js.compile('constructor').evaluate({ a: 1 }), undefined);
  });
});

describe('value mode: vStepField / vFieldFinal', () => {
  for (const keepSingleton of [false, true]) {
    it(`matches the tuple-mode field step and terminal value (keepSingleton=${keepSingleton})`, () => {
      for (const v of FIELD_CASES) {
        assert.deepStrictEqual(
          P.vFieldFinal(P.vSeed(v), 'a', keepSingleton),
          P.fieldFinal(P.seed(v), 'a', undefined, keepSingleton),
          `vFieldFinal diverged for ${JSON.stringify(v)}`
        );
        assert.deepStrictEqual(
          P.vStepField(P.vSeed(v), 'a'),
          P.stepField(P.seed(v), 'a').map((t) => t.v),
          `vStepField diverged for ${JSON.stringify(v)}`
        );
      }
    });
  }
});

describe('value mode: vFilter / vSubscript', () => {
  const PRED_INPUTS = [undefined, 3, { level: 'senior' }, [], [{ level: 'senior' }],
    [{ level: 'senior' }, { level: 'junior' }, { level: 'senior' }], [[1, 2], [3]]];

  it('matches stepPredicate for boolean predicates', () => {
    const cond = ($) => P.fieldOne($, 'level', false) === 'senior';
    for (const v of PRED_INPUTS) {
      assert.deepStrictEqual(
        RT.collapse(P.vFilter(P.vSeed(v), cond), false),
        P.collapseTuples(P.stepPredicate(P.seed(v), cond, false), false),
        `vFilter diverged for ${JSON.stringify(v)}`
      );
    }
  });

  it('matches the tuple-mode single-group behaviour for numeric (index-selecting) stages', () => {
    for (const idx of [0, 1, -1, 2.7, 99]) {
      const cond = () => idx;
      for (const v of PRED_INPUTS) {
        // `vSeed` produces one sibling group, which is the only case the
        // translator lets a positional stage reach value mode in.
        assert.deepStrictEqual(
          RT.collapse(P.vFilter(P.vSeed(v), cond), false),
          P.collapseTuples(P.stepPredicate(P.seed(v), cond, false), false),
          `vFilter diverged for index ${idx} over ${JSON.stringify(v)}`
        );
        assert.deepStrictEqual(
          RT.collapse(P.vSubscript(P.vSeed(v), cond), false),
          P.collapseTuples(P.stepSubscript(P.seed(v), cond, false), false),
          `vSubscript diverged for index ${idx} over ${JSON.stringify(v)}`
        );
      }
    }
  });

  it('keeps end-to-end predicate/subscript semantics through the compiler', () => {
    const data = { e: [{ n: 'a', lvl: 1 }, { n: 'b', lvl: 2 }, { n: 'c', lvl: 2 }] };
    assert.deepStrictEqual(j2js.compile('e[lvl = 2].n').evaluate(data), ['b', 'c']);
    assert.strictEqual(j2js.compile('e[lvl = 1].n').evaluate(data), 'a');
    assert.deepStrictEqual(j2js.compile('e[lvl = 1].n[]').evaluate(data), ['a']);
    assert.strictEqual(j2js.compile('e[0].n').evaluate(data), 'a');
    assert.strictEqual(j2js.compile('e[-1].n').evaluate(data), 'c');
    assert.strictEqual(j2js.compile('e[lvl = 9].n').evaluate(data), undefined);
    // `%` in the predicate forces tuple mode — the fast path must not be used
    assert.deepStrictEqual(j2js.compile('e[%.count = 3].n').evaluate({ ...data, count: 3 }), ['a', 'b', 'c']);
  });
});
