'use strict';

const assert = require('assert');
const {
  fn_fromMillis,
  fn_toMillis,
  fn_formatInteger,
  fn_parseInteger
} = require('../../src/runtime/datetime');
const { createClock } = require('../../src/runtime/clock');
const { JsonataEvaluationError } = require('../../src/errors');
const j2js = require('../../src');

describe('runtime/datetime', () => {
  describe('fn_fromMillis / fn_toMillis round-trips', () => {
    it('round-trips a millis value through default ISO 8601 formatting', () => {
      const millis = 1521801216617;
      const iso = fn_fromMillis(millis);
      assert.strictEqual(iso, '2018-03-23T10:33:36.617Z');
      assert.strictEqual(fn_toMillis(iso), millis);
    });

    it('returns undefined for undefined input on both directions', () => {
      assert.strictEqual(fn_fromMillis(undefined, 'picture'), undefined);
      assert.strictEqual(fn_toMillis(undefined, 'picture'), undefined);
    });

    it('throws D3110 when toMillis is given a non ISO-8601 string with no picture', () => {
      assert.throws(() => fn_toMillis('not-a-date'), (err) => {
        assert.ok(err instanceof JsonataEvaluationError);
        assert.strictEqual(err.code, 'D3110');
        assert.strictEqual(err.value, 'not-a-date');
        assert.match(err.message, /ISO 8601/);
        return true;
      });
    });

    it('formats with a custom picture string and round-trips back via the same picture', () => {
      const picture = '[Y0001]-[M01]-[D01]';
      const formatted = fn_fromMillis(1521801216617, picture);
      assert.strictEqual(formatted, '2018-03-23');
      assert.strictEqual(fn_toMillis(formatted, picture), Date.parse('2018-03-23T00:00:00.000Z'));
    });
  });

  describe('fn_formatInteger — real test-suite cases (test-suite/groups/function-formatInteger/formatInteger.json)', () => {
    it('formats Roman numerals, upper and lower case', () => {
      assert.strictEqual(fn_formatInteger(1984, 'I'), 'MCMLXXXIV');
      assert.strictEqual(fn_formatInteger(99, 'i'), 'xcix');
      assert.strictEqual(fn_formatInteger(0, 'I'), '');
    });

    it('spells out cardinal words, including title case', () => {
      assert.strictEqual(fn_formatInteger(555, 'W'), 'FIVE HUNDRED AND FIFTY-FIVE');
      assert.strictEqual(fn_formatInteger(555, 'Ww'), 'Five Hundred and Fifty-Five');
      assert.strictEqual(fn_formatInteger(1000000000001, 'w'), 'one trillion and one');
    });

    it('spells out ordinal words', () => {
      assert.strictEqual(fn_formatInteger(12, 'w;o'), 'twelfth');
    });

    it('formats plain decimal patterns with zero-padding and negative sign', () => {
      assert.strictEqual(fn_formatInteger(123, '0000'), '0123');
      assert.strictEqual(fn_formatInteger(-3, '0000'), '-0003');
    });
  });

  describe('fn_parseInteger — real test-suite cases (test-suite/groups/function-parseInteger/parseInteger.json)', () => {
    it('parses Roman numerals', () => {
      assert.strictEqual(fn_parseInteger('MCMLXXXIV', 'I'), 1984);
      assert.strictEqual(fn_parseInteger('xcix', 'i'), 99);
    });

    it('parses spelled-out cardinal words, including large magnitudes', () => {
      assert.strictEqual(fn_parseInteger('twelve', 'w'), 12);
      assert.strictEqual(fn_parseInteger('one trillion and one', 'w'), 1000000000001);
    });

    it('parses grouped decimal digits regardless of grouping-separator regularity', () => {
      assert.strictEqual(fn_parseInteger('1,234,567,890', '#,##0'), 1234567890);
      assert.strictEqual(fn_parseInteger('12345,67,890', '##,##,##0'), 1234567890);
    });

    it('returns undefined for undefined input', () => {
      assert.strictEqual(fn_parseInteger(undefined, '0'), undefined);
    });
  });

  describe('real test-suite cases from function-tomillis/parseDateTime.json', () => {
    it('parses a year-only picture', () => {
      assert.strictEqual(fn_toMillis('2018', '[Y1]'), 1514764800000);
    });

    it('parses year/month/day', () => {
      assert.strictEqual(fn_toMillis('2018-03-27', '[Y1]-[M01]-[D01]'), 1522108800000);
    });

    it('parses ordinal-day numeric dates', () => {
      assert.strictEqual(fn_toMillis('27th 3 1976', '[D1o] [M#1] [Y0001]'), 196732800000);
    });

    it('parses Roman-numeral years mixed with numeric day/month', () => {
      assert.strictEqual(fn_toMillis('27 03 MMXVIII', '[D1] [M01] [YI]'), 1522108800000);
    });
  });

  describe('real test-suite cases from function-fromMillis/formatDateTime.json', () => {
    it('formats a literal-only picture', () => {
      assert.strictEqual(fn_fromMillis(1521801216617, 'Hello'), 'Hello');
    });

    it('formats the year with a grouping separator', () => {
      assert.strictEqual(fn_fromMillis(1521801216617, 'Year: <[Y9,999,*]>'), 'Year: <2,018>');
    });

    it('handles doubled square-bracket literals', () => {
      assert.strictEqual(fn_fromMillis(1521801216617, '[[Year]]: [[[Y0001]]]'), '[Year]: [2018]');
    });

    it('formats day-of-week names, with Sunday as day 7', () => {
      assert.strictEqual(fn_fromMillis(1522616700000, '[F0] [FNn]'), '7 Sunday');
      assert.strictEqual(fn_fromMillis(1522703100000, '[F0] [FNn]'), '1 Monday');
    });
  });
});

