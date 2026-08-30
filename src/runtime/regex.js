'use strict';

/**
 * Regex-form string built-ins ($match, $contains, $replace, $split) — ports
 * jsonata's matcher-closure protocol (jsonata/src/jsonata.js `evaluateRegex`)
 * adapted to a plain native `RegExp` (jsonata2js's regex value model, see
 * function-value.js `compileRegexLiteral`: always forced-`g`) instead of a
 * pluggable `RegexEngine`/Joni abstraction — no engine indirection needed.
 *
 * The plain-string overloads of these same JSONata function names
 * ($contains(str,token), $replace(str,pattern,...), $split(str,sep,...))
 * live in string.js; the functions here are the regex-pattern branches only
 * (jsonata/src/functions.js `contains`/`match`/`replace`/`split`, the
 * `typeof token !== 'string'` / `typeof pattern !== 'string'` branches).
 * Only `$match`'s result is a jsonata *sequence* (built via
 * `this.createSequence()` in real jsonata, `RT.collapse` here) - `$split`'s
 * plain-array result and `$contains`'s boolean never collapse.
 */

const { JsonataEvaluationError } = require('../errors');
const RT = require('./values');

/**
 * True if `result` has enough of the matcher-closure shape
 * (`{match,start,end,groups,next}`) to be accepted - jsonata's own
 * `evaluateMatcher` check: *any one* of `start`/`end` being a number,
 * `groups` being an array, or `next` being a function is sufficient (an
 * intentionally loose OR, not a full shape check).
 */
function isValidMatchResult(result) {
  return !!result && (
    typeof result.start === 'number' ||
    typeof result.end === 'number' ||
    Array.isArray(result.groups) ||
    typeof result.next === 'function'
  );
}

/**
 * Wraps a validated custom-matcher result so calling `.next()` on it (and
 * on every subsequent result in the chain) drives `LAM.unwind` first. A
 * compiled JSONata lambda's tail-position body call (e.g. `'next':
 * function() {$match(...)}`, itself calling `$match` in tail position)
 * returns a deferred tail-call thunk, not the real value, when invoked as
 * a plain JS closure the way `fn_match`/`fn_split`/etc. call `.next()` -
 * outside the normal `LAM.applyFn`/`unwind` call path every other
 * function-value invocation goes through. `lambda.js` requires this
 * module lazily for its own regex-value call branch, so this requires it
 * back lazily too (both requires happen inside a function body, after
 * module load has completed, avoiding a circular-require deadlock).
 */
function wrapCustomMatchResult(m, matcherLabel) {
  if (typeof m.next !== 'function') return m;
  const rawNext = m.next;
  return Object.assign({}, m, {
    next() {
      const { unwind } = require('./lambda');
      const r = unwind(rawNext());
      if (r === undefined) return undefined;
      if (!isValidMatchResult(r)) throw new JsonataEvaluationError('T1010', { token: matcherLabel });
      return wrapCustomMatchResult(r, matcherLabel);
    },
  });
}

/**
 * Builds one matcher-closure result over an ALREADY-OWNED `re` (a private
 * clone - see `regexClosure`) for `str`, starting the search at
 * `fromIndex`. Mirrors jsonata's own `evaluateRegex` closure exactly,
 * including its non-advancing zero-length-match semantics: `RegExp#exec`
 * with the `g` flag leaves `lastIndex` unchanged after a zero-length
 * match, so a caller who keeps calling `.next()` without manually
 * advancing would loop forever — jsonata (and we) detect that one step
 * ahead and throw D1004 instead of hanging.
 */
function matchFrom(re, str, fromIndex, matcherLabel) {
  re.lastIndex = fromIndex || 0;
  const m = re.exec(str);
  if (m === null) return undefined;

  const result = {
    match: m[0],
    start: m.index,
    end: m.index + m[0].length,
    groups: [],
  };
  for (let i = 1; i < m.length; i++) {
    result.groups.push(m[i]);
  }
  result.next = function next() {
    if (re.lastIndex >= str.length) return undefined;
    const nextResult = matchFrom(re, str, re.lastIndex, matcherLabel);
    if (nextResult && nextResult.match === '') {
      // matches zero length string; this will never progress
      throw new JsonataEvaluationError('D1004', { value: re.source });
    }
    return nextResult;
  };
  return result;
}

