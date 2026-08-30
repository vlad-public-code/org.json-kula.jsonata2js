'use strict';

/**
 * Central built-in-function registry: assembles every runtime module into
 * one `{ name -> function }` map, tags every entry with `._jsonataArity`
 * (design.md D2 function-value convention) and records which entries
 * support JSONata's signature "context default" (`-` marker: if called
 * with fewer arguments than declared, the current context `$` is used for
 * the first missing parameter) — verified against every `staticFrame.bind`
 * call in jsonata's `src/jsonata.js` function-registration block.
 *
 * `contains`/`replace`/`split`/`match` dispatch between the plain-string
 * overload (`runtime/string.js`) and the regex overload (`runtime/regex.js`)
 * based on the actual argument's runtime type, since JSONata's signature
 * allows either (`(sf)` union type).
 */

const { tagFunction } = require('./function-value');
const S = require('./string');
const NUM = require('./numeric');
const CODEC = require('./codec');
const CORE = require('./core');
// `datetime.js` (50 KB of XPath picture-string machinery) and `regex.js` are
// deferred: an expression that touches neither pays neither. They cost 3.6 ms
// and 1.4 ms of a 17.9 ms `require('jsonata2js')`, and the first date/regex
// call in a process pays that once instead. `lambda.js` already required
// `./regex` lazily for the same reason.
let _DT = null;
const DT = () => _DT || (_DT = require('./datetime'));
let _REGEX = null;
const REGEX = () => _REGEX || (_REGEX = require('./regex'));
const COLL = require('./collections');
const HOF = require('./hof');
const OBJ = require('./objects');
const { err } = require('./values');
const { isRegexValue, isFunctionValue } = require('./function-value');
const { currentClock } = require('./clock');

function isMatcherValue(v) {
  return isRegexValue(v) || isFunctionValue(v);
}

function dispatchContains(str, pattern) {
  return isMatcherValue(pattern) ? REGEX().fn_contains(str, pattern) : S.fn_contains(str, pattern);
}
function dispatchSplit(str, separator, limit) {
  return isMatcherValue(separator) ? REGEX().fn_split(str, separator, limit) : S.fn_split(str, separator, limit);
}
function dispatchReplace(str, pattern, replacement, limit) {
  if (str === undefined) return undefined;
  if (isMatcherValue(pattern)) return REGEX().fn_replace(str, pattern, replacement, limit);
  if (typeof replacement !== 'string') throw err('D3012', { value: replacement });
  if (pattern === '') throw err('D3010');
  if (limit !== undefined) {
    if (typeof limit !== 'number' || limit < 0) throw err('D3011', { value: limit, index: 4 });
    if (limit === 0) return str;
  }
  const n = limit === undefined ? Infinity : limit;
  let result = '';
  let rest = str;
  let count = 0;
  let idx;
  while (count < n && (idx = rest.indexOf(pattern)) !== -1) {
    result += rest.slice(0, idx) + replacement;
    rest = rest.slice(idx + pattern.length);
    count++;
  }
  return result + rest;
}

// ---------------------------------------------------------------------------
// Lightweight signature validation (design.md task 9.3's scoped-down bound-
// function grammar, reused here for jsonata2js's own built-ins): checks
// declared arity (extra arguments beyond the signature -> T0410) and each
// provided argument's type against a single-letter type code ('s' string,
// 'n' number, 'b' boolean, 'a' array, 'o' object, 'f' function/regex,
// 'x' any). Missing (`undefined`) arguments are never checked — they
// propagate per the runtime-value-semantics capability.
// ---------------------------------------------------------------------------

function typeMatches(value, code) {
  switch (code) {
    case 'x': return true;
    case 's': return typeof value === 'string';
    case 'n': return typeof value === 'number';
    case 'b': return typeof value === 'boolean';
    case 'a': return Array.isArray(value);
    case 'o': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'f': return typeof value === 'function' || isRegexValue(value);
    default: return true;
  }
}

