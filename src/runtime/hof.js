'use strict';

/**
 * Higher-order-function runtime support (design.md D4: "port callback/
 * tuple-unpacking wiring; may reference the interpreter's algorithm for the
 * loop/merge-sort skeleton" — ported from JSonata2Java's
 * `SequenceBuiltins`/`FunctionCallCodeGen`, simplified to a single
 * runtime-arity-dispatch implementation instead of Java's codegen-time
 * dispatch: every JSONata function value is tagged with `._jsonataArity`
 * (src/runtime/function-value.js), and each helper below inspects that tag
 * once per call to decide how many positional arguments the callback wants
 * (element only / element+index / element+index+array). This trades a
 * small per-call arity check for a much simpler, single-path implementation
 * — acceptable per design.md's stated correctness-first priority.
 *
 * Collapsing behavior below (which results go through `RT.collapse` and
 * which stay plain arrays) is verified against real jsonata's own
 * `functions.js` (whether each built-in constructs its result via
 * `this.createSequence()` — collapse-eligible — or a plain `[]` literal —
 * never collapsed).
 */

const RT = require('./values');
const { arityOf } = require('./function-value');
const { JsonataEvaluationError } = require('../errors');
const { unwind, tickDeadline } = require('./lambda');

function err(code, extra) {
  return new JsonataEvaluationError(code, extra);
}

/**
 * Invokes `fn` with up to `n` of `(elem, index, array)` based on its
 * declared/inferred arity, then drives the tail-call trampoline on the
 * result. `fn` may itself return a deferred `Thunk` (a dynamic call in
 * tail position inside a lambda body - see translator.js#genStaticOrDynamicCall)
 * rather than a real value; every HOF entry point in this file feeds a
 * user-supplied callback's return value straight into a sequence/predicate/
 * accumulator, so it MUST be unwound here - the one choke point every
 * caller below shares - or the raw `Thunk` object silently leaks out as if
 * it were real data (e.g. `$filter`'s truthiness check on an unresolved
 * `Thunk` is always true, so the predicate appears to always pass).
 */
function callWithTuple(fn, elem, index, array) {
  // Sampled evaluation-timeout check: every HOF callback invocation in this
  // file funnels through here, so this alone makes `setTimeout(ms)` bite on
  // `$map`/`$filter`/`$each`/`$sift`/`$single`/`$sort` over a huge sequence
  // (jsonata2js.md JS-3). No-op unless a deadline is active.
  tickDeadline();
  const arity = arityOf(fn);
  if (arity >= 3) return unwind(fn(elem, index, array));
  if (arity === 2) return unwind(fn(elem, index));
  return unwind(fn(elem));
}

/**
 * `$map(array, function)` — collapses like a normal sequence.
 *
 * A callback result is PUSHED, not spread: jsonata's own `fn.map` does
 * `result.push(res)` into a `createSequence()`, so an array-valued result
 * stays one element (`$map([1,2], function($v){ [$v,$v] })` is
 * `[[1,1],[2,2]]`, not `[1,1,2,2]`). Path-step accumulation
 * (`RT.appendToSequence`) flattens one level; a HOF result does not. Verified
 * against `jsonata` 2.2.2.
 */
function mapSeq(arr, fn) {
  if (arr === undefined) return undefined;
  if (typeof fn !== 'function') throw err('T0410', { index: 2, token: 'map' });
  const items = Array.isArray(arr) ? arr : [arr];
  const out = RT.newSequence();
  for (let i = 0; i < items.length; i++) {
    const res = callWithTuple(fn, items[i], i, items);
    if (res !== undefined) out.push(res);
  }
  return RT.collapse(out, false);
}

/** `$filter(array, predicate)` — collapses like a normal sequence. */
function filterSeq(arr, fn) {
  if (arr === undefined) return undefined;
  if (typeof fn !== 'function') throw err('T0410', { index: 2, token: 'filter' });
  const items = Array.isArray(arr) ? arr : [arr];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    if (RT.isTruthy(callWithTuple(fn, items[i], i, items))) out.push(items[i]);
  }
  return RT.collapse(out, false);
}

