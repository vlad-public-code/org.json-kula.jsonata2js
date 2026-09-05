'use strict';

/**
 * jsonata's `expr.stages` and the other places `evaluateStep` /
 * `evaluatePath` differ from a naive "filter the flattened stream" model.
 * Every expected value below was measured against `jsonata` 2.2.2.
 *
 * The headline rule: a `[...]` written after a path STEP is a *stage*, which
 * `evaluateStep` runs inside its per-input-item loop on that item's own step
 * result - not on the whole stream. For a navigation step the two models
 * agree, because each source element's results already form one sibling
 * group; for a step whose per-element result is a single value or one
 * un-flattened array (`$`, `[a,b]`, `(expr)`) they do not.
 */

const assert = require('assert');
const j2js = require('../../src/index');

const data = {
  nums: [1, 2, 3],
  objs: [{ x: 1 }, { x: 2 }],
  one: [{ x: 1 }],
  a: { b: 1, c: [7, 8] },
  o: [{ p: [{ v: 2 }, { v: 1 }], q: 5 }, { p: [{ v: 4 }, { v: 3 }], q: 6 }],
};
// A bare `[...]` path step tags its array with the internal `cons` marker
// (a module-private Symbol); rebuild arrays before comparing.
const plain = (v) => (Array.isArray(v) ? v.map(plain) : v);
const ev = (expr, input = data) => plain(j2js.compile(expr).evaluate(input));

describe('path stages on a non-navigation step', () => {
  it('applies per source element to that element\'s own result', () => {
    assert.deepStrictEqual(ev('objs.[1,2][0]'), [1, 1]);
    assert.deepStrictEqual(ev('objs.[1,2][1]'), [2, 2]);
    assert.deepStrictEqual(ev('nums.[1,2][0]'), [1, 1, 1]);
    assert.deepStrictEqual(ev('o.[q,q][0]'), [5, 6]);
    assert.deepStrictEqual(ev('objs.[x][0]'), [1, 2]);
    // a single source element: one sequence result, flattened then collapsed
    assert.strictEqual(ev('a.[1,2][0]'), 1);
    assert.strictEqual(ev('a.[1,2][1]'), 2);
    assert.strictEqual(ev('a.[1,2][-1]'), 2);
    assert.strictEqual(ev('a.[nope][0]'), undefined);
  });

  it('keeps a selected ARRAY item whole (jsonata\'s `results = item`)', () => {
    assert.deepStrictEqual(ev('a.[[1,2]][0]'), [1, 2]);
    assert.deepStrictEqual(ev('a.[[1,2],[3,4]][0]'), [1, 2]);
    assert.deepStrictEqual(ev('objs.[[1]][0]'), [1, 1]);
  });

  it('handles a general predicate, not just a literal index', () => {
    assert.strictEqual(ev('a.[1,2][$>1]'), 2);
    assert.deepStrictEqual(ev('objs.[1,2][$>1]'), [2, 2]);
  });

  it('treats a `$` step as one result per element', () => {
    assert.deepStrictEqual(ev('objs.$[0]'), [{ x: 1 }, { x: 2 }]);
    assert.strictEqual(ev('objs.$[1]'), undefined);
    assert.deepStrictEqual(ev('objs.$[-1]'), [{ x: 1 }, { x: 2 }]);
    assert.deepStrictEqual(ev('nums.$[0]'), [1, 2, 3]);
    assert.deepStrictEqual(ev('a.c.$[0]'), [7, 8]);
    assert.deepStrictEqual(ev('objs.$[0].x'), [1, 2]);
    assert.deepStrictEqual(ev('objs.$[0][]'), [{ x: 1 }, { x: 2 }]);
  });

  it('leaves a navigation step\'s sibling-group indexing alone', () => {
    assert.deepStrictEqual(ev('o.p[0]'), [{ v: 2 }, { v: 4 }]);
    assert.deepStrictEqual(ev('o.p[0].v'), [2, 4]);
    assert.deepStrictEqual(ev('o.p[v>1]'), [{ v: 2 }, { v: 4 }, { v: 3 }]);
    assert.deepStrictEqual(ev('o.p[-1]'), [{ v: 1 }, { v: 3 }]);
    assert.deepStrictEqual(ev('objs[0]'), { x: 1 });
    assert.strictEqual(ev('nums[0]'), 1);
    // and a STANDALONE predicate still applies to the whole result
    assert.strictEqual(ev('$v[1]', undefined), undefined);
    assert.strictEqual(j2js.compile('$v[1]').evaluate({}, { v: [1, 2, 3] }), 2);
  });

  it('applies stages once over the whole stream in a `%` (tuple) path', () => {
    // `evaluateTupleStep` runs `expr.stages` after expanding every outer
    // tuple, unlike `evaluateStep`'s per-item loop.
    assert.deepStrictEqual(ev('o.p.v.%[0]'), { v: 2 });
    assert.deepStrictEqual(ev('o.p.v.%[1]'), { v: 1 });
    // `%` with no derivable parent is a compile error, stage or not
    assert.throws(() => ev('$.%'), (e) => e.code === 'S0217');
    assert.throws(() => ev('$.%[0]'), (e) => e.code === 'S0217');
  });
});

