'use strict';

/**
 * `fn_round` scales by a power of ten in floating point when the scaled value
 * is provably far from a tie, falling back to the exact decimal-string shift
 * otherwise (see the comment on `fn_round`). The fast path is a bit-for-bit
 * equivalence claim, so this test compares it against a verbatim copy of the
 * original string-only implementation — over the tie cases where the two
 * *could* disagree, over the documented guard boundaries, and over 200k
 * randomized values.
 */

const assert = require('assert');
const { fn_round } = require('../../src/runtime/numeric');

/** The pre-fast-path implementation (jsonata's own algorithm), kept as the oracle. */
function referenceRound(arg, precision) {
  if (arg === undefined) return undefined;
  if (precision) {
    const parts = arg.toString().split('e');
    arg = +(parts[0] + 'e' + (parts[1] ? +parts[1] + precision : precision));
  }
  let result = Math.round(arg);
  const diff = result - arg;
  if (Math.abs(diff) === 0.5 && Math.abs(result % 2) === 1) result -= 1;
  if (precision) {
    const parts = result.toString().split('e');
    result = +(parts[0] + 'e' + (parts[1] ? +parts[1] - precision : -precision));
  }
  if (Object.is(result, -0)) result = 0;
  return result;
}

function assertSame(value, precision) {
  const got = fn_round(value, precision);
  const want = referenceRound(value, precision);
  assert.strictEqual(
    Object.is(got, want) ? want : got,
    want,
    `$round(${value}, ${precision}) = ${got}, reference = ${want}`
  );
}

describe('fn_round fast path', () => {
  it('matches the reference on exact ties (the case the guard exists for)', () => {
    const ties = [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.05, 0.15, 0.25, 0.35, 0.45,
      1.005, 1.015, 1.025, 2.675, 8.835, 88.35, 0.125, 0.375, -1.005, -2.675,
      1234.5675, 0.0000015, 1.0000005];
    for (const v of ties) {
      for (let p = 0; p <= 8; p++) assertSame(v, p);
    }
  });

  it('matches the reference around the guard boundaries', () => {
    const boundary = [1e9 - 1, 1e9, 1e9 + 1, 1e8, 999999999.4999, 1e15, 1e16, 1e21,
      Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 1e-9, 5e-324, -0, 0];
    for (const v of boundary) {
      for (const p of [0, 1, 2, 3, 7, 14, 15, 16, 20]) assertSame(v, p);
    }
  });

  it('matches the reference for non-finite and missing inputs', () => {
    assert.strictEqual(fn_round(undefined, 2), undefined);
    for (const v of [Infinity, -Infinity, NaN]) {
      for (const p of [0, 2]) {
        const got = fn_round(v, p);
        const want = referenceRound(v, p);
        assert.ok(
          Object.is(got, want) || (Number.isNaN(got) && Number.isNaN(want)),
          `$round(${v}, ${p}) = ${got}, reference = ${want}`
        );
      }
    }
  });

  it('matches the reference on 200k randomized values', () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 20260830;
    const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 200000; i++) {
      const magnitude = Math.pow(10, Math.floor(next() * 12) - 4);
      const value = (next() - 0.5) * 2 * magnitude;
      const precision = Math.floor(next() * 9);
      assertSame(value, precision);
      // also feed values that are exact multiples of a half-step at this
      // precision, which is where the two implementations can diverge
      const halfStep = (Math.round(value * Math.pow(10, precision)) + 0.5) / Math.pow(10, precision);
      assertSame(halfStep, precision);
    }
  });
});
