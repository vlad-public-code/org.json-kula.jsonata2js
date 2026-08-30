'use strict';

/**
 * `$length`/`$substring` are code-point based, which the straightforward
 * implementation achieves by materializing the string as an array of
 * single-character strings — one allocation per character, on every call. A
 * string with no surrogate code unit has one UTF-16 unit per code point, so
 * `.length`/`.slice` are already code-point correct there (measured: 9,210 ms
 * -> 5.7 ms per 200k calls on a 1,800-character ASCII string).
 *
 * These tests are differential against the array implementation over inputs
 * either side of that guard: pure ASCII, astral characters (surrogate pairs),
 * lone surrogates, combining marks, and every out-of-range index case.
 */

const assert = require('assert');
const { fn_length, fn_substring, fn_pad, stringToArray } = require('../../src/runtime/string');
const j2js = require('../../src/index');

/** The pre-fast-path implementations, kept as oracles. */
function referenceLength(str) {
  if (str === undefined) return undefined;
  return stringToArray(str).length;
}
function referenceSubstring(str, start, length) {
  if (str === undefined) return undefined;
  const strArray = stringToArray(str);
  const strLength = strArray.length;
  if (strLength + start < 0) start = 0;
  if (length !== undefined) {
    if (length <= 0) return '';
    const end = start >= 0 ? start + length : strLength + start + length;
    return strArray.slice(start, end).join('');
  }
  return strArray.slice(start).join('');
}

const STRINGS = [
  '', 'a', 'plain ascii text', 'The quick brown fox. '.repeat(5),
  'tab\tnewline\n', 'quote"backslash\\',
  '😀', 'a😀b', '😀😀😀', 'x😀y😀z',
  'e\u0301', 'e\u0301\u0301',            // combining marks (2 code points)
  '\uD800', 'a\uDC00b',                  // lone surrogates
  '中文字', 'ключ', 'עברית',
];
const INDEXES = [-20, -5, -2, -1, 0, 1, 2, 3, 5, 20];
const LENGTHS = [undefined, -5, -1, 0, 1, 2, 3, 5, 20];

describe('string code-point fast paths', () => {
  it('$length matches the array implementation for every input', () => {
    for (const s of STRINGS) {
      assert.strictEqual(fn_length(s), referenceLength(s), `length diverged for ${JSON.stringify(s)}`);
    }
    assert.strictEqual(fn_length(undefined), undefined);
  });

  it('$substring matches the array implementation across every index/length', () => {
    for (const s of STRINGS) {
      for (const start of INDEXES) {
        for (const len of LENGTHS) {
          assert.strictEqual(
            fn_substring(s, start, len),
            referenceSubstring(s, start, len),
            `substring diverged for ${JSON.stringify(s)} start=${start} len=${len}`
          );
        }
      }
    }
    assert.strictEqual(fn_substring(undefined, 0, 1), undefined);
  });

  it('$pad still counts code points (it is built on $length/$substring)', () => {
    assert.strictEqual(fn_pad('😀', 3, '-'), '😀--');
    assert.strictEqual(fn_pad('😀', -3, '-'), '--😀');
    assert.strictEqual(fn_pad('abc', 2, '-'), 'abc');
    assert.strictEqual(fn_pad('a', 4, '😀'), 'a😀😀😀');
  });

  it('keeps end-to-end semantics through the compiler', () => {
    const ev = (expr) => j2js.compile(expr).evaluate();
    assert.strictEqual(ev('$length("hello")'), 5);
    assert.strictEqual(ev('$length("a😀b")'), 3);
    assert.strictEqual(ev('$substring("hello world", 6)'), 'world');
    assert.strictEqual(ev('$substring("a😀b", 1, 1)'), '😀');
    assert.strictEqual(ev('$substring("hello", -3, 2)'), 'll');
    assert.strictEqual(ev('$substring("hello", 2, 0)'), '');
  });
});
