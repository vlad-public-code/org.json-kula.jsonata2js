'use strict';

/**
 * Codegen context threaded through the translator: lexical-scope tracking
 * (which JSONata variable names are bound by an enclosing Block/Lambda/
 * path-binding/loop, vs. must fall back to a runtime `ENV` lookup) plus
 * unique JS identifier minting. Mirrors JSonata2Java's `GenCtx`/`GenState`,
 * simplified because JS closures make manual "scope" threading unnecessary
 * — nested generated arrow functions just close over outer `let` bindings.
 */

class GenCtx {
  constructor() {
    this._scopes = [new Set()]; // stack of Sets of JS-safe local variable base-names currently in lexical scope
    this._aliasScopes = [new Map()]; // parallel stack: JSONata name -> JS identifier override for this scope
    this._counter = 0;
    this.hoisted = []; // array of { name, code } top-level const declarations (literal hoisting, e.g. compiled regexes)
    this._hoistCache = new Map(); // "pattern\u0000flags" -> hoisted var name (dedupes identical regex literals)
    this.parentVar = null; // JS expression string for the "parent tuple" `%` resolves against right now, or null
    this.tupleBindingsVar = null; // JS expression string for the innermost active tuple's `.b` bindings object, or null
    this.tbStack = []; // stack of every enclosing per-element scope's own tuple-bindings identifier (outermost first), for resolveVariable's full lexical-chain fallback
    this.activeTupleBindings = new Set(); // JSONata names currently bound via an active path's @$/#$ step
    this.stepHasStage = false; // true once a PredicateExpr/ArraySubscript has run for the *current* navigational step (jsonata's own step.stages) - a later #$var on the same step then indexes globally, not per sibling-group (see translator.js#compilePathStep's PositionBinding case)
    this.dollarIsRoot = true; // true when JS `$` at this codegen point is still lexically the compiled function's own top-level input parameter (no enclosing per-element closure has rebound it) - real jsonata's `Expression.evaluate` wraps an array-typed *document root* as a single opaque sequence entry before any bare (non-`$`-prefixed) path step runs, so a bare path's own root seeding must special-case this; a `$`/`$$`-prefixed path, or any path nested inside a per-element closure, never sees that wrapping - see translator.js#compilePathSteps and #compileSourceToTuples's root-seed sites, and runtime/path.js#seedSingle
    this.inPathScope = false; // true while compiling any predicate/sort-key/group-by-pair/bare-step expression that belongs to an *enclosing* path's own step processing - distinct from `parentVar` (which is nulled for a parent-less terminal group-by's pairs, `compileGroupByPairs`'s `keepParent=false`) because those pairs still need to *inherit* `activeTupleBindings` (e.g. `Employee@$e...{ $e.Name: Phone[...] }`'s `Phone` still needs `@$e`'s `$$`-fallback even though it has no `%`). A fresh top-level `PathExpr`/`PredicateExpr`/etc reached with this false scopes its own `activeTupleBindings` instead of inheriting/leaking across sibling expressions - see translator.js#genPathExpr
    this.suppressParentAncestryCheck = false; // true while compiling a desugared call's synthetic callee binding - see translator.js#genParentStep
  }

  /** Sanitizes a JSONata identifier (variable/param name) into a safe JS identifier. */
  static jsName(prefix, name) {
    const safe = String(name).replace(/[^A-Za-z0-9_$]/g, (c) => '_' + c.codePointAt(0).toString(16) + '_');
    return `${prefix}${safe || '_'}`;
  }

  /** Mints a fresh unique temp identifier, e.g. `t3`. */
  fresh(prefix) {
    return `${prefix || 't'}${this._counter++}`;
  }

  pushScope() {
    this._scopes.push(new Set());
    this._aliasScopes.push(new Map());
  }
  popScope() {
    this._scopes.pop();
    this._aliasScopes.pop();
  }

  /** Declares `jsIdent` as lexically bound in the current (innermost) scope. */
  declare(jsIdent) {
    this._scopes[this._scopes.length - 1].add(jsIdent);
  }

  /** Removes `jsIdent` from the current (innermost) scope, if present there. */
  undeclare(jsIdent) {
    this._scopes[this._scopes.length - 1].delete(jsIdent);
  }