/** `$each(object, function($value,$key))` — collapses like a normal sequence; pushes each result, see `mapSeq`. */
function eachSeq(obj, fn) {
  if (obj === undefined || obj === null || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  if (typeof fn !== 'function') throw err('T0410', { index: 2, token: 'each' });
  const out = RT.newSequence();
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const res = callWithTuple(fn, obj[keys[i]], keys[i], obj);
    if (res !== undefined) out.push(res);
  }
  return RT.collapse(out, false);
}


/** `$sift(object, predicate)` — object result, never collapsed. */
function siftObj(obj, fn) {
  if (obj === undefined) return undefined;
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  // Object.create(null) - see translator.js#genObjectConstructor's comment / CODE-REVIEW.md H5.
  const out = Object.create(null);
  for (const key of Object.keys(obj)) {
    if (RT.isTruthy(callWithTuple(fn, obj[key], key, obj))) out[key] = obj[key];
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** `$single(array[, predicate])` — returns the raw matching element (never array-wrapped); D3138/D3139 on 0/2+ matches. */
function singleSeq(arr, fn) {
  if (arr === undefined) return undefined;
  const items = Array.isArray(arr) ? arr : [arr];
  let found;
  let any = false;
  for (let i = 0; i < items.length; i++) {
    const matches = fn ? RT.isTruthy(callWithTuple(fn, items[i], i, items)) : true;
    if (matches) {
      if (any) throw err('D3138', { index: i });
      found = items[i];
      any = true;
    }
  }
  if (!any) throw err('D3139');
  return found;
}

/** `$reduce(array, function($acc,$v[,$i,$a]), init?)` — scalar accumulator, never collapsed. D3050 if fn arity < 2. */
function reduceSeq(arr, fn, init) {
  if (arr === undefined) return undefined;
  if (typeof fn !== 'function' || arityOf(fn) < 2) {
    throw err('D3050');
  }
  const items = Array.isArray(arr) ? arr : [arr];
  let acc;
  let start = 0;
  if (init !== undefined) {
    acc = init;
  } else {
    if (items.length === 0) return undefined;
    acc = items[0];
    start = 1;
  }
  const arity = arityOf(fn);
  for (let i = start; i < items.length; i++) {
    tickDeadline();
    if (arity >= 4) acc = unwind(fn(acc, items[i], i, items));
    else if (arity === 3) acc = unwind(fn(acc, items[i], i));
    else acc = unwind(fn(acc, items[i]));
  }
  return acc;
}

/** Natural comparator for `$sort`'s single-argument form: strings or numbers only (D3070 otherwise). */
function naturalCompare(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  throw err('D3070');
}

/**
 * `$sort(array[, comparator])` — stable sort; plain array result, never
 * collapsed. `comparator(a,b)` returns truthy when `a` should sort AFTER `b`
 * (JSONata's documented convention).
 *
 * The comparator path is a bottom-up merge sort rather than
 * `Array.prototype.sort`, because the JSONata convention only tells us
 * "after" or "not after": deriving a three-way result for a JS comparator
 * meant calling the user's function TWICE per comparison. Merge sort needs
 * exactly one call per comparison and takes from the left run on a falsy
 * result, which is both stable and the same order jsonata's own merge-sort
 * implementation produces. Halves the lambda invocations, which dominate the
 * cost of any non-trivial comparator (1.03 -> 0.55 ms for 2,000 objects).
 */
function sortArr(arr, fn) {
  if (arr === undefined) return undefined;
  const items = Array.isArray(arr) ? arr.slice() : [arr];
  if (!fn) {
    // jsonata merge-sorts, so with nothing to compare it never evaluates a
    // comparison and never reports a bad one: `$sort([[1]])` is `[[1]]`, not
    // D3070. Validating eagerly made a working expression throw.
    if (items.length < 2) return items;
    for (const v of items) {
      if (typeof v !== 'number' && typeof v !== 'string') throw err('D3070');
    }
    return items.sort(naturalCompare);
  }
  const n = items.length;
  if (n < 2) return items;
  let src = items;
  let dst = new Array(n);
  for (let width = 1; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += width * 2) {
      const mid = Math.min(lo + width, n);
      const hi = Math.min(lo + width * 2, n);
      let i = lo;
      let j = mid;
      for (let k = lo; k < hi; k++) {
        tickDeadline();
        if (i < mid && (j >= hi || !RT.isTruthy(unwind(fn(src[i], src[j]))))) {
          dst[k] = src[i++];
        } else {
          dst[k] = src[j++];
        }
      }
    }
    const swap = src;
    src = dst;
    dst = swap;
  }
  return src;
}

/**
 * `$distinct(array)` — plain array result (order of first occurrence
 * preserved).
 *
 * Primitives are deduplicated through a `Set`, which makes the common case
 * linear instead of the O(n²) `deepEqual` scan this used to run for every
 * element (4.67 ms -> 0.09 ms for 2,000 strings with 500 distinct values).
 * `NaN` is excluded from the `Set` path deliberately: `Set` treats it as equal
 * to itself (SameValueZero) but `deepEqual` does not, so it keeps taking the
 * scan path and stays non-deduplicated exactly as before.
 *
 * Composite values still need `deepEqual`, but only against candidates whose
 * `structuralHash` matches (a hash consistent with `deepEqual`: equal values
 * always land in the same bucket), so the comparison count is near-linear
 * instead of quadratic.
 */
function distinctArr(arr) {
  if (arr === undefined) return undefined;
  if (!Array.isArray(arr)) return arr;
  const out = [];
  let seen = null;      // primitives (and null)
  let buckets = null;   // signature -> array of composite values already kept
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    const composite = v !== null && typeof v === 'object';
    if (!composite && !(typeof v === 'number' && Number.isNaN(v))) {
      if (seen === null) seen = new Set();
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
      continue;
    }
    if (composite) {
      const signature = RT.structuralHash(v);
      if (buckets === null) buckets = new Map();
      let bucket = buckets.get(signature);
      if (bucket === undefined) {
        bucket = [];
        buckets.set(signature, bucket);
      }
      let duplicate = false;
      for (let b = 0; b < bucket.length; b++) {
        if (RT.deepEqual(bucket[b], v)) { duplicate = true; break; }
      }
      if (duplicate) continue;
      bucket.push(v);
      out.push(v);
      continue;
    }
    // NaN (or any other value `deepEqual` never matches): linear scan, so the
    // pre-existing behaviour is preserved bit for bit.
    let duplicate = false;
    for (let o = 0; o < out.length; o++) {
      if (RT.deepEqual(out[o], v)) { duplicate = true; break; }
    }
    if (!duplicate) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation ($sum/$count/$max/$min/$average) — ported from JsonataRuntime's
// aggregation methods; semantics (empty array, non-array scalar auto-wrap,
// T0412 on non-numeric elements) verified against jsonata's own sum/count/
// max/min/average in functions.js.
// ---------------------------------------------------------------------------

/**
 * Aggregates validate every element is a number and combine in ONE pass over
 * the sequence — the validation used to be a separate `requireNumberArray`
 * walk, and `$max`/`$min` used `Math.max(...items)`, which both re-walks the
 * array and spreads it onto the stack (a real limit for a large sequence).
 * Throwing on the first non-number keeps the observable behaviour identical:
 * the T0412 error is raised before any result can escape.
 */
function aggTypeError(fnName) {
  return err('T0412', { token: fnName, index: 1, type: 'number' });
}

/** `$count(array)` — missing input counts as 0. */
function countAgg(arg) {
  if (arg === undefined) return 0;
  return Array.isArray(arg) ? arg.length : 1;
}

/** `$sum(array)` — missing input is missing; empty array sums to 0. */
function sumAgg(arg) {
  if (arg === undefined) return undefined;
  if (!Array.isArray(arg)) {
    if (typeof arg !== 'number') throw aggTypeError('sum');
    return arg;
  }
  let total = 0;
  for (let i = 0; i < arg.length; i++) {
    const v = arg[i];
    if (typeof v !== 'number') throw aggTypeError('sum');
    total += v;
  }
  return total;
}

/** `$max(array)` — missing input or empty array is missing. */
function maxAgg(arg) {
  return extremumAgg(arg, 'max', true);
}

/** `$min(array)` — missing input or empty array is missing. */
function minAgg(arg) {
  return extremumAgg(arg, 'min', false);
}

function extremumAgg(arg, fnName, wantMax) {
  if (arg === undefined) return undefined;
  if (!Array.isArray(arg)) {
    if (typeof arg !== 'number') throw aggTypeError(fnName);
    return arg;
  }
  if (arg.length === 0) return undefined;
  // Validate the whole sequence before comparing, so a non-numeric element
  // after a numeric one still raises T0412 rather than being ignored.
  for (let i = 0; i < arg.length; i++) {
    if (typeof arg[i] !== 'number') throw aggTypeError(fnName);
  }
  let best = arg[0];
  for (let i = 1; i < arg.length; i++) {
    const v = arg[i];
    if (wantMax ? v > best : v < best) best = v;
  }
  return best;
}

/** `$average(array)` — missing input or empty array is missing. */
function averageAgg(arg) {
  if (arg === undefined) return undefined;
  if (!Array.isArray(arg)) {
    if (typeof arg !== 'number') throw aggTypeError('average');
    return arg;
  }
  if (arg.length === 0) return undefined;
  let total = 0;
  for (let i = 0; i < arg.length; i++) {
    const v = arg[i];
    if (typeof v !== 'number') throw aggTypeError('average');
    total += v;
  }
  return total / arg.length;
}

// ---------------------------------------------------------------------------
// Fused path aggregates
//
// `$sum(x.f)`, `$count(x[cond])` and friends are emitted by the translator as
// a single call over the value-mode stream instead of
// `agg(<terminal-value of the path>)`, which materialized the intermediate
// sequence first. Mirrors JSonata2Java's `Translator#tryFusedCall` /
// `JsonataRuntime#fn_sum_field`.
//
// Every helper reproduces `path.js#finalizeRaw`'s collapse rule exactly,
// because that rule is observable: a *single* raw field result that is itself
// an array passes through verbatim (keeping any `undefined` elements, which a
// numeric aggregate then rejects), whereas two or more raw results flatten
// with `undefined` dropped. `test/unit/aggregate-fusion.test.js` asserts the
// equivalence differentially.
// ---------------------------------------------------------------------------

/** `$sum`/`$average`/`$max`/`$min` applied to an already-computed value. */
function aggregateValue(value, kind) {
  switch (kind) {
    case 'sum': return sumAgg(value);
    case 'average': return averageAgg(value);
    case 'max': return maxAgg(value);
    default: return minAgg(value);
  }
}

/**
 * Single pass over `values`, validating numbers and computing every statistic
 * the four aggregates need; `undefined` elements are skipped (the caller only
 * passes streams that already dropped them).
 */
function aggregateSpan(values, kind) {
  let total = 0;
  let count = 0;
  let best;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== 'number') throw aggTypeError(kind);
    total += v;
    count++;
    if (count === 1 || (kind === 'max' ? v > best : v < best)) best = v;
  }
  if (count === 0) return kind === 'sum' ? 0 : undefined;
  switch (kind) {
    case 'sum': return total;
    case 'average': return total / count;
    default: return best;
  }
}

