'use strict';

const assert = require('assert');
const { fn_match, fn_contains, fn_replace, fn_split } = require('../../src/runtime/regex');
const { fn_reverse, fn_shuffle, fn_zip, fn_merge } = require('../../src/runtime/collections');
const { compileRegexLiteral } = require('../../src/runtime/function-value');

// Vendored regex-form test-suite cases translated into direct function calls
// (no parser/evaluator exists yet to run the `expr` strings themselves).
// See test/test-suite/groups/regex/*.json and
// test/test-suite/groups/function-{replace,split}/*.json.

describe('runtime/regex.js', () => {
  describe('fn_split (regex form)', () => {
    it('splits on every match (case000: $split("ababbxabbcc",/b+/))', () => {
      const result = fn_split('ababbxabbcc', compileRegexLiteral('b+'));
      assert.deepStrictEqual(result, ['a', 'a', 'xa', 'cc']);
    });

    it('honors limit (case001: $split("ababbxabbcc",/b+/,2))', () => {
      const result = fn_split('ababbxabbcc', compileRegexLiteral('b+'), 2);
      assert.deepStrictEqual(result, ['a', 'a']);
    });

    it('D3020 on negative limit (function-split/case011,013 pattern, regex form)', () => {
      assert.throws(() => fn_split('a, b, c, d', compileRegexLiteral(', '), -3), (err) => err.code === 'D3020');
    });
  });

  describe('fn_replace (regex form)', () => {
    it('leaves string unchanged when pattern never matches (case010)', () => {
      assert.strictEqual(fn_replace('ababbxabbcc', compileRegexLiteral('d+'), 'yy'), 'ababbxabbcc');
    });

    it('treats $<non-digit> as literal when there are no capture groups to index (case013)', () => {
      assert.strictEqual(fn_replace('265USD', compileRegexLiteral('([0-9]+)USD'), '$w'), '$w');
    });

    it('removes matched substrings for empty replacement (case020)', () => {
      assert.strictEqual(fn_replace('abracadabra', compileRegexLiteral('a'), ''), 'brcdbr');
    });

    it('replaces with literal $-prefixed text when no matching group index (case030)', () => {
      assert.strictEqual(fn_replace('abcdefghijklmno', compileRegexLiteral('ijk'), '$x'), 'abcdefgh$xlmno');
    });

    it('D1004 when the pattern can zero-length-match without progressing (case022)', () => {
      assert.throws(() => fn_replace('abracadabra', compileRegexLiteral('.*?'), '$1'), (err) => err.code === 'D1004');
    });

    it('expands $N backreferences from capture groups', () => {
      assert.strictEqual(fn_replace('265USD', compileRegexLiteral('([0-9]+)USD'), '$1 dollars'), '265 dollars');
    });

    it('invokes a function replacement value per match with {match,start,end,groups,next} (case034 shape)', () => {
      const result = fn_replace(
        'temperature = 68F today',
        compileRegexLiteral('(-?\\d+(?:\\.\\d*)?)F\\b'),
        ($m) => String(((Number($m.groups[0]) - 32) * 5) / 9) + 'C'
      );
      assert.strictEqual(result, 'temperature = 20C today');
    });

    it('function replacement can read $match.match (case033 style)', () => {
      const result = fn_replace('bobble hat', compileRegexLiteral('(h)(at)', 'i'), ($m) => $m.match.toUpperCase());
      assert.strictEqual(result, 'bobble HAT');
    });

    it('D3012 when a function replacement returns a non-string (case035/036)', () => {
      assert.throws(
        () => fn_replace('bobble hat', compileRegexLiteral('hat', 'i'), () => true),
        (err) => err.code === 'D3012'
      );
      assert.throws(
        () => fn_replace('bobble hat', compileRegexLiteral('hat', 'i'), () => 42),
        (err) => err.code === 'D3012'
      );
    });

    it('D3011 on negative limit (function-replace/case007 pattern, regex form)', () => {
      assert.throws(() => fn_replace('hello', compileRegexLiteral('l'), '1', -2), (err) => err.code === 'D3011');
    });

    it('returns the original string unchanged when limit is 0', () => {
      assert.strictEqual(fn_replace('abracadabra', compileRegexLiteral('a'), '', 0), 'abracadabra');
    });
  });

  describe('fn_match (regex form)', () => {
    it('collapses a single match to a bare {match,index,groups} object, not a one-element array (matches real jsonata sequence semantics)', () => {
      const result = fn_match('Felicia Saunders', compileRegexLiteral('^(\\w*\\s\\w*)'));
      assert.deepStrictEqual(result, { match: 'Felicia Saunders', index: 0, groups: ['Felicia Saunders'] });
    });

    it('returns undefined (not an empty array) when there is no match', () => {
      assert.strictEqual(fn_match('no match here', compileRegexLiteral('xyz')), undefined);
    });

    it('honors limit across repeated matches', () => {
      const result = fn_match('ababbxabbcc', compileRegexLiteral('b+'));
      assert.deepStrictEqual(
        result.map((m) => m.match),
        ['b', 'bb', 'bb']
      );
      const limited = fn_match('ababbxabbcc', compileRegexLiteral('b+'), 2);
      assert.strictEqual(limited.length, 2);
    });

    it('D3040 on negative limit', () => {
      assert.throws(() => fn_match('aaa', compileRegexLiteral('a'), -1), (err) => err.code === 'D3040');
    });

    it('returns undefined for undefined input string', () => {
      assert.strictEqual(fn_match(undefined, compileRegexLiteral('a')), undefined);
    });
  });

  describe('fn_contains (regex form)', () => {
    it('true when the pattern matches anywhere in the string (case005 style)', () => {
      assert.strictEqual(fn_contains('Bobble Hat', compileRegexLiteral('hat', 'i')), true);
    });

    it('false when the pattern does not match', () => {
      assert.strictEqual(fn_contains('bobble', compileRegexLiteral('hat')), false);
    });

    it('returns undefined when either input is undefined', () => {
      assert.strictEqual(fn_contains(undefined, compileRegexLiteral('a')), undefined);
      assert.strictEqual(fn_contains('a', undefined), undefined);
    });
  });
});

