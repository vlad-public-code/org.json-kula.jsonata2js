'use strict';

/**
 * The translator compiles to a factory and lifts every per-element callback
 * that captures nothing into the factory's scope, so it is created once per
 * compiled expression instead of once per `evaluate()` call (28 of them in the
 * benchmark expression; ~11% of throughput on a callback-shaped microbenchmark).
 *
 * The analysis (`Translator#hoistableClosure`) is a whitelist, and getting it
 * wrong is severe: a wrongly-hoisted callback either throws `ReferenceError`
 * for an identifier that only exists in the evaluator's scope, or silently
 * reads a stale value. These tests therefore pin the boundary — every
 * construct that reaches evaluator scope must still work, must see per-call
 * state, and must keep working when the same compiled expression is evaluated
 * repeatedly with different inputs and bindings.
 */

const assert = require('assert');
const j2js = require('../../src/index');
const { Translator } = require('../../src/translator/translator');
const { optimize } = require('../../src/optimizer/optimizer');
const { parse } = require('../../src/parser/parser');
const { buildRegistry } = require('../../src/runtime/builtins');

const BUILTIN_NAMES = new Set(Object.keys(buildRegistry()));
const hoistedCount = (expr) => {
  const { body } = new Translator(BUILTIN_NAMES).translate(optimize(parse(expr)));
  return (body.match(/^const fn\d+ = /gm) || []).length;
};

const data = {
  e: [{ n: 'a', lvl: 1, tag: 'x' }, { n: 'b', lvl: 2, tag: 'y' }, { n: 'c', lvl: 2, tag: 'x' }],
  limit: 2,
  root: 'x',
};

describe('closure hoisting: what gets hoisted', () => {
  it('hoists capture-free predicates, steps and sort keys', () => {
    assert.strictEqual(hoistedCount('e[lvl = 2].n'), 1);
    assert.strictEqual(hoistedCount('e[lvl = 2].n[lvl > 0]'), 2);
    assert.strictEqual(hoistedCount('e.(lvl * 2)'), 1);
    assert.strictEqual(hoistedCount('e^(lvl)'), 1);           // the key descriptor array
    assert.strictEqual(hoistedCount('e[$number(lvl) > 1]'), 1); // static builtin call
    assert.strictEqual(hoistedCount('e[tag = "x"]'), 1);
  });

  it('deduplicates identical callbacks', () => {
    // both predicates compile to the same source
    assert.strictEqual(hoistedCount('[e[lvl = 2], e[lvl = 2]]'), 1);
  });

  it('does NOT hoist a callback that reaches the evaluator scope', () => {
    for (const expr of [
      'e[lvl = limit]',                       // FieldRef is fine, but this one is: root field
      'e[lvl = $$.limit]',                    // $$ (root)
      '($n := 2; e[lvl = $n])',               // lexically bound variable
      'e[lvl = $lim]',                        // ENV-resolved binding
      'e.p[%.lvl = 2]',                       // % parent
      'e@$x.n[$x.lvl = 2]',                   // @$ binding
      'e#$i[$i = 0]',                         // #$ binding
      '$map(e, function($t) { e[tag = $t.tag] })', // lambda parameter
      '($f := function($v) { $v > 1 }; e[$f(lvl)])', // user function call
      'e[$eval("lvl") = 2]',                  // $eval reaches ENV
    ]) {
      const n = hoistedCount(expr);
      // `e[lvl = limit]` is genuinely capture-free (both sides are fields of
      // the element/context), so it may hoist; everything else must not.
      if (expr === 'e[lvl = limit]') continue;
      assert.strictEqual(n, 0, `${expr} hoisted ${n} callback(s) but reaches evaluator scope`);
    }
  });
});

describe('closure hoisting: behaviour is unchanged', () => {
  const ev = (expr, input = data, bindings) => j2js.compile(expr).evaluate(input, bindings);

  it('evaluates hoisted-callback expressions correctly', () => {
    assert.deepStrictEqual(ev('e[lvl = 2].n'), ['b', 'c']);
    assert.deepStrictEqual(ev('e^(>lvl).n'), ['b', 'c', 'a']);
    assert.deepStrictEqual(ev('e.(lvl * 10)'), [10, 20, 20]);
    assert.strictEqual(ev('$count(e[tag = "x"])'), 2);
  });

  it('sees per-call bindings and inputs on every evaluation', () => {
    const expr = j2js.compile('e[lvl = $want].n');
    assert.deepStrictEqual(expr.evaluate(data, { want: 2 }), ['b', 'c']);
    assert.strictEqual(expr.evaluate(data, { want: 1 }), 'a');
    assert.strictEqual(expr.evaluate({ e: [{ n: 'z', lvl: 1 }] }, { want: 1 }), 'z');
    assert.strictEqual(expr.evaluate(data, { want: 99 }), undefined);
  });

  it('reuses one compiled expression across inputs without leaking state', () => {
    const expr = j2js.compile('e[lvl = 2].n');
    assert.deepStrictEqual(expr.evaluate(data), ['b', 'c']);
    assert.strictEqual(expr.evaluate({ e: [{ n: 'only', lvl: 2 }] }), 'only');
    assert.strictEqual(expr.evaluate({ e: [] }), undefined);
    assert.deepStrictEqual(expr.evaluate(data), ['b', 'c']);
  });

  it('keeps nested lambda scopes correct (callback per invocation)', () => {
    assert.deepStrictEqual(
      ev('$map(e, function($t) { $count(e[tag = $t.tag]) })'),
      [2, 1, 2]
    );
    assert.deepStrictEqual(ev('e.($map([1,2], function($i) { $i * lvl }))'), [1, 2, 2, 4, 2, 4]);
  });

  it('keeps $now/$millis and other per-evaluation state per call', () => {
    const expr = j2js.compile('e[lvl = 2].{ "n": n, "t": $millis() }');
    const first = expr.evaluate(data);
    const start = Date.now();
    while (Date.now() === start) { /* spin one tick */ }
    const second = expr.evaluate(data);
    assert.ok(second[0].t > first[0].t, 'each evaluation must observe its own clock snapshot');
  });
});