/**
 * Builds one matcher-closure result over `pattern` for `str`, starting the
 * search at `fromIndex`. `pattern` is either a compiled regex value (a
 * native `RegExp`) or an arbitrary JSONata function value used as a
 * *custom* matcher (jsonata's pluggable-matcher convention: called with
 * just `str`, returning `{match,start,end,groups,next}` or `undefined`;
 * `next()` - zero-arg - continues the search). `matcherLabel` names the
 * calling built-in for a T1010 ("does not return the correct object
 * structure") message when a custom matcher's result fails shape
 * validation.
 *
 * When `pattern` is a `RegExp`, it is CLONED here before any match is
 * attempted: the translator hoists one shared `RegExp` instance per
 * distinct regex literal (`gen-ctx.js#hoistRegex`) and reuses it across
 * every evaluation of that literal, but `RegExp#exec` with the `g` flag
 * mutates `.lastIndex` in place — without a private clone, a *reentrant*
 * use of the same literal (e.g. a `$match`/`$replace` callback that itself
 * calls `$match` against the same `/pattern/`) corrupts the outer match
 * session's cursor and can loop forever (upstream jsonata sidesteps this
 * by building a fresh `RegexEngine` per node evaluation - see
 * `gen-ctx.js#hoistRegex`'s own comment). Cloning once per top-level
 * session (not once per `.next()` step, which stays on the owned clone
 * via `matchFrom`) matches that granularity at negligible cost.
 *
 * @returns {{match:string,start:number,end:number,groups:Array<string|undefined>,next:Function}|undefined}
 */
function regexClosure(pattern, str, fromIndex, matcherLabel) {
  if (typeof pattern === 'function') {
    const m = pattern(str);
    if (m === undefined) return undefined;
    if (!isValidMatchResult(m)) throw new JsonataEvaluationError('T1010', { token: matcherLabel });
    return wrapCustomMatchResult(m, matcherLabel);
  }
  const re = new RegExp(pattern.source, pattern.flags);
  return matchFrom(re, str, fromIndex, matcherLabel);
}

/**
 * $match(str, pattern [, limit]) — regex form. Returns an array of
 * `{match, index, groups}` objects, one per match, in `pattern` order -
 * collapsed like any other jsonata sequence result (real jsonata builds
 * this via `this.createSequence()`, not a plain array): zero matches
 * yields `undefined`, not `[]`; exactly one match yields that bare
 * `{match,index,groups}` object, not a one-element array. Matches
 * `hof.js`'s established `RT.collapse(..., false)` convention for every
 * other sequence-building built-in ($filter/$map/$each/...).
 */
function fn_match(str, pattern, limit) {
  if (str === undefined) return undefined;

  // limit, if specified, must be a non-negative number
  if (limit < 0) {
    throw new JsonataEvaluationError('D3040', { value: limit });
  }

  const result = [];

  if (limit === undefined || limit > 0) {
    let count = 0;
    let matches = regexClosure(pattern, str, 0, 'match');
    while (matches !== undefined && (limit === undefined || count < limit)) {
      result.push({ match: matches.match, index: matches.start, groups: matches.groups });
      matches = matches.next();
      count++;
    }
  }

  return RT.collapse(result, false);
}

/**
 * $contains(str, pattern) — regex form. True iff `pattern` matches anywhere
 * in `str`.
 */
function fn_contains(str, pattern) {
  if (str === undefined || pattern === undefined) return undefined;
  const matches = regexClosure(pattern, str, 0, 'contains');
  return matches !== undefined;
}

/**
 * Builds the string replacer for `$replace`'s `$N`/`$$`/`$0` backreference
 * syntax, ported verbatim from jsonata's `replace` (the closure captured
 * over the literal `replacement` string). Operates on a raw matcher-closure
 * result (`{match, groups, ...}`), matching jsonata's actual calling
 * convention (NOT the remapped `{match, index, groups}` shape `$match`
 * returns — verified against real jsonata: the function-replacer form of
 * `$replace` is invoked with the raw closure object, `start`/`end`/`next`
 * included).
 */