/**
 * A kind-independent aggregate accumulator: `sum`, `average`, `max` and `min`
 * over the same field differ only in which number they read back, so one of
 * these serves all four - which is what lets a fused sequence scan
 * (`translator/scan-fusion.js`) read that field ONCE for all of them.
 *
 * A non-numeric value is RECORDED rather than thrown, and `scanAgg` raises it
 * on read. Running alone that is unobservable (nothing happens between the bad
 * element and the end of the call), and in a fused scan it is what keeps each
 * aggregate's error at its own statement instead of at the scan's.
 */
/**
 * Records a comparison that would have thrown, for a fused scan's predicate
 * slot. The slot then holds this marker instead of the matching elements, and
 * `cmpCheck` raises the identical error where the result is READ - the
 * original statement - exactly as `scanAgg` does for an aggregate's first
 * non-numeric value.
 */
function cmpBad(a, b, token) {
  return { cmpBad: RT.orderingError(a, b, token) };
}

/** The read side of `cmpBad`: raises a recorded comparison error, else passes the slot through. */
function cmpCheck(slot) {
  if (slot !== null && typeof slot === 'object' && !Array.isArray(slot) && slot.cmpBad !== undefined) {
    throw slot.cmpBad;
  }
  return slot;
}

function scanAcc() {
  return { rawCount: 0, first: undefined, total: 0, count: 0, max: undefined, min: undefined, bad: undefined };
}

