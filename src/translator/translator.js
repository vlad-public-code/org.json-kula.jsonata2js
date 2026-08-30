'use strict';

/**
 * Translator (code generator): compiles an optimized JSONata AST into a
 * single JS function body (design.md capability `javascript-code-generation`).
 * Every AST node compiles to a JS *expression*; multi-statement forms
 * (blocks, path navigation, group-by, transform) compile to an
 * immediately-invoked arrow function `(() => { ...stmts...; return expr; })()`
 * instead of Java's private-helper-method extraction — JS closures already
 * give every nested form correct lexical scoping for free.
 *
 * The compiled function's parameter list is fixed:
 *   ($, $$, ENV, RT, P, H, LAM, OBJ, STRUCT, B, FV)
 *     $    current context value      $$   root (input) value
 *     ENV  variable/function bindings (plain object; missing lookup -> undefined)
 *     RT   runtime/values.js          P    runtime/path.js
 *     H    runtime/hof.js             LAM  runtime/lambda.js (apply/chain/TCO)
 *     OBJ  runtime/objects.js         STRUCT runtime/structural.js (group-by/transform)
 *     B    the built-in function registry (runtime/builtins.js)
 *     FV   runtime/function-value.js (tagging, regex compile)
 */

const { GenCtx } = require('./gen-ctx');
const { CONTEXT_DEFAULT, CONTEXT_DEFAULT_MAX_ARITY } = require('../runtime/builtins');
const { ParseError } = require('../errors');

const PATH_STEP_TYPES = new Set([
  'FieldRef', 'WildcardStep', 'DescendantStep', 'ParentStep',
  'PositionBinding', 'ContextBinding', 'PredicateExpr', 'ArraySubscript',
]);

/**
 * True if `node`'s subtree references `%` (`ParentStep`) anywhere, not
 * descending into a nested `Lambda`'s body (its own `%` binds a different
 * scope). Real jsonata's parser marks a step `tuple: true` under this same
 * condition and routes it through `evaluateTupleStep` instead of
 * `evaluateStep` - see `compilePathStep`'s `ArrayConstructor` case.
 */
function containsParentRef(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'ParentStep') return true;
  if (node.type === 'Lambda') return false;
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'pos') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const el of val) if (containsParentRef(el)) return true;
    } else if (val && typeof val === 'object') {
      if (containsParentRef(val)) return true;
    }
  }
  return false;
}

/** Operators whose runtime helper can only ever yield a boolean or `undefined` (never a number). */
const NEVER_NUMERIC_OPS = new Set(['=', '!=', '<', '<=', '>', '>=', 'in', 'and', 'or']);
/** Built-ins whose result can only ever be a boolean or `undefined`. */
const NEVER_NUMERIC_FNS = new Set(['exists', 'not', 'contains', 'boolean']);
/** Aggregates the translator can fuse onto a value-mode path stream (see `genFusedAggregate`). */
const AGG_FUSABLE = new Set(['count', 'sum', 'average', 'max', 'min']);

/**
 * True when `node`'s value can never be a *number* at runtime. A predicate
 * `[expr]` whose result is numeric selects by index within the current
 * sibling group (`path.js#matchesPredicate`), which is the one thing that
 * makes the parent linkage in a tuple observable for an otherwise
 * binding-free path; a predicate that can only be boolean/`undefined`
 * filters position-independently, so such a path can run in value mode
 * (see `pathValueModeSteps`). Deliberately conservative: anything not
 * recognized here is assumed possibly-numeric.
 */
function neverNumeric(node, ctx) {
  if (!node || typeof node !== 'object') return false;
  switch (node.type) {
    case 'BooleanLiteral': return true;
    case 'BinaryOp': return NEVER_NUMERIC_OPS.has(node.op);
    case 'Parenthesized': return neverNumeric(node.inner, ctx);
    case 'FunctionCall':
      // Only when the name really resolves to the built-in here — a
      // lexically bound `$not`/`$exists` is an arbitrary lambda.
      return !node.bare
        && NEVER_NUMERIC_FNS.has(node.name)
        && !ctx.isLexicallyBound(GenCtx.jsName('v_', node.name));
    default: return false;
  }
}

/**
 * Estimates one non-tail call's weight against the non-tail-recursion
 * depth guardrail (`LAM.applyFn`'s budget) - approximates how many
 * *simultaneously nested* `evaluate()` frames real jsonata's interpreter
 * would have on its own call stack for one execution of `node` (a
 * lambda's body), verified empirically against jsonata's own
 * `environment.base.depth` guardrail (`3` for a simple
 * `$n = 0 ? 1 : $n * $factorial($n - 1)`-shaped body - confirmed via
 * `Symbol.for('jsonata.__evaluate_entry'/'_exit')` instrumentation
 * against real jsonata: max depth for `$factorial(n)` is exactly `3n+5`).
 *
 * This is *not* a total node count - sibling sub-expressions (a
 * `BinaryOp`'s two operands, a function call's own arguments, a
 * `ConditionalExpr`'s untaken branch) evaluate sequentially and fully
 * unwind before the next one starts, so they never stack on top of each
 * other; only genuine parent -> child nesting is additive. The quantity
 * that matters for a *recursive* call site is therefore the AST-nesting
 * depth from the lambda body's root down to the (potentially recursive)
 * call node itself - a function call's own `.args` are evaluated to a
 * plain value and fully unwound *before* the call proceeds, so they are
 * excluded from this spine, exactly like an untaken conditional branch;
 * a nested `Lambda`'s own body is excluded too (only paid if that lambda
 * is itself later invoked). Takes the deepest of every call site
 * reachable this way, since which branch actually recurses is a runtime
 * decision this static estimate can't know.
 */
function estimateRecursionDepthCost(node, depth) {
  if (!node || typeof node !== 'object') return 0;
  if (node.type === 'FunctionCall' || node.type === 'LambdaCall') return depth;
  if (node.type === 'Lambda') return 0;
  let best = 0;
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'pos') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const el of val) best = Math.max(best, estimateRecursionDepthCost(el, depth + 1));
    } else if (val && typeof val === 'object') {
      best = Math.max(best, estimateRecursionDepthCost(val, depth + 1));
    }
  }
  return best;
}

class Translator {
  constructor(builtinNames) {
    this.builtinNames = builtinNames; // Set<string> — names dispatched directly to B[name]
  }

  /**
   * Compiles `ast` to a *factory*: the returned source takes the runtime
   * modules, declares every hoisted constant (compiled regex literals, and
   * every callback that captures nothing — see `hoistableClosure`), and
   * returns the evaluator `($, $$, ENV) => value`.
   *
   * The factory shape exists so those constants are built once per compiled
   * expression rather than once per `evaluate()` call. Measured on a
   * generated function shaped like this benchmark's output (28 predicate
   * callbacks, 30,000 evaluations): 210.7 ms with per-call callbacks,
   * 188.1 ms with them hoisted. Binding the runtime modules once is worth
   * nothing on its own (209.5 ms) — the win is entirely the callbacks.
   */
  translate(ast) {
    const ctx = new GenCtx();
    const bodyExpr = this.genExpr(ast, ctx, true);
    const hoistedDecls = ctx.hoisted.map((h) => `const ${h.name} = ${h.code};`).join('\n');
    const body = `${hoistedDecls}\nreturn function ($, $$, ENV) {\nreturn LAM.unwind(${bodyExpr});\n};`;
    return { params: ['RT', 'P', 'H', 'LAM', 'OBJ', 'STRUCT', 'B', 'FV'], body };
  }

  /**
   * Whitelist walk deciding whether the callback generated for `node` can be
   * hoisted into the factory's scope. Only the evaluator's own scope is
   * off-limits: `$$` (root), `ENV` (dynamic bindings, reached by any
   * `VariableRef`), the `let` bindings a block/lambda introduces, and any
   * enclosing per-element closure's `%`/`@$`/`#$` state. Everything else a
   * predicate normally contains — literals, `$`-rooted navigation,
   * comparisons, arithmetic, static built-in calls, hoisted regex literals —
   * refers only to the callback's own parameters or to factory-scope
   * constants.
   *
   * Conservative by construction: an unrecognized node type means "not
   * hoistable", so a new AST node cannot silently produce a closure that
   * references a variable which no longer exists in the factory's scope.
   */
  hoistableClosure(node, ctx) {
    if (ctx.parentVar || ctx.tupleBindingsVar || ctx.tbStack.length > 0) return false;
    if (ctx.activeTupleBindings.size > 0) return false;
    return this.hoistableSubtree(node, ctx);
  }

  hoistableSubtree(node, ctx) {
    if (node === null || node === undefined) return true;
    switch (node.type) {
      case 'StringLiteral':
      case 'NumberLiteral':
      case 'BooleanLiteral':
      case 'NullLiteral':
      case 'RegexLiteral':      // hoisted to the same factory scope
      case 'ContextRef':        // the callback's own `$` parameter
      case 'WildcardStep':
      case 'DescendantStep':
        return true;
      case 'FieldRef':
        return true;
      case 'PathExpr':
        return node.steps.every((s) => this.hoistableSubtree(s, ctx));
      case 'PredicateExpr':
        return this.hoistableSubtree(node.source, ctx) && this.hoistableSubtree(node.predicate, ctx);
      case 'ArraySubscript':
        return this.hoistableSubtree(node.source, ctx) && this.hoistableSubtree(node.index, ctx);
      case 'BinaryOp':
        return this.hoistableSubtree(node.left, ctx) && this.hoistableSubtree(node.right, ctx);
      case 'UnaryMinus':
        return this.hoistableSubtree(node.operand, ctx);
      case 'RangeExpr':
        return this.hoistableSubtree(node.from, ctx) && this.hoistableSubtree(node.to, ctx);
      case 'Parenthesized':
        return this.hoistableSubtree(node.inner, ctx);
      case 'ConditionalExpr':
        return this.hoistableSubtree(node.condition, ctx) && this.hoistableSubtree(node.then, ctx)
          && this.hoistableSubtree(node.otherwise, ctx);
      case 'ElvisExpr':
      case 'CoalesceExpr':
        return this.hoistableSubtree(node.left, ctx) && this.hoistableSubtree(node.right, ctx);
      case 'ArrayConstructor':
        return node.elements.every((e) => this.hoistableSubtree(e, ctx));
      case 'ObjectConstructor':
        return node.pairs.every((p) => this.hoistableSubtree(p.key, ctx) && this.hoistableSubtree(p.value, ctx));
      case 'FunctionCall':
        // Only a call that compiles to `B["name"](…)`: a bare call is a field
        // lookup routed through `LAM`, and a lexically bound or ENV-resolved
        // name reaches the evaluator's scope.
        return !node.bare
          && this.builtinNames.has(node.name)
          && !ctx.isLexicallyBound(GenCtx.jsName('v_', node.name))
          && node.args.every((a) => this.hoistableSubtree(a, ctx));
      default:
        // RootRef, VariableRef, ParentStep, ContextBinding, PositionBinding,
        // Lambda, LambdaCall, PartialApplication, Block, VariableBinding,
        // ChainExpr, TransformExpr, SortExpr, GroupByExpr, …
        return false;
    }
  }

