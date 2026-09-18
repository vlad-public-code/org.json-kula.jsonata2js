'use strict';

/**
 * Public API (design.md capability `expression-public-api`): mirrors
 * JSonata2Java's `JsonataExpressionFactory`/`JsonataExpression`.
 *
 *   const jsonata2js = require('jsonata2js');
 *   const expr = jsonata2js.compile('Account.Order.OrderID');
 *   const result = expr.evaluate(data);
 */

const { parse } = require('./parser/parser');
const { optimize } = require('./optimizer/optimizer');
const { Translator } = require('./translator/translator');
const { loadFunction } = require('./loader/loader');
const { buildRegistry } = require('./runtime/builtins');
const { createClock, pushClock, popClock } = require('./runtime/clock');
const RT = require('./runtime/values');
const P = require('./runtime/path');
const H = require('./runtime/hof');
const LAM = require('./runtime/lambda');
const OBJ = require('./runtime/objects');
const STRUCT = require('./runtime/structural');
const FV = require('./runtime/function-value');
const {
  JsonataError,
  ParseError,
  JsonataCompilationError,
  JsonataLoadError,
  JsonataEvaluationError,
} = require('./errors');

// The builtin registry is clock-independent (`$now`/`$millis` read the
// active evaluation's pushed clock snapshot), so it is built once per
// process and shared as the prototype terminus of every evaluation's ENV
// chain — nothing ever writes to it. Rebuilding it per `evaluate()` call
// cost ~5% of evaluation CPU plus ~110 closure allocations per call.
const BUILTINS = buildRegistry();
// Every builtin name (static dispatch set for codegen).
const BUILTIN_NAMES = new Set(Object.keys(BUILTINS));

/**
 * Parses a `<params:return>`-shaped function signature string far enough to
 * recover its declared minimum arity — used by `registerFunction`'s optional
 * `signature` parameter (design.md/task 9.3's bound-function signature
 * grammar; full XPath-style type validation is out of scope, matching the
 * D4 reuse decision to prioritize breadth). Returns `{ arity }`.
 */
function parseSignatureArity(signature) {
  if (!signature) return { arity: undefined };
  const inner = /^<([^:>]*)/.exec(signature);
  if (!inner) return { arity: undefined };
  let count = 0;
  const body = inner[1];
  let depth = 0;
  for (const ch of body) {
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth--;
    else if (depth === 0 && /[a-zA-Z]/.test(ch)) count++;
  }
  return { arity: count };
}

/**
 * Compiles `exprSource` to its evaluator `($, $$, ENV) => value`.
 *
 * `translator.translate` emits a *factory* that takes the runtime modules and
 * returns the evaluator, so every hoisted constant it declares (compiled regex
 * literals, and every per-element callback that captures nothing) is built
 * once here rather than on every `evaluate()` call.
 */
function compilePipeline(exprSource) {
  let ast;
  try {
    ast = optimize(parse(exprSource));
  } catch (e) {
    if (e instanceof JsonataError) {
      throw new JsonataCompilationError(e.code, e.message, e);
    }
    throw new JsonataCompilationError('S0500', `Attempted to evaluate an expression containing syntax error(s): ${e.message}`, e);
  }
  const translator = new Translator(BUILTIN_NAMES);
  const { params, body } = translator.translate(ast);
  let factory;
  try {
    factory = loadFunction(params, body, exprSource);
  } catch (e) {
    if (e instanceof JsonataLoadError) throw e;
    throw new JsonataLoadError('U1002', `Internal error: generated code failed to compile: ${e.message}`, e);
  }
  return factory(RT, P, H, LAM, OBJ, STRUCT, BUILTINS, FV);
}

/** `$eval(exprStr, context)` — compiles and evaluates a JSONata string using this expression's current bindings (design.md D4/task 6.8). */
function makeEvalFunction(getEnv) {
  const fn = (exprStr, context, callerEnv) => {
    if (exprStr === undefined) return undefined;
    if (typeof exprStr !== 'string') {
      throw new JsonataEvaluationError('T0410', { index: 1, token: 'eval' });
    }
    let compiledFn;
    try {
      compiledFn = compilePipeline(exprStr);
    } catch (e) {
      // T1005/T1007/T1008 ("did you mean $name?") are detected eagerly by
      // this parser (design.md - a deliberate shortcut over tracking it
      // through to the actual call site at runtime), but real jsonata
      // only detects them when the offending call is *evaluated* - to
      // `$eval`, that is a dynamic (D3121) failure, not a syntax (D3120)
      // one, even though this implementation happens to raise it during
      // parsing.
      if (e.code === 'T1005' || e.code === 'T1007' || e.code === 'T1008') {
        throw new JsonataEvaluationError('D3121', { value: e.message });
      }
      throw new JsonataEvaluationError('D3120', { value: e.message });
    }
    // `callerEnv` is supplied by generated code (translator.js#genEvalEnv):
    // the *live* environment of the `$eval` call site — per-evaluation
    // `bindings`, `assign()`/`registerFunction()` bindings, the builtin
    // registry, plus any enclosing block locals / lambda parameters /
    // `@$`-`#$` path bindings. Real jsonata evaluates the string in exactly
    // that environment. The fallback (a `$eval` reached as a first-class
    // function value, e.g. `$map(exprs, $eval)`) can only see the permanent
    // bindings.
    const env = callerEnv !== undefined && callerEnv !== null && typeof callerEnv === 'object'
      ? callerEnv
      : Object.assign(Object.create(BUILTINS), getEnv());
    try {
      return compiledFn(context, context, env);
    } catch (e) {
      if (e instanceof JsonataError) {
        throw new JsonataEvaluationError('D3121', { value: e.message });
      }
      throw e;
    }
  };
  return FV.tagFunction(fn, 2);
}

