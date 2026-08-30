'use strict';

/**
 * Function-value and regex-value conventions (design.md D2 last two rows).
 *
 * Function value: a native JS `function` tagged with `._jsonataArity` (its
 * declared JSONata parameter count) and optionally `._jsonataSignature`
 * (raw `<...>` signature string, used by the bound-function signature
 * grammar in the public API). Every compiled lambda and every built-in
 * exposed as a first-class value MUST carry `._jsonataArity` so `$type()`,
 * higher-order-function callback wiring (arity-based tuple unpacking), and
 * partial application can all inspect it without a runtime probe call.
 *
 * Regex value: a native `RegExp`, always compiled with a forced trailing
 * `g` flag (JSONata regex literals are always "repeated match" — see
 * jsonata/src/parser.js `scanRegex`), so `x instanceof RegExp` alone is a
 * sufficient/necessary test for "is this a JSONata regex value".
 */

function isFunctionValue(v) {
  return typeof v === 'function';
}

function isRegexValue(v) {
  return v instanceof RegExp;
}

/** Tags `fn` as a JSONata function value with the given declared arity. `depthCost` (default 1) is how much one non-tail call to `fn` weighs against `LAM`'s depth guardrail - see `lambda.js#applyFn`. */
function tagFunction(fn, arity, signature, depthCost) {
  fn._jsonataArity = arity;
  if (signature) fn._jsonataSignature = signature;
  fn._jsonataDepthCost = depthCost || 1;
  return fn;
}

/** Declared parameter count of a function value, or -1 if untagged/unknown. */
function arityOf(fn) {
  if (typeof fn !== 'function') return -1;
  return typeof fn._jsonataArity === 'number' ? fn._jsonataArity : fn.length;
}

/** Compiles a JSONata regex literal (pattern/flags already split by the lexer) to a forced-`g` RegExp. */
function compileRegexLiteral(pattern, flags) {
  const f = flags && flags.length ? flags : '';
  return new RegExp(pattern, f.includes('g') ? f : f + 'g');
}

// ---------------------------------------------------------------------------
// Inline lambda `<sig>` type validation (design.md's "full XPath-style
// argument matching" for an *immediately-called* lambda carrying a type
// signature, e.g. `function($x,$y)<n-n:n>{...}(6)`). Scoped down like
// `builtins.js#withSignature`: per-parameter base type (single letter or
// `(union)`), `a<subtype>` array-element checking, and `?`/`-` optional
// modifiers are honored; `+` (one-or-more repetition/absorption) is
// treated as a plain required parameter rather than absorbing multiple
// call arguments into one - real jsonata's regex-based variadic argument
// matching is not replicated.
// ---------------------------------------------------------------------------

function typeMatchesChar(value, code) {
  switch (code) {
    case 'x': case 'j': return true;
    case 's': return typeof value === 'string';
    case 'n': return typeof value === 'number';
    case 'b': return typeof value === 'boolean';
    case 'a': return Array.isArray(value);
    case 'o': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'f': return typeof value === 'function' || isRegexValue(value);
    case 'u': return value === undefined;
    default: return true;
  }
}

/** Parses a signature's parameter section (the part before `:`, inside the outer `<...>`) into `{ types, subtype, modifier }` descriptors, one per declared parameter. */
function parseSignatureParams(paramsStr) {
  const specs = [];
  let i = 0;
  while (i < paramsStr.length) {
    let types;
    if (paramsStr[i] === '(') {
      const end = paramsStr.indexOf(')', i);
      types = paramsStr.slice(i + 1, end).split('');
      i = end + 1;
    } else {
      types = [paramsStr[i]];
      i++;
    }
    let subtype = null;
    if (types.length === 1 && paramsStr[i] === '<') {
      // Track bracket depth so a nested annotation (`a<a<n>>`, `f<n:n>`)
      // finds its *matching* `>`, not the first inner one. Only an `a`
      // (array) type's bracket content is a validated element subtype;
      // any other type's bracket content (e.g. `f<n:n>`, a higher-order
      // function's own parameter/return signature) is consumed here so it
      // doesn't get misread as further parameter specs, but is otherwise
      // unvalidated - matching this module's documented scope (function
      // values aren't introspected for their own declared signature).
      let depth = 1;
      let end = i + 1;
      while (end < paramsStr.length && depth > 0) {
        if (paramsStr[end] === '<') depth++;
        else if (paramsStr[end] === '>') depth--;
        end++;
      }
      if (types[0] === 'a') subtype = paramsStr.slice(i + 1, end - 1);
      i = end;
    }
    let modifier = null;
    if (i < paramsStr.length && '?+-'.includes(paramsStr[i])) {
      modifier = paramsStr[i];
      i++;
    }
    specs.push({ types, subtype, modifier });
  }
  return specs;
}