describe('runtime/clock', () => {
  it('createClock().millis() returns the identical value on repeated calls', () => {
    const clock = createClock();
    const first = clock.millis();
    const second = clock.millis();
    assert.strictEqual(first, second);
    assert.strictEqual(typeof first, 'number');
  });

  it('two separate createClock() calls are independent snapshots (each internally stable)', () => {
    const clockA = createClock();
    assert.strictEqual(clockA.millis(), clockA.millis());
    // Force the wall clock to actually advance at least one tick before
    // taking the second snapshot, so this genuinely tests independence
    // (a shared/global clock would fail this) rather than re-asserting
    // clockA's own internal stability a second time.
    const start = Date.now();
    while (Date.now() === start) { /* spin for one tick */ }
    const clockB = createClock();
    assert.strictEqual(clockB.millis(), clockB.millis());
    assert.ok(clockB.millis() > clockA.millis(), 'a later createClock() must observe a later snapshot');
  });

  it('now() formats the same fixed snapshot as millis()', () => {
    const clock = createClock();
    assert.strictEqual(fn_toMillis(clock.now()), clock.millis());
  });
});

// The builtin registry is built ONCE per process and shared as the prototype
// terminus of every evaluation's ENV chain (src/index.js `BUILTINS`), so
// `$now`/`$millis` must resolve the *active* evaluation's pushed snapshot at
// call time rather than one captured when the registry was built. These tests
// fail if a registry-level clock is ever re-introduced.
describe('$now/$millis through the shared builtin registry', () => {
  it('every call site within one evaluate() sees one fixed snapshot', () => {
    const expr = j2js.compile('{ "a": $millis(), "b": $millis(), "c": $toMillis($now()) }');
    const r = expr.evaluate({});
    assert.strictEqual(r.a, r.b);
    assert.strictEqual(r.c, r.a);
  });

  it('a later evaluate() of the same compiled expression observes a later snapshot', () => {
    const expr = j2js.compile('$millis()');
    const first = expr.evaluate({});
    const start = Date.now();
    while (Date.now() === start) { /* spin for one tick */ }
    const second = expr.evaluate({});
    assert.ok(second > first, `expected a fresh snapshot per evaluate(), got ${first} then ${second}`);
  });

  it('an $eval-ed inner expression shares the outer evaluation snapshot', () => {
    const expr = j2js.compile('$eval("$millis()") = $millis()');
    assert.strictEqual(expr.evaluate({}), true);
  });
});