class JsonataExpression {
  constructor(compiledFn, sourceText) {
    this._fn = compiledFn;
    this._source = sourceText;
    // Object.create(null) so assign('__proto__', v)/registerFunction('__proto__', fn)
    // create a real own binding instead of silently reassigning this
    // object's own prototype (see CODE-REVIEW.md M6).
    this._permanentEnv = Object.create(null);
    this._timeoutMs = 0;
    this._permanentEnv.eval = makeEvalFunction(() => this._permanentEnv);
    // Lazily built view of `_permanentEnv` layered over the shared builtin
    // registry, reused across `evaluate()` calls and invalidated only by
    // `assign`/`registerFunction`/`useLibrary` (same trick as JSonata2Java's
    // cached `permanentBindings()`): rebuilding it per call allocated two
    // objects and re-ran `Object.assign` for every evaluation. Safe to share
    // because generated code only ever READS `ENV[name]` (the sole emission
    // sites are gen-ctx.js#resolveVariable / #envRef) — no evaluation can
    // write a binding into it.
    this._baseEnv = null;
  }

  /** Binds `name` to `value` for every future `evaluate()` call on this expression. */
  assign(name, value) {
    this._permanentEnv[name] = value;
    this._baseEnv = null;
    return this;
  }

  /**
   * Registers a native JS function as a callable JSONata function value.
   * `signature` (optional) is a `<params:return>` string used only to infer
   * declared arity when `fn.length` is not reliable (e.g. a variadic or
   * rest-parameter function) — see `parseSignatureArity`.
   */
  registerFunction(name, fn, signature) {
    const { arity } = parseSignatureArity(signature);
    // Passing `signature` through tags `fn._jsonataSignature` too (not
    // just arity), so `lambda.js#callFunctionValue` - the choke point
    // every dynamic call path (`applyFn`/`chainStep`/HOF callbacks via
    // `hof.js#callWithTuple`'s `unwind`) already routes through -
    // validates argument count/type against it automatically, the same
    // way it already does for built-ins. Fixes the previously-silent
    // `<n:n>` "arity-only" gap (see CODE-REVIEW.md M7a): a signature is
    // now actually enforced, not merely mined for a `fn.length` fallback.
    FV.tagFunction(fn, arity !== undefined ? arity : fn.length, signature);
    this._permanentEnv[name] = fn;
    this._baseEnv = null;
    return this;
  }

  /** Merges every export of `library` (a plain `{name: fn}` object, or a compiled library — see `compileLibrary`) as bound functions. */
  useLibrary(library) {
    const exports = library && library.__jsonataLibraryExports ? library.__jsonataLibraryExports : library;
    for (const name of Object.keys(exports || {})) {
      this.registerFunction(name, exports[name]);
    }
    return this;
  }

  /** Sets an evaluation wall-clock timeout in milliseconds (0/unset = no timeout); throws `U1001` past the deadline. */
  setTimeout(ms) {
    this._timeoutMs = ms;
    return this;
  }

  /** Sets a non-tail-recursion depth guardrail (0/unset = no limit); throws `U1001` past it. Weighted by each called lambda's own estimated recursion cost (see translator.js#estimateRecursionDepthCost), not a flat 1 per call - see `LAM.pushMaxDepth`. */
  setMaxDepth(n) {
    this._maxDepth = n;
    return this;
  }

  /** Returns the original JSONata source text this expression was compiled from. */
  getSourceJsonata() {
    return this._source;
  }

