'use strict';

/**
 * Algorithmic rewrites in the runtime, each of which replaced a naive
 * implementation whose cost was quadratic or doubled:
 *
 *   `H.distinctArr`      O(n²) `deepEqual` scan -> `Set` + hash buckets
 *   `RT.structuralHash`  the bucket key; must never disagree with `deepEqual`
 *   `H.sortArr`          two comparator calls per comparison -> merge sort
 *   `STRUCT.sortValues`  value-mode twin of `sortTuples` (terminal `^()`)
 *   `STRUCT.groupByValues` value-mode twin of `groupBy` (binding-free `{}`)
 *
 * The tests below pin the observable behaviour each rewrite had to preserve:
 * first-occurrence order, `NaN`'s never-equal-to-itself treatment, key-order
 * insensitivity, sort stability, `undefined`-sorts-last, and the T2007/T2008
 * comparison errors.
 */

const assert = require('assert');
const H = require('../../src/runtime/hof');
const RT = require('../../src/runtime/values');
const STRUCT = require('../../src/runtime/structural');
const j2js = require('../../src/index');

describe('runtime: $distinct', () => {
  it('keeps first occurrences in order for primitives', () => {
    assert.deepStrictEqual(H.distinctArr([3, 1, 3, 2, 1, 'a', 'a', true, true, null, null]),
      [3, 1, 2, 'a', true, null]);
  });

  it('does not conflate values of different types', () => {
    assert.deepStrictEqual(H.distinctArr([1, '1', true, 'true', 0, false, null]),
      [1, '1', true, 'true', 0, false, null]);
  });

  it('treats NaN as never equal to itself (matching deepEqual)', () => {
    const out = H.distinctArr([NaN, NaN, 1, NaN]);
    assert.strictEqual(out.length, 4);
    assert.ok(Number.isNaN(out[0]) && Number.isNaN(out[1]) && Number.isNaN(out[3]));
    assert.strictEqual(out[2], 1);
  });

  it('deduplicates composite values regardless of key order or nesting', () => {
    const a = { x: 1, y: [1, 2] };
    const b = { y: [1, 2], x: 1 };   // deepEqual to `a`
    const c = { x: 1, y: [2, 1] };   // not equal
    assert.deepStrictEqual(H.distinctArr([a, b, c, a]), [a, c]);
    assert.deepStrictEqual(H.distinctArr([[1, [2]], [1, [2]], [1, [3]]]), [[1, [2]], [1, [3]]]);
  });

  it('agrees with a reference O(n²) implementation on mixed data', () => {
    const reference = (arr) => {
      const out = [];
      for (const v of arr) if (!out.some((e) => RT.deepEqual(e, v))) out.push(v);
      return out;
    };
    let seed = 7;
    const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let round = 0; round < 200; round++) {
      const arr = Array.from({ length: 40 }, () => {
        const r = next();
        if (r < 0.3) return Math.floor(next() * 5);
        if (r < 0.5) return `s${Math.floor(next() * 5)}`;
        if (r < 0.6) return next() < 0.5;
        if (r < 0.7) return null;
        if (r < 0.85) return { k: Math.floor(next() * 3), n: { d: Math.floor(next() * 2) } };
        return [Math.floor(next() * 3), Math.floor(next() * 3)];
      });
      assert.deepStrictEqual(H.distinctArr(arr), reference(arr));
    }
  });

  it('passes non-arrays and missing input through', () => {
    assert.strictEqual(H.distinctArr(undefined), undefined);
    assert.strictEqual(H.distinctArr(5), 5);
  });
});