/**
 * Wraps `fn` (declared arity = `paramCodes.length`) with argument-count and
 * per-argument type validation. `paramCodes[i]` may be a single type code
 * string or an array of alternatives (union type, e.g. `['s','f']`).
 * `minArity` (default: every declared param is required) is the number of
 * *leading* params that are mandatory; a call with fewer arguments than
 * that throws T0410 (matching real jsonata's `?`-suffixed optional-param
 * signature notation) - trailing params beyond `minArity` may be omitted
 * (left `undefined`) freely.
 */
function withSignature(name, fn, paramCodes, minArity) {
  const min = minArity === undefined ? paramCodes.length : minArity;
  const maxArity = paramCodes.length;
  // Normalized once per built-in at registry-build time, not once per
  // argument per call: a union code (`['s','f']`) stays as-is, a single code
  // is lifted into a one-element array, and the "coerce a scalar into a
  // one-element array" case (`['a']`) is precomputed into a flag. This used
  // to allocate an array per argument plus a closure per `.some()` call on
  // every built-in invocation.
  const alts = paramCodes.map((c) => (Array.isArray(c) ? c : [c]));
  const coerceToArray = alts.map((a) => a.length === 1 && a[0] === 'a');

  /** Validates one argument, returning it (possibly array-coerced). */
  const checkArg = (i, v) => {
    // 'a'-typed params auto-wrap a non-array scalar into a single-element
    // array (JSONata's own general signature-coercion rule for array types),
    // rather than rejecting it as a type mismatch.
    if (coerceToArray[i]) return Array.isArray(v) ? v : [v];
    const codes = alts[i];
    for (let c = 0; c < codes.length; c++) {
      if (typeMatches(v, codes[c])) return v;
    }
    throw err('T0410', { index: i + 1, token: name });
  };
  const checkCount = (n) => {
    if (n > maxArity) throw err('T0410', { index: maxArity + 1, token: name });
    if (n < min) throw err('T0410', { index: n + 1, token: name });
  };

  // Arity-specialized wrappers: a fixed parameter list avoids the rest-array
  // allocation on every built-in call plus the spread at the call to `fn`
  // (`arguments.length` alone does not materialize the arguments object).
  // Anything wider than 3 declared parameters is rare enough to keep the
  // generic form.
  switch (maxArity) {
    case 0:
      return function () {
        checkCount(arguments.length);
        return fn();
      };
    case 1:
      return function (a0) {
        checkCount(arguments.length);
        return fn(a0 === undefined ? a0 : checkArg(0, a0));
      };
    case 2:
      return function (a0, a1) {
        checkCount(arguments.length);
        return fn(
          a0 === undefined ? a0 : checkArg(0, a0),
          a1 === undefined ? a1 : checkArg(1, a1)
        );
      };
    case 3:
      return function (a0, a1, a2) {
        checkCount(arguments.length);
        return fn(
          a0 === undefined ? a0 : checkArg(0, a0),
          a1 === undefined ? a1 : checkArg(1, a1),
          a2 === undefined ? a2 : checkArg(2, a2)
        );
      };
    default:
      return (...args) => {
        checkCount(args.length);
        for (let i = 0; i < args.length; i++) {
          if (args[i] !== undefined) args[i] = checkArg(i, args[i]);
        }
        return fn(...args);
      };
  }
}
/** Function names whose first parameter defaults to the current context `$` when omitted. */
const CONTEXT_DEFAULT = new Set([
  'string', 'substring', 'substringBefore', 'substringAfter', 'lowercase', 'uppercase',
  'length', 'trim', 'pad', 'match', 'contains', 'replace', 'split', 'formatNumber',
  'formatBase', 'formatInteger', 'parseInteger', 'number', 'floor', 'ceil', 'round',
  'abs', 'sqrt', 'power', 'boolean', 'not', 'sift', 'keys', 'lookup', 'spread', 'each',
  'base64encode', 'base64decode', 'encodeUrlComponent', 'encodeUrl', 'decodeUrlComponent',
  'decodeUrl', 'toMillis', 'fromMillis', 'clone',
]);

