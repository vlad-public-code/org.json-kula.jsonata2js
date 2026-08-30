'use strict';

/**
 * Core value-model runtime helpers every generated function relies on
 * (design.md D2 / capability `runtime-value-semantics`).
 *
 * Value representation (design.md D2 table):
 *   missing  -> undefined
 *   null     -> null
 *   array    -> plain Array (a "sequence" only while codegen is still
 *               accumulating path-navigation results; flattened/collapsed
 *               by `collapse` before it escapes to the surrounding expression)
 *   object   -> plain Object, insertion-ordered
 *   function value -> native function tagged with `._jsonataArity`
 *   regex    -> native RegExp, always compiled with a forced trailing `g` flag
 *
 * Error codes/messages are ported verbatim from jsonata's own interpreter
 * (src/jsonata.js), which is the semantics the vendored official test suite
 * (jsonata/test/test-suite) actually asserts against.
 */

const { JsonataEvaluationError } = require('../errors');

function isMissing(v) {
  return v === undefined;
}

function err(code, extra) {
  return new JsonataEvaluationError(code, extra);
}

// ---------------------------------------------------------------------------
// Sequence construction (path-navigation accumulator)
// ---------------------------------------------------------------------------

/** Starts a new empty path-navigation result sequence. */
function newSequence() {
  return [];
}

/**
 * Appends `value` to a path-navigation sequence being accumulated, flattening
 * one level (a step that itself produced an array is spread in, never
 * double-nested) and dropping `undefined`/missing results — mirrors
 * JsonataRuntime's per-step accumulation and jsonata's own `evaluateStep`.
 */
function appendToSequence(seq, value) {
  if (value === undefined) return seq;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (value[i] !== undefined) seq.push(value[i]);
    }
  } else {
    seq.push(value);
  }
  return seq;
}

/**
 * Collapses a finished sequence: zero elements -> undefined, one element ->
 * that element (singleton collapse), otherwise the array itself.
 * `keepSingleton` (set when the path/array literal used the `[]` "force
 * array" suffix, or is itself an explicit array constructor with exactly one
 * element) suppresses singleton collapse.
 */
function collapse(seq, keepSingleton) {
  if (seq.length === 0) return undefined;
  if (seq.length === 1 && !keepSingleton) return seq[0];
  return seq;
}

/** `expr[]` — forces an array result even for zero/one matches. */
function forceArray(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  return [value];
}

/** Wraps a non-array context value as a single-element sequence (root of a path). */
function toSequence(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// ---------------------------------------------------------------------------
// Path navigation
// ---------------------------------------------------------------------------

/**
 * Hoisted once: `field` is the single hottest runtime function in a compiled
 * expression (15% of evaluation self time), and the inline
 * `Object.prototype.hasOwnProperty.call(...)` form paid two property loads
 * per call before even reaching the call.
 */
const hasOwn = Object.prototype.hasOwnProperty;

/** `context.name` — object field access; missing/null context yields missing. */
function field(value, name) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    const seq = newSequence();
    for (let i = 0; i < value.length; i++) appendToSequence(seq, field(value[i], name));
    return collapse(seq, false);
  }
  // Own properties only: an inherited member (`constructor`, a class method)
  // is not a JSONata field.
  return hasOwn.call(value, name) ? value[name] : undefined;
}

/**
 * `*` — every own-property value of an object; an array is treated like
 * any other object (its numeric indices are its "keys"), so `*` on a bare
 * array of scalars is just that array's elements, not a recursive search.
 * An array-valued field is fully (recursively) flattened into the result;
 * a scalar field value is pushed as-is. Ports jsonata's `evaluateWildcard`.
 */
function flattenDeep(arr, out) {
  for (const item of arr) {
    if (Array.isArray(item)) flattenDeep(item, out);
    else out.push(item);
  }
  return out;
}

function wildcard(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const seq = newSequence();
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (Array.isArray(v)) {
      for (const e of flattenDeep(v, [])) if (e !== undefined) seq.push(e);
    } else if (v !== undefined) {
      seq.push(v);
    }
  }
  return collapse(seq, false);
}

/** `**` — recursive-descent collection of every descendant value (depth-first, self excluded... actually includes all nested values). */
function descendant(value) {
  if (value === undefined || value === null) return undefined;
  const seq = newSequence();
  const walk = (v) => {
    if (Array.isArray(v)) {
      for (const e of v) walk(e);
    } else {
      seq.push(v);
      if (v !== null && typeof v === 'object') {
        for (const k of Object.keys(v)) walk(v[k]);
      }
    }
  };
  if (Array.isArray(value)) {
    for (const e of value) walk(e);
  } else {
    walk(value);
  }
  return collapse(seq, false);
}

/** `%` step is resolved lexically by the translator (closes over the parent binding); no runtime helper needed. */

/** `seq[index]` numeric subscript (0-based; negative counts from the end). */
function subscript(seq, index) {
  if (seq === undefined) return undefined;
  const arr = Array.isArray(seq) ? seq : [seq];
  let i = Math.trunc(toNumber(index));
  if (i < 0) i = arr.length + i;
  if (i < 0 || i >= arr.length) return undefined;
  return arr[i];
}