describe('runtime/collections.js', () => {
  describe('fn_reverse', () => {
    it('reverses element order', () => {
      assert.deepStrictEqual(fn_reverse([1, 2, 3]), [3, 2, 1]);
    });

    it('returns the same array reference for length <= 1', () => {
      const single = [1];
      assert.strictEqual(fn_reverse(single), single);
      const empty = [];
      assert.strictEqual(fn_reverse(empty), empty);
    });

    it('passes through undefined', () => {
      assert.strictEqual(fn_reverse(undefined), undefined);
    });
  });

  describe('fn_shuffle', () => {
    it('returns an array with the same length and multiset of elements', () => {
      const input = [1, 2, 3, 4, 5, 6, 7, 8];
      const result = fn_shuffle(input);
      assert.strictEqual(result.length, input.length);
      assert.deepStrictEqual([...result].sort((a, b) => a - b), input);
    });

    it('actually permutes the input (not a no-op) across repeated calls', () => {
      // A single shuffle landing back on the identity order is possible
      // (if unlikely), so assert over many independent calls instead of
      // one - this fails hard for a no-op `arr => arr` stub while staying
      // effectively non-flaky for a real shuffle (P(50 consecutive
      // identity results by chance) is astronomically small).
      const input = [1, 2, 3, 4, 5, 6, 7, 8];
      let sawDifferentOrder = false;
      for (let i = 0; i < 50 && !sawDifferentOrder; i++) {
        const result = fn_shuffle(input);
        sawDifferentOrder = result.some((v, idx) => v !== input[idx]);
      }
      assert.ok(sawDifferentOrder, 'fn_shuffle never produced a different order across 50 calls');
    });

    it('returns the same array reference for length <= 1', () => {
      const single = ['only'];
      assert.strictEqual(fn_shuffle(single), single);
    });

    it('passes through undefined', () => {
      assert.strictEqual(fn_shuffle(undefined), undefined);
    });
  });

  describe('fn_zip', () => {
    it('convolves values from each array into tuples', () => {
      assert.deepStrictEqual(fn_zip([1, 2, 3], [4, 5, 6]), [
        [1, 4],
        [2, 5],
        [3, 6],
      ]);
    });

    it('truncates to the shortest input array length', () => {
      assert.deepStrictEqual(fn_zip([1, 2, 3], ['a', 'b']), [
        [1, 'a'],
        [2, 'b'],
      ]);
    });

    it('supports more than two input arrays', () => {
      assert.deepStrictEqual(fn_zip([1, 2], [3, 4], [5, 6]), [
        [1, 3, 5],
        [2, 4, 6],
      ]);
    });
  });

  describe('fn_merge', () => {
    it('shallow-merges objects left to right, later keys winning', () => {
      // fn_merge returns Object.create(null) (reference-jsonata parity -
      // see CODE-REVIEW.md H5); normalize before comparing content.
      assert.deepStrictEqual(Object.assign({}, fn_merge([{ a: 1, b: 2 }, { b: 3, c: 4 }])), { a: 1, b: 3, c: 4 });
    });

    it('returns undefined for undefined input', () => {
      assert.strictEqual(fn_merge(undefined), undefined);
    });

    it('returns an empty object for an empty array', () => {
      assert.deepStrictEqual(Object.assign({}, fn_merge([])), {});
    });
  });
});