  /**
   * Emits a per-element callback, hoisting it to factory scope when its body
   * cannot reference the evaluator's own scope. `compile` returns the
   * callback's body source.
   *
   * A hoisted callback whose body never mentions its own `%`-tuple/bindings
   * parameters is emitted with canonical parameter names, so two textually
   * identical predicates (`e[lvl = 2]` twice in one expression) collapse to a
   * single hoisted constant instead of differing only by minted identifiers.
   */
  genElementCallback(node, ctx, compile) {
    const { result, ptName, tbName } = this.withFreshElementScope(ctx, () => compile());
    if (!this.hoistableClosure(node, ctx)) {
      return `($, ${ptName}, ${tbName}) => (${result})`;
    }
    const usesScopeParams = result.includes(ptName) || result.includes(tbName);
    const params = usesScopeParams ? `$, ${ptName}, ${tbName}` : '$, __pt, __tb';
    return ctx.hoistClosure(`(${params}) => (${result})`);
  }

  // ===== dispatch =====

  genExpr(node, ctx, tail) {
    const method = this['gen' + node.type];
    if (!method) throw new Error(`translator: no codegen for AST node type "${node.type}"`);
    return method.call(this, node, ctx, tail);
  }

  // ===== literals =====

  genStringLiteral(node) { return JSON.stringify(node.value); }
  genNumberLiteral(node) { return JSON.stringify(node.value); }
  genBooleanLiteral(node) { return node.value ? 'true' : 'false'; }
  genNullLiteral() { return 'null'; }
  genRegexLiteral(node, ctx) { return ctx.hoistRegex(node.pattern, node.flags); }

  // ===== references =====

  genContextRef() { return '$'; }
  genRootRef() { return '$$'; }
  genVariableRef(node, ctx) { return ctx.resolveVariable(node.name); }

  // ===== path primitives used standalone (not inside a PathExpr) =====

  genFieldRef(node, ctx) { return `P.${ctx.dollarIsRoot ? 'fieldOneSingle' : 'fieldOne'}($, ${JSON.stringify(node.name)}, false)`; }
  genWildcardStep() { return `P.wildcardFinal(P.seedSingle($), false)`; }
  genDescendantStep() { return `P.descendantFinal(P.seedSingle($), false)`; }
  genParentStep(node, ctx) {
    // A standalone `%` (not folded into a path step, e.g. the whole
    // expression `%`, `(%)`, or an array-constructor/block element `[%]`)
    // with no enclosing per-element closure to derive an ancestor from is
    // exactly jsonata's "the object representing the 'parent' cannot be
    // derived from this expression" case - a compile-time error, not a
    // silently-missing runtime value. Not applied in a desugared call's
    // callee position (`%()`/`%(1)`, `suppressParentAncestryCheck`) -
    // real jsonata doesn't ancestor-validate a callee either, letting it
    // evaluate to `undefined` and fail with the ordinary T1006
    // ("attempted to invoke a non-function") at runtime instead.
    if (!ctx.parentVar && !ctx.suppressParentAncestryCheck) {
      throw new ParseError('S0217', node.pos, { token: node.type });
    }
    return `(${ctx.parentVar} ? ${ctx.parentVar}.v : undefined)`;
  }
  genPositionBinding() { return 'undefined'; } // only meaningful as a path step; see genPathExpr
  genContextBinding() { return 'undefined'; }

  // ===== path expressions =====

  genPathExpr(node, ctx, tail, forceKeepSingleton) {
    // `ctx.activeTupleBindings` accumulates every `@$`/`#$` name seen so
    // far *within the path currently being compiled* - read both during
    // and after `compilePathSteps` below (e.g. the terminal-FieldRef
    // fallback check just past it). When this PathExpr starts fresh -
    // not already lexically nested inside an *enclosing* path's own
    // predicate/sort-key/group-by-pair/bare-step processing
    // (`ctx.inPathScope` false - distinct from `parentVar`, which is
    // nulled for a parent-less terminal group-by's pairs even though
    // those pairs must still inherit `activeTupleBindings`, e.g. bare
    // `Phone` in `Employee@$e...{ $e.Name: Phone[...] }` still needs
    // `@$e`'s `$$`-fallback despite having no `%`) - scope it to just
    // this path, so it can't leak into/out of an unrelated sibling
    // expression (e.g. either side of a binary op, or two
    // array-constructor elements) compiled right before or after this one.
    if (ctx.inPathScope) return this.genPathExprBody(node, ctx, tail, forceKeepSingleton);
    const savedActiveTupleBindings = ctx.activeTupleBindings;
    ctx.activeTupleBindings = new Set();
    const result = this.genPathExprBody(node, ctx, tail, forceKeepSingleton);
    ctx.activeTupleBindings = savedActiveTupleBindings;
    return result;
  }

  genPathExprBody(node, ctx, tail, forceKeepSingleton) {
    const keep = forceKeepSingleton ? 'true' : 'false';
    const steps = node.steps;
    const lastStep = steps[steps.length - 1];
    // Value mode (no `{v,p,b}` tuples) whenever the path provably cannot
    // observe one — the common case, and several times cheaper per element.
    const valueModeSteps = steps.length > 0 ? this.pathValueModeSteps(steps, ctx) : null;
    if (valueModeSteps) return this.genPathExprValueMode(valueModeSteps, ctx, keep);
    // Terminal field/wildcard/descendant step: compile every step before it
    // to a tuples list, then compute the path's value directly via the
    // `*Final` runtime helpers (single-raw-result passthrough - see
    // `path.js#finalValue`) instead of always-flattening + `collapseTuples`.
    if (lastStep && (lastStep.type === 'FieldRef' || lastStep.type === 'WildcardStep' || lastStep.type === 'DescendantStep')) {
      const { code, tuplesVar } = this.compilePathSteps(steps.slice(0, -1), ctx);
      let finalExpr;
      if (lastStep.type === 'FieldRef') {
        const fallback = ctx.activeTupleBindings.size > 0 ? '$$' : 'undefined';
        finalExpr = `P.fieldFinal(${tuplesVar}, ${JSON.stringify(lastStep.name)}, ${fallback}, ${keep})`;
      } else if (lastStep.type === 'WildcardStep') {
        finalExpr = `P.wildcardFinal(${tuplesVar}, ${keep})`;
      } else {
        finalExpr = `P.descendantFinal(${tuplesVar}, ${keep})`;
      }
      return `(() => {\n${code}\nreturn ${finalExpr};\n})()`;
    }
    // Terminal group-by (`{}`, folded onto the path by the optimizer as its
    // last step): a *non-dotted* (postfix `foo{...}`) group-by sees the
    // *whole* tuple stream produced by every step before it in one shot -
    // it must not be evaluated per-element via the generic bare-step
    // fallback. A *dotted* (`foo.{...}`) group-by is real jsonata's `{`
    // NUD production instead of its infix/aggregate production - it
    // constructs one `{pairs}` object independently per source element
    // (still via `STRUCT.groupBy`, so within-element duplicate-pair-key
    // collisions still throw D1009, but there is no cross-element
    // merging) - falls through to the generic per-element step path.
    if (lastStep && lastStep.type === 'GroupByExpr' && !lastStep.dotted) {
      const { code, tuplesVar } = this.compilePathSteps(steps.slice(0, -1), ctx);
      const groupByExpr = this.compileGroupByPairs(lastStep, tuplesVar, ctx);
      return `(() => {\n${code}\nreturn ${groupByExpr};\n})()`;
    }
    // Terminal generic expression step (`o.(p^(v))`, `$data.$zip(a, b)`): the
    // reference applies the same "one raw array result passes through
    // verbatim, two or more flatten" rule as for a terminal field step, which
    // `P.exprFinal` implements. A bare array-constructor step is excluded (it
    // is jsonata's `consarray`: never flattened, so plain per-element
    // collection plus collapse is the right shape), and so is a tuple-mode
    // path, which flattens unconditionally through `evaluateTupleStep`.
    if (
      steps.length > 1 && lastStep && !PATH_STEP_TYPES.has(lastStep.type)
      && lastStep.type !== 'ArrayConstructor' && lastStep.type !== 'GroupByExpr' && lastStep.type !== 'SortExpr'
    ) {
      const { code, tuplesVar } = this.compilePathSteps(steps.slice(0, -1), ctx);
      if (ctx.activeTupleBindings.size === 0 && !containsParentRef(lastStep)) {
        const cb = this.genElementCallback(lastStep, ctx, () => this.genExpr(lastStep, ctx, false));
        return `(() => {\n${code}\nreturn P.exprFinal(${tuplesVar}, ${cb}, ${keep});\n})()`;
      }
      const next = ctx.fresh('tp');
      const stepCode = this.compilePathStep(lastStep, tuplesVar, next, ctx);
      return `(() => {\n${code}\n${stepCode}\nreturn P.collapseTuples(${next}, ${keep});\n})()`;
    }
    const { code, tuplesVar } = this.compilePathSteps(steps, ctx);
    return `(() => {\n${code}\nreturn P.collapseTuples(${tuplesVar}, ${keep});\n})()`;
  }