describe('runtime: structuralHash', () => {
  it('gives equal hashes to deepEqual values', () => {
    const pairs = [
      [1, 1], [0, -0], ['a', 'a'], [null, null], [true, true],
      [{ a: 1, b: 2 }, { b: 2, a: 1 }],
      [[1, { x: [2] }], [1, { x: [2] }]],
      [{}, {}], [[], []],
    ];
    for (const [a, b] of pairs) {
      assert.ok(RT.deepEqual(a, b), `${JSON.stringify(a)} should be deepEqual to ${JSON.stringify(b)}`);
      assert.strictEqual(RT.structuralHash(a), RT.structuralHash(b),
        `hash mismatch for ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    }
  });

  it('distinguishes value types that are not deepEqual', () => {
    const distinct = [1, '1', true, 'true', null, {}, [], { a: 1 }, [1], { a: 2 }, [2]];
    const hashes = distinct.map(RT.structuralHash);
    assert.strictEqual(new Set(hashes).size, distinct.length);
  });
});

describe('runtime: $sort', () => {
  it('is stable and follows the "truthy means a sorts after b" convention', () => {
    const items = [
      { k: 2, id: 'a' }, { k: 1, id: 'b' }, { k: 2, id: 'c' },
      { k: 1, id: 'd' }, { k: 3, id: 'e' }, { k: 1, id: 'f' },
    ];
    const sorted = H.sortArr(items, (a, b) => a.k > b.k);
    assert.deepStrictEqual(sorted.map((x) => x.id), ['b', 'd', 'f', 'a', 'c', 'e']);
  });

  it('sorts descending when the comparator is inverted, still stably', () => {
    const items = [{ k: 1, id: 'a' }, { k: 2, id: 'b' }, { k: 1, id: 'c' }];
    assert.deepStrictEqual(H.sortArr(items, (a, b) => a.k < b.k).map((x) => x.id), ['b', 'a', 'c']);
  });

  it('handles the sizes that exercise every merge width', () => {
    for (const n of [0, 1, 2, 3, 5, 8, 9, 16, 17, 33]) {
      const input = Array.from({ length: n }, (_, i) => (i * 7) % n || 0);
      const sorted = H.sortArr(input, (a, b) => a > b);
      assert.deepStrictEqual(sorted, input.slice().sort((x, y) => x - y), `n=${n}`);
    }
  });

  it('calls the comparator once per comparison', () => {
    let calls = 0;
    const input = Array.from({ length: 64 }, (_, i) => (i * 13) % 64);
    H.sortArr(input, (a, b) => { calls++; return a > b; });
    // n log2 n = 384 for n=64; the old two-call form needed up to twice that.
    assert.ok(calls <= 64 * 6, `expected <= 384 comparator calls, got ${calls}`);
  });

  it('leaves non-array and missing input alone', () => {
    assert.strictEqual(H.sortArr(undefined, () => true), undefined);
    assert.deepStrictEqual(H.sortArr(5, () => true), [5]);
  });
});

describe('runtime: sortValues (value-mode ^())', () => {
  const asTuples = (values) => values.map((v) => ({ v, p: undefined, b: undefined }));
  const keys = [{ key: ($) => ($ === null ? undefined : $.k), desc: false }];

  it('matches sortTuples on ordering, ties and undefined keys', () => {
    const values = [{ k: 2 }, { k: 1 }, { k: 2 }, {}, { k: 0 }, {}];
    const viaValues = STRUCT.sortValues(values, keys);
    const viaTuples = STRUCT.sortTuples(asTuples(values), keys).map((t) => t.v);
    assert.deepStrictEqual(viaValues, viaTuples);
    assert.deepStrictEqual(viaValues.map((v) => v.k), [0, 1, 2, 2, undefined, undefined]);
  });

  it('matches sortTuples for a descending multi-key sort', () => {
    const values = [{ k: 1, j: 'b' }, { k: 1, j: 'a' }, { k: 2, j: 'a' }];
    const multi = [{ key: ($) => $.k, desc: true }, { key: ($) => $.j, desc: false }];
    assert.deepStrictEqual(
      STRUCT.sortValues(values, multi),
      STRUCT.sortTuples(asTuples(values), multi).map((t) => t.v)
    );
  });

  it('raises the same comparison errors as sortTuples', () => {
    const bad = [{ k: 1 }, { k: 'x' }];
    assert.throws(() => STRUCT.sortValues(bad, keys), (e) => e.code === 'T2007');
    assert.throws(() => STRUCT.sortTuples(asTuples(bad), keys), (e) => e.code === 'T2007');
    const worse = [{ k: {} }, { k: {} }];
    assert.throws(() => STRUCT.sortValues(worse, keys), (e) => e.code === 'T2008');
  });

  it('evaluates no key expression for a 0/1-element sort', () => {
    let calls = 0;
    const counting = [{ key: () => { calls++; return 1; }, desc: false }];
    STRUCT.sortValues([], counting);
    STRUCT.sortValues([{ k: 1 }], counting);
    assert.strictEqual(calls, 0);
  });

  it('keeps end-to-end ^() semantics, including with a following stage', () => {
    const data = { p: [{ n: 'c', v: 3 }, { n: 'a', v: 1 }, { n: 'b', v: 2 }] };
    assert.deepStrictEqual(j2js.compile('p^(v).n').evaluate(data), ['a', 'b', 'c']);
    assert.deepStrictEqual(j2js.compile('p^(>v).n').evaluate(data), ['c', 'b', 'a']);
    assert.strictEqual(j2js.compile('(p^(v))[0].n').evaluate(data), 'a');
    // A subscript after a sort applies once across the whole sorted sequence
    // (verified against the reference interpreter), not per source parent.
    const nested = { o: [{ p: [{ v: 2 }, { v: 1 }] }, { p: [{ v: 4 }, { v: 3 }] }] };
    assert.deepStrictEqual(j2js.compile('o.p^(v).v').evaluate(nested), [1, 2, 3, 4]);
    assert.strictEqual(j2js.compile('o.p^(v)[0].v').evaluate(nested), 1);
  });
});

describe('runtime: groupByValues (value-mode {})', () => {
  const asTuples = (values) => values.map((v) => ({ v, p: undefined, b: undefined }));
  const pairs = [{
    keyFn: ($) => ($ === undefined ? undefined : $.k),
    valueFn: ($) => (Array.isArray($) ? $.length : 1),
  }];

  it('matches groupBy on bucketing, ordering and the empty stream', () => {
    for (const values of [
      [],
      [{ k: 'a' }],
      [{ k: 'a' }, { k: 'b' }, { k: 'a' }],
      [{ k: 'b' }, { k: 'b' }, { k: 'b' }],
      [{}, { k: 'a' }],                      // missing key is skipped
    ]) {
      assert.deepStrictEqual(
        Object.entries(STRUCT.groupByValues(values, pairs)),
        Object.entries(STRUCT.groupBy(asTuples(values), pairs)),
        `groupByValues diverged for ${JSON.stringify(values)}`
      );
    }
  });

  it('raises the same key errors as groupBy', () => {
    const numericKey = [{ keyFn: () => 5, valueFn: () => 1 }];
    assert.throws(() => STRUCT.groupByValues([{ k: 1 }], numericKey), (e) => e.code === 'T1003');
    assert.throws(() => STRUCT.groupBy(asTuples([{ k: 1 }]), numericKey), (e) => e.code === 'T1003');
    const twoPairs = [
      { keyFn: () => 'dup', valueFn: () => 1 },
      { keyFn: () => 'dup', valueFn: () => 2 },
    ];
    assert.throws(() => STRUCT.groupByValues([{}], twoPairs), (e) => e.code === 'D1009');
    assert.throws(() => STRUCT.groupBy(asTuples([{}]), twoPairs), (e) => e.code === 'D1009');
  });

  it('keeps end-to-end `{}` semantics, including the tuple-mode cases', () => {
    const data = { o: [{ c: 'x', n: 1 }, { c: 'y', n: 2 }, { c: 'x', n: 3 }] };
    const ev = (expr, input = data) => j2js.compile(expr).evaluate(input);
    assert.deepStrictEqual({ ...ev('o{c: $sum(n)}') }, { x: 4, y: 2 });
    assert.deepStrictEqual({ ...ev('o{c: $count($)}') }, { x: 2, y: 1 });
    assert.deepStrictEqual({ ...ev('o{c: {"n": $count($), "t": $sum(n)}}').x }, { n: 2, t: 4 });
    assert.deepStrictEqual({ ...ev('o.{"k": c}')[0] }, { k: 'x' });
    assert.deepStrictEqual({ ...ev('o{c: $sum(n)}', { o: [] }) }, {});
    // `@$` bindings must keep using the tuple stream (values carry no bindings)
    assert.deepStrictEqual({ ...ev('o@$e{$e.c: $sum($e.n)}') }, { x: 4, y: 2 });
    // all of the above verified against the reference interpreter
  });
});
