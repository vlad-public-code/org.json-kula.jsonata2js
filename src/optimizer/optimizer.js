'use strict';

/**
 * Single-pass, bottom-up AST optimizer for JSONata expressions, ported from
 * JSonata2Java's `optimizer/Optimizer.java`.
 *
 * Each rewrite rule runs post-order (children first, mirroring the Java
 * `RewriteVisitor`), then applies local rewrites to the resulting node. The
 * original AST is never mutated; `optimize` returns a (possibly identical,
 * reference-preserving) new tree built from `../ast/nodes.js` factories.
 *
 * <h2>Rewrites applied</h2>
 * - **Constant folding** for two-literal operands only: arithmetic
 *   (`+ - *`), string concatenation (`&`), comparisons
 *   (`= != < <= > >=`), and boolean logic (`and`, `or`) when *both*
 *   operands of a `BinaryOp` are already literals of the same kind.
 * - **Boolean short-circuit absorption**, but ONLY when the *left* operand
 *   is the literal that determines the result (`false and X` -> `false`,
 *   `true or X` -> `true`) — see "Why no arithmetic/string/right-side
 *   boolean identity folds" below for why the mirror-image rules are
 *   deliberately NOT ported.
 * - **Conditional folding** when the condition is a literal
 *   `true`/`false`/`null`.
 * - **Unary-minus elimination** on a numeric literal operand:
 *   `-NumberLiteral(v)` -> `NumberLiteral(-v)`.
 * - **Single-expression block unwrapping**, except when the sole binding is
 *   a self-referential lambda (see below).
 * - **PathExpr flattening** of nested `PathExpr` steps, preserving a
 *   `Parenthesized` step that immediately follows a `ContextBinding` (the
 *   `@$l.(...)` cross-join pattern the translator needs to detect).
 * - **Parenthesized stripping**, except when the inner node is a
 *   `VariableBinding` (preserves scoping of parenthesised assignments).
 * - **Group-by unfolding**: a `GroupByExpr` whose source path contains a
 *   `@$var`/`#$var` binding is rewritten into a `PathExpr` ending in a
 *   `GroupByExpr(ContextRef, pairs)` so the binding stays in scope for the
 *   key/value expressions.
 *
 * <h2>Why no arithmetic/string/right-side-boolean identity folds</h2>
 * JSonata2Java's optimizer additionally folds `x+0`, `0+x`, `x*1`, `x*0`,
 * `x/1`, `x-0`, `x & ""`, `"" & x`, `x and false`, `x or true`, and
 * double negation `-(-x)` whenever *one* side is the identity/absorbing
 * literal and the *other* side (`x`) is an arbitrary, not-yet-known-typed
 * subexpression. Every one of those rules is UNSAFE to port as-is, because
 * jsonata2js's runtime arithmetic/concat/negate helpers
 * (`src/runtime/values.js`) type-check their operands and throw
 * (T2001/T2002/D1001/D1002) — dropping the operation from the tree also
 * drops that check, silently swallowing a runtime error real JSONata would
 * throw. Verified against the real `jsonata` interpreter:
 *   - `"foo"+0` and `x*0` (x="foo") both throw T2001 — folding `x+0`/`x*0`
 *     to `x`/`0` would swallow that.
 *   - `5 & ""` evaluates to the STRING `"5"`, not the number `5` — folding
 *     `x & ""` to `x` would silently change the result's type.
 *   - `false and $error("boom")` evaluates to `false` with NO error, but
 *     `$error("boom") and false` throws D3137 — `and`/`or` only
 *     short-circuit (skip evaluating) the RIGHT operand, so folding
 *     `X and false` -> `false` (right-literal) would skip evaluating a
 *     LEFT operand real JSONata always evaluates; only `false and X` /
 *     `true or X` (left-literal) are safe, because those are exactly the
 *     short-circuit case real evaluation already applies.
 *   - `-(-x)` -> `x` for non-literal `x` would skip both `negate()` calls,
 *     swallowing a D1001/D1002 the first `negate(x)` would have thrown.
 * Arithmetic/comparison/concat/boolean folding is therefore restricted to
 * cases where BOTH operands are already literals (fully evaluable at
 * compile time with no operand type ever needing a runtime check), and
 * `/`/`%` are NEVER folded at all — even `NumberLiteral(1) / NumberLiteral(0)`
 * is left as a `BinaryOp` so the runtime `divide`/`modulo` helpers throw
 * their real errors at evaluation time. `+`/`-`/`*` on two finite-literal
 * operands are folded only when `Number.isFinite(result)`, so an
 * overflow-to-Infinity multiplication (e.g. two huge literals) is left
 * unfolded for the same reason.
 *
 * <h2>Self-referential block bindings</h2>
 * A `Block` containing exactly one `VariableBinding` whose value is a
 * `Lambda` that references its own binding name (directly, or transitively
 * through nested non-shadowing expressions) is NEVER unwrapped: the
 * translator needs the `Block` wrapper to apply a "declare then assign"
 * pattern so the lambda can close over its own name.
 */