/**
 * Validates `args` (already-evaluated call arguments) against a `<...>`
 * signature string, auto-wrapping a non-array scalar passed to an
 * `a`-typed parameter into a single-element array (same coercion rule as
 * `builtins.js#withSignature`); returns the (possibly rewritten) args
 * array, or throws T0410 (arity/base-type mismatch) / T0412 (array
 * element type mismatch). Missing (`undefined`) arguments are never
 * type-checked, matching jsonata's own optional-argument propagation.
 * A `+` (one-or-more) spec greedily absorbs and validates every leading
 * unconsumed argument *except* however many the specs after it still need
 * (each counted as needing exactly one, whether required or `+`) -
 * approximates real jsonata's regex-based variadic matching for the
 * common "one repeating spec" case without full backtracking.
 *
 * A `-` (context-default) spec substitutes `context` (the caller's
 * current `$`) whenever there aren't enough remaining explicit `args` to
 * cover it *and* every spec still to come (mirroring jsonata's own
 * "supplied one argument short -> the omitted slot borrows `$`" rule,
 * applied positionally instead of via full regex backtracking) - throws
 * T0411 if `context` doesn't match that parameter's declared type. A
 * fully-supplied call (enough explicit args for every spec) never
 * substitutes - the `-` spec is then just an ordinary required parameter.
 */
function validateSignatureArgs(signature, args, context) {
  const { JsonataEvaluationError } = require('../errors');
  const err = (code, extra) => new JsonataEvaluationError(code, extra);
  const m = /^<([^:]*)(?::.*)?>$/.exec(signature);
  const specs = parseSignatureParams(m ? m[1] : '');
  const hasRepeat = specs.some((s) => s.modifier === '+');
  const minRequired = specs.filter((s) => s.modifier !== '?' && s.modifier !== '-').length;
  if (!hasRepeat && args.length > specs.length) throw err('T0410', { index: specs.length + 1 });
  if (args.length < minRequired) throw err('T0410', { index: args.length + 1 });
  const out = args.slice();

  const checkOne = (i, spec) => {
    const v = out[i];
    if (v === undefined) return;
    if (spec.types.length === 1 && spec.types[0] === 'a' && !Array.isArray(v)) {
      out[i] = [v];
    } else if (!spec.types.some((t) => typeMatchesChar(v, t))) {
      throw err('T0410', { index: i + 1 });
    }
    if (spec.subtype) {
      for (const el of out[i]) {
        if (el !== undefined && !typeMatchesChar(el, spec.subtype)) {
          throw err('T0412', { index: i + 1, type: spec.subtype });
        }
      }
    }
  };

  /** Non-throwing check used by an optional (`?`) spec to decide whether it should consume `out[i]` at all - an array (`a`) type always matches (any scalar auto-wraps). */
  const specMatches = (i, spec) => {
    const v = out[i];
    return v === undefined || (spec.types.length === 1 && spec.types[0] === 'a') || spec.types.some((t) => typeMatchesChar(v, t));
  };

  let argIdx = 0;
  for (let s = 0; s < specs.length && argIdx <= out.length; s++) {
    const spec = specs[s];
    if (spec.modifier === '-' && out.length - argIdx < specs.length - s) {
      if (context === undefined || !spec.types.some((t) => typeMatchesChar(context, t))) {
        throw err('T0411', { index: argIdx + 1 });
      }
      out.splice(argIdx, 0, context);
      argIdx++;
      continue;
    }
    if (argIdx >= out.length) break;
    if (spec.modifier === '+') {
      // A `+`/required spec later in the signature still needs at least one
      // argument of its own to reserve for - an `?`/`-` spec never does
      // (it can match zero explicit args, falling back to absence/context),
      // so only count non-optional specs here or a lone trailing number
      // gets wrongly withheld from this `+` to "reserve" for a spec that
      // was always going to be satisfied some other way.
      const reserveForRest = specs.slice(s + 1).filter((sp) => sp.modifier !== '?' && sp.modifier !== '-').length;
      // Greedily consume while the next arg still fits *this* spec's own
      // type and enough remain for the reserved specs - approximating
      // regex backtracking for the common case where a later spec's type
      // diverges from this one (e.g. `n+s-` called with `(1, 2, "a")`:
      // `n+` must stop at the number run's end, leaving `"a"` for `s-`,
      // rather than greedily absorbing it and only then failing its
      // number check).
      let absorbed = 0;
      while (argIdx < out.length && (out.length - argIdx) > reserveForRest && specMatches(argIdx, spec)) {
        checkOne(argIdx, spec);
        argIdx++;
        absorbed++;
      }
      if (absorbed === 0 && argIdx < out.length) {
        // Consume exactly one to satisfy `+`'s minimum-one requirement,
        // even though it didn't type-match - reproduces this case's
        // precise T0410 error instead of silently passing zero through.
        checkOne(argIdx, spec);
        argIdx++;
      }
    } else if (spec.modifier === '?') {
      // An optional spec that doesn't match the next explicit arg is
      // "zero occurrences" - skip it (no throw, no consume) and let a
      // later spec try that same argument instead.
      if (specMatches(argIdx, spec)) {
        checkOne(argIdx, spec);
        argIdx++;
      }
    } else {
      checkOne(argIdx, spec);
      argIdx++;
    }
  }
  // Every spec has now had its turn; any explicit arg still unconsumed
  // means the type pattern didn't cover the whole args list (e.g. `nn+`
  // against `(1,3,2,"g")` - the number run ends at "g", which no spec
  // claims) - real jsonata's anchored regex match would fail the same way.
  if (argIdx < out.length) throw err('T0410', { index: argIdx + 1 });
  return out;
}

module.exports = { isFunctionValue, isRegexValue, tagFunction, arityOf, compileRegexLiteral, validateSignatureArgs };