/**
 * Full parameter count of every `CONTEXT_DEFAULT` function *that has no
 * other optional trailing parameter* (i.e. every parameter after the
 * context-defaulted first one is mandatory) - lets the translator
 * recognize "every parameter but the context-defaulted first one was
 * supplied" (e.g. `$each(fn)`) and shift the given arguments right past
 * the omitted context parameter. Functions with *additional* optional
 * trailing parameters (e.g. `substring`'s optional `length`, `round`'s
 * optional `precision`) are deliberately excluded: a call one argument
 * short of their max arity is ambiguous between "context omitted" and
 * "trailing optional omitted" without replicating jsonata's full
 * regex-based per-argument-type signature matcher (`signature.js`), so
 * those still only default the context on a *zero*-argument call.
 */
const CONTEXT_DEFAULT_MAX_ARITY = {
  substringBefore: 2, substringAfter: 2, contains: 2, formatInteger: 2,
  parseInteger: 2, power: 2, sift: 2, lookup: 2, each: 2,
};

/**
 * `name -> { fn, arity, contextDefault }`. `arity` is the DECLARED arity used
 * for `._jsonataArity` tagging (so `$type()`/HOF arity-dispatch/partial
 * application see the right value); it is the function's full JS parameter
 * count, matching jsonata's documented signatures.
 *
 * The registry is clock-independent and therefore built ONCE per process
 * (see index.js's `BUILTINS`), not once per `evaluate()` call: `$now()`/
 * `$millis()` read the clock snapshot the active evaluation pushed onto
 * `runtime/clock.js`'s stack (`currentClock()`), so a shared registry still
 * observes the correct per-evaluation timestamp. Rebuilding it per call cost
 * ~5% of evaluation CPU time plus the GC pressure of ~110 fresh signature
 * closures per call (measured with `node --cpu-prof`, see docs/performance.md).
 */