  /** Evaluates the compiled expression against `input`, with optional one-shot `bindings`. */
  evaluate(input, bindings) {
    const clock = createClock();
    // Builtins must also resolve as bare `$name` function-value references
    // (e.g. `$map(arr, $sum)`), not just via the codegen's static `$name(args)`
    // dispatch — so ENV's prototype chain bottoms out at the builtins registry.
    let baseEnv = this._baseEnv;
    if (baseEnv === null) {
      baseEnv = Object.assign(Object.create(BUILTINS), this._permanentEnv);
      this._baseEnv = baseEnv;
    }
    // No per-call bindings -> the cached chain IS this evaluation's ENV; only
    // one-shot `bindings` need a fresh frame layered on top.
    const env = bindings ? Object.assign(Object.create(baseEnv), bindings) : baseEnv;
    const deadline = this._timeoutMs > 0 ? Date.now() + this._timeoutMs : null;
    if (deadline !== null) LAM.pushDeadline(deadline);
    const maxDepth = this._maxDepth > 0 ? this._maxDepth : null;
    if (maxDepth !== null) LAM.pushMaxDepth(maxDepth);
    // Scope this evaluation's clock snapshot so a nested `$eval` call
    // reuses it instead of taking a second, later `Date.now()` reading
    // (see runtime/clock.js's integration contract / CODE-REVIEW.md M1).
    pushClock(clock);
    try {
      return this._fn(input, input, env);
    } catch (e) {
      // Only a genuine native stack overflow ("Maximum call stack size
      // exceeded") is a resource-limit condition; a RangeError from an
      // unrelated cause (a user-registered function's own throw, an
      // out-of-range `$pad`/`toFixed`/array-length call, ...) must not be
      // masked as a phantom timeout (see CODE-REVIEW.md M2).
      if (e instanceof RangeError && /call stack/i.test(e.message)) {
        throw new JsonataEvaluationError('U1001', {});
      }
      throw e;
    } finally {
      popClock();
      if (deadline !== null) LAM.popDeadline();
      if (maxDepth !== null) LAM.popMaxDepth();
    }
  }
}

/** Compiles a single JSONata expression string. Throws `JsonataCompilationError` on invalid input. */
function compile(exprSource) {
  const fn = compilePipeline(exprSource);
  return new JsonataExpression(fn, exprSource);
}

/**
 * Compiles multiple JSONata expression strings; returns an array of
 * compiled expressions in the same order when every one succeeds.
 *
 * On any failure, throws a single `JsonataCompilationError` (code/message/
 * cause taken from the FIRST failing expression) carrying two extra own
 * properties so no information is silently discarded (CODE-REVIEW.md M7c):
 *   `.failures` — `{ index, source, code, message }` for every expression
 *                 that failed to compile, in order.
 *   `.results`  — the full `exprSources`-length array, with a compiled
 *                 `JsonataExpression` at every index that DID succeed and
 *                 `undefined` at every index that failed.
 */
function compileAll(exprSources) {
  const results = new Array(exprSources.length);
  const failures = [];
  for (let i = 0; i < exprSources.length; i++) {
    try {
      results[i] = compile(exprSources[i]);
    } catch (e) {
      failures.push({ index: i, source: exprSources[i], code: e.code, message: e.message, cause: e });
    }
  }
  if (failures.length > 0) {
    const first = failures[0];
    const summary = failures.map((f) => `#${f.index} (${f.code}): ${f.message}`).join('; ');
    const err = new JsonataCompilationError(
      first.code,
      `compileAll: ${failures.length} of ${exprSources.length} expression(s) failed to compile: ${summary}`,
      first.cause
    );
    err.failures = failures.map((f) => ({ index: f.index, source: f.source, code: f.code, message: f.message }));
    err.results = results;
    throw err;
  }
  return results;
}

/**
 * Compiles a "library definition" — a plain object mapping exported names to
 * JSONata expression source strings, each of which must evaluate to a
 * function value (typically a lambda literal) — into a plain
 * `{ name: fn }`-shaped `CompiledLibrary` of native-callable JS functions
 * (each still a tagged JSONata function value), suitable for `useLibrary()`.
 * `options` currently only supports `{ bindings }`, applied to every
 * definition.
 *
 * The returned library carries a `close()` method (CODE-REVIEW.md M7b):
 * after `close()` is called, every export throws `T2006` instead of
 * running, so a caller can retire a shared library and be sure nothing
 * already holding one of its exports keeps silently using it.
 */
function compileLibrary(definition, options) {
  const bindings = (options && options.bindings) || {};
  const exportsObj = {};
  let closed = false;
  for (const name of Object.keys(definition)) {
    const compiled = compile(definition[name]);
    for (const bindingName of Object.keys(bindings)) compiled.assign(bindingName, bindings[bindingName]);
    const fnValue = compiled.evaluate(undefined);
    if (typeof fnValue !== 'function') {
      throw new JsonataCompilationError('T2006', `Library export "${name}" did not evaluate to a function value`);
    }
    const guarded = (...args) => {
      if (closed) {
        throw new JsonataEvaluationError('T2006', { value: `Library export "${name}" used after close()` });
      }
      return fnValue(...args);
    };
    FV.tagFunction(guarded, FV.arityOf(fnValue), fnValue._jsonataSignature, fnValue._jsonataDepthCost);
    exportsObj[name] = guarded;
  }
  return {
    __jsonataLibraryExports: exportsObj,
    close() {
      closed = true;
    },
  };
}

module.exports = {
  compile,
  compileAll,
  compileLibrary,
  JsonataExpression,
  JsonataError,
  ParseError,
  JsonataCompilationError,
  JsonataLoadError,
  JsonataEvaluationError,
};
