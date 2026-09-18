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

describe('review JS-2: a caller-bound name shadows a built-in', () => {
  // Reference behaviour, measured: a user binding always wins, because
  // `$sum` resolves through the environment chain.
  it('registerFunction wins over the built-in', () => {
    const e = j2js.compile('$sum([1,2])');
    e.registerFunction('sum', () => 'mine');
    assert.strictEqual(e.evaluate({}), 'mine');
  });

  it('a non-function assign() makes the call T1006, as in the reference', () => {
    const e = j2js.compile('$sum([1,2])');
    e.assign('sum', 42);
    assert.throws(() => e.evaluate({}), (err) => err.code === 'T1006');
    const e2 = j2js.compile('$abs(-1)');
    e2.assign('abs', 7);
    assert.throws(() => e2.evaluate({}), (err) => err.code === 'T1006');
  });

  it('a per-evaluation binding wins too', () => {
    // reference: "B"
    const e = j2js.compile('$uppercase("a")');
    assert.strictEqual(e.evaluate({}, { uppercase: () => 'B' }), 'B');
    // ...and the un-shadowed call is unaffected on the next evaluation
    assert.strictEqual(e.evaluate({}), 'A');
  });

  it('wins in a ~> chain step', () => {
    // reference: "mine"
    const e = j2js.compile('[1,2] ~> $sum()');
    e.registerFunction('sum', () => 'mine');
    assert.strictEqual(e.evaluate({}), 'mine');
  });

  it('wins for the specially-compiled built-ins ($lookup, $string, $count)', () => {
    // reference: "L" / "S" / 99
    const a = j2js.compile('$lookup({"a":1},"a")');
    a.registerFunction('lookup', () => 'L');
    assert.strictEqual(a.evaluate({}), 'L');
    const b = j2js.compile('$string(1)');
    b.registerFunction('string', () => 'S');
    assert.strictEqual(b.evaluate({}), 'S');
    const c = j2js.compile('$count([1,2])');
    c.registerFunction('count', () => 99);
    assert.strictEqual(c.evaluate({}), 99);
  });

  it('a lexical := binding still shadows the built-in (unchanged)', () => {
    // reference: 1
    assert.strictEqual(evalOf('( $sum := function($x){ 1 }; $sum([1,2]) )'), 1);
  });

  it('an un-shadowed expression is unchanged and compiled once', () => {
    const e = j2js.compile('$sum([1,2])');
    assert.strictEqual(e.evaluate({}), 3);
    assert.strictEqual(e._shadowVariants, null);
  });
});

describe('review JS-5: registerFunction does not tag the caller-owned function', () => {
  it('registering one JS function on two expressions keeps both signatures', () => {
    const shared = (x) => x;
    const a = j2js.compile('$f(1)');
    a.registerFunction('f', shared, '<n:n>');
    const b = j2js.compile('$f("s")');
    b.registerFunction('f', shared, '<s:s>');
    assert.strictEqual(a.evaluate({}), 1);
    assert.strictEqual(b.evaluate({}), 's');
    // ...and still after the second registration, which used to overwrite
    // `shared._jsonataSignature` in place.
    assert.strictEqual(a.evaluate({}), 1);
    const c = j2js.compile('$f("s")');
    c.registerFunction('f', shared, '<n:n>');
    assert.throws(() => c.evaluate({}), (err) => err.code === 'T0410');
  });

  it('leaves no JSONata properties on the caller-owned object', () => {
    const shared = (x) => x;
    j2js.compile('$f(1)').registerFunction('f', shared, '<n:n>');
    assert.deepStrictEqual(Object.keys(shared), []);
    assert.strictEqual(shared._jsonataSignature, undefined);
    assert.strictEqual(shared._jsonataArity, undefined);
  });

  it('keeps an already-tagged function value declared arity', () => {
    const lib = j2js.compileLibrary({ add: 'function($a, $b) { $a + $b }' });
    const e = j2js.compile('$add(2, 3)').useLibrary(lib);
    assert.strictEqual(e.evaluate({}), 5);
  });
});

