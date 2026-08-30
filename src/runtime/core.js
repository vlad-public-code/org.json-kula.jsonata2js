'use strict';

/**
 * Core boolean/type/error/clone built-ins ported from jsonata's
 * `src/functions.js` (`boolean`, `not`, `exists`, `type`, `error`, `assert`)
 * and `src/jsonata.js` (`functionClone`).
 *
 * Adaptation: `$type()` gains a `'regex'` result for native `RegExp` values
 * — jsonata2js's value model represents JSONata regex literals as a
 * distinct native `RegExp` (see `runtime/function-value.js`), whereas
 * upstream jsonata evaluates a regex literal straight into a JS function
 * (its matcher closure) and so never distinguishes "regex" from "function"
 * in `$type()`. This is the one deliberate behavioral divergence from
 * `jsonata/src/functions.js`'s `type()`, per design.md D2 / tasks.md 4.2.
 */

const { err, deepEqual } = require('./values');
const { isFunctionValue, isRegexValue } = require('./function-value');

/** Ports jsonata's `utils.isNumeric`: true for a present, non-NaN number;
 * throws D1001 if the number is present but non-finite (Infinity/-Infinity),
 * matching jsonata's "D1001 fires on consumption, not production" rule. */
function isNumericChecked(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return false;
  if (!Number.isFinite(v)) throw err('D1001', { value: v });
  return true;
}

function booleanOf(arg) {
  let result = false;
  if (Array.isArray(arg)) {
    if (arg.length === 1) {
      result = booleanOf(arg[0]);
    } else if (arg.length > 1) {
      const trues = arg.filter((val) => booleanOf(val));
      result = trues.length > 0;
    }
  } else if (typeof arg === 'string') {
    if (arg.length > 0) result = true;
  } else if (isNumericChecked(arg)) {
    if (arg !== 0) result = true;
  } else if (arg !== null && typeof arg === 'object') {
    // covers plain objects (non-empty -> true) and regex values (always
    // zero own enumerable keys -> false, matching upstream's "function -> false")
    if (Object.keys(arg).length > 0) result = true;
  } else if (typeof arg === 'boolean' && arg === true) {
    result = true;
  }
  return result;
}

/**
 * `$boolean()` — NOT a trivial `values.isTruthy` wrapper: jsonata's own
 * `boolean(undefined) === undefined` (missing propagates), whereas
 * `values.isTruthy(undefined) === false` (used for `if`/predicate contexts
 * where missing must count as falsy, not propagate). This ports jsonata's
 * actual recursive `boolean()` algorithm, including its "single-element
 * array unwraps recursively" and "isNumeric throws D1001 on Infinity" quirks.
 */
function fn_boolean(arg) {
  if (arg === undefined) return undefined;
  return booleanOf(arg);
}

function fn_not(arg) {
  if (arg === undefined) return undefined;
  return !fn_boolean(arg);
}

/** `$exists()` — never propagates missing; always returns a boolean. */
function fn_exists(arg) {
  return arg !== undefined;
}

/** `$type()` — 'undefined' is never actually returned (missing short-circuits
 * to `undefined` itself, matching jsonata: the type of "no value" is "no value"). */
function fn_type(value) {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (isRegexValue(value)) return 'regex';
  if (isNumericChecked(value)) return 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (isFunctionValue(value)) return 'function';
  return 'object';
}

/** `$error([message])` — always throws D3137. */
function fn_error(message) {
  throw err('D3137', { message: message === undefined ? '$error() function evaluated' : message });
}

/** `$assert(condition[, message])` — throws D3141 when `condition` is falsy. */
function fn_assert(condition, message) {
  if (!condition) {
    throw err('D3141', { message: message === undefined ? '$assert() statement failed' : message });
  }
  return undefined;
}

/** `$clone()` — deep clone via jsonata's own `JSON.parse($string(arg))` one-liner
 * (see jsonata/src/jsonata.js `functionClone`); requires `runtime/string.js`'s
 * `fn_string`, required lazily to avoid a require cycle. */
function fn_clone(arg) {
  if (arg === undefined) return undefined;
  const { fn_string } = require('./string');
  return JSON.parse(fn_string(arg));
}

module.exports = {
  fn_boolean,
  fn_not,
  fn_exists,
  fn_type,
  fn_error,
  fn_assert,
  fn_clone,
  isDeepEqual: deepEqual,
};
