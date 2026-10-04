'use strict';

/**
 * A small bounded LRU keyed by string, shared by the compiler and the runtime:
 * the picture-driven built-ins
 * (`$formatNumber`/`$formatDateTime`/`$toMillis`/`$fromMillis`) memoize
 * picture analysis with it, and `$eval` memoizes compiled expressions with it
 * (jsonata2js.md P-1/P-3/M-1).
 *
 * Analysing a date/time or number picture — splitting it, validating it and
 * building the component spec (and, for `$toMillis`, compiling a `RegExp`
 * from it) — costs far more than the actual format/parse it feeds, and every
 * one of those built-ins re-did it on every call. A `$formatNumber` or
 * `$fromMillis` inside a `$map` over thousands of rows paid it per row
 * (jsonata2js.md P-1). The picture is almost always a literal, so a tiny
 * cache turns that into one analysis per distinct picture.
 *
 * Deliberately simple and bounded in BOTH entry count and total key bytes:
 * a picture can come from data (`$formatNumber(v, row.picture)`), so an
 * unbounded map keyed by it would be a memory-growth vector. Insertion order
 * is the eviction order (`Map` preserves it) and a hit re-inserts, which
 * gives true LRU behaviour without a second data structure.
 *
 * Cached values must be treated as IMMUTABLE by callers — they are shared
 * across every call with the same picture.
 */

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_MAX_KEY_BYTES = 64 * 1024;

class BoundedCache {
  constructor(maxEntries, maxKeyBytes) {
    this._map = new Map();
    this._maxEntries = maxEntries || DEFAULT_MAX_ENTRIES;
    this._maxKeyBytes = maxKeyBytes || DEFAULT_MAX_KEY_BYTES;
    this._keyBytes = 0;
  }

  /** Returns the cached analysis for `key`, computing (and storing) it via `compute` on a miss. */
  get(key, compute) {
    const hit = this._map.get(key);
    if (hit !== undefined) {
      // Refresh recency: delete + set moves it to the end of the iteration
      // order, so `evict` always drops the genuinely least-recently-used key.
      this._map.delete(key);
      this._map.set(key, hit);
      return hit;
    }
    // `compute` may throw (an invalid picture is a D308x error) — nothing is
    // cached in that case, so the same error is reported again next time.
    const value = compute();
    // A single absurd key is not worth caching at all.
    if (key.length > this._maxKeyBytes) return value;
    this._map.set(key, value);
    this._keyBytes += key.length;
    while (this._map.size > this._maxEntries || this._keyBytes > this._maxKeyBytes) {
      const oldest = this._map.keys().next();
      if (oldest.done) break;
      this._map.delete(oldest.value);
      this._keyBytes -= oldest.value.length;
    }
    return value;
  }

  /** Test/diagnostic hook. */
  get size() {
    return this._map.size;
  }

  clear() {
    this._map.clear();
    this._keyBytes = 0;
  }
}

module.exports = { BoundedCache, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_KEY_BYTES };