describe('review JS-6: a signature error names the function', () => {
  const msgOf = (src) => {
    try {
      evalOf(src);
    } catch (e) {
      return e.message;
    }
    return null;
  };

  it('uses the call-site name', () => {
    // reference: Argument 1 of function "f" does not match function signature
    assert.strictEqual(msgOf('( $f := function($x)<s>{$x}; $f(5) )'),
      'Argument 1 of function "f" does not match function signature');
    assert.strictEqual(msgOf('( $f := function($x)<s>{$x}; $g := $f; $g(5) )'),
      'Argument 1 of function "g" does not match function signature');
  });

  it('reports "undefined" where the reference does (no call-site name)', () => {
    // reference: Argument 1 of function undefined does not match ... for both
    assert.strictEqual(msgOf('( $f := function($x)<s>{$x}; 5 ~> $f )'),
      'Argument 1 of function undefined does not match function signature');
    assert.strictEqual(msgOf('function($x)<s>{$x}(5)'),
      'Argument 1 of function undefined does not match function signature');
  });

  it('is unchanged for a built-in', () => {
    // reference: Argument 1 of function "abs" does not match function signature
    assert.strictEqual(msgOf('$abs("x")'),
      'Argument 1 of function "abs" does not match function signature');
  });
});

describe('review JS-7: an out-of-range $pad/$join width is a coded error', () => {
  it('$pad reports D1001 instead of a bare RangeError', () => {
    // The reference lets V8's own `RangeError` escape uncoded; this port
    // reports the JSONata error code so `err.code` filtering works.
    assert.throws(() => evalOf('$pad("a", 1e15)'),
      (e) => e.code === 'D1001' && e instanceof j2js.JsonataError);
    assert.throws(() => evalOf('$pad("a", -1e15)'), (e) => e.code === 'D1001');
  });

  it('leaves ordinary $pad/$join alone', () => {
    // reference: "abc--" / "a-b" / "--abc"
    assert.strictEqual(evalOf('$pad("abc", 5, "-")'), 'abc--');
    assert.strictEqual(evalOf('$join(["a","b"], "-")'), 'a-b');
    assert.strictEqual(evalOf('$pad("abc", -5, "-")'), '--abc');
  });
});

describe('review JS-8: $keys over arrays handles a __proto__ key', () => {
  it('returns __proto__ like any other key', () => {
    // reference: ["__proto__","a"]
    const input = JSON.parse('[{"__proto__":1,"a":2}]');
    assert.deepStrictEqual(plain(evalOf('$keys($$)', input)), ['__proto__', 'a']);
  });

  it('is unchanged for the ordinary cases', () => {
    // reference: ["a","b"] / ["a","b"]
    assert.deepStrictEqual(plain(evalOf('$keys($$)', { a: 1, b: 2 })), ['a', 'b']);
    assert.deepStrictEqual(plain(evalOf('$keys($$)', [{ a: 1 }, { b: 2 }])), ['a', 'b']);
  });
});

describe('review JS-9: $clone/transform number rendering (inherited quirk)', () => {
  it('matches the reference exactly, precision loss included', () => {
    // reference: {"a":0.3} / {"a":0.333333333333333} / {"a":0.3,"b":1}
    assert.deepStrictEqual(plain(evalOf('$clone({"a": 0.1 + 0.2})')), { a: 0.3 });
    assert.deepStrictEqual(plain(evalOf('$clone({"a": 1/3})')), { a: 0.333333333333333 });
    assert.deepStrictEqual(plain(evalOf('{"a": 0.1+0.2} ~> |$|{"b":1}|')), { a: 0.3, b: 1 });
  });

  it('keeps large integral values integral', () => {
    // reference: {"a":1e+30,"b":100000000000000000000}
    assert.deepStrictEqual(plain(evalOf('$clone({"a": 1e30, "b": 100000000000000000000})')),
      { a: 1e30, b: 100000000000000000000 });
  });
});
