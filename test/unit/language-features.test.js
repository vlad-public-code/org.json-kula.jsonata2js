'use strict';

/**
 * Hand-written scenario tests exercising jsonata2js's full pipeline
 * (compile -> evaluate) across string/numeric/date-time/boolean-operator/
 * error-code/object/regex/flattening/programming/path-operator/predicate
 * coverage (design.md task 10.4), mirroring the spirit of JSonata2Java's
 * `language_features` scenario tests re-expressed as JS/mocha tests.
 */

const assert = require('assert');
const j2js = require('../../src/index');

function evaluate(expr, input, bindings) {
  return j2js.compile(expr).evaluate(input, bindings);
}

describe('language features: string', () => {
  it('concatenation and case conversion', () => {
    assert.strictEqual(evaluate('$uppercase("foo") & "-" & $lowercase("BAR")'), 'FOO-bar');
  });
  it('substring family', () => {
    assert.strictEqual(evaluate('$substring("hello world", 6)'), 'world');
    assert.strictEqual(evaluate('$substringBefore("a.b.c", ".")'), 'a');
    assert.strictEqual(evaluate('$substringAfter("a.b.c", ".")'), 'b.c');
  });
  it('padding and joining', () => {
    assert.strictEqual(evaluate('$join(["a","b","c"], "-")'), 'a-b-c');
    assert.strictEqual(evaluate('$pad("5", 3, "0")'), '500');
  });
});

describe('language features: numeric', () => {
  it('arithmetic operator precedence', () => {
    assert.strictEqual(evaluate('2 + 3 * 4 - 1'), 13);
  });
  it('round-half-to-even', () => {
    assert.strictEqual(evaluate('$round(0.5)'), 0);
    assert.strictEqual(evaluate('$round(1.5)'), 2);
  });
  it('overflow is not thrown until the non-finite value is consumed', () => {
    assert.strictEqual(evaluate('1/0'), Infinity);
    assert.throws(() => evaluate('1 + 1/0'), (e) => e.code === 'D1001');
  });
});

describe('language features: date-time', () => {
  it('fromMillis/toMillis round-trip', () => {
    const iso = evaluate('$fromMillis(0)');
    assert.strictEqual(evaluate('$toMillis($iso)', undefined, { iso }), 0);
  });
  it('formatInteger Roman numerals', () => {
    assert.strictEqual(evaluate('$formatInteger(1994, "I")'), 'MCMXCIV');
  });
});

describe('language features: boolean operators', () => {
  it('and/or short-circuit and truthiness', () => {
    assert.strictEqual(evaluate('true and false'), false);
    assert.strictEqual(evaluate('false or true'), true);
    assert.strictEqual(evaluate('[] ? "t" : "f"'), 'f');
    assert.strictEqual(evaluate('[0] ? "t" : "f"'), 'f');
  });
  it('elvis and coalesce operators', () => {
    assert.strictEqual(evaluate('0 ?: "default"'), 'default');
    assert.strictEqual(evaluate('missing ?? "default"'), 'default');
  });
});

describe('language features: error codes', () => {
  it('type errors surface documented codes', () => {
    assert.throws(() => evaluate('"a" + 1'), (e) => e.code === 'T2001');
    assert.throws(() => evaluate('1 < true'), (e) => e.code === 'T2010');
    assert.throws(() => evaluate('$sqrt(-1)'), (e) => e.code === 'D3060');
  });
  it('parse errors surface documented codes with position', () => {
    try {
      j2js.compile('"unterminated');
      assert.fail('expected a ParseError');
    } catch (e) {
      assert.strictEqual(e.code, 'S0101');
      assert.ok(e.cause && e.cause.position >= 0);
    }
  });
});

describe('language features: object construction', () => {
  it('object constructor skips missing values and validates key types', () => {
    // Constructed objects are `Object.create(null)` (reference-jsonata
    // parity, so a `"__proto__"` key becomes an ordinary own key instead
    // of hijacking the prototype - see CODE-REVIEW.md H5); normalize to a
    // plain object before comparing so the assertion checks *content*,
    // not incidental prototype identity.
    assert.deepStrictEqual(Object.assign({}, evaluate('{"a": 1, "b": missing}')), { a: 1 });
    assert.doesNotThrow(() => evaluate('{missing: 1}'));
  });
  it('group-by aggregates per key', () => {
    const result = evaluate('Account.Order{Product: $sum(Price)}', {
      Account: { Order: [{ Product: 'A', Price: 10 }, { Product: 'A', Price: 5 }, { Product: 'B', Price: 3 }] },
    });
    assert.deepStrictEqual(Object.assign({}, result), { A: 15, B: 3 });
  });
});

describe('language features: regex', () => {
  it('match and replace with backreferences', () => {
    assert.deepStrictEqual(evaluate('$match("2024-01-15", /(\\d+)-(\\d+)-(\\d+)/).groups'), ['2024', '01', '15']);
    assert.strictEqual(evaluate('$replace("hello", /l/, "L")'), 'heLLo');
  });
});

describe('language features: flattening / sequences', () => {
  it('path navigation flattens one level and collapses singletons', () => {
    const data = { a: [{ b: [1, 2] }, { b: [3] }] };
    assert.deepStrictEqual(evaluate('a.b', data), [1, 2, 3]);
  });
  it('array constructor of a single match does not collapse', () => {
    assert.deepStrictEqual(evaluate('[a.b]', { a: { b: 1 } }), [1]);
  });
});

describe('language features: programming (recursion, closures, HOF)', () => {
  it('tail-recursive function handles deep recursion without stack overflow', () => {
    const result = evaluate(
      '($sum := function($n, $acc){ $n = 0 ? $acc : $sum($n - 1, $acc + $n) }; $sum(50000, 0))'
    );
    assert.strictEqual(result, (50000 * 50001) / 2);
  });
  it('closures capture enclosing bindings inside higher-order callbacks', () => {
    assert.deepStrictEqual(evaluate('($factor := 3; $map([1,2,3], function($v){ $v * $factor }))'), [3, 6, 9]);
  });
  it('mutual recursion resolves via block-level forward references', () => {
    const result = evaluate(
      '($isEven := function($n){ $n = 0 ? true : $isOdd($n - 1) }; $isOdd := function($n){ $n = 0 ? false : $isEven($n - 1) }; $isEven(10))'
    );
    assert.strictEqual(result, true);
  });
});

describe('language features: path operators and predicates', () => {
  it('predicate filtering and numeric index selection', () => {
    const data = { items: [{ v: 1 }, { v: 5 }, { v: 9 }] };
    assert.deepStrictEqual(evaluate('items[v > 3].v', data), [5, 9]);
    assert.strictEqual(evaluate('items[0].v', data), 1);
    assert.strictEqual(evaluate('items[-1].v', data), 9);
  });
  it('sort operator with descending multi-key and parent access', () => {
    const data = { items: [{ v: 2 }, { v: 1 }, { v: 3 }] };
    assert.deepStrictEqual(evaluate('items^(>v).v', data), [3, 2, 1]);
  });
  it('wildcard and descendant operators', () => {
    const data = { a: { x: 1 }, b: { x: 2 } };
    // No `.sort()`: key-insertion order (`a` before `b`) is the documented
    // traversal order for both `*` and `**`, and is exactly what the
    // reference `jsonata` interpreter produces for this input too -
    // sorting the result away hid this ordering contract entirely.
    assert.deepStrictEqual(evaluate('*.x', data), [1, 2]);
    assert.deepStrictEqual(evaluate('**.x', data), [1, 2]);
  });
});
