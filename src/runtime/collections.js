'use strict';

/**
 * Pure array/object set-operation built-ins — ports jsonata's `reverse`,
 * `shuffle`, `zip` and `merge` (jsonata/src/functions.js) verbatim. All four
 * operate on already-materialized plain JS arrays/objects, matching
 * jsonata2js's value model (sequences are plain flat Arrays, objects are
 * plain JS objects).
 */

/**
 * $reverse(arr) — new array with `arr`'s elements in reverse order.
 */
function fn_reverse(arr) {
  if (arr === undefined) return undefined;
  if (arr.length <= 1) return arr;

  const length = arr.length;
  const result = new Array(length);
  for (let i = 0; i < length; i++) {
    result[length - i - 1] = arr[i];
  }
  return result;
}

/**
 * $shuffle(arr) — new array with `arr`'s elements in random order, using
 * the 'inside-out' variant of the Fisher-Yates algorithm (same as jsonata).
 */
function fn_shuffle(arr) {
  if (arr === undefined) return undefined;
  if (arr.length <= 1) return arr;

  const result = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const j = Math.floor(Math.random() * (i + 1)); // random integer such that 0 <= j <= i
    if (i !== j) {
      result[i] = result[j];
    }
    result[j] = arr[i];
  }
  return result;
}

/**
 * $zip(array1, array2, ...) — variadic (jsonata signature `<a+>`: one or
 * more arguments, each individually coerced to an array like any other
 * array-typed signature parameter - a scalar becomes a single-element
 * array, an already-array argument is used as-is). Convolves each value
 * from the input arrays into tuples, truncating to the length of the
 * shortest input array (`undefined`/missing counts as length 0).
 */
function fn_zip(...args) {
  const arrays = args.map((arg) => (arg === undefined ? undefined : Array.isArray(arg) ? arg : [arg]));
  const result = [];
  const length = Math.min(
    ...arrays.map((arg) => (Array.isArray(arg) ? arg.length : 0))
  );
  for (let i = 0; i < length; i++) {
    result.push(arrays.map((arg) => arg[i]));
  }
  return result;
}

/**
 * $merge(arrayOfObjects) — shallow-merges an array of objects into a single
 * object, left to right; later entries' keys override earlier ones'.
 */
function fn_merge(arrOfObjects) {
  if (arrOfObjects === undefined) return undefined;

  // Object.create(null) - see genObjectConstructor's comment / CODE-REVIEW.md H5.
  const result = Object.create(null);
  arrOfObjects.forEach((obj) => {
    if (typeof obj === 'object' && obj !== null) {
      for (const prop of Object.keys(obj)) {
        result[prop] = obj[prop];
      }
    }
  });
  return result;
}

module.exports = { fn_reverse, fn_shuffle, fn_zip, fn_merge };
