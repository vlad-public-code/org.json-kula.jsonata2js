'use strict';

const assert = require('assert');
const s = require('../../src/runtime/string');
const n = require('../../src/runtime/numeric');
const c = require('../../src/runtime/core');
const cd = require('../../src/runtime/codec');

describe('runtime/string', () => {
  it('fn_string', () => {
    assert.strictEqual(s.fn_string(5), '5');
    assert.strictEqual(s.fn_string(5.5), '5.5');
    assert.strictEqual(s.fn_string('foo'), 'foo');
    assert.strictEqual(s.fn_string(undefined), undefined);
    assert.strictEqual(s.fn_string(true), 'true');
    assert.strictEqual(s.fn_string([1, 2]), '[1,2]');
  });
  it('fn_string throws D3001 on Infinity/NaN', () => {
    assert.throws(() => s.fn_string(Infinity), (e) => e.code === 'D3001');
    assert.throws(() => s.fn_string(-Infinity), (e) => e.code === 'D3001');
    assert.throws(() => s.fn_string(NaN), (e) => e.code === 'D3001');
  });
  it('fn_substring', () => {
    assert.strictEqual(s.fn_substring('hello', 1, 3), 'ell');
    assert.strictEqual(s.fn_substring('hello', -3), 'llo');
  });
  it('fn_substringBefore / fn_substringAfter', () => {
    assert.strictEqual(s.fn_substringBefore('foo.bar.baz', '.'), 'foo');
    assert.strictEqual(s.fn_substringAfter('foo.bar.baz', '.'), 'bar.baz');
  });
  it('fn_uppercase / fn_lowercase', () => {
    assert.strictEqual(s.fn_uppercase('foo'), 'FOO');
    assert.strictEqual(s.fn_lowercase('FOO'), 'foo');
  });
  it('fn_length', () => {
    assert.strictEqual(s.fn_length('hello'), 5);
  });
  it('fn_trim collapses internal whitespace and strips ends', () => {
    assert.strictEqual(s.fn_trim('  a   b  '), 'a b');
  });
  it('fn_pad', () => {
    assert.strictEqual(s.fn_pad('foo', 5), 'foo  ');
    assert.strictEqual(s.fn_pad('foo', -5), '  foo');
    assert.strictEqual(s.fn_pad('1', 2, '0'), '10');
  });
  it('fn_join', () => {
    assert.strictEqual(s.fn_join(['a', 'b', 'c'], '-'), 'a-b-c');
    assert.strictEqual(s.fn_join(['a', 'b']), 'ab');
  });
  it('fn_contains / fn_split plain-string overloads', () => {
    assert.strictEqual(s.fn_contains('hello world', 'wor'), true);
    assert.deepStrictEqual(s.fn_split('a,b,c', ','), ['a', 'b', 'c']);
    assert.deepStrictEqual(s.fn_split('a,b,c', ',', 2), ['a', 'b']);
  });
});

describe('runtime/numeric', () => {
  it('fn_number', () => {
    assert.strictEqual(n.fn_number('5'), 5);
    assert.strictEqual(n.fn_number(true), 1);
    assert.strictEqual(n.fn_number(false), 0);
  });
  it('fn_number throws D3030 on unparsable string', () => {
    assert.throws(() => n.fn_number('not a number'), (e) => e.code === 'D3030');
  });
  it('fn_abs / fn_floor / fn_ceil', () => {
    assert.strictEqual(n.fn_abs(-5), 5);
    assert.strictEqual(n.fn_floor(1.9), 1);
    assert.strictEqual(n.fn_ceil(1.1), 2);
  });
  it('fn_round uses round-half-to-even', () => {
    assert.strictEqual(n.fn_round(2.5), 2);
    assert.strictEqual(n.fn_round(3.5), 4);
    assert.strictEqual(n.fn_round(-0.5), 0);
  });
  it('fn_sqrt throws D3060 on negative', () => {
    assert.throws(() => n.fn_sqrt(-4), (e) => e.code === 'D3060');
    assert.strictEqual(n.fn_sqrt(4), 2);
  });
  it('fn_power throws D3061 on non-finite result', () => {
    assert.throws(() => n.fn_power(10, 1000), (e) => e.code === 'D3061');
    assert.strictEqual(n.fn_power(2, 10), 1024);
  });
  it('fn_formatBase', () => {
    assert.strictEqual(n.fn_formatBase(100, 2), '1100100');
    assert.strictEqual(n.fn_formatBase(255, 16), 'ff');
  });
  it('fn_formatBase throws D3100 on bad radix', () => {
    assert.throws(() => n.fn_formatBase(10, 1), (e) => e.code === 'D3100');
  });
  it('fn_formatNumber basic picture', () => {
    assert.strictEqual(n.fn_formatNumber(12345.6, '#,###.00'), '12,345.60');
  });
});

describe('runtime/core', () => {
  it('fn_boolean matches jsonata truthy rules and undefined passthrough', () => {
    assert.strictEqual(c.fn_boolean(undefined), undefined);
    assert.strictEqual(c.fn_boolean(0), false);
    assert.strictEqual(c.fn_boolean(1), true);
    assert.strictEqual(c.fn_boolean([]), false);
    assert.strictEqual(c.fn_boolean(''), false);
  });
  it('fn_not', () => {
    assert.strictEqual(c.fn_not(true), false);
    assert.strictEqual(c.fn_not(false), true);
  });
  it('fn_exists never propagates missing', () => {
    assert.strictEqual(c.fn_exists(undefined), false);
    assert.strictEqual(c.fn_exists(null), true);
  });
  it('fn_type', () => {
    assert.strictEqual(c.fn_type(5), 'number');
    assert.strictEqual(c.fn_type('x'), 'string');
    assert.strictEqual(c.fn_type(true), 'boolean');
    assert.strictEqual(c.fn_type(null), 'null');
    assert.strictEqual(c.fn_type([1]), 'array');
    assert.strictEqual(c.fn_type({}), 'object');
  });
  it('fn_error throws D3137', () => {
    assert.throws(() => c.fn_error('boom'), (e) => e.code === 'D3137');
    try {
      c.fn_error('boom');
    } catch (e) {
      assert.strictEqual(e.message, 'boom');
    }
  });
  it('fn_assert throws D3141 on falsy condition', () => {
    assert.throws(() => c.fn_assert(false, 'nope'), (e) => e.code === 'D3141');
    assert.doesNotThrow(() => c.fn_assert(true, 'nope'));
  });
  it('fn_clone deep-copies', () => {
    const obj = { a: [1, 2, { b: 3 }] };
    const clone = c.fn_clone(obj);
    assert.deepStrictEqual(clone, obj);
    assert.notStrictEqual(clone, obj);
    assert.notStrictEqual(clone.a, obj.a);
  });
});

describe('runtime/codec', () => {
  it('base64 round-trip', () => {
    assert.strictEqual(cd.fn_base64encode('hello'), 'aGVsbG8=');
    assert.strictEqual(cd.fn_base64decode('aGVsbG8='), 'hello');
  });
  it('url encode/decode round-trip', () => {
    const s2 = 'a b/c?d=e';
    assert.strictEqual(cd.fn_decodeUrlComponent(cd.fn_encodeUrlComponent(s2)), s2);
    assert.strictEqual(cd.fn_decodeUrl(cd.fn_encodeUrl(s2)), s2);
  });
  it('fn_decodeUrlComponent throws D3140 on malformed input', () => {
    assert.throws(() => cd.fn_decodeUrlComponent('%'), (e) => e.code === 'D3140');
  });
});