  /**
   * Registers `jsonataName` as resolving to `jsIdent` in the current
   * (innermost) scope, overriding the standard `v_<name>` convention.
   * Needed when a block-local `:=` binding *shadows* an already-lexically-
   * bound outer binding of the same name (e.g. a lambda parameter): a JS
   * `let v_x;` pre-declared at the top of the block's IIFE (required so
   * the same name can be `:=`-rebound more than once within one block)
   * would otherwise shadow the outer `v_x` for the *entire* block,
   * including the initializer expression that is supposed to read the
   * outer value (`$x := $x ? $x : 1`) - mint a fresh identifier instead so
   * the outer `v_x` stays reachable while it's being read.
   */
  declareAlias(jsonataName, jsIdent) {
    this._aliasScopes[this._aliasScopes.length - 1].set(jsonataName, jsIdent);
    this.declare(jsIdent);
  }

  /** Temporarily removes `jsonataName`'s alias (and underlying declaration) from the current scope, e.g. while compiling its own initializer so a self-reference resolves to an outer binding instead. */
  undeclareAlias(jsonataName) {
    const scope = this._aliasScopes[this._aliasScopes.length - 1];
    const ident = scope.get(jsonataName);
    scope.delete(jsonataName);
    if (ident !== undefined) this.undeclare(ident);
  }

  /** Registers (or reuses) a top-level hoisted `FV.compileRegexLiteral(...)` constant; returns its JS identifier. */
  hoistRegex(pattern, flags) {
    const key = pattern + '\u0000' + flags;
    if (this._hoistCache.has(key)) return this._hoistCache.get(key);
    const name = this.fresh('re');
    this.hoisted.push({ name, code: `FV.compileRegexLiteral(${JSON.stringify(pattern)}, ${JSON.stringify(flags)})` });
    this._hoistCache.set(key, name);
    return name;
  }

  /**
   * Registers a hoisted closure constant (a `($, __pt, __tb) => …` callback
   * whose body provably references nothing from the evaluator's own scope —
   * see `translator.js#hoistableClosure`) and returns its JS identifier.
   * Hoisted declarations live in the compiled *factory*'s scope, so the
   * closure is created once per compiled expression instead of once per
   * `evaluate()` call; the benchmark expression alone allocated 28 of them
   * per evaluation (~11% of its throughput).
   *
   * Identical callback source is deduplicated, which also collapses the
   * repeated `[level = "x"]`-style predicates a generated expression tends to
   * contain.
   */
  hoistClosure(code) {
    const key = 'fn\u0000' + code;
    if (this._hoistCache.has(key)) return this._hoistCache.get(key);
    const name = this.fresh('fn');
    this.hoisted.push({ name, code });
    this._hoistCache.set(key, name);
    return name;
  }

  /** True if `jsIdent` is bound by some enclosing lexical scope. */
  isLexicallyBound(jsIdent) {
    for (let i = this._scopes.length - 1; i >= 0; i--) {
      if (this._scopes[i].has(jsIdent)) return true;
    }
    return false;
  }

  /**
   * Resolves a JSONata variable name to a JS expression: a per-tuple `@$`/
   * `#$` binding if active - searching every *enclosing* per-element
   * scope's own tuple-bindings object (innermost first, `tbStack`), not
   * just the immediately-nearest one, since a construct compiled while
   * already lexically nested inside another per-element closure (e.g. a
   * predicate in a group-by value, `items#$i.{'x': $$.items[$i]...}`)
   * establishes its *own* tuple-bindings scope that generally doesn't
   * carry the outer binding - jsonata's own variable resolution walks the
   * full lexical environment chain, matching that here - else an alias
   * override (see `declareAlias`) if one is active, else the lexical JS
   * identifier if bound by an enclosing scope, else a dynamic `ENV`
   * lookup (covers top-level `evaluate(input, bindings)` bindings,
   * `assign()`, `registerFunction()`, and built-in function names).
   */
  resolveVariable(name) {
    if (this.tbStack.length > 0 && this.activeTupleBindings.has(name)) {
      const key = JSON.stringify(name);
      let expr = `ENV[${key}]`;
      for (const tb of this.tbStack) {
        expr = `(${tb} && Object.prototype.hasOwnProperty.call(${tb}, ${key}) ? ${tb}[${key}] : ${expr})`;
      }
      return expr;
    }
    for (let i = this._aliasScopes.length - 1; i >= 0; i--) {
      if (this._aliasScopes[i].has(name)) return this._aliasScopes[i].get(name);
    }
    const ident = GenCtx.jsName('v_', name);
    if (this.isLexicallyBound(ident)) return ident;
    return `ENV[${JSON.stringify(name)}]`;
  }
}

module.exports = { GenCtx };