/** Folds one raw field value (never `undefined`) into `acc`. */
function scanPush(acc, sv) {
  acc.rawCount++;
  if (acc.rawCount === 1) { acc.first = sv; return; }
  // The first raw result was buffered in case it turned out to be the only one
  // (verbatim passthrough); it is not, so fold it in now.
  if (acc.rawCount === 2) foldRawInto(acc, acc.first);
  foldRawInto(acc, sv);
}

/** Reads `kind`'s result out of `acc`, raising a recorded type error first. */
function scanAgg(acc, kind) {
  if (acc.rawCount === 0) return undefined;
  if (acc.rawCount === 1) return aggregateValue(acc.first, kind);
  if (acc.bad !== undefined) throw aggTypeError(kind);
  if (acc.count === 0) return undefined; // every raw result was an empty array
  switch (kind) {
    case 'sum': return acc.total;
    case 'average': return acc.total / acc.count;
    case 'max': return acc.max;
    default: return acc.min;
  }
}

/** `aggregateValue(P.vFieldFinal(values, name, false), kind)` without the intermediate sequence. */
function aggField(values, name, kind) {
  const acc = scanAcc();
  for (let i = 0; i < values.length; i++) {
    const sv = RT.field(values[i], name);
    if (sv !== undefined) scanPush(acc, sv);
  }
  return scanAgg(acc, kind);
}

