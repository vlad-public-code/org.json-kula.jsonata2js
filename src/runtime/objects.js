'use strict';

/**
 * `$keys`/`$lookup`/`$append`/`$spread`/`$flatten` — ported from
 * JsonataRuntime.java (design.md D4: object/array-manipulation built-ins
 * with no complex callback wiring), semantics cross-checked against
 * jsonata's own `functions.js` (`keys`/`lookup`/`append`/`spread`).
 */

const RT = require('./values');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v !== 'function';
}

/** `$keys(x)` — own keys of an object; for an array, the union of every element's keys. */
function fn_keys(arg) {
  if (arg === undefined) return undefined;
  if (Array.isArray(arg)) {
    // Object.create(null), not `{}`: a key literally named `__proto__` on a
    // `{}` set the object's prototype instead of recording the key, and was
    // then missing from the result (jsonata2js.md JS-8). The reference
    // returns it like any other key.
    const merged = Object.create(null);
    for (const item of arg) {
      const ks = fn_keys(item);
      if (ks === undefined) continue;
      for (const k of Array.isArray(ks) ? ks : [ks]) merged[k] = true;
    }
    const out = Object.keys(merged);
    return RT.collapse(out, false);
  }
  if (isPlainObject(arg)) return RT.collapse(Object.keys(arg), false);
  return undefined;
}

/** `$lookup(x, key)` — object field lookup that recurses/flattens over arrays. */
function fn_lookup(input, key) {
  if (Array.isArray(input)) return RT.collapse(lookupSequence(input, key), false);
  if (isPlainObject(input) && Object.prototype.hasOwnProperty.call(input, key)) {
    return input[key];
  }
  return undefined;
}

function lookupSequence(input, key) {
  const out = [];
  for (const item of input) {
    const res = fn_lookup(item, key);
    if (res !== undefined) RT.appendToSequence(out, res);
  }
  return out;
}

/**
 * `$lookup(...)` followed by `[]`. Over an ARRAY input jsonata builds a
 * sequence, which `keepArray` then stops collapsing - so `$lookup([{"b":1}],
 * "b")[]` is `[1]` where `$lookup({"b":1},"b")[]` is `1` (an object input
 * returns the raw value, which no `[]` can touch). `fn_lookup` has already
 * collapsed by the time a wrapper could see it, so the `[]` form needs the
 * sequence itself.
 */
function fn_lookup_keepArray(input, key) {
  if (!Array.isArray(input)) return fn_lookup(input, key);
  const out = lookupSequence(input, key);
  return out.length === 0 ? undefined : out;
}

/** `$append(arg1, arg2)` — array concatenation (missing on either side passes the other through). */
function fn_append(arg1, arg2) {
  if (arg1 === undefined) return arg2;
  if (arg2 === undefined) return arg1;
  const a = Array.isArray(arg1) ? arg1 : [arg1];
  const b = Array.isArray(arg2) ? arg2 : [arg2];
  return a.concat(b);
}

/** `$spread(x)` — splits an object into an array of single-key objects; recurses over arrays. */
function fn_spread(arg) {
  if (Array.isArray(arg)) {
    let out = undefined;
    for (const item of arg) out = fn_append(out, fn_spread(item));
    return out === undefined ? [] : out;
  }
  if (isPlainObject(arg)) {
    const out = [];
    // Object.create(null) - see translator.js#genObjectConstructor's comment / CODE-REVIEW.md H5.
    for (const key of Object.keys(arg)) {
      const single = Object.create(null);
      single[key] = arg[key];
      out.push(single);
    }
    return RT.collapse(out, false);
  }
  return arg;
}

/** `$flatten(x)` — recursively flattens nested arrays into a single flat array. */
function fn_flatten(arg) {
  if (arg === undefined) return undefined;
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== undefined) out.push(v);
  };
  walk(arg);
  return out;
}

module.exports = { fn_keys, fn_lookup, fn_lookup_keepArray, fn_append, fn_spread, fn_flatten };