function buildRegistry() {
  const entries = {
    sum: [withSignature('sum', HOF.sumAgg, ['x']), 1],
    count: [withSignature('count', HOF.countAgg, ['x']), 1],
    max: [withSignature('max', HOF.maxAgg, ['x']), 1],
    min: [withSignature('min', HOF.minAgg, ['x']), 1],
    average: [withSignature('average', HOF.averageAgg, ['x']), 1],

    string: [withSignature('string', S.fn_string, ['x', 'b'], 1), 1],
    substring: [withSignature('substring', S.fn_substring, ['s', 'n', 'n'], 2), 2],
    substringBefore: [withSignature('substringBefore', S.fn_substringBefore, ['s', 's']), 2],
    substringAfter: [withSignature('substringAfter', S.fn_substringAfter, ['s', 's']), 2],
    lowercase: [withSignature('lowercase', S.fn_lowercase, ['s']), 1],
    uppercase: [withSignature('uppercase', S.fn_uppercase, ['s']), 1],
    length: [withSignature('length', S.fn_length, ['s']), 1],
    trim: [withSignature('trim', S.fn_trim, ['s']), 1],
    pad: [withSignature('pad', S.fn_pad, ['s', 'n', 's'], 2), 2],
    join: [withSignature('join', S.fn_join, ['a', 's'], 1), 1],
    match: [withSignature('match', (str, pattern, limit) => REGEX().fn_match(str, pattern, limit), ['s', 'f', 'n'], 2), 2],
    contains: [withSignature('contains', dispatchContains, ['s', ['s', 'f']]), 2],
    replace: [withSignature('replace', dispatchReplace, ['s', ['s', 'f'], ['s', 'f'], 'n'], 3), 3],
    split: [withSignature('split', dispatchSplit, ['s', ['s', 'f'], 'n'], 2), 2],

    formatNumber: [withSignature('formatNumber', NUM.fn_formatNumber, ['n', 's', 'o'], 2), 2],
    formatBase: [withSignature('formatBase', NUM.fn_formatBase, ['n', 'n'], 1), 1],
    formatInteger: [withSignature('formatInteger', (value, picture) => DT().fn_formatInteger(value, picture), ['n', 's']), 2],
    parseInteger: [withSignature('parseInteger', (value, picture) => DT().fn_parseInteger(value, picture), ['s', 's']), 2],
    number: [withSignature('number', NUM.fn_number, [['n', 's', 'b']]), 1],
    floor: [withSignature('floor', NUM.fn_floor, ['n']), 1],
    ceil: [withSignature('ceil', NUM.fn_ceil, ['n']), 1],
    round: [withSignature('round', NUM.fn_round, ['n', 'n'], 1), 1],
    abs: [withSignature('abs', NUM.fn_abs, ['n']), 1],
    sqrt: [withSignature('sqrt', NUM.fn_sqrt, ['n']), 1],
    power: [withSignature('power', NUM.fn_power, ['n', 'n']), 2],
    random: [withSignature('random', NUM.fn_random, [], 0), 0],

    boolean: [withSignature('boolean', CORE.fn_boolean, ['x']), 1],
    not: [withSignature('not', CORE.fn_not, ['x']), 1],
    exists: [withSignature('exists', CORE.fn_exists, ['x']), 1],
    type: [withSignature('type', CORE.fn_type, ['x'], 1), 1],
    error: [withSignature('error', CORE.fn_error, ['s'], 0), 0],
    assert: [withSignature('assert', CORE.fn_assert, ['b', 's'], 1), 1],
    clone: [withSignature('clone', CORE.fn_clone, [['o', 'a']]), 1],



    map: [HOF.mapSeq, 2], filter: [HOF.filterSeq, 2], single: [HOF.singleSeq, 2],
    reduce: [HOF.reduceSeq, 3], sift: [HOF.siftObj, 2], each: [HOF.eachSeq, 2],
    sort: [HOF.sortArr, 2], distinct: [HOF.distinctArr, 1],

    keys: [OBJ.fn_keys, 1], lookup: [OBJ.fn_lookup, 2], append: [OBJ.fn_append, 2],
    spread: [OBJ.fn_spread, 1], flatten: [OBJ.fn_flatten, 1],

    reverse: [withSignature('reverse', COLL.fn_reverse, ['a']), 1],
    shuffle: [withSignature('shuffle', COLL.fn_shuffle, ['a']), 1],
    zip: [COLL.fn_zip, 8],
    merge: [withSignature('merge', COLL.fn_merge, ['a']), 1],

    base64encode: [withSignature('base64encode', CODEC.fn_base64encode, ['s']), 1],
    base64decode: [withSignature('base64decode', CODEC.fn_base64decode, ['s']), 1],
    encodeUrlComponent: [withSignature('encodeUrlComponent', CODEC.fn_encodeUrlComponent, ['s']), 1],
    encodeUrl: [withSignature('encodeUrl', CODEC.fn_encodeUrl, ['s']), 1],
    decodeUrlComponent: [withSignature('decodeUrlComponent', CODEC.fn_decodeUrlComponent, ['s']), 1],
    decodeUrl: [withSignature('decodeUrl', CODEC.fn_decodeUrl, ['s']), 1],

    toMillis: [withSignature('toMillis', (timestamp, picture) => DT().fn_toMillis(timestamp, picture), ['s', 's'], 1), 1],
    fromMillis: [withSignature('fromMillis', (millis, picture, tz) => DT().fn_fromMillis(millis, picture, tz), ['n', 's', 's'], 1), 1],
    // Resolved per call against the active evaluation's pushed snapshot, so
    // the registry itself carries no clock state (see clock.js's contract).
    now: [withSignature('now', (picture, timezone) => currentClock().now(picture, timezone), ['s', 's'], 0), 2],
    millis: [withSignature('millis', () => currentClock().millis(), [], 0), 0],
  };

  // Object.create(null): the registry is the terminus of every compiled
  // expression's `ENV` prototype chain (see index.js JsonataExpression -
  // `Object.create(B)` / `Object.create(baseEnv)`), so a plain `{}` here
  // would leak `Object.prototype` members (`$constructor`, `$valueOf`,
  // `$toString`, ...) as if they were resolvable JSONata built-ins, and
  // any error they raise escapes as a raw un-coded `TypeError` instead of
  // a `JsonataError` - see CODE-REVIEW.md H6.
  const registry = Object.create(null);
  for (const name of Object.keys(entries)) {
    const [fn, arity] = entries[name];
    registry[name] = tagFunction(fn, arity);
  }
  return registry;
}

module.exports = { buildRegistry, CONTEXT_DEFAULT, CONTEXT_DEFAULT_MAX_ARITY };