function foldRawInto(acc, raw) {
  if (Array.isArray(raw)) {
    for (let j = 0; j < raw.length; j++) {
      if (raw[j] !== undefined) foldNumberInto(acc, raw[j]);
    }
    return;
  }
  foldNumberInto(acc, raw);
}

function foldNumberInto(acc, v) {
  if (typeof v !== 'number') { if (acc.bad === undefined) acc.bad = v; return; }
  acc.total += v;
  acc.count++;
  if (acc.count === 1) { acc.max = v; acc.min = v; return; }
  if (v > acc.max) acc.max = v;
  if (v < acc.min) acc.min = v;
}

/** `aggregateValue(RT.collapse(values, false), kind)` for a value-mode stream. */
function aggOf(values, kind) {
  const n = values.length;
  if (n === 0) return undefined;
  if (n === 1) return aggregateValue(values[0], kind);
  return aggregateSpan(values, kind);
}

/** `countAgg(P.vFieldFinal(values, name, false))` without the intermediate sequence. */
function countField(values, name) {
  let rawCount = 0;
  let first;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const sv = RT.field(values[i], name);
    if (sv === undefined) continue;
    rawCount++;
    if (rawCount === 1) { first = sv; continue; }
    if (rawCount === 2) count += countRaw(first);
    count += countRaw(sv);
  }
  if (rawCount === 0) return 0;
  if (rawCount === 1) return Array.isArray(first) ? first.length : 1;
  return count;
}

function countRaw(raw) {
  if (!Array.isArray(raw)) return 1;
  let n = 0;
  for (let j = 0; j < raw.length; j++) if (raw[j] !== undefined) n++;
  return n;
}

/** `countAgg(RT.collapse(values, false))` for a value-mode stream. */
function countOf(values) {
  const n = values.length;
  if (n === 1 && Array.isArray(values[0])) return values[0].length;
  return n;
}

module.exports = {
  callWithTuple,
  cmpBad,
  cmpCheck,
  scanAcc,
  scanPush,
  scanAgg,
  mapSeq,
  filterSeq,
  eachSeq,
  siftObj,
  singleSeq,
  reduceSeq,
  sortArr,
  naturalCompare,
  distinctArr,
  countAgg,
  sumAgg,
  // fused path aggregates (emitted by the translator; see the block comment)
  aggField,
  aggOf,
  countField,
  countOf,
  maxAgg,
  minAgg,
  averageAgg,
};