function makeStringReplacer(replacement) {
  return function replacer(regexMatch) {
    let substitute = '';
    let position = 0;
    let index = replacement.indexOf('$', position);
    while (index !== -1 && position < replacement.length) {
      substitute += replacement.substring(position, index);
      position = index + 1;
      const dollarVal = replacement.charAt(position);
      if (dollarVal === '$') {
        // literal $
        substitute += '$';
        position++;
      } else if (dollarVal === '0') {
        substitute += regexMatch.match;
        position++;
      } else {
        let maxDigits;
        if (regexMatch.groups.length === 0) {
          // no sub-matches; any $ followed by a digit will be replaced by an empty string
          maxDigits = 1;
        } else {
          // max number of digits to parse following the $
          maxDigits = Math.floor(Math.log(regexMatch.groups.length) * Math.LOG10E) + 1;
        }
        let groupIndex = parseInt(replacement.substring(position, position + maxDigits), 10);
        if (maxDigits > 1 && groupIndex > regexMatch.groups.length) {
          groupIndex = parseInt(replacement.substring(position, position + maxDigits - 1), 10);
        }
        if (!Number.isNaN(groupIndex)) {
          if (regexMatch.groups.length > 0) {
            const submatch = regexMatch.groups[groupIndex - 1];
            if (submatch !== undefined) {
              substitute += submatch;
            }
          }
          position += groupIndex.toString().length;
        } else {
          // not a capture group, treat the $ as literal
          substitute += '$';
        }
      }
      index = replacement.indexOf('$', position);
    }
    substitute += replacement.substring(position);
    return substitute;
  };
}

/**
 * $replace(str, pattern, replacement [, limit]) — regex form. `replacement`
 * is either a literal string (with `$N`/`$$`/`$0` backreference expansion)
 * or a function value invoked per match with the raw matcher-closure result
 * and expected to return a string (D3012 otherwise).
 */
function fn_replace(str, pattern, replacement, limit) {
  if (str === undefined) return undefined;

  // limit, if specified, must be a non-negative number
  if (limit < 0) {
    throw new JsonataEvaluationError('D3011', { value: limit });
  }

  const replacer = typeof replacement === 'string' ? makeStringReplacer(replacement) : replacement;

  let result = '';
  let position = 0;

  if (limit === undefined || limit > 0) {
    let count = 0;
    let matches = regexClosure(pattern, str, 0, 'replace');
    if (matches !== undefined) {
      while (matches !== undefined && (limit === undefined || count < limit)) {
        result += str.substring(position, matches.start);
        const replacedWith = replacer(matches);
        if (typeof replacedWith === 'string') {
          result += replacedWith;
        } else {
          throw new JsonataEvaluationError('D3012', { value: replacedWith });
        }
        position = matches.start + matches.match.length;
        count++;
        matches = matches.next();
      }
      result += str.substring(position);
    } else {
      result = str;
    }
  } else {
    result = str;
  }

  return result;
}

/**
 * $split(str, pattern [, limit]) — regex form. Splits `str` at every
 * `pattern` match, dropping the matched separator text itself.
 */
function fn_split(str, pattern, limit) {
  if (str === undefined) return undefined;

  // limit, if specified, must be a non-negative number
  if (limit < 0) {
    throw new JsonataEvaluationError('D3020', { value: limit });
  }

  const result = [];

  if (limit === undefined || limit > 0) {
    let count = 0;
    let matches = regexClosure(pattern, str, 0, 'split');
    if (matches !== undefined) {
      let start = 0;
      while (matches !== undefined && (limit === undefined || count < limit)) {
        result.push(str.substring(start, matches.start));
        start = matches.end;
        matches = matches.next();
        count++;
      }
      if (limit === undefined || count < limit) {
        result.push(str.substring(start));
      }
    } else {
      result.push(str);
    }
  }

  return result;
}

module.exports = { fn_match, fn_contains, fn_replace, fn_split, regexClosure };
