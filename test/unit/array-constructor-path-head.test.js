'use strict';

/**
 * jsonata's `consarray` rule, and the value-level `cons` marker that follows
 * from it (see `runtime/values.js#markCons`, `runtime/path.js#consHead`).
 *
 * When a path's FIRST step is a bare `[...]` array constructor, jsonata
 * evaluates that step as a VALUE instead of iterating it, and an empty result
 * ends the path there: the remaining steps are never evaluated, and because a
 * constructor's array is not a sequence it escapes the usual
 * empty-to-undefined collapse. So `[].x` is `[]` while `([]).x`, `nums.[].x`
 * and `empty.x` are all undefined — the trigger is syntactic AND positional
 * AND dynamic.
 *
 * The constructor's array also carries a `cons` marker wherever it appears as
 * a path step, which stops a later step or a `[]`/`^()` postfix from
 * flattening or collapsing it.
 *
 * NONE of this is covered by the official test suite (all 18 of its
 * constructor-headed paths are non-empty), so these cases carry the whole
 * weight of the rule. Every expected value below was measured against
 * `jsonata` 2.2.2.
 */

const assert = require('assert');
const j2js = require('../../src/index');

const data = { nums: [1, 2, 3], empty: [], objs: [{ x: 1 }], a: { b: 1 }, one: [{ x: 1 }] };
// The `cons` marker is a module-private Symbol; `deepStrictEqual` compares
// symbol keys, so rebuild arrays before comparing (see path-step-parity).
const plain = (v) => (Array.isArray(v) ? v.map(plain) : v);
const ev = (expr, input = data) => plain(j2js.compile(expr).evaluate(input));

describe('array constructor heading a path', () => {
  it('returns the empty array itself, not undefined', () => {
    for (const expr of ['[].x', '[].x.y', '[].$count()', '[].*', '[].**', '[].{}', '[].[1]']) {
      assert.deepStrictEqual(ev(expr), [], expr);
    }
  });

  it('triggers on a constructor that is empty only at RUNTIME', () => {
    assert.deepStrictEqual(ev('[nope].x'), []);
    assert.deepStrictEqual(ev('[nope, nope].x'), []);
    assert.deepStrictEqual(ev('[nums[false]].x'), []);
    assert.deepStrictEqual(ev('[empty].x'), []);
  });

  it('produces a real array value, observably', () => {
    assert.strictEqual(ev('$exists([].x)'), true);
    assert.strictEqual(ev('$type([].x)'), 'array');
    assert.strictEqual(ev('$string([].x)'), '[]');
    assert.strictEqual(ev('$boolean([].x)'), false);
    assert.strictEqual(ev('[].x = []'), true);
    assert.deepStrictEqual(ev('$append([].x, 1)'), [1]);
  });

  it('skips the remaining steps rather than evaluating them to nothing', () => {
    assert.deepStrictEqual(ev('[].($error("boom"))'), []);
    // ... and only because the constructor is empty:
    assert.throws(() => ev('["a"].($error("boom"))'), (e) => e.code === 'D3137');
  });

  it('applies through a sort folded onto the head step', () => {
    assert.deepStrictEqual(ev('[]^(x).y'), []);
    assert.deepStrictEqual(ev('[nope]^(x).y'), []);
  });

  it('applies to a parenthesised sub-path used as a step', () => {
    assert.deepStrictEqual(ev('a.([].x)'), []);
    assert.deepStrictEqual(ev('objs.([].x)'), []);
    assert.deepStrictEqual(ev('one.([].x)'), []);
    assert.strictEqual(ev('$type(a.([].x))'), 'array');
    // one result per source element, each kept whole
    assert.deepStrictEqual(ev('nums.([].x)'), [[], [], []]);
  });

  it('promotes the empty array under `[]` and keeps it under `^()`', () => {
    assert.deepStrictEqual(ev('[].x[]'), [[]]);
    assert.deepStrictEqual(ev('[].x^($)'), []);
    assert.deepStrictEqual(ev('a.([].x)[]'), [[]]);
    assert.deepStrictEqual(ev('nums.([].x)[]'), [[], [], []]);
    assert.deepStrictEqual(ev('a.([].x)^($)'), []);
    assert.deepStrictEqual(ev('a.([].x).$'), []);
  });

  it('does NOT apply where jsonata does not (regression guards)', () => {
    // a non-empty constructor
    assert.strictEqual(ev('["a"].x'), undefined);
    assert.strictEqual(ev('[1].x'), undefined);
    assert.strictEqual(ev('[[]].x'), undefined);
    assert.strictEqual(ev('[{"x":1}].x'), 1);
    // parenthesised, or not the first step
    assert.strictEqual(ev('([]).x'), undefined);
    assert.strictEqual(ev('($e := []; $e.x)'), undefined);
    assert.strictEqual(ev('nums.[].x'), undefined);
    assert.strictEqual(ev('$.[].x'), undefined);
    // a different parse shape
    assert.strictEqual(ev('[][0].x'), undefined);
    assert.strictEqual(ev('{}.x'), undefined);
    // the general empty-sequence collapse must survive untouched
    assert.strictEqual(ev('empty.x'), undefined);
    assert.strictEqual(ev('nums[false].x'), undefined);
    assert.strictEqual(ev('$filter(nums, function($v){false}).x'), undefined);
    // consumers that hide the difference
    assert.strictEqual(ev('$count([].x)'), 0);
    assert.strictEqual(ev('[] ~> $count()'), 0);
    assert.strictEqual(ev('[].x ? "yes" : "no"'), 'no');
  });

  it('keeps a constructor step array un-flattened past a later step', () => {
    assert.deepStrictEqual(ev('nums.[1].$'), [[1], [1], [1]]);
    assert.deepStrictEqual(ev('a.[1].$'), [1]);
    assert.deepStrictEqual(ev('a.[1].$[]'), [[1]]);
    assert.deepStrictEqual(ev('a.[].$[]'), [[]]);
    assert.deepStrictEqual(ev('a.[1][].$'), [[1]]);
    assert.deepStrictEqual(ev('a.[1].$^($)'), [1]);
    // parenthesising removes the marker, so it flattens like any expression
    assert.deepStrictEqual(ev('nums.([1,2].$)'), [1, 2, 1, 2, 1, 2]);
    assert.deepStrictEqual(ev('nums.([1,2,3].$string())'), ['1', '2', '3', '1', '2', '3', '1', '2', '3']);
    assert.strictEqual(ev('$count(nums.([1,2,3].$))'), 9);
    assert.strictEqual(ev('$sum(nums.([1,2,3].$))'), 18);
  });

  it('does not validate a sort key it never compares', () => {
    // jsonata merge-sorts, so with nothing to compare it never evaluates a
    // key and never reports a bad one.
    assert.deepStrictEqual(ev('$sort([[1]])'), [[1]]);
    assert.deepStrictEqual(ev('[[1]]^($)'), [1]);
    assert.deepStrictEqual(ev('one^($)'), { x: 1 });
    // two elements DO get compared, so a bad key still throws
    assert.throws(() => ev('$sort([[1],[2]])'), (e) => e.code === 'D3070');
    assert.throws(() => ev('[{"k":true},{"k":false}]^(k)'), (e) => e.code === 'T2008');
  });
});