const Nodes = require('../ast/nodes');
const { visit } = require('../ast/visit');

function optimize(node) {
  return rewrite(node);
}

function rewrite(node) {
  return visit(node, HANDLERS, undefined);
}

// ---------------------------------------------------------------------------
// Generic list/pair/sort-key rewriting helpers (reference-preserving: return
// the original array when nothing inside it changed).
// ---------------------------------------------------------------------------

function rewriteList(nodes) {
  let changed = false;
  const result = nodes.map((n) => {
    const r = rewrite(n);
    if (r !== n) changed = true;
    return r;
  });
  return changed ? result : nodes;
}

function rewritePairs(pairs) {
  let changed = false;
  const result = pairs.map((p) => {
    const key = rewrite(p.key);
    const value = rewrite(p.value);
    if (key === p.key && value === p.value) return p;
    changed = true;
    return Nodes.KeyValuePair(key, value);
  });
  return changed ? result : pairs;
}

function rewriteSortKeys(keys) {
  let changed = false;
  const result = keys.map((k) => {
    const key = rewrite(k.key);
    if (key === k.key) return k;
    changed = true;
    return Nodes.SortKey(key, k.descending);
  });
  return changed ? result : keys;
}

function sameElements(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Generic post-order child rewriting, driven by a small per-type field spec.
// Covers every node type that has no bespoke folding rule; nodes with a
// bespoke rule (see HANDLERS below) get an explicit `visit<Type>` override
// that shadows this table-driven default.
// ---------------------------------------------------------------------------

const CHILD_SPEC = {
  // Terminals: no AST-node children to rewrite.
  StringLiteral: {},
  NumberLiteral: {},
  BooleanLiteral: {},
  NullLiteral: {},
  RegexLiteral: {},
  ContextRef: {},
  RootRef: {},
  VariableRef: {},
  FieldRef: {},
  WildcardStep: {},
  DescendantStep: {},
  ParentStep: {},
  PositionBinding: {},
  ContextBinding: {},
  PartialPlaceholder: {},

  // Structural nodes with no folding rule of their own: rewrite children only.
  ArrayConstructor: { elements: 'nodes' },
  ObjectConstructor: { pairs: 'pairs' },
  PredicateExpr: { source: 'node', predicate: 'node' },
  ArraySubscript: { source: 'node', index: 'node' },
  FunctionCall: { args: 'nodes' },
  Lambda: { body: 'node' },
  LambdaCall: { lambda: 'node', args: 'nodes' },
  VariableBinding: { value: 'node' },
  RangeExpr: { from: 'node', to: 'node' },
  SortExpr: { source: 'node', keys: 'sortkeys' },
  ChainExpr: { steps: 'nodes' },
  TransformExpr: { source: 'node', pattern: 'node', update: 'node', delete: 'nodeOpt' },
  TransformLambda: { pattern: 'node', update: 'node', delete: 'nodeOpt' },
  ForceArray: { source: 'node' },
  ElvisExpr: { left: 'node', right: 'node' },
  CoalesceExpr: { left: 'node', right: 'node' },
  PartialApplication: { args: 'nodes' },
};

function genericRewrite(n) {
  const spec = CHILD_SPEC[n.type];
  if (spec === undefined) {
    throw new TypeError(`optimizer: no CHILD_SPEC entry for AST node type "${n.type}"`);
  }
  let changed = false;
  const patch = {};
  for (const key of Object.keys(spec)) {
    const kind = spec[key];
    const orig = n[key];
    if (kind === 'node') {
      const r = rewrite(orig);
      if (r !== orig) changed = true;
      patch[key] = r;
    } else if (kind === 'nodeOpt') {
      if (orig == null) {
        patch[key] = orig;
        continue;
      }
      const r = rewrite(orig);
      if (r !== orig) changed = true;
      patch[key] = r;
    } else if (kind === 'nodes') {
      const r = rewriteList(orig);
      if (r !== orig) changed = true;
      patch[key] = r;
    } else if (kind === 'pairs') {
      const r = rewritePairs(orig);
      if (r !== orig) changed = true;
      patch[key] = r;
    } else if (kind === 'sortkeys') {
      const r = rewriteSortKeys(orig);
      if (r !== orig) changed = true;
      patch[key] = r;
    }
  }
  return changed ? { ...n, ...patch } : n;
}

// ---------------------------------------------------------------------------
// Constant folding
// ---------------------------------------------------------------------------

/**
 * Attempts to fold a `BinaryOp` whose (already-optimized) operands are
 * literals, or applies the two provably safe left-literal short-circuit
 * absorption rules. Returns the folded node, or `null` if no rule matched.
 */
function tryFold(op, left, right, pos) {
  if (left.type === 'NumberLiteral' && right.type === 'NumberLiteral') {
    return foldNumNum(op, left.value, right.value, pos);
  }
  if (left.type === 'StringLiteral' && right.type === 'StringLiteral') {
    return foldStrStr(op, left.value, right.value, pos);
  }
  if (left.type === 'BooleanLiteral' && right.type === 'BooleanLiteral') {
    return foldBoolBool(op, left.value, right.value, pos);
  }
  // Left-literal short-circuit absorption: safe because it is exactly what
  // real `and`/`or` evaluation already does — the right operand is
  // (provably, by jsonata's own short-circuit semantics) never evaluated,
  // so dropping it from the tree changes nothing observable.
  if (op === 'and' && left.type === 'BooleanLiteral' && left.value === false) {
    return Nodes.BooleanLiteral(false, pos);
  }
  if (op === 'or' && left.type === 'BooleanLiteral' && left.value === true) {
    return Nodes.BooleanLiteral(true, pos);
  }
  return null;
}

function foldNumNum(op, l, r, pos) {
  switch (op) {
    case '+': {
      const v = l + r;
      return Number.isFinite(v) ? Nodes.NumberLiteral(v, pos) : null;
    }
    case '-': {
      const v = l - r;
      return Number.isFinite(v) ? Nodes.NumberLiteral(v, pos) : null;
    }
    case '*': {
      const v = l * r;
      return Number.isFinite(v) ? Nodes.NumberLiteral(v, pos) : null;
    }
    // '/' and '%' are intentionally NEVER folded, even for a non-zero,
    // finite divisor — see the file header for why.
    case '=':
      return Nodes.BooleanLiteral(l === r, pos);
    case '!=':
      return Nodes.BooleanLiteral(l !== r, pos);
    case '<':
      return Nodes.BooleanLiteral(l < r, pos);
    case '<=':
      return Nodes.BooleanLiteral(l <= r, pos);
    case '>':
      return Nodes.BooleanLiteral(l > r, pos);
    case '>=':
      return Nodes.BooleanLiteral(l >= r, pos);
    default:
      return null;
  }
}

function foldStrStr(op, l, r, pos) {
  switch (op) {
    case '&':
      return Nodes.StringLiteral(l + r, pos);
    case '=':
      return Nodes.BooleanLiteral(l === r, pos);
    case '!=':
      return Nodes.BooleanLiteral(l !== r, pos);
    case '<':
      return Nodes.BooleanLiteral(l < r, pos);
    case '<=':
      return Nodes.BooleanLiteral(l <= r, pos);
    case '>':
      return Nodes.BooleanLiteral(l > r, pos);
    case '>=':
      return Nodes.BooleanLiteral(l >= r, pos);
    default:
      return null;
  }
}

function foldBoolBool(op, l, r, pos) {
  switch (op) {
    case 'and':
      return Nodes.BooleanLiteral(l && r, pos);
    case 'or':
      return Nodes.BooleanLiteral(l || r, pos);
    case '=':
      return Nodes.BooleanLiteral(l === r, pos);
    case '!=':
      return Nodes.BooleanLiteral(l !== r, pos);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Self-referential lambda-binding detection (guards Block unwrapping)
// ---------------------------------------------------------------------------

/**
 * Returns true if `node` contains a reference to `name` as a free variable
 * (a `VariableRef` or `FunctionCall` callee) not shadowed by an intervening
 * `Lambda` parameter of the same name.
 */
function lambdaBodyReferencesName(node, name) {
  return refCheck(node, name, new Set());
}

function refCheck(node, name, bound) {
  if (!node) return false;
  switch (node.type) {
    case 'VariableRef':
      return !bound.has(node.name) && node.name === name;
    case 'FunctionCall':
      return (
        (!bound.has(node.name) && node.name === name) ||
        node.args.some((a) => refCheck(a, name, bound))
      );
    case 'Lambda': {
      const inner = new Set(bound);
      for (const p of node.params) inner.add(p);
      return refCheck(node.body, name, inner);
    }
    case 'Block':
      return node.expressions.some((e) => refCheck(e, name, bound));
    case 'VariableBinding':
      return refCheck(node.value, name, bound);
    case 'BinaryOp':
      return refCheck(node.left, name, bound) || refCheck(node.right, name, bound);
    case 'UnaryMinus':
      return refCheck(node.operand, name, bound);
    case 'ConditionalExpr':
      return (
        refCheck(node.condition, name, bound) ||
        refCheck(node.then, name, bound) ||
        (node.otherwise != null && refCheck(node.otherwise, name, bound))
      );
    case 'PathExpr':
      return node.steps.some((s) => refCheck(s, name, bound));
    case 'ArrayConstructor':
      return node.elements.some((e) => refCheck(e, name, bound));
    case 'ObjectConstructor':
      return node.pairs.some((p) => refCheck(p.key, name, bound) || refCheck(p.value, name, bound));
    case 'PredicateExpr':
      return refCheck(node.source, name, bound) || refCheck(node.predicate, name, bound);
    case 'Parenthesized':
      return refCheck(node.inner, name, bound);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// GroupByExpr Rule D — unfold when the source path contains a binding.
// ---------------------------------------------------------------------------

function containsBinding(node) {
  switch (node.type) {
    case 'ContextBinding':
    case 'PositionBinding':
      return true;
    case 'PathExpr':
      return node.steps.some(containsBinding);
    case 'PredicateExpr':
      return containsBinding(node.source);
    case 'SortExpr':
      return containsBinding(node.source);
    default:
      return false;
  }
}

function unfoldToPathSteps(source, steps) {
  if (source.type === 'PathExpr') {
    steps.push(...source.steps);
  } else if (source.type === 'PredicateExpr') {
    unfoldToPathSteps(source.source, steps);
    steps.push(Nodes.PredicateExpr(Nodes.ContextRef(), source.predicate));
  } else {
    steps.push(source);
  }
}

// ---------------------------------------------------------------------------
// Bespoke handlers
// ---------------------------------------------------------------------------

const HANDLERS = {
  visitDefault: genericRewrite,

  // A `Parenthesized` node directly in `.source` position is semantically
  // load-bearing (it is the sole signal, post-parse, that a subscript/
  // predicate binds to the *whole collected sequence* rather than folding
  // per-element — see parser.js's own doc comment on `Parenthesized`), so
  // it must survive optimization here even though `visitParenthesized`
  // strips it everywhere else.
  visitPredicateExpr(n) {
    const source = n.source.type === 'Parenthesized'
      ? Nodes.Parenthesized(rewrite(n.source.inner), n.source.pos)
      : rewrite(n.source);
    const predicate = rewrite(n.predicate);
    return source === n.source && predicate === n.predicate ? n : Nodes.PredicateExpr(source, predicate, n.pos);
  },

  visitArraySubscript(n) {
    const source = n.source.type === 'Parenthesized'
      ? Nodes.Parenthesized(rewrite(n.source.inner), n.source.pos)
      : rewrite(n.source);
    const index = rewrite(n.index);
    return source === n.source && index === n.index ? n : Nodes.ArraySubscript(source, index, n.pos);
  },


  visitUnaryMinus(n) {
    const operand = rewrite(n.operand);
    // -NumberLiteral(v) -> NumberLiteral(-v). (Double-negation on a
    // non-literal operand is deliberately NOT folded — see file header.)
    if (operand.type === 'NumberLiteral') {
      return Nodes.NumberLiteral(-operand.value, n.pos);
    }
    return operand === n.operand ? n : Nodes.UnaryMinus(operand, n.pos);
  },

  visitBinaryOp(n) {
    const left = rewrite(n.left);
    const right = rewrite(n.right);
    const folded = tryFold(n.op, left, right, n.pos);
    if (folded) return folded;
    return left === n.left && right === n.right ? n : Nodes.BinaryOp(n.op, left, right, n.pos);
  },

  visitConditionalExpr(n) {
    const condition = rewrite(n.condition);
    const then = rewrite(n.then);
    const otherwise = n.otherwise != null ? rewrite(n.otherwise) : null;

    // true ? a : b -> a
    if (condition.type === 'BooleanLiteral' && condition.value === true) return then;
    // false ? a : b -> b;  null ? a : b -> b — but ONLY when there is a
    // real else-branch to hand back. An else-less conditional
    // (`otherwise === null`) must NOT fold to `NullLiteral`: JSONata
    // `null` is a real, distinct value, not "nothing", so collapsing a
    // statically-false else-less conditional to `NullLiteral` injects a
    // spurious value into arrays/objects/results where the unoptimized
    // form correctly contributes nothing at all (see CODE-REVIEW.md H1).
    // Falling through to the generic construction below leaves the
    // (already translator-correct) runtime conditional in place instead.
    if (otherwise !== null) {
      if (condition.type === 'BooleanLiteral' && condition.value === false) return otherwise;
      if (condition.type === 'NullLiteral') return otherwise;
    }

    return condition === n.condition && then === n.then && otherwise === n.otherwise
      ? n
      : Nodes.ConditionalExpr(condition, then, otherwise, n.pos);
  },

  visitBlock(n) {
    const exprs = rewriteList(n.expressions);
    // Single-expression block: unwrap — UNLESS it is a self-referential
    // VariableBinding whose lambda body references the binding name. In
    // that case the Block must be preserved so the translator can apply
    // the "declare, then assign" pattern that makes the name available to
    // the lambda's own body.
    if (exprs.length === 1) {
      const only = exprs[0];
      const isSelfRef =
        only.type === 'VariableBinding' &&
        only.value.type === 'Lambda' &&
        lambdaBodyReferencesName(only.value.body, only.name);
      if (!isSelfRef) return only;
    }
    return exprs === n.expressions ? n : Nodes.Block(exprs, n.pos);
  },

  visitPathExpr(n) {
    // Rewrite each step, then flatten nested PathExprs.
    // NOTE: a Parenthesized step that immediately follows a ContextBinding
    // step MUST be preserved (not stripped) so the translator can detect
    // cross-join patterns such as `@$l.(library.books)`, where the
    // parenthesised sub-expression is evaluated from the document root
    // rather than the current context element — only its inner expression
    // is rewritten.
    const flat = [];
    let prevWasContextBinding = false;
    for (const step of n.steps) {
      if (prevWasContextBinding && step.type === 'Parenthesized') {
        const innerRewritten = rewrite(step.inner);
        flat.push(innerRewritten === step.inner ? step : Nodes.Parenthesized(innerRewritten, step.pos));
        prevWasContextBinding = false;
        continue;
      }
      const rewritten = rewrite(step);
      if (rewritten.type === 'PathExpr') {
        flat.push(...rewritten.steps);
      } else {
        flat.push(rewritten);
      }
      prevWasContextBinding = rewritten.type === 'ContextBinding';
    }
    return sameElements(flat, n.steps) ? n : Nodes.PathExpr(flat, n.pos);
  },

  visitGroupByExpr(n) {
    const source = rewrite(n.source);
    const pairs = rewritePairs(n.pairs);
    // Rule D: if the source path contains a @$var or #$var binding,
    // unfold to a PathExpr so the binding steps become path steps and the
    // binding variable(s) remain in scope when the group-by key/value
    // expressions are compiled.
    if (containsBinding(source)) {
      const steps = [];
      unfoldToPathSteps(source, steps);
      const g = Nodes.GroupByExpr(Nodes.ContextRef(), pairs);
      g.dotted = n.dotted;
      steps.push(g);
      return Nodes.PathExpr(steps, n.pos);
    }
    if (source === n.source && pairs === n.pairs) return n;
    const g = Nodes.GroupByExpr(source, pairs, n.pos);
    g.dotted = n.dotted;
    return g;
  },

  visitParenthesized(n) {
    // The Parenthesized wrapper only exists to affect parsing (grouping /
    // suppressing path-step subscript folding); once parsing is done the
    // AST structure itself encodes the distinction, so the wrapper can be
    // stripped so constant-folding and other rewrites see through it.
    // Exceptions:
    //  - inner is a VariableBinding: preserve, so a parenthesised
    //    assignment does not inadvertently leak/reassign an outer-scope
    //    variable of the same name.
    //  - inner is a GroupByExpr: preserve. `a.(b{"k":c})`'s parens are the
    //    sole post-parse signal that the group-by is a per-element step
    //    expression (evaluated once per `a`-element, `$` bound to that
    //    element) rather than a bare path step operating on the whole
    //    collected `a.b` sequence (`a.b{"k":c}`, no parens - a materially
    //    different grouping). Stripping the wrapper here made `visitPathExpr`
    //    treat the two identically, silently changing which items `$`
    //    resolves to inside the group-by's key/value expressions (see
    //    CODE-REVIEW.md H2).
    //  - inner is an ArrayConstructor: preserve. jsonata marks a *bare*
    //    `[...]` path step `consarray`, which stops its per-element array
    //    result from flattening into the outer sequence (`o.[q,q]` is
    //    `[[5,5],[6,6]]`); parenthesizing the same constructor removes the
    //    marking and it flattens like any other expression step
    //    (`o.([q,q])` is `[5,5,6,6]`, verified against the reference).
    //    Stripping the wrapper made the two indistinguishable — see
    //    `translator.js#compilePathStep`'s default case.
    const inner = rewrite(n.inner);
    if (inner.type === 'VariableBinding' || inner.type === 'GroupByExpr' || inner.type === 'ArrayConstructor') {
      return Nodes.Parenthesized(inner, n.pos);
    }
    return inner;
  },
};

module.exports = { optimize };