// ---------------------------------------------------------------------------
// Truthy / boolean coercion
// ---------------------------------------------------------------------------

function isTruthy(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) {
    if (value.length === 0) return false;
    if (value.length === 1) return isTruthy(value[0]);
    return value.some(isTruthy);
  }
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return false; // functions/regex are always falsy
}

// ---------------------------------------------------------------------------
// Equality
// ---------------------------------------------------------------------------

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * Hash consistent with `deepEqual`: equal values always hash equal (unequal
 * values usually don't). Object keys are combined order-independently because
 * `deepEqual` ignores key order; `-0` is normalized to `0` because `===`
 * equates them. `NaN` may collide with itself, which is harmless — a
 * collision only costs one `deepEqual` call, which then correctly reports
 * "not equal".
 *
 * Used to bucket candidates for `$distinct` over composite values, turning an
 * O(n²) pairwise `deepEqual` scan into a near-linear one.
 */
function structuralHash(value) {
  if (value === null) return 0x9e3779b1;
  switch (typeof value) {
    case 'boolean': return value ? 0x27d4eb2d : 0x165667b1;
    case 'number': return hashString('n', String(value === 0 ? 0 : value));
    case 'string': return hashString('s', value);
    case 'object': break;
    default: return 0x85ebca6b; // functions/regex: never `deepEqual` anyway
  }
  if (Array.isArray(value)) {
    let h = 0x01000193 ^ value.length;
    for (let i = 0; i < value.length; i++) {
      h = (Math.imul(h, 31) + structuralHash(value[i])) >>> 0;
    }
    return h;
  }
  const keys = Object.keys(value);
  let h = 0x811c9dc5 ^ keys.length;
  for (let i = 0; i < keys.length; i++) {
    // Addition (not a positional mix) so the result is independent of key order.
    h = (h + Math.imul(hashString('k', keys[i]) ^ structuralHash(value[keys[i]]), 0x85ebca6b)) >>> 0;
  }
  return h;
}

function hashString(tag, str) {
  let h = 0x811c9dc5 ^ tag.charCodeAt(0);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** `=` — both sides typed (present); undefined on either side yields false, matching jsonata's `evaluateEqualityExpression`. */
function eq(a, b) {
  if (a === undefined || b === undefined) return false;
  return deepEqual(a, b);
}

/** `!=` */
function ne(a, b) {
  if (a === undefined || b === undefined) return false;
  return !deepEqual(a, b);
}

// ---------------------------------------------------------------------------
// Ordering comparisons (<, <=, >, >=) — ports jsonata's `evaluateComparisonExpression`
// ---------------------------------------------------------------------------

function orderingOk(v) {
  return v === undefined || typeof v === 'number' || typeof v === 'string';
}

/** T2010 (incomparable type) vs T2009 (comparable types that differ), matching jsonata exactly. */
function orderingError(a, b, token) {
  const la = typeof a, lb = typeof b;
  if (!orderingOk(a) || !orderingOk(b)) {
    const bad = !(la === 'string' || la === 'number') ? a : b;
    return err('T2010', { value: bad, token });
  }
  return err('T2009', { value: a, value2: b, token });
}

function compareOp(a, b, token, op) {
  if (!orderingOk(a) || !orderingOk(b)) throw orderingError(a, b, token);
  if (a === undefined || b === undefined) return undefined;
  if (typeof a !== typeof b) throw orderingError(a, b, token);
  return op(a, b);
}

function lt(a, b) { return compareOp(a, b, '<', (x, y) => x < y); }
function le(a, b) { return compareOp(a, b, '<=', (x, y) => x <= y); }
function gt(a, b) { return compareOp(a, b, '>', (x, y) => x > y); }
function ge(a, b) { return compareOp(a, b, '>=', (x, y) => x >= y); }

/** `item in seq` — strict (`===`) membership test, matching jsonata's `evaluateIncludesExpression` (not deep-equal). */
function inOp(item, seq) {
  if (item === undefined || seq === undefined) return false;
  const arr = Array.isArray(seq) ? seq : [seq];
  return arr.some((e) => e === item);
}

// ---------------------------------------------------------------------------
// Arithmetic — ports jsonata's `evaluateNumericExpression` + `utils.isNumeric`
// ---------------------------------------------------------------------------

/**
 * Validates an arithmetic operand exactly like jsonata's `isNumeric`: a
 * non-number (or NaN) operand throws T2001/T2002 ("must evaluate to a
 * number"); a number that is present but non-finite (overflow from a prior
 * operation, e.g. `1e308 * 1e308`) throws D1001 immediately when *used* here
 * — jsonata does not validate finiteness at the point a result is produced,
 * only at the point it is next consumed as an operand.
 */
function requireNumericOperand(v, side, token) {
  if (v === undefined) return;
  if (typeof v !== 'number' || Number.isNaN(v)) {
    throw err(side === 'left' ? 'T2001' : 'T2002', { value: v, token });
  }
  if (!Number.isFinite(v)) {
    throw err('D1001', { value: v });
  }
}

function add(a, b) {
  requireNumericOperand(a, 'left', '+');
  requireNumericOperand(b, 'right', '+');
  if (a === undefined || b === undefined) return undefined;
  return a + b;
}
function subtract(a, b) {
  requireNumericOperand(a, 'left', '-');
  requireNumericOperand(b, 'right', '-');
  if (a === undefined || b === undefined) return undefined;
  return a - b;
}
function multiply(a, b) {
  requireNumericOperand(a, 'left', '*');
  requireNumericOperand(b, 'right', '*');
  if (a === undefined || b === undefined) return undefined;
  return a * b;
}
function divide(a, b) {
  requireNumericOperand(a, 'left', '/');
  requireNumericOperand(b, 'right', '/');
  if (a === undefined || b === undefined) return undefined;
  return a / b;
}
function modulo(a, b) {
  requireNumericOperand(a, 'left', '%');
  requireNumericOperand(b, 'right', '%');
  if (a === undefined || b === undefined) return undefined;
  return a % b;
}
/** Unary `-` — D1001 if the operand is already non-finite, else D1002 if it is not numeric at all. */
function negate(a) {
  if (a === undefined) return undefined;
  if (typeof a !== 'number' || Number.isNaN(a)) {
    throw err('D1002', { value: a, token: '-' });
  }
  if (!Number.isFinite(a)) throw err('D1001', { value: a });
  return -a;
}

// ---------------------------------------------------------------------------
// String concatenation (&) — delegates to the vendored `$string()` so numeric
// formatting (precision, no scientific notation) matches jsonata exactly.
// Lazily required to avoid a require cycle (string.js also uses values.js).
// ---------------------------------------------------------------------------

let _stringFn = null;
function toStringValue(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (!_stringFn) _stringFn = require('./string').fn_string;
  return _stringFn(v);
}

function concat(a, b) {
  return toStringValue(a) + toStringValue(b);
}

// ---------------------------------------------------------------------------
// Boolean logic / defaulting
// ---------------------------------------------------------------------------

function and(a, bThunk) {
  return isTruthy(a) && isTruthy(bThunk());
}
function or(a, bThunk) {
  return isTruthy(a) || isTruthy(bThunk());
}
function elvis(left, right) {
  return isTruthy(left) ? left : right;
}
function coalesce(left, right) {
  return left === undefined ? right : left;
}

// ---------------------------------------------------------------------------
// Numeric coercion for internal use (subscripts, etc.)
// ---------------------------------------------------------------------------

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (v === undefined) return NaN;
  const n = Number(v);
  return n;
}

// ---------------------------------------------------------------------------
// Range operator [from..to]
// ---------------------------------------------------------------------------

const MAX_RANGE_SIZE = 10000000; // mirrors jsonata's D2014 guard

function range(from, to) {
  if (from !== undefined && (typeof from !== 'number' || !Number.isInteger(from))) {
    throw err('T2003', { value: from });
  }
  if (to !== undefined && (typeof to !== 'number' || !Number.isInteger(to))) {
    throw err('T2004', { value: to });
  }
  if (from === undefined || to === undefined) return undefined;
  if (from > to) return undefined;
  const size = to - from + 1;
  if (size > MAX_RANGE_SIZE) {
    throw err('D2014', { value: size });
  }
  const result = new Array(size);
  for (let i = 0; i < size; i++) result[i] = from + i;
  return result;
}

/**
 * Invokes a context-default builtin (`fn`) with `ctxValue` substituted for
 * its first (omitted) argument, followed by any remaining explicit
 * `restArgs` (the argument-shift case, e.g. `$substringBefore(chars)`
 * shifting `chars` into the second parameter). If the context
 * substitution fails the parameter's type check (T0410), re-throws as
 * T0411 ("context value is not a compatible type with argument 1") -
 * matching jsonata's distinct error for a bad *implicit* context argument
 * vs a bad *explicit* one.
 */
function ctxDefaultCall(fn, ctxValue, name, ...restArgs) {
  try {
    return fn(ctxValue, ...restArgs);
  } catch (e) {
    if (e instanceof JsonataEvaluationError && e.code === 'T0410' && e.index === 1) {
      throw err('T0411', { index: 1, token: name });
    }
    throw e;
  }
}

module.exports = {
  err,
  isMissing,
  ctxDefaultCall,
  newSequence,
  appendToSequence,
  collapse,
  forceArray,
  toSequence,
  field,
  wildcard,
  descendant,
  subscript,
  isTruthy,
  deepEqual,
  structuralHash,
  eq,
  ne,
  lt,
  le,
  gt,
  ge,
  inOp,
  add,
  subtract,
  multiply,
  divide,
  modulo,
  negate,
  concat,
  toStringValue,
  and,
  or,
  elvis,
  coalesce,
  toNumber,
  range,
};