describe('`[]` on a source that is not a path', () => {
  // jsonata's `keepArray` flag is only consulted where the result is a
  // sequence, so `[]` after anything that is not a path is a no-op.
  it('is a no-op', () => {
    assert.deepStrictEqual(ev('[][]'), []);
    assert.deepStrictEqual(ev('([])[]'), []);
    assert.deepStrictEqual(ev('[nope][]'), []);
    // constructed objects are `Object.create(null)`, so compare by value
    assert.strictEqual(ev('$string({}[])'), '{}');
    assert.strictEqual(ev('$string({"k":1}[])'), '{"k":1}');
    assert.strictEqual(ev('$type({}[])'), 'object');
    assert.strictEqual(ev('1[]'), 1);
    assert.strictEqual(ev('"s"[]'), 's');
    assert.strictEqual(ev('true[]'), true);
    assert.strictEqual(ev('null[]'), null);
    assert.strictEqual(ev('1+1[]'), 2);
    assert.strictEqual(ev('(1)[]'), 1);
    assert.strictEqual(ev('(a.b)[]'), 1);
    assert.strictEqual(ev('($v:=1;$v)[]'), 1);
    assert.deepStrictEqual(ev('($x:=[];$x)[]'), []);
    assert.strictEqual(ev('$string(a{"k":b}[])'), '{"k":1}');
  });

  it('still forces an array for a real path source', () => {
    assert.deepStrictEqual(ev('a.b[]'), [1]);
    assert.deepStrictEqual(ev('nums[]'), [1, 2, 3]);
    assert.deepStrictEqual(ev('nums[0][]'), [1]);
    assert.deepStrictEqual(ev('[1,2][0][]'), [1]);
    assert.deepStrictEqual(ev('a.b[0][]'), [1]);
    assert.deepStrictEqual(ev('nums^($)[]'), [1, 2, 3]);
    assert.deepStrictEqual(ev('$^($)[]', 5), [5]);
    assert.deepStrictEqual(ev('a.*[]'), [1]);
  });
});
