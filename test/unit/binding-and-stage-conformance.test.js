'use strict';

/**
 * Four rules the ports settled in §§12-13 and §20 of the cross-port
 * conformance note, each of which this port had wrong until they were
 * measured against `jsonata` 2.2.2 case by case. None is covered by the
 * official suite.
 *
 *   1. `consarray`, and the literal-step check beside it, are set by the `.`
 *      production ALONE - so `1@$e` is legal and `[1,2]#$i@$e` is not a
 *      short-circuiting constructor head (§20.1).
 *   2. A binding written on a non-path head seeds the tuple stream from the
 *      path's own INPUT, so `@$v` reverts to it (§20.2/§20.3).
 *   3. A postfix written straight onto a `~>` call never runs: jsonata hangs
 *      it on the function node, which `evaluateApplyExpression` calls
 *      directly. A `^()` makes a node of its own and still applies (§13.5's
 *      B, corrected).
 *   4. A `[]` mark rides through a `^()` only when what carries it is
 *      path-shaped, and a group-by bucket accumulates with `fn.append`
 *      (§13.5's A and the group half of §14.5).
 */

const assert = require('assert');
const j2js = require('../../src/index');

const data = {
  nums: [1, 2, 3], objs: [{ x: 1 }, { x: 2 }], one: [{ x: 1 }],
  a: { b: 1, c: [7, 8] }, empty: [],
};
// Constructed objects use a null prototype (see genObjectConstructor) and
// arrays can carry the private `cons` marker: rebuild both before comparing.
const plain = (v) => {
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = plain(v[k]);
    return out;
  }
  return v;
};
const ev = (expr, input = data) => plain(j2js.compile(expr).evaluate(input));

describe('bindings on a non-path head', () => {
  it('makes a literal step legal when a binding, not a dot, built the path', () => {
    assert.strictEqual(ev('1@$e'), 1);
    assert.strictEqual(ev('1#$i'), 1);
    assert.strictEqual(ev('true@$e'), true);
    // The `.` production still rejects one, through the stages a step carries.
    for (const expr of ['1[].$', '1[0].$', 'a.true', '1.$']) {
      assert.throws(() => j2js.compile(expr), (e) => e.code === 'S0213', expr);
    }
  });

  it('gives a constructor head no consarray flag without a dot', () => {
    // With the dot the head short-circuits as a value and the stream restarts
    // from the path's input; without it the constructor is an ordinary step.
    assert.deepStrictEqual(ev('[1,2]#$i@$e.$'), data);
    assert.deepStrictEqual(ev('[1,2]#$i@$e'), [data, data]);
    assert.deepStrictEqual(ev('[1,2]@$e#$i'), [data, data]);
    assert.deepStrictEqual(ev('[1,2]@$e'), [1, 2]);
  });

  it('reverts `@$v` to the path input for every non-path head', () => {
    assert.deepStrictEqual(ev('(a.b)@$e'), 1);
    assert.deepStrictEqual(ev('(a.b)@$e.$'), data);
    assert.deepStrictEqual(ev('(nums)@$e'), [1, 2, 3]);
    assert.deepStrictEqual(ev('$sum(nums)@$e'), 6);
    assert.deepStrictEqual(ev('$sum(nums)@$e.$'), data);
  });

  it('keeps a constructor head\'s bindings out of the rest of the path', () => {
    assert.strictEqual(ev('[1]#$i.$'), 1);
    assert.strictEqual(ev('[1]#$i.$i'), undefined);
    // A `#$v` makes the stream a tuple stream, whose empty case is nothing.
    assert.strictEqual(ev('[]#$i.$'), undefined);
    assert.deepStrictEqual(ev('[].x@$e'), []);
  });

  it('reads a quoted string heading a path as a field, through any stage', () => {
    assert.strictEqual(ev('"z"@$e.$'), undefined);
    assert.strictEqual(ev('"z"[0].$'), undefined);
    assert.deepStrictEqual(ev('"z"{"k":$}.$'), {});
    assert.strictEqual(ev('"b".$', { b: 5 }), 5);
  });
});

describe('a postfix on a ~> step', () => {
  it('drops a `[...]` or `{...}` written straight onto the call', () => {
    assert.deepStrictEqual(ev('nums ~> $reverse()[0]'), [3, 2, 1]);
    assert.deepStrictEqual(ev('nums ~> $reverse()[1]'), [3, 2, 1]);
    assert.deepStrictEqual(ev('a ~> $keys()[0]'), ['b', 'c']);
    assert.strictEqual(ev('nums ~> $sum(){"k":$}'), 6);
    assert.strictEqual(ev('nums ~> $sum()[0]'), 6);
  });

  it('still applies a `^()`, and everything above it', () => {
    assert.deepStrictEqual(ev('nums ~> $reverse()^($)'), [1, 2, 3]);
    assert.strictEqual(ev('nums ~> $reverse()^($)[0]'), 1);
    assert.deepStrictEqual(ev('nums ~> $reverse()[]^($)'), [1, 2, 3]);
  });

  it('gives a `[]` whose stage run was dropped the call\'s own answer', () => {
    assert.strictEqual(ev('nums ~> $sum()[0][]'), 6);
    assert.deepStrictEqual(ev('nums ~> $reverse()[0][]'), [3, 2, 1]);
  });
});

describe('the `[]` mark and a group-by bucket', () => {
  it('drops the mark at a `^()` unless what carries it is path-shaped', () => {
    assert.strictEqual(ev('1[]^($)'), 1);
    assert.strictEqual(ev('[1][]^($)'), 1);
    assert.strictEqual(ev('$map(one, function($v){$v.x})[]^($)'), 1);
    assert.strictEqual(ev('(a.b)[0][]^($)'), 1);
    // Path-shaped carriers keep it, and a sort's own result IS a sequence.
    assert.deepStrictEqual(ev('a.b[]^($)'), [1]);
    assert.deepStrictEqual(ev('nums[0][]^($)'), [1]);
    assert.deepStrictEqual(ev('1^($)[]'), [1]);
  });

  it('leaves a value that is already an array alone', () => {
    assert.deepStrictEqual(ev('$zip(nums,nums)[0][]'), [1, 1]);
    assert.deepStrictEqual(ev('[[1,2]][0][]'), [1, 2]);
    assert.deepStrictEqual(ev('1[0][]'), [1]);
  });

  it('does nothing after `$eval`, which is not a sequence builder', () => {
    assert.strictEqual(ev('$eval("1")[]'), 1);
    assert.deepStrictEqual(ev('$eval("[1]")[]'), [1]);
  });

  it('accumulates a group-by bucket with `fn.append`', () => {
    assert.deepStrictEqual(ev('$zip(nums,nums){"k":$}'), { k: [1, 1, 2, 2, 3, 3] });
    assert.deepStrictEqual(ev('a{"k":c}'), { k: [7, 8] });
    assert.deepStrictEqual(ev('objs{"k":x}'), { k: [1, 2] });
  });

  it('lets a group-by stage on a constructor head end the path', () => {
    assert.strictEqual(ev('[1]{"k":1}.$'), undefined);
    assert.strictEqual(ev('[1]{"k":1}[].$'), undefined);
    assert.strictEqual(ev('[1][0].$'), undefined);
  });
});