  /**
   * Decides whether `steps` can be compiled in value mode (plain values, no
   * `{v,p,b}` tuples — see the header block in `runtime/path.js`). Returns the
   * step list to compile, or `null` to fall back to tuple mode.
   *
   * A tuple is observable in exactly three ways, so value mode requires all
   * three to be absent:
   *   1. `%` (parent) anywhere in the path or its sub-expressions.
   *   2. `@$`/`#$` bindings — as a step here, or already active from an
   *      *enclosing* path (whose `@$` also gives a terminal field step its
   *      `$$` root fallback).
   *   3. Sibling-group scoping of a *positional* stage: a subscript `[n]`, or
   *      a predicate whose result may be numeric, applies per sibling group
   *      (`stepPredicate`'s `groupByParent`). Straight after the seed there is
   *      exactly one group, so a positional stage there is safe; after any
   *      step that re-parents the stream (navigation, or a per-element
   *      expression) it is not.
   * `^()` and non-dotted `{}` steps consume the raw tuple stream and are
   * rejected outright.
   */
  pathValueModeSteps(steps, ctx) {
    if (ctx.activeTupleBindings.size > 0) return null;
    let multiGroup = false; // more than one sibling group possible?
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (containsParentRef(step)) return null;
      switch (step.type) {
        case 'FieldRef':
        case 'WildcardStep':
        case 'DescendantStep':
          multiGroup = true;
          break;
        case 'PredicateExpr':
        case 'ArraySubscript': {
          const srcGroups = this.valueModeSourceGroups(step.source, multiGroup, ctx);
          if (srcGroups === null) return null;
          multiGroup = srcGroups;
          const positional = step.type === 'ArraySubscript' || !neverNumeric(step.predicate, ctx);
          if (positional && multiGroup) return null;
          break;
        }
        case 'ParentStep':
        case 'ContextBinding':
        case 'PositionBinding':
          return null;
        case 'VariableRef':
          // As the path's seed (`$employees.salary`) this is just an
          // expression; as a later step (`foo.$var`) it resolves against the
          // tuple's own `@$`/`#$` bindings, which value mode does not carry.
          if (i === 0) break;
          return null;
        case 'SortExpr':
        case 'GroupByExpr':
          // `^()`/`{}` need the tuple stream (sort keys and group-by pairs
          // both resolve `%`/bindings against it, and a seed `^()` must keep
          // the pre-sort parent linkage for a following positional stage).
          return null;
        default:
          // A per-element expression step (`foo.(a+b)`, `foo.[a,b]`): one
          // output per input, each re-parented to its own source element.
          if (i === 0 && !PATH_STEP_TYPES.has(step.type)) break; // path seed
          multiGroup = true;
          break;
      }
    }
    return steps;
  }

  /**
   * Validates a predicate/subscript step's folded `.source` for value mode and
   * returns the resulting "more than one sibling group?" state (`null` = not
   * eligible). `ContextRef` is identity; a navigation step or a whole
   * navigation path re-parents the stream.
   */
  valueModeSourceGroups(source, multiGroup, ctx) {
    if (!source || source.type === 'ContextRef') return multiGroup;
    if (source.type === 'FieldRef' || source.type === 'WildcardStep' || source.type === 'DescendantStep') return true;
    if (source.type === 'PathExpr') {
      return this.pathValueModeSteps(source.steps, ctx) === null ? null : true;
    }
    return null;
  }

  /**
   * Value-mode twin of `compilePathSteps` + `genPathExprBody`: compiles the
   * whole path and applies the terminal-step collapse rule. Only called for
   * step lists `pathValueModeSteps` accepted.
   *
   * Emitted as one nested expression (`vFieldFinal(vStepField(vSeed($), …), …)`)
   * rather than the statement sequence tuple mode uses: every value-mode step
   * is a pure call taking the previous stream as its first argument, so no
   * locals are needed — and skipping the wrapper IIFE removes one closure
   * allocation *per path per evaluation* (~6% of this benchmark's throughput
   * with 28 predicates in the expression).
   */
  genPathExprValueMode(steps, ctx, keep) {
    const last = steps.length - 1;
    const terminal = steps[last];
    // A terminal navigation step uses the `*Final` single-raw-result
    // passthrough rule instead of always-flattening (see `finalizeRaw`), so it
    // is applied to the stream produced by every step before it.
    if (terminal.type === 'FieldRef' || terminal.type === 'WildcardStep' || terminal.type === 'DescendantStep') {
      const stream = this.genValueModeStream(steps, ctx, last);
      if (terminal.type === 'FieldRef') return `P.vFieldFinal(${stream}, ${JSON.stringify(terminal.name)}, ${keep})`;
      if (terminal.type === 'WildcardStep') return `P.vWildcardFinal(${stream}, ${keep})`;
      return `P.vDescendantFinal(${stream}, ${keep})`;
    }
    // Terminal generic expression step: same verbatim-single-result rule as a
    // terminal navigation step (see `P.exprFinal`); a bare array constructor
    // is excluded (jsonata's `consarray` never flattens).
    if (
      last > 0 && !PATH_STEP_TYPES.has(terminal.type)
      && terminal.type !== 'ArrayConstructor' && terminal.type !== 'GroupByExpr' && terminal.type !== 'SortExpr'
    ) {
      const stream = this.genValueModeStream(steps, ctx, last);
      const cb = this.genElementCallback(terminal, ctx, () => this.genExpr(terminal, ctx, false));
      return `P.vExprFinal(${stream}, ${cb}, ${keep})`;
    }
    return `RT.collapse(${this.genValueModeStream(steps, ctx, steps.length)}, ${keep})`;
  }

  /**
   * Value-mode steps compiled to a *stream* expression (no terminal collapse),
   * consuming `steps[0..upto)`. `upto === 0` emits just the path's seed.
   */
  genValueModeStream(steps, ctx, upto = steps.length) {
    let expr;
    let i = 0;
    if (!PATH_STEP_TYPES.has(steps[0].type)) {
      expr = `P.vSeed(${this.genExpr(steps[0], ctx, false)})`;
      i = 1;
    } else {
      // Same "bare first step treats an array `$` as multiple implicit root
      // items, an explicit `$[...]`/`$#$pos` does not" rule as tuple mode.
      const isExplicitDollarStep = (steps[0].type === 'ArraySubscript' || steps[0].type === 'PredicateExpr')
        && steps[0].source && steps[0].source.type === 'ContextRef';
      const rootWrap = ctx.dollarIsRoot && !isExplicitDollarStep;
      expr = rootWrap ? 'P.vSeedSingle($)' : 'P.vSeed($)';
    }
    for (; i < upto; i++) {
      expr = this.genPathStepValueMode(steps[i], expr, ctx);
    }
    return expr;
  }

  /** One value-mode step: `srcExpr` is an expression producing the incoming values array. */
  genPathStepValueMode(step, srcExpr, ctx) {
    switch (step.type) {
      case 'FieldRef':
        return `P.vStepField(${srcExpr}, ${JSON.stringify(step.name)})`;
      case 'WildcardStep':
        return `P.vStepWildcard(${srcExpr})`;
      case 'DescendantStep':
        return `P.vStepDescendant(${srcExpr})`;
      case 'PredicateExpr': {
        const src = this.genValueModeSource(step.source, srcExpr, ctx);
        const cb = this.genElementCallback(step.predicate, ctx, () => this.genExpr(step.predicate, ctx, false));
        return `P.vFilter(${src}, ${cb})`;
      }
      case 'ArraySubscript': {
        const src = this.genValueModeSource(step.source, srcExpr, ctx);
        const cb = this.genElementCallback(step.index, ctx, () => this.genExpr(step.index, ctx, false));
        return `P.vSubscript(${src}, ${cb})`;
      }
      default: {
        // Same flatten rule as tuple mode (see `compilePathStep`'s default
        // case): only a syntactically bare array constructor keeps its
        // per-element array nested.
        const cb = this.genElementCallback(step, ctx, () => this.genExpr(step, ctx, false));
        const helper = step.type === 'ArrayConstructor' ? 'vStepExpr' : 'vStepFlatten';
        return `P.${helper}(${srcExpr}, ${cb})`;
      }
    }
  }

  /**
   * Value-mode `compileFoldSource`: chains a folded `.source` onto `srcExpr`.
   * `ContextRef` is identity; a navigation step or a whole navigation path is
   * compiled as value-mode steps (`pathValueModeSteps` already accepted it).
   */
  genValueModeSource(sourceNode, srcExpr, ctx) {
    if (!sourceNode || sourceNode.type === 'ContextRef') return srcExpr;
    if (sourceNode.type === 'PathExpr') {
      let expr = srcExpr;
      for (const s of sourceNode.steps) expr = this.genPathStepValueMode(s, expr, ctx);
      return expr;
    }
    return this.genPathStepValueMode(sourceNode, srcExpr, ctx);
  }

  /**
   * Statically rejects a path whose `%` steps can *never* resolve an
   * ancestor, regardless of runtime data (e.g. `library.loans.%.%.%` -
   * only 2 real navigation steps precede 3 parent-hops; `$.%`/`$$.%`/
   * `{...}.%` - the seed isn't a navigation step at all) - jsonata's own
   * `S0217` ("the object representing the 'parent' cannot be derived from
   * this expression"), thrown at compile time. Only `FieldRef`/
   * `WildcardStep`/`DescendantStep` count as a level of available
   * ancestor depth (matching jsonata's own `seekParent`, which only
   * treats `name`/`wildcard` steps that way); every other step type
   * (predicates, bindings, subscripts, bare expressions) is depth-neutral
   * - it neither adds nor consumes a level. Skipped when this path is
   * itself nested inside an enclosing per-element closure (`ctx.parentVar`
   * truthy): that closure may supply additional depth this purely local
   * walk can't see, so a negative local count there isn't conclusive.
   */
  validateParentDepth(steps, ctx) {
    if (ctx.parentVar) return;
    let depth = 0;
    for (const step of steps) {
      if (step.type === 'ParentStep') {
        depth--;
        if (depth < 0) throw new ParseError('S0217', step.pos, { token: step.type });
      } else if (step.type === 'FieldRef' || step.type === 'WildcardStep' || step.type === 'DescendantStep') {
        depth++;
      }
    }
  }

  /**
   * Compiles a path's step list to a sequence of statements ending with a
   * tuples-array variable; returns `{ code, tuplesVar }`. Shared by
   * `genPathExpr`, standalone `PredicateExpr`/`ArraySubscript`, and by
   * `SortExpr`/`GroupByExpr`/`TransformExpr` (which need the raw tuples,
   * not a collapsed value, to preserve `%` parent-chain fidelity).
   */
  /** True if `step`, used as a `PathExpr`'s first step, must establish its own fresh seed (ignoring any outer accumulator) rather than fold onto one - `%` (needs the enclosing closure's parent tuple), `^()` (needs its own sorted-tuples seed), or anything not itself a continuation-style step (`VariableRef`, a bare expression, `ContextRef`, ...). */
  needsIndependentSeed(step) {
    return step.type === 'ParentStep' || step.type === 'SortExpr' || !PATH_STEP_TYPES.has(step.type);
  }

  /**
   * Compiles `compileFn` with `ctx.parentVar`/`ctx.tupleBindingsVar` rebound
   * to freshly-minted per-element-closure identifiers, restoring the
   * previous values afterward. Every generated `($, __pt, __tb) => (...)`
   * per-element callback (predicate/subscript conditions, sort keys,
   * group-by pairs, bare path-step expressions) MUST mint its own names
   * this way instead of hardcoding the literal `__pt`/`__tb` - a construct
   * like this one can itself be *compiled while already lexically inside*
   * another such callback (a predicate nested in a group-by value, e.g.
   * `items#$i.{'x': $$.items[$i]...}`), and JS's own closure shadowing
   * would otherwise make the *inner* (usually binding-less) `__tb` win
   * over the *outer* one a variable like `$i` actually needs - silently
   * resolving to `undefined` instead of a compile error, since
   * `ENV[name]` is always a legal (if wrong) fallback. Returns
   * `{ result, ptName, tbName }`: `result` is whatever `compileFn`
   * returns, `ptName`/`tbName` are this scope's own fresh identifiers to
   * use in the enclosing callback's own parameter list.
   */
  withFreshElementScope(ctx, compileFn) {
    const savedParent = ctx.parentVar;
    const savedTB = ctx.tupleBindingsVar;
    const savedDollarIsRoot = ctx.dollarIsRoot;
    const savedInPathScope = ctx.inPathScope;
    const ptName = ctx.fresh('pt');
    const tbName = ctx.fresh('tb');
    ctx.parentVar = ptName;
    ctx.tupleBindingsVar = tbName;
    ctx.dollarIsRoot = false;
    ctx.inPathScope = true;
    ctx.tbStack.push(tbName);
    const result = compileFn(ptName, tbName);
    ctx.tbStack.pop();
    ctx.parentVar = savedParent;
    ctx.tupleBindingsVar = savedTB;
    ctx.dollarIsRoot = savedDollarIsRoot;
    ctx.inPathScope = savedInPathScope;
    return { result, ptName, tbName };
  }


  compilePathSteps(steps, ctx) {
    this.validateParentDepth(steps, ctx);
    const lines = [];
    let cur = ctx.fresh('tp');
    let i = 0;
    const savedStepHasStage = ctx.stepHasStage;
    ctx.stepHasStage = false;
    if (steps.length > 0 && steps[0].type === 'ParentStep') {
      // `%` as the first step of a path (e.g. `%.OrderID`, `%.%.Foo`) must
      // resolve against the *tuple* captured by the enclosing per-element
      // closure (`ctx.parentVar`), not the ambient `$` value - `$` has no
      // `.p` parent-tuple linkage, so seeding from it would make `%` always
      // resolve to nothing.
      lines.push(`let ${cur} = ${ctx.parentVar} ? [${ctx.parentVar}] : [];`);
      i = 1;
    } else if (steps.length > 0 && steps[0].type === 'SortExpr') {
      // `^()` as the seed step of an outer path (e.g. `Foo^(k).{...}`)
      // must keep the raw sorted tuples (with `.b` bindings, `.p` parent
      // chain) so later steps can still see `@$`/`#$` bindings and `%`
      // established before the sort - collapsing here (as the standalone
      // `genSortExpr` terminal form does) would drop them.
      const { stmts, tuplesVar } = this.compileSortToTuples(steps[0], ctx);
      lines.push(...stmts);
      cur = tuplesVar;
      i = 1;
    } else if (steps.length > 0 && !PATH_STEP_TYPES.has(steps[0].type)) {
      const seedExpr = this.genExpr(steps[0], ctx, false);
      lines.push(`let ${cur} = P.seed(${seedExpr});`);
      i = 1;
    } else {
      // The root-array "treat as one opaque item" wrap only matches real
      // jsonata's bare (non-`$`-prefixed) first step - `$[0].foo`/`$#$pos`
      // parse with `steps[0].source === 'ContextRef'` (an *explicit* `$`
      // was written) and must behave like ordinary indexing into `$`'s
      // current value instead, exactly like ContextRef itself would via
      // the branch above.
      const isExplicitDollarStep = steps.length > 0 && (steps[0].type === 'ArraySubscript' || steps[0].type === 'PredicateExpr')
        && steps[0].source && steps[0].source.type === 'ContextRef';
      const rootWrap = ctx.dollarIsRoot && !isExplicitDollarStep;
      lines.push(`let ${cur} = ${rootWrap ? 'P.seedSingle($)' : 'P.seed($)'};`);
    }
    for (; i < steps.length; i++) {
      const step = steps[i];
      const next = ctx.fresh('tp');
      lines.push(this.compilePathStep(step, cur, next, ctx, i === 0));
      cur = next;
    }
    ctx.stepHasStage = savedStepHasStage;
    return { code: lines.join('\n'), tuplesVar: cur };
  }

  /**
   * Compiles a step's `.source` (ContextRef = identity, else a nested fold
   * target) onto `curVar`; returns `{code, resultVar}`. `isPathSeedStep` marks
   * the stage as the path's own first step, where the source establishes the
   * sequence instead of continuing an incoming stream.
   */
  compileFoldSource(sourceNode, curVar, ctx, isPathSeedStep) {
    if (sourceNode.type === 'ContextRef') return { code: '', resultVar: curVar };
    if (sourceNode.type === 'PathExpr') {
      if (sourceNode.steps.length > 0 && this.needsIndependentSeed(sourceNode.steps[0])) {
        // The source path's own first step (e.g. `$c` in `$c.Phone[cond]`,
        // `%` in `%.Foo[cond]`) needs a fresh seed of its own - it is not
        // a continuation of the *outer* accumulator `curVar` at all
        // (`VariableRef`'s `stepVariableStep` ignores its input tuple's
        // value entirely, resolving purely from bindings/`ENV`, so
        // chaining it onto `curVar` would re-evaluate it once per
        // `curVar` tuple and duplicate/cartesian-product the result -
        // see the `joins` conformance group).
        const { code, tuplesVar } = this.compilePathSteps(sourceNode.steps, ctx);
        return { code, resultVar: tuplesVar };
      }
      const lines = [];
      let cur = curVar;
      for (const s of sourceNode.steps) {
        const next = ctx.fresh('tp');
        lines.push(this.compilePathStep(s, cur, next, ctx));
        cur = next;
      }
      return { code: lines.join('\n'), resultVar: cur };
    }
    if (PATH_STEP_TYPES.has(sourceNode.type)) {
      const resultVar = ctx.fresh('tp');
      const code = this.compilePathStep(sourceNode, curVar, resultVar, ctx);
      return { code, resultVar };
    }
    const resultVar = ctx.fresh('tp');
    if (isPathSeedStep) {
      // The stage IS the path's first step (`$var[0]`, `(a.b)[0]` as a whole
      // expression): its source establishes the sequence, evaluated once
      // against the ambient context.
      const valExpr = this.genExpr(sourceNode, ctx, false);
      return { code: `let ${resultVar} = P.seed(${valExpr});`, resultVar };
    }
    // A stage further along the path (`o.(p^(v))[0]`, `o.([q,q])[0]`): the
    // source is a per-element expression step over the incoming stream, so
    // every element keeps its own parent and the stage's `[n]` stays scoped to
    // each sibling group — the reference gives `[1,3]` for
    // `o.(p^(v))[0].v`, i.e. the first per source element, not the first
    // overall. Evaluating the source once against the ambient `$` (what this
    // used to do) resolved it against the wrong context entirely.
    const helper = sourceNode.type === 'ArrayConstructor' ? 'stepExpr' : 'stepFlatten';
    const cb = this.genElementCallback(sourceNode, ctx, () => this.genExpr(sourceNode, ctx, false));
    return { code: `let ${resultVar} = P.${helper}(${curVar}, ${cb});`, resultVar };
  }

  /**
   * A `Parenthesized{inner: PathExpr}` predicate/subscript `.source`
   * (e.g. `(Account.Order.Product)[%.OrderID=...]`) is left wrapped by
   * default - `compileFoldSource`/`compileSourceToTuples` treat it as an
   * opaque value-producing expression, collapsing it to its terminal
   * value first (the cheaper, common-case path, correct whenever the
   * predicate/index doesn't need the parenthesized path's own tuple
   * shape). Only when `conditionNode` (the predicate or subscript index)
   * actually references `%` does it need that path's raw tuples (parent
   * chain intact, not just the collapsed value) - unwrap to the inner
   * `PathExpr` so `compileFoldSource`/`compileSourceToTuples`'s own
   * `PathExpr` handling compiles and chains it exactly as if the parens
   * were never there.
   */
  unwrapParenSourceIfNeeded(sourceNode, conditionNode) {
    if (sourceNode.type === 'Parenthesized' && containsParentRef(conditionNode)) return sourceNode.inner;
    return sourceNode;
  }

  /** `isPathSeedStep`: this step is the path's first, so a stage's own `.source` establishes the sequence rather than continuing one (see `compileFoldSource`). */
  compilePathStep(step, curVar, nextVar, ctx, isPathSeedStep) {
    switch (step.type) {
      case 'FieldRef': {
        ctx.stepHasStage = false;
        const fallback = ctx.activeTupleBindings.size > 0 ? ', $$' : '';
        return `let ${nextVar} = P.stepField(${curVar}, ${JSON.stringify(step.name)}${fallback});`;
      }
      case 'WildcardStep':
        ctx.stepHasStage = false;
        return `let ${nextVar} = P.stepWildcard(${curVar});`;
      case 'DescendantStep':
        ctx.stepHasStage = false;
        return `let ${nextVar} = P.stepDescendant(${curVar});`;
      case 'ParentStep':
        return `let ${nextVar} = P.stepParent(${curVar});`;
      case 'PositionBinding': {
        // The *first* `#$var`/predicate/subscript for its navigational
        // step is scoped per sibling-group (jsonata's own `step.index`,
        // assigned during the per-outer-iteration expand); a `#$var` that
        // instead *follows* a predicate/subscript on the same step
        // (`ctx.stepHasStage`) indexes globally across the whole
        // already-filtered tuple stream instead (jsonata's
        // `evaluateStages` "index"-type stage) - see `stepPositionBind`.
        ctx.activeTupleBindings.add(step.varName);
        const global = ctx.stepHasStage;
        return `let ${nextVar} = P.stepPositionBind(${curVar}, ${JSON.stringify(step.varName)}, ${global});`;
      }
      case 'ContextBinding': {
        ctx.activeTupleBindings.add(step.varName);
        return `let ${nextVar} = P.stepContextBind(${curVar}, ${JSON.stringify(step.varName)});`;
      }
      case 'VariableRef': {
        const outer = ctx.resolveVariable(step.name);
        return `let ${nextVar} = P.stepVariableStep(${curVar}, ${JSON.stringify(step.name)}, () => (${outer}));`;
      }
      case 'PredicateExpr': {
        // `.source` is either ContextRef (identity — the fold-onto-position/context-binding
        // case) or a nested primitive step (e.g. the wrapped FieldRef when this PredicateExpr
        // itself was wrapped as a bare path step, such as `Order[cond].Product`'s `Order[cond]`).
        const { code: srcCode, resultVar: mid } = this.compileFoldSource(this.unwrapParenSourceIfNeeded(step.source, step.predicate), curVar, ctx, isPathSeedStep);
        const global = ctx.activeTupleBindings.size > 0;
        const cb = this.genElementCallback(step.predicate, ctx, () => this.genExpr(step.predicate, ctx, false));
        ctx.stepHasStage = true;
        const predLine = `let ${nextVar} = P.stepPredicate(${mid}, ${cb}, ${global});`;
        return srcCode ? `${srcCode}\n${predLine}` : predLine;
      }
      case 'ArraySubscript': {
        const { code: srcCode, resultVar: mid } = this.compileFoldSource(this.unwrapParenSourceIfNeeded(step.source, step.index), curVar, ctx, isPathSeedStep);
        const global = ctx.activeTupleBindings.size > 0;
        const cb = this.genElementCallback(step.index, ctx, () => this.genExpr(step.index, ctx, false));
        ctx.stepHasStage = true;
        const subLine = `let ${nextVar} = P.stepSubscript(${mid}, ${cb}, ${global});`;
        return srcCode ? `${srcCode}\n${subLine}` : subLine;
      }
      default: {
        // An arbitrary expression used as a bare path step (`foo.{...}`
        // group-by, `foo.[...]` array constructor, `foo.(a+b)` parenthesized
        // expression): evaluated per element with `$` rebound to that element.
        //
        // An array-valued per-element result FLATTENS into the outer sequence
        // — verified against the reference interpreter: `o.(p^(v))`,
        // `o.($map(p, …))`, `o.([q,q])` and `nums.([$,$])` all flatten one
        // level. The single exception is a *syntactically bare* array
        // constructor step (`o.[q,q]`, `o.p.[v,v]` → `[[5,5],[6,6]]`), which
        // jsonata marks `consarray` and never flattens; wrapping the same
        // constructor in parentheses removes the marking and it flattens
        // again. Tuple-mode paths (`%`/`@$`/`#$` anywhere) go through
        // jsonata's distinct `evaluateTupleStep`, which flattens
        // unconditionally — see the `joins`/`parent-operator` groups
        // (`Employee@$e.(Contact)`, `Foo.[X, %.Y]`).
        const tupleMode = ctx.activeTupleBindings.size > 0 || containsParentRef(step);
        const cb = this.genElementCallback(step, ctx, () => this.genExpr(step, ctx, false));
        ctx.stepHasStage = false;
        const helper = !tupleMode && step.type === 'ArrayConstructor' ? 'stepExpr' : 'stepFlatten';
        return `let ${nextVar} = P.${helper}(${curVar}, ${cb});`;
      }
    }
  }

  /**
   * Standalone (non-folded) predicate/subscript, e.g. `$employees[cond]` or
   * `Employee@$e.Contact[...]`. Both are exactly a one-step path over the
   * source, so they are offered to the value-mode compiler as a synthetic
   * step list first (`X[cond]` ≡ path `X` followed by a `ContextRef`-sourced
   * stage) and fall back to the tuple stream — needed to preserve `%` parent
   * chains and `@$`/`#$` bindings — only when value mode declines.
   *
   * A `PathExpr` source contributes its own steps, chained. Any other source
   * is a *value*: `compileSourceToTuples` collapses it and re-seeds, which
   * spreads an array result into one item per element (`$[1][0]` on
   * `[[1,2],[3,4]]` is `3`, not `[3,4]`). Wrapping it in `Parenthesized`
   * keeps that meaning here, since only a non-step node is treated as the
   * path's seed expression.
   */
  syntheticStageSteps(node, conditionNode) {
    const src = this.unwrapParenSourceIfNeeded(node.source, conditionNode);
    const stage = Object.assign({}, node, { source: { type: 'ContextRef' } });
    if (src.type === 'PathExpr') return [...src.steps, stage];
    const seed = PATH_STEP_TYPES.has(src.type) ? { type: 'Parenthesized', inner: src } : src;
    return [seed, stage];
  }

  genPredicateExpr(node, ctx) {
    const vm = this.pathValueModeSteps(this.syntheticStageSteps(node, node.predicate), ctx);
    if (vm) return this.genPathExprValueMode(vm, ctx, 'false');
    const { stmts, tuplesVar } = this.compileSourceToTuples(this.unwrapParenSourceIfNeeded(node.source, node.predicate), ctx);
    const global = ctx.activeTupleBindings.size > 0;
    const cb = this.genElementCallback(node.predicate, ctx, () => this.genExpr(node.predicate, ctx, false));
    const lines = stmts.slice();
    lines.push(`return P.collapseTuples(P.stepPredicate(${tuplesVar}, ${cb}, ${global}), false);`);
    return `(() => {\n${lines.join('\n')}\n})()`;
  }

  genArraySubscript(node, ctx) {
    const vm = this.pathValueModeSteps(this.syntheticStageSteps(node, node.index), ctx);
    if (vm) return this.genPathExprValueMode(vm, ctx, 'false');
    const { stmts, tuplesVar } = this.compileSourceToTuples(this.unwrapParenSourceIfNeeded(node.source, node.index), ctx);
    const global = ctx.activeTupleBindings.size > 0;
    const cb = this.genElementCallback(node.index, ctx, () => this.genExpr(node.index, ctx, false));
    const lines = stmts.slice();
    lines.push(`return P.collapseTuples(P.stepSubscript(${tuplesVar}, ${cb}, ${global}), false);`);
    return `(() => {\n${lines.join('\n')}\n})()`;
  }


  genForceArray(node, ctx) {
    // `[]` means "keep singleton array" - the whole path's final result
    // stays a 1-element array instead of collapsing to a scalar. Treating
    // a non-path source as a synthetic 1-step path reuses `genPathExpr`'s
    // existing step-type-aware collapse logic (terminal field/wildcard/
    // descendant `*Final` passthrough, group-by aggregation, or the
    // generic `collapseTuples`) uniformly, instead of a separate
    // `RT.forceArray` runtime helper with different collapse semantics.
    const pathNode = node.source.type === 'PathExpr' ? node.source : { steps: [node.source] };
    return this.genPathExpr(pathNode, ctx, false, true);
  }

  genParenthesized(node, ctx, tail) {
    return this.genExpr(node.inner, ctx, tail);
  }

  // ===== constructors =====

  genArrayConstructor(node, ctx) {
    const stmts = [];
    const out = ctx.fresh('arr');
    stmts.push(`const ${out} = [];`);
    for (const el of node.elements) {
      const code = this.genExpr(el, ctx, false);
      if (el.type === 'ArrayConstructor') {
        stmts.push(`${out}.push(${code});`);
      } else {
        stmts.push(`RT.appendToSequence(${out}, ${code});`);
      }
    }
    stmts.push(`return ${out};`);
    return `(() => {\n${stmts.join('\n')}\n})()`;
  }

  genObjectConstructor(node, ctx) {
    const out = ctx.fresh('obj');
    // Object.create(null): a plain `{}` here would let a `"__proto__"` key
    // silently reassign the result's prototype instead of becoming an
    // ordinary own key (reference jsonata builds every constructed object
    // via `Object.create(null)` - see jsonata.js's `evaluateGroupExpression`/
    // object-constructor evaluator) - see CODE-REVIEW.md H5.
    const stmts = [`const ${out} = Object.create(null);`];
    for (const pair of node.pairs) {
      const keyVar = ctx.fresh('k');
      const keyCode = this.genExpr(pair.key, ctx, false);
      const valCode = this.genExpr(pair.value, ctx, false);
      stmts.push(`const ${keyVar} = ${keyCode};`);
      stmts.push(`if (${keyVar} !== undefined) {`);
      stmts.push(`  if (typeof ${keyVar} !== 'string') throw RT.err('T1003', { value: ${keyVar} });`);
      stmts.push(`  const __v = ${valCode};`);
      stmts.push(`  if (__v !== undefined) ${out}[${keyVar}] = __v;`);
      stmts.push('}');
    }
    stmts.push(`return ${out};`);
    return `(() => {\n${stmts.join('\n')}\n})()`;
  }

  // ===== operators =====

  genBinaryOp(node, ctx) {
    const op = node.op;
    if (op === 'and') {
      const l = this.genExpr(node.left, ctx, false);
      const rThunk = `() => (${this.genExpr(node.right, ctx, false)})`;
      return `RT.and(${l}, ${rThunk})`;
    }
    if (op === 'or') {
      const l = this.genExpr(node.left, ctx, false);
      const rThunk = `() => (${this.genExpr(node.right, ctx, false)})`;
      return `RT.or(${l}, ${rThunk})`;
    }
    const l = this.genExpr(node.left, ctx, false);
    const r = this.genExpr(node.right, ctx, false);
    switch (op) {
      case '+': return `RT.add(${l}, ${r})`;
      case '-': return `RT.subtract(${l}, ${r})`;
      case '*': return `RT.multiply(${l}, ${r})`;
      case '/': return `RT.divide(${l}, ${r})`;
      case '%': return `RT.modulo(${l}, ${r})`;
      case '&': return `RT.concat(${l}, ${r})`;
      case '=': return `RT.eq(${l}, ${r})`;
      case '!=': return `RT.ne(${l}, ${r})`;
      case '<': return `RT.lt(${l}, ${r})`;
      case '<=': return `RT.le(${l}, ${r})`;
      case '>': return `RT.gt(${l}, ${r})`;
      case '>=': return `RT.ge(${l}, ${r})`;
      case 'in': return `RT.inOp(${l}, ${r})`;
      case '..': return `RT.range(${l}, ${r})`;
      default: throw new Error(`translator: unsupported binary operator "${op}"`);
    }
  }

  genUnaryMinus(node, ctx) {
    return `RT.negate(${this.genExpr(node.operand, ctx, false)})`;
  }

  genRangeExpr(node, ctx) {
    return `RT.range(${this.genExpr(node.from, ctx, false)}, ${this.genExpr(node.to, ctx, false)})`;
  }

  genElvisExpr(node, ctx, tail) {
    const l = ctx.fresh('el');
    const left = this.genExpr(node.left, ctx, false);
    const right = this.genExpr(node.right, ctx, tail);
    return `((${l}) => RT.isTruthy(${l}) ? ${l} : (${right}))(${left})`;
  }

  genCoalesceExpr(node, ctx, tail) {
    const l = ctx.fresh('co');
    const left = this.genExpr(node.left, ctx, false);
    const right = this.genExpr(node.right, ctx, tail);
    return `((${l}) => ${l} !== undefined ? ${l} : (${right}))(${left})`;
  }

  genConditionalExpr(node, ctx, tail) {
    const cond = this.genExpr(node.condition, ctx, false);
    const then = this.genExpr(node.then, ctx, tail);
    const otherwise = node.otherwise ? this.genExpr(node.otherwise, ctx, tail) : 'undefined';
    return `(RT.isTruthy(${cond}) ? (${then}) : (${otherwise}))`;
  }

  // ===== blocks / bindings =====

  genBlock(node, ctx, tail) {
    if (node.expressions.length === 0) return 'undefined';
    // Pre-declare every binding name in this block so forward/mutual
    // references between sibling lambdas resolve lexically (matching JS's
    // own `let`-in-a-block behavior for deferred/closure access). `let`
    // (not `const`) because JSONata allows the same name to be `:=`-bound
    // more than once in one block (each occurrence rebinds it from that
    // point on, e.g. `$a := 5; $a := $a + 2`), which `const` would reject
    // as a redeclaration. Computed *before* `pushScope` so the shadow
    // check below sees only outer scopes, not this block's own names.
    const rawNames = [...new Set(
      node.expressions.filter((e) => e.type === 'VariableBinding').flatMap((e) => this.chainedBindingNames(e))
    )];
    const identFor = new Map();
    for (const name of rawNames) {
      const plain = GenCtx.jsName('v_', name);
      // A block-hoisted `let` for this name would shadow an outer binding
      // of the same name (e.g. a lambda parameter) for the *entire*
      // block, corrupting an initializer that means to read that outer
      // value (`$x := $x ? $x : 1`) - give it a fresh identifier instead.
      identFor.set(name, ctx.isLexicallyBound(plain) ? ctx.fresh(plain + '_') : plain);
    }
    ctx.pushScope();
    const savedTB = ctx.tupleBindingsVar;
    const savedTBStack = ctx.tbStack;
    const savedActive = ctx.activeTupleBindings;
    const savedInPathScope = ctx.inPathScope;
    ctx.tupleBindingsVar = null;
    ctx.tbStack = [];
    ctx.activeTupleBindings = new Set();
    ctx.inPathScope = false;
    for (const name of rawNames) ctx.declareAlias(name, identFor.get(name));
    const stmts = [...new Set(identFor.values())].map((ident) => `let ${ident};`);
    const seenInThisBlock = new Set();
    for (let i = 0; i < node.expressions.length; i++) {
      const e = node.expressions[i];
      const isLast = i === node.expressions.length - 1;
      if (e.type === 'VariableBinding') {
        const ident = identFor.get(e.name);
        // A non-lambda initializer's own self-reference (e.g. `$step := $step ? $step : 1`)
        // must see the *outer* binding, not this not-yet-initialized one (real JS `const`
        // TDZ would reject that); a lambda's self-reference must see *this* binding (to
        // support self/mutual recursion, since the body only runs after full initialization).
        // Only applies to this name's *first* binding in the block - a later rebinding of
        // the same name (`$a := 5; $a := $a + 2`) must see the value just assigned to it.
        const hideOwnName = e.value.type !== 'Lambda' && !seenInThisBlock.has(e.name);
        seenInThisBlock.add(e.name);
        if (hideOwnName) ctx.undeclareAlias(e.name);
        const savedSuppress = ctx.suppressParentAncestryCheck;
        if (e.isCalleeBinding) ctx.suppressParentAncestryCheck = true;
        const valCode = this.genBindingValue(e.value, ctx, identFor);
        ctx.suppressParentAncestryCheck = savedSuppress;
        if (hideOwnName) ctx.declareAlias(e.name, ident);
        stmts.push(`${ident} = ${valCode};`);
        if (isLast) stmts.push(`return ${ident};`);
      } else {
        const code = this.genExpr(e, ctx, isLast && tail);
        if (isLast) stmts.push(`return (${code});`);
        else stmts.push(`(${code});`);
      }
    }
    ctx.tupleBindingsVar = savedTB;
    ctx.tbStack = savedTBStack;
    ctx.activeTupleBindings = savedActive;
    ctx.inPathScope = savedInPathScope;
    ctx.popScope();
    return `(() => {\n${stmts.join('\n')}\n})()`;
  }

  /**
   * Compiles a `VariableBinding`'s `.value`. If the value is itself a
   * `VariableBinding` (chained assignment, e.g. `$a := $b := 5`), `$b` was
   * pre-declared by the enclosing `genBlock` (`identFor`, from
   * `chainedBindingNames`) so it stays visible in that same block after
   * this statement - assign into it directly rather than creating a fresh
   * nested scope. Anything else (including a `VariableBinding` reached
   * only via a `Parenthesized` wrapper, e.g. `(a; ($x := 1); b)` -
   * jsonata's parens always open a new scope, even around a single
   * statement) goes through the ordinary `genExpr` dispatch, where
   * `genVariableBinding` gives it its own scope.
   */
  genBindingValue(node, ctx, identFor) {
    if (node.type === 'VariableBinding') {
      const ident = identFor.get(node.name);
      const hideOwnName = node.value.type !== 'Lambda';
      if (hideOwnName) ctx.undeclareAlias(node.name);
      const valCode = this.genBindingValue(node.value, ctx, identFor);
      if (hideOwnName) ctx.declareAlias(node.name, ident);
      return `(${ident} = ${valCode})`;
    }
    return this.genExpr(node, ctx, false);
  }

  /** Collects `node`'s raw name plus every nested `VariableBinding` name reachable through a chained `:=` value (e.g. `$a := $b := 5` binds both `$a` and `$b`). */
  chainedBindingNames(node) {
    const names = [node.name];
    if (node.value.type === 'VariableBinding') names.push(...this.chainedBindingNames(node.value));
    return names;
  }

  genVariableBinding(node, ctx) {
    // Standalone (not a direct top-level/chained statement of an enclosing
    // Block, e.g. the whole program is `$x := 5`, or this is reached
    // through a `Parenthesized` wrapper - see `genBindingValue`): always
    // gets its own fresh scope, matching jsonata's parens-always-a-block
    // semantics.
    const ident = GenCtx.jsName('v_', node.name);
    // A lambda value's own body may self-reference this binding's name
    // (recursion, e.g. `$f := function($n){...$f(...)...}`) - declare it
    // *before* compiling the value so that reference resolves lexically
    // instead of falling through to `ENV`/a same-named builtin. A
    // non-lambda value's self-reference (`$x := $x + 1`) must instead see
    // the *outer* binding (this one isn't initialized yet), matching
    // `genBindingValue`'s identical rule for the block-statement path.
    const isLambda = node.value.type === 'Lambda';
    if (isLambda) ctx.declare(ident);
    const valCode = this.genExpr(node.value, ctx, false);
    if (!isLambda) ctx.declare(ident);
    return `(() => { const ${ident} = ${valCode}; return ${ident}; })()`;
  }

  // ===== lambdas / function calls =====

  genLambda(node, ctx) {
    ctx.pushScope();
    const params = node.params.map((p) => GenCtx.jsName('v_', p));
    for (const p of params) ctx.declare(p);
    const savedInLambda = ctx.inLambdaBody;
    const savedParent = ctx.parentVar;
    const savedTB = ctx.tupleBindingsVar;
    const savedTBStack = ctx.tbStack;
    const savedActive = ctx.activeTupleBindings;
    const savedInPathScope = ctx.inPathScope;
    ctx.inLambdaBody = true;
    ctx.parentVar = null;
    ctx.tupleBindingsVar = null;
    ctx.tbStack = [];
    ctx.activeTupleBindings = new Set();
    ctx.inPathScope = false;
    const bodyCode = this.genExpr(node.body, ctx, true);
    ctx.inLambdaBody = savedInLambda;
    ctx.parentVar = savedParent;
    ctx.tupleBindingsVar = savedTB;
    ctx.tbStack = savedTBStack;
    ctx.activeTupleBindings = savedActive;
    ctx.inPathScope = savedInPathScope;
    ctx.popScope();
    const depthCost = estimateRecursionDepthCost(node.body, 1);
    return `FV.tagFunction((${params.join(',')}) => (${bodyCode}), ${params.length}${node.signature ? `, ${JSON.stringify(node.signature)}` : ', null'}, ${depthCost})`;
  }

  genLambdaCall(node, ctx) {
    const lambdaCode = this.genLambda(node.lambda, ctx);
    const argsCode = node.args.map((a) => this.genExpr(a, ctx, false));
    return `LAM.applyFn(${lambdaCode}, [${argsCode.join(',')}], $)`;
  }

  genPartialPlaceholder() {
    throw new Error('translator: PartialPlaceholder must only appear as a PartialApplication argument');
  }

  genPartialApplication(node, ctx) {
    const phParams = [];
    const argExprs = node.args.map((a) => {
      if (a.type === 'PartialPlaceholder') {
        const p = ctx.fresh('ph');
        phParams.push(p);
        return p;
      }
      return this.genExpr(a, ctx, false);
    });
    if (node.bare) {
      // A bare callee must be resolved (and checked) *now*, not deferred
      // into the returned partial-application closure - jsonata reports
      // an uncallable bare callee (T1005/T1008) as soon as the partial
      // application expression itself is evaluated, before it is ever
      // invoked.
      const isBuiltin = this.builtinNames.has(node.name);
      const calleeVar = ctx.fresh('pfn');
      const errCode = isBuiltin ? 'T1007' : 'T1008';
      const errExtra = isBuiltin ? `{ token: ${JSON.stringify(node.name)} }` : '{}';
      return `((${calleeVar}) => {\n` +
        `if (typeof ${calleeVar} !== 'function' && !FV.isRegexValue(${calleeVar})) throw RT.err(${JSON.stringify(errCode)}, ${errExtra});\n` +
        `return FV.tagFunction((${phParams.join(',')}) => (LAM.applyFn(${calleeVar}, [${argExprs.join(',')}], $)), ${phParams.length});\n` +
        `})(RT.field($, ${JSON.stringify(node.name)}))`;
    }
    const callCode = this.genStaticOrDynamicCall(node.name, argExprs, ctx, false);
    return `FV.tagFunction((${phParams.join(',')}) => (${callCode}), ${phParams.length})`;
  }

  genFunctionCall(node, ctx, tail) {
    if (node.bare) {
      // A bare (non-`$`-prefixed) callee is a field lookup against the
      // current context, never a builtin/lexical dispatch - see
      // `lambda.js#callBareFunctionValue`.
      const argsCode = node.args.map((a) => this.genExpr(a, ctx, false));
      const isBuiltin = this.builtinNames.has(node.name);
      const helper = tail && ctx.inLambdaBody ? 'thunkBare' : 'applyBareFn';
      return `LAM.${helper}($, ${JSON.stringify(node.name)}, [${argsCode.join(',')}], ${isBuiltin})`;
    }
    let argNodes = node.args;
    const jsName = GenCtx.jsName('v_', node.name);
    const isStaticBuiltin = this.builtinNames.has(node.name) && !ctx.isLexicallyBound(jsName);
    if (isStaticBuiltin && argNodes.length === 0 && CONTEXT_DEFAULT.has(node.name)) {
      // Calling a context-default builtin with zero explicit arguments
      // substitutes the current `$` for its first parameter. If `$` then
      // fails that parameter's type check, jsonata reports it as T0411
      // ("context value is not a compatible type"), not the generic T0410
      // used for an explicitly-passed bad argument - `RT.ctxDefaultCall`
      // re-tags that one specific failure.
      return `RT.ctxDefaultCall(B[${JSON.stringify(node.name)}], $, ${JSON.stringify(node.name)})`;
    }
    // Calling a context-default builtin with every parameter but the
    // (leading) context-defaulted one supplied (e.g. `$each(fn)` for
    // `each`'s `<o-f:a>` signature, `$substringBefore(chars)` for
    // `substringBefore`'s `<s-s>`) shifts the given arguments right past
    // it, substituting `$` for the omitted first parameter - matching
    // jsonata's own "one argument short -> fill the context-default slot"
    // call rule. Routed through the same `RT.ctxDefaultCall` as the
    // zero-argument case so a bad context value is still reported as
    // T0411, not the generic T0410.
    if (
      isStaticBuiltin && CONTEXT_DEFAULT.has(node.name) &&
      argNodes.length === (CONTEXT_DEFAULT_MAX_ARITY[node.name] ?? Infinity) - 1
    ) {
      const restArgsCode = argNodes.map((a) => this.genExpr(a, ctx, false));
      return `RT.ctxDefaultCall(B[${JSON.stringify(node.name)}], $, ${JSON.stringify(node.name)}, ${restArgsCode.join(',')})`;
    }
    // `$eval(exprStr)` (1 arg) defaults its evaluation context to the current `$`.
    if (node.name === 'eval' && argNodes.length === 1) {
      argNodes = [argNodes[0], { type: 'ContextRef' }];
    }
    // Fused aggregate over a value-mode path: `$sum(x.f)` / `$count(x[cond])`
    // aggregate the stream directly instead of materializing the path's
    // terminal value and then reducing it (see `hof.js`'s fused-aggregate
    // block, and JSonata2Java's `Translator#tryFusedCall`).
    if (isStaticBuiltin && argNodes.length === 1 && AGG_FUSABLE.has(node.name)) {
      const fused = this.genFusedAggregate(node.name, argNodes[0], ctx);
      if (fused) return fused;
    }
    const argsCode = argNodes.map((a) => this.genExpr(a, ctx, false));
    return this.genStaticOrDynamicCall(node.name, argsCode, ctx, tail);
  }

  /**
   * Emits a fused aggregate for `$count/$sum/$average/$max/$min(<path>)` when
   * the argument is a path value mode can compile, else `null` (caller falls
   * back to `agg(<value>)`).
   *
   * The saving is the intermediate sequence: `$sum(x.f)` becomes one pass that
   * reads each `f` and adds it, and `$count(x[cond])` counts matches without
   * building the filtered array. The `finalizeRaw` collapse rule still has to
   * be honoured, which is why the terminal field step gets its own helper
   * (`H.aggField`/`H.countField`) rather than aggregating a flat stream.
   */
  genFusedAggregate(name, argNode, ctx) {
    let steps = null;
    if (argNode.type === 'PathExpr') steps = argNode.steps;
    else if (argNode.type === 'PredicateExpr') steps = this.syntheticStageSteps(argNode, argNode.predicate);
    else if (argNode.type === 'ArraySubscript') steps = this.syntheticStageSteps(argNode, argNode.index);
    if (!steps || steps.length === 0) return null;
    // Value mode is scoped to this path exactly like `genPathExpr` does, so a
    // rejected analysis cannot leave `activeTupleBindings` mutated.
    const savedActive = ctx.activeTupleBindings;
    if (!ctx.inPathScope) ctx.activeTupleBindings = new Set();
    const vm = this.pathValueModeSteps(steps, ctx);
    let result = null;
    if (vm) {
      const lastStep = vm[vm.length - 1];
      const kind = JSON.stringify(name);
      if (lastStep.type === 'FieldRef' && vm.length > 1) {
        const stream = this.genValueModeStream(vm, ctx, vm.length - 1);
        const field = JSON.stringify(lastStep.name);
        result = name === 'count'
          ? `H.countField(${stream}, ${field})`
          : `H.aggField(${stream}, ${field}, ${kind})`;
      } else if (lastStep.type !== 'FieldRef' && lastStep.type !== 'WildcardStep' && lastStep.type !== 'DescendantStep') {
        const stream = this.genValueModeStream(vm, ctx, vm.length);
        result = name === 'count' ? `H.countOf(${stream})` : `H.aggOf(${stream}, ${kind})`;
      }
    }
    ctx.activeTupleBindings = savedActive;
    return result;
  }

  genStaticOrDynamicCall(name, argsCode, ctx, tail) {
    const jsName = GenCtx.jsName('v_', name);
    const isStaticBuiltin = this.builtinNames.has(name) && !ctx.isLexicallyBound(jsName);
    if (isStaticBuiltin) {
      return `B[${JSON.stringify(name)}](${argsCode.join(',')})`;
    }
    const calleeCode = ctx.resolveVariable(name);
    if (tail && ctx.inLambdaBody) {
      return `LAM.thunk(${calleeCode}, [${argsCode.join(',')}], $)`;
    }
    return `LAM.applyFn(${calleeCode}, [${argsCode.join(',')}], $)`;
  }

  // ===== sort =====

  /**
   * A *terminal* `^()` sort (`objs^(price)`, `Account.Order.Product^(Price)`)
   * has no following stage that could observe the pre-sort parent linkage, so
   * when its source path and its key expressions are free of `%`/`@$`/`#$` it
   * sorts plain values — which also lets the whole preceding navigation
   * compile in value mode instead of being dragged into tuple mode by the
   * sort. A sort feeding a further step keeps the tuple stream
   * (`compileSortToTuples`), because a positional stage after it is scoped per
   * pre-sort sibling group.
   */
  genSortExpr(node, ctx) {
    const vm = containsParentRef(node)
      ? null
      : this.pathValueModeSteps(node.source.type === 'PathExpr' ? node.source.steps : [node.source], ctx);
    if (vm) {
      const stream = this.genValueModeStream(vm, ctx, vm.length);
      return `RT.collapse(STRUCT.sortValues(${stream}, ${this.genSortKeys(node, ctx)}), false)`;
    }
    const { stmts, tuplesVar } = this.compileSortToTuples(node, ctx);
    const lines = stmts.slice();
    lines.push(`return P.collapseTuples(${tuplesVar}, false);`);
    return `(() => {\n${lines.join('\n')}\n})()`;
  }

  /**
   * Compiles a `SortExpr` to its raw sorted tuples array (`{v,p,b}`,
   * `.b` preserved) instead of a collapsed value list. Used both by
   * `genSortExpr` (terminal `^()`, which then collapses) and by
   * `compilePathSteps` (when `^()` is the seed step of an outer path,
   * e.g. `Foo^(k).{...}`, where a later step still needs `%`/`@$`
   * fidelity from before the sort).
   */
  compileSortToTuples(node, ctx) {
    const { tuplesVar, stmts } = this.compileSourceToTuples(node.source, ctx);
    const keys = this.genSortKeys(node, ctx);
    const sorted = ctx.fresh('srt');
    const lines = stmts.slice();
    lines.push(`const ${sorted} = STRUCT.sortTuples(${tuplesVar}, ${keys});`);
    return { stmts: lines, tuplesVar: sorted };
  }

  /**
   * `[{ key, desc }, …]` descriptors for a `^()` sort. Hoisted to factory
   * scope (one array plus one closure per key, built once per compiled
   * expression) whenever every key expression is capture-free — otherwise
   * emitted inline, as before.
   */
  genSortKeys(node, ctx) {
    const { result: keyFns } = this.withFreshElementScope(ctx, (ptName, tbName) =>
      node.keys.map((k) => {
        const keyExpr = this.genExpr(k.key, ctx, false);
        return `{ key: ($, ${ptName}, ${tbName}) => (${keyExpr}), desc: ${k.descending ? 'true' : 'false'} }`;
      })
    );
    const code = `[${keyFns.join(',')}]`;
    const hoistable = node.keys.every((k) => this.hoistableClosure(k.key, ctx));
    return hoistable ? ctx.hoistClosure(code) : code;
  }

  /** Compiles `sourceNode` to a raw (uncollapsed) tuples array, preserving `%` parent chains and `@$`/`#$` bindings when it is a multi-step path. */
  compileSourceToTuples(sourceNode, ctx) {
    if (sourceNode.type === 'PathExpr') {
      const { code, tuplesVar } = this.compilePathSteps(sourceNode.steps, ctx);
      return { stmts: [code], tuplesVar };
    }
    if (sourceNode.type === 'ContextRef' && ctx.parentVar) {
      // Identity source (`$`) nested inside an enclosing per-element
      // closure (e.g. dotted group-by `foo.{...}`, or a sort/predicate
      // built on the current context): `$` didn't lose its `%` parent
      // chain or `@$`/`#$` bindings just because this construct re-seeds
      // a fresh tuple stream from it - carry both forward instead of
      // resetting to none, which is what a plain `P.seed($)` would do.
      // `ctx.parentVar` (unlike `ctx.tupleBindingsVar`, which a `SortExpr`/
      // `GroupByExpr` used as a path's *own* seed step sets ahead of any
      // actual closure) is only ever assigned inside a real `($, __pt,
      // __tb) => ...` per-element callback, so it reliably means both
      // `__pt` and `__tb` are in lexical scope here.
      const v = ctx.fresh('tp');
      const bArg = ctx.tupleBindingsVar || 'undefined';
      return { stmts: [`let ${v} = P.seedWithBindings($, ${ctx.parentVar}, ${bArg});`], tuplesVar: v };
    }
    const valueExpr = this.genExpr(sourceNode, ctx, false);
    const v = ctx.fresh('tp');
    return { stmts: [`let ${v} = P.seed(${valueExpr});`], tuplesVar: v };
  }

  // ===== group-by =====

  genGroupByExpr(node, ctx) {
    // Value mode when neither the source path nor any key/value expression can
    // observe a tuple: buckets then hold plain values (`STRUCT.groupByValues`),
    // saving one tuple object per source element.
    const vm = containsParentRef(node)
      ? null
      : this.pathValueModeSteps(node.source.type === 'PathExpr' ? node.source.steps : [node.source], ctx);
    if (vm && node.pairs.every((p) => this.hoistableSubtree(p.key, ctx) && this.hoistableSubtree(p.value, ctx))) {
      const stream = this.genValueModeStream(vm, ctx, vm.length);
      return `STRUCT.groupByValues(${stream}, ${this.genGroupByPairFns(node, ctx, false)})`;
    }
    const { stmts, tuplesVar } = this.compileSourceToTuples(node.source, ctx);
    // Dotted (`foo.{...}`) group-by keeps `%` resolving against the
    // enclosing per-element closure's parent tuple, since it's evaluated
    // inline as an ordinary per-element step; non-dotted (postfix
    // `foo{...}`) group-by genuinely has no parent to thread, matching
    // jsonata's own semantics for real cross-element aggregation.
    const groupByExpr = this.compileGroupByPairs(node, tuplesVar, ctx, !!node.dotted);
    const lines = stmts.slice();
    lines.push(`return ${groupByExpr};`);
    return `(() => {\n${lines.join('\n')}\n})()`;
  }

  /** Compiles `node.pairs` (a `GroupByExpr`'s `{key: value, ...}` list) against `tuplesVar`, a raw tuples array. */
  compileGroupByPairs(node, tuplesVar, ctx, keepParent) {
    return `STRUCT.groupBy(${tuplesVar}, ${this.genGroupByPairFns(node, ctx, keepParent)})`;
  }

  /**
   * `[{ keyFn, valueFn }, …]` for a group-by's pairs. Hoisted to factory scope
   * when every key/value expression is capture-free, so the descriptors and
   * their callbacks are built once per compiled expression.
   */
  genGroupByPairFns(node, ctx, keepParent) {
    const savedParent = ctx.parentVar;
    if (!keepParent) ctx.parentVar = null; // group-by key/value are evaluated with a fresh context, no parent thread
    const savedTB = ctx.tupleBindingsVar;
    const savedInPathScope = ctx.inPathScope;
    const tbName = ctx.fresh('tb');
    ctx.tupleBindingsVar = tbName;
    ctx.inPathScope = true;
    ctx.tbStack.push(tbName);
    const pairFns = node.pairs.map((pair) => {
      const keyExpr = this.genExpr(pair.key, ctx, false);
      const valExpr = this.genExpr(pair.value, ctx, false);
      return `{ keyFn: ($, ${tbName}) => (${keyExpr}), valueFn: ($, ${tbName}) => (${valExpr}) }`;
    });
    ctx.tbStack.pop();
    ctx.tupleBindingsVar = savedTB;
    ctx.parentVar = savedParent;
    ctx.inPathScope = savedInPathScope;
    const code = `[${pairFns.join(',')}]`;
    const hoistable = !ctx.parentVar && ctx.tbStack.length === 0 && ctx.activeTupleBindings.size === 0
      && !code.includes(tbName)
      && node.pairs.every((p) => this.hoistableSubtree(p.key, ctx) && this.hoistableSubtree(p.value, ctx));
    return hoistable ? ctx.hoistClosure(code) : code;
  }

  // ===== chain (~>) =====

  genChainExpr(node, ctx) {
    const stmts = [];
    let cur = ctx.fresh('ch');
    stmts.push(`let ${cur} = (${this.genExpr(node.steps[0], ctx, false)});`);
    for (let i = 1; i < node.steps.length; i++) {
      let step = node.steps[i];
      // `$map($square)[]` - `[]` (collected by `parsePostfix`, see
      // `ForceArray`) binds to this individual chain step's own call, not
      // the whole chain: unwrap it here so the call still gets `cur`
      // prepended normally, and reapply "keep as array" to its result.
      let forceStepArray = false;
      if (step.type === 'ForceArray') {
        forceStepArray = true;
        step = step.source;
      }
      const next = ctx.fresh('ch');
      if (step.type === 'FunctionCall') {
        const jsName = GenCtx.jsName('v_', step.name);
        const isStaticBuiltin = this.builtinNames.has(step.name) && !ctx.isLexicallyBound(jsName);
        const extraArgs = step.args.map((a) => this.genExpr(a, ctx, false));
        if (isStaticBuiltin) {
          stmts.push(`let ${next} = B[${JSON.stringify(step.name)}](${[cur, ...extraArgs].join(',')});`);
        } else {
          const calleeCode = ctx.resolveVariable(step.name);
          stmts.push(`let ${next} = LAM.chainStep(${cur}, ${calleeCode}, [${extraArgs.join(',')}]);`);
        }
      } else {
        const fnCode = this.genExpr(step, ctx, false);
        stmts.push(`let __fn${next} = (${fnCode});`);
        stmts.push(`let ${next} = (typeof ${cur} === 'function') ? STRUCT.composeFunctions(${cur}, __fn${next}) : LAM.chainStep(${cur}, __fn${next}, []);`);
      }
      if (forceStepArray) stmts.push(`${next} = RT.forceArray(${next});`);
      cur = next;
    }
    stmts.push(`return ${cur};`);
    return `(() => {\n${stmts.join('\n')}\n})()`;
  }

  // ===== transform =====

  genTransformExpr(node, ctx) {
    const source = this.genExpr(node.source, ctx, false);
    // Resolves whatever `$clone` currently means at this lexical/dynamic
    // point (the built-in, or a `$clone :=` override) - jsonata's own
    // `evaluateTransformExpression` does `environment.lookup('clone')` and
    // clones the source through THAT, throwing T2013 if it isn't callable
    // (see structural.js#transform / CODE-REVIEW.md M4).
    const cloneFn = ctx.resolveVariable('clone');
    const patternFn = this.genTransformPatternFn(node.pattern, ctx);
    const updateFn = this.genTransformSubFn(node.update, ctx);
    const deleteFn = node.delete ? this.genTransformSubFn(node.delete, ctx) : 'null';
    return `STRUCT.transform(${source}, ${cloneFn}, ${patternFn}, ${updateFn}, ${deleteFn})`;
  }

  genTransformLambda(node, ctx) {
    const cloneFn = ctx.resolveVariable('clone');
    const patternFn = this.genTransformPatternFn(node.pattern, ctx);
    const updateFn = this.genTransformSubFn(node.update, ctx);
    const deleteFn = node.delete ? this.genTransformSubFn(node.delete, ctx) : 'null';
    return `FV.tagFunction(($src) => STRUCT.transform($src, ${cloneFn}, ${patternFn}, ${updateFn}, ${deleteFn}), 1)`;
  }

  genTransformPatternFn(patternNode, ctx) {
    ctx.pushScope();
    const savedTB = ctx.tupleBindingsVar;
    const savedTBStack = ctx.tbStack;
    const savedActive = ctx.activeTupleBindings;
    const savedInPathScope = ctx.inPathScope;
    ctx.tupleBindingsVar = null;
    ctx.tbStack = [];
    ctx.activeTupleBindings = new Set();
    ctx.inPathScope = false;
    const bodyCode = this.genExpr(patternNode, ctx, false);
    ctx.tupleBindingsVar = savedTB;
    ctx.tbStack = savedTBStack;
    ctx.activeTupleBindings = savedActive;
    ctx.inPathScope = savedInPathScope;
    ctx.popScope();
    return `($) => (${bodyCode})`;
  }

  genTransformSubFn(node, ctx) {
    ctx.pushScope();
    const savedTB = ctx.tupleBindingsVar;
    const savedTBStack = ctx.tbStack;
    const savedActive = ctx.activeTupleBindings;
    const savedInPathScope = ctx.inPathScope;
    ctx.tupleBindingsVar = null;
    ctx.tbStack = [];
    ctx.activeTupleBindings = new Set();
    ctx.inPathScope = false;
    const bodyCode = this.genExpr(node, ctx, false);
    ctx.tupleBindingsVar = savedTB;
    ctx.tbStack = savedTBStack;
    ctx.activeTupleBindings = savedActive;
    ctx.inPathScope = savedInPathScope;
    ctx.popScope();
    return `($) => (${bodyCode})`;
  }
}

module.exports = { Translator, PATH_STEP_TYPES };