describe('a group-by hangs off the whole path', () => {
  it('lets a predicate, sort or step run BEFORE the grouping', () => {
    assert.strictEqual(ev('$string(objs{"k":x}[0])'), '{"k":1}');
    assert.strictEqual(ev('$string(nums{"k":$}[0])'), '{"k":1}');
    assert.strictEqual(ev('$string(a{"k":b}[0])'), '{"k":1}');
    // `objs[0].k` grouped by "k" - `k` is missing, so the group is empty
    assert.strictEqual(ev('$string(objs{"k":x}[0].k)'), '{}');
    // sorting objects by `$` is a bad sort key, reached only because the sort
    // runs on `objs` rather than on the grouped object
    assert.throws(() => ev('objs{"k":x}^($)'), (e) => e.code === 'T2008');
  });

  it('still rejects a suffix on a group-by over a non-path', () => {
    assert.throws(() => ev('(1){"k":$}[0]'), (e) => e.code === 'S0209');
  });
});

describe('terminal `*`', () => {
  // `evaluateWildcard` builds a sequence but appends any ARRAY-valued key
  // through `fn.append`, whose `concat` drops the sequence flag - and
  // `evaluateStep`'s last-step rule then passes that plain array through.
  const w = { w1: { e: [], f: { g: 9 } }, w2: { f: { g: 9 } }, w3: { a: [], b: [] }, w4: { a: [7] } };
  it('does not collapse when an array-valued key was flattened in', () => {
    assert.deepStrictEqual(ev('w1.*', w), [{ g: 9 }]);
    assert.deepStrictEqual(ev('w3.*', w), []);
    assert.deepStrictEqual(ev('w4.*', w), [7]);
    assert.strictEqual(ev('$type(w1.*)', w), 'array');
  });
  it('collapses normally when none was', () => {
    assert.deepStrictEqual(ev('w2.*', w), { g: 9 });
  });
});

describe('a literal may not be a path step', () => {
  it('is S0213 anywhere in a multi-step path', () => {
    for (const expr of ['1[].$', 'true[].$', 'null[].$', 'true.x', 'null.x', 'a.true', '1.x']) {
      assert.throws(() => ev(expr), (e) => e.code === 'S0213', expr);
    }
  });
  it('does not reject a parenthesised one, which is a block', () => {
    assert.strictEqual(ev('a.(1)'), 1);
    assert.strictEqual(ev('a.(1+1)'), 2);
    assert.deepStrictEqual(ev('nums.(2)'), [2, 2, 2]);
  });
});

describe('`[]` after a call', () => {
  it('keeps the singleton only for a built-in that builds a sequence', () => {
    assert.deepStrictEqual(ev('$map(one, function($v){$v.x})[]'), [1]);
    assert.deepStrictEqual(ev('$keys(a)[]'), ['b', 'c']);
    assert.deepStrictEqual(ev('$filter(one, function($v){true})[]'), [{ x: 1 }]);
    assert.deepStrictEqual(ev('$each({"k":1}, function($v,$k){$k})[]'), ['k']);
  });
  it('is a no-op for one that does not', () => {
    assert.strictEqual(ev('$sum(nums)[]'), 6);
    assert.strictEqual(ev('$string(1)[]'), '1');
    assert.strictEqual(ev('$type(1)[]'), 'number');
    assert.strictEqual(ev('$substring("qq",0,1)[]'), 'q');
    assert.strictEqual(ev('$append(1, nope)[]'), 1);
    assert.strictEqual(ev('nums ~> $sum()[]'), 6);
    assert.strictEqual(ev('a.b ~> $string()[]'), '1');
  });
  it('tracks `$lookup`\'s two shapes', () => {
    // an ARRAY input builds a sequence; an object input returns the raw value
    assert.strictEqual(ev('$lookup(a, "b")[]'), 1);
    assert.deepStrictEqual(ev('$lookup(one, "x")[]'), [1]);
    assert.deepStrictEqual(ev('$lookup(objs, "x")[]'), [1, 2]);
    assert.strictEqual(ev('$lookup(a, "zz")[]'), undefined);
  });
});

describe('a consarray head carrying a `[...]` stage', () => {
  // The stage collapses the head to a plain value, which `evaluatePath` hands
  // to the next step as its whole input - walked by JS `.length`.
  it('yields nothing when the head has no length', () => {
    assert.strictEqual(ev('[1,2][0].$'), undefined);
    assert.strictEqual(ev('[1,2][1].$'), undefined);
    assert.strictEqual(ev('[1,2][-1].$'), undefined);
    assert.strictEqual(ev('[{"x":1}][0].x'), undefined);
    assert.strictEqual(ev('[nums][0].$'), undefined);
    assert.strictEqual(ev('[1,2][$>1].$'), undefined);
  });
  it('walks a string head by character', () => {
    assert.deepStrictEqual(ev('["ab"][0].$'), ['a', 'b']);
    assert.deepStrictEqual(ev('["ab","cd"][0].$'), ['a', 'b']);
    assert.strictEqual(ev('$type(["ab"][0].$)'), 'array');
    assert.strictEqual(ev('[""][0].x'), '');
  });
  it('keeps an array head', () => {
    assert.deepStrictEqual(ev('[[1,2]][0].$'), [1, 2]);
    assert.strictEqual(ev('[[1],[2]][0].$'), 1);
  });
  it('honours a `[]` written on the head step itself', () => {
    assert.deepStrictEqual(ev('[1,2][0][].$'), [1]);
    assert.strictEqual(ev('[1,2][0].$[]'), undefined);
  });
  it('is defeated by parentheses, like every other consarray head', () => {
    assert.strictEqual(ev('([1,2][0]).$'), 1);
  });
});
