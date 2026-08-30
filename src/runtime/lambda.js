'use strict';

/**
 * Function-value application, `~>` chain support, and the tail-call
 * trampoline (design.md D4: ported entirely, compiled-code-specific;
 * mirrors JSonata2Java's `LambdaRegistry`).
 *
 * Every compiled JSONata `Lambda` is a plain JS function tagged with
 * `._jsonataArity`. A lambda body compiled in *tail position* (the
 * translator threads a `tail` flag through Block-last-expression,
 * ConditionalExpr branches, ElvisExpr, and CoalesceExpr) does not directly
 * recurse into another function value call — instead it returns a
 * lightweight "thunk" object `{__jsonataThunk, fn, args}` describing the
 * deferred call, letting its own JS stack frame pop before the callee runs.
 * `unwind` drives that trampoline in a flat loop; `applyFn`/`callFunctionValue`
 * are the two ways generated/runtime code invokes a JSONata function value:
 * `applyFn` always fully unwinds (used wherever the concrete result value is
 * needed immediately — non-tail-position calls, `$map`/`$filter`/etc.
 * callbacks, `~>` steps), and `callFunctionValue` performs only the
 * not-a-function (T1006/T1007) check and the raw call — used by the
 * translator for tail-position calls, whose result (possibly itself a thunk)
 * is returned as-is to be unwound by whichever `applyFn` eventually consumes it.
 */

const { JsonataEvaluationError } = require('../errors');
const { arityOf, isRegexValue, validateSignatureArgs } = require('./function-value');

function err(code, extra) {
  return new JsonataEvaluationError(code, extra);
}

const MAX_TRAMPOLINE_HOPS = 5000000;

// Stack of active evaluation deadlines (epoch ms), supporting nested $eval
// calls; `unwind`'s loop periodically checks the innermost one.
const _deadlineStack = [];
function pushDeadline(ts) {
  _deadlineStack.push(ts);
}
function popDeadline() {
  _deadlineStack.pop();
}
function checkDeadline() {
  const ts = _deadlineStack[_deadlineStack.length - 1];
  if (ts !== undefined && ts !== null && Date.now() > ts) {
    throw err('U1001');
  }
}

// Stack of active non-tail-recursion depth guardrails, supporting nested
// `$eval` calls; each entry carries its own budget and the caller's
// depth-so-far (restored on pop, so a nested `$eval`'s own recursion
// doesn't consume the outer evaluation's budget or vice versa). Mirrors
// real jsonata's `options.stack`/`environment.base.depth` guardrail -
// every *non-tail* function-value call (`applyFn`/`applyBareFn`; a
// trampolined tail call never grows depth in either implementation)
// weighs against the innermost active budget by the callee's own
// `_jsonataDepthCost` (a compile-time estimate of how many nested
// `evaluate()`-equivalent node visits real jsonata would make for one
// call to it - see translator.js#estimateEvaluateCost) instead of a flat
// 1 per JS call frame, which would let compiled code recurse far deeper
// than jsonata's own interpreter ever could before it reports U1001 -
// see the `tail-recursion` conformance group's depth-limited cases.
const _maxDepthStack = [];
let _currentDepth = 0;
function pushMaxDepth(maxDepth) {
  _maxDepthStack.push({ maxDepth, savedDepth: _currentDepth });
  _currentDepth = 0;
}
function popMaxDepth() {
  const top = _maxDepthStack.pop();
  _currentDepth = top ? top.savedDepth : 0;
}
/** Charges `cost` against the innermost active depth budget (a no-op stack if none is active); throws U1001 past it. Returns an "uncharge" callback to run once the call returns/throws. */
function chargeDepth(fn) {
  if (_maxDepthStack.length === 0) return null;
  const top = _maxDepthStack[_maxDepthStack.length - 1];
  const cost = (typeof fn === 'function' && fn._jsonataDepthCost) || 1;
  if (_currentDepth + cost > top.maxDepth) throw err('U1001');
  _currentDepth += cost;
  return () => { _currentDepth -= cost; };
}


/** Deferred tail-call descriptor; a real class (not a tagged plain object) so an
 *  adversarial JSON input value can never be mistaken for one via `instanceof`. */
class Thunk {
  constructor(fn, args, context) {
    this.fn = fn;
    this.args = args;
    this.context = context;
  }
}

/** Not-a-function check + raw invocation; result may itself be a thunk (tail-position callee). A regex value is also callable - jsonata's regex literals are themselves function values, invoking to a single matcher-closure result (`{match,start,end,groups,next}` or `undefined`). A function value tagged with `_jsonataSignature` (see `function-value.js#validateSignatureArgs`) validates/coerces `args` before invoking, whether called directly or as a HOF callback; `context` (the caller's current `$`, when known) fills a `-`-marked signature parameter omitted from `args`. */
function callFunctionValue(fn, args, context) {
  if (isRegexValue(fn)) {
    return require('./regex').regexClosure(fn, args[0], 0);
  }
  if (typeof fn !== 'function') {
    throw err('T1006', { value: fn });
  }
  const validatedArgs = fn._jsonataSignature ? validateSignatureArgs(fn._jsonataSignature, args, context) : args;
  return fn.apply(null, validatedArgs);
}

/** Drives the tail-call trampoline until a non-thunk value is produced. */
function unwind(value) {
  let v = value;
  let hops = 0;
  while (v instanceof Thunk) {
    if (++hops > MAX_TRAMPOLINE_HOPS) {
      throw err('U1001');
    }
    if ((hops & 0x3ff) === 0) checkDeadline();
    v = callFunctionValue(v.fn, v.args, v.context);
  }
  return v;
}

/** Full call-and-unwind: what every non-tail-position dynamic function-value call site uses. */
function applyFn(fn, args, context) {
  const uncharge = chargeDepth(fn);
  try {
    return unwind(callFunctionValue(fn, args, context));
  } finally {
    if (uncharge) uncharge();
  }
}

/** Builds a deferred tail-call thunk (never call directly; only ever returned from a lambda body). */
function thunk(fn, args, context) {
  return new Thunk(fn, args, context);
}

/**
 * Not-a-function check for a *bare* (non-`$`-prefixed) call's resolved
 * callee. jsonata treats a bare identifier used as a callee - `field(args)`
 * at the top of a path, or `obj.field(args)` continuing one - as an
 * ordinary field lookup against the current context (`context[name]`),
 * *never* a builtin/lexical-variable dispatch (that is exclusively what
 * `$name(args)` is for). Reports T1005 ("did you mean $name?") instead of
 * the generic T1006 when `name` matches a known builtin - jsonata's own
 * helpful hint for the common "forgot the $" mistake - matching
 * `callFunctionValue`'s signature-validation/regex-value handling
 * otherwise.
 */
function callBareFunctionValue(fn, args, context, name, isBuiltinName) {
  if (isRegexValue(fn)) {
    return require('./regex').regexClosure(fn, args[0], 0);
  }
  if (typeof fn !== 'function') {
    throw err(isBuiltinName ? 'T1005' : 'T1006', isBuiltinName ? { token: name } : { value: fn });
  }
  const validatedArgs = fn._jsonataSignature ? validateSignatureArgs(fn._jsonataSignature, args, context) : args;
  return fn.apply(null, validatedArgs);
}

/** Full call-and-unwind for a bare (non-`$`-prefixed) call: resolves the callee by field lookup against `context`, then behaves like `applyFn`. */
function applyBareFn(context, name, args, isBuiltinName) {
  const fn = require('./values').field(context, name);
  const uncharge = chargeDepth(fn);
  try {
    return unwind(callBareFunctionValue(fn, args, context, name, isBuiltinName));
  } finally {
    if (uncharge) uncharge();
  }
}

/**
 * Builds a deferred tail-call thunk for a bare call. The not-a-function
 * check runs immediately (not deferred into the thunk) - a tail call still
 * fails at the same observable point either way, and resolving the field
 * lookup against `context` *now* (while it is cheaply available) avoids
 * needing to carry `name`/`isBuiltinName` through the trampoline.
 */
function thunkBare(context, name, args, isBuiltinName) {
  const fn = require('./values').field(context, name);
  if (!isRegexValue(fn) && typeof fn !== 'function') {
    throw err(isBuiltinName ? 'T1005' : 'T1006', isBuiltinName ? { token: name } : { value: fn });
  }
  return new Thunk(fn, args, context);
}


/**
 * `~>` chain step application: `prevResult ~> stepFn` calls `stepFn` with
 * `prevResult` prepended as its first argument (jsonata's `evaluateApplyExpression`
 * / `evaluateFunction(..., {context: lhs})`).
 */
function chainStep(prevResult, stepFn, extraArgs, context) {
  if (typeof stepFn !== 'function' && !isRegexValue(stepFn)) {
    throw err('T2006', { value: stepFn });
  }
  const args = extraArgs && extraArgs.length ? [prevResult].concat(extraArgs) : [prevResult];
  return applyFn(stepFn, args, context);
}

module.exports = {
  err,
  callFunctionValue,
  unwind,
  applyFn,
  thunk,
  callBareFunctionValue,
  applyBareFn,
  thunkBare,
  chainStep,
  pushDeadline,
  popDeadline,
  checkDeadline,
  pushMaxDepth,
  popMaxDepth,
  MAX_TRAMPOLINE_HOPS,
};
