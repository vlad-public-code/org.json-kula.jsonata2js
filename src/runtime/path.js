'use strict';

/**
 * Path-navigation runtime support (design.md D4/`javascript-code-generation`
 * capability: field/wildcard/descendant steps, `%` parent-tracking to
 * arbitrary depth, predicate/subscript steps, `@$`/`#$` bindings).
 *
 * A path is evaluated as a sequence of "tuples" `{ v: value, p: parentTuple }`
 * instead of bare values, where `p` is the *whole preceding tuple* (not just
 * its value) — chasing `.p.p.p...` links reaches a parent at any depth, which
 * is exactly what nested `%.%.field` references need. This mirrors
 * PathCodeGen's parent-tracking in spirit, implemented as a runtime data
 * shape instead of compile-time scope bookkeeping.
 */

const RT = require('./values');
const { toNumber } = require('./values');

// ---------------------------------------------------------------------------
// Value mode
//
// A `{v, p, b}` tuple exists only so that `%` (parent), `@$` and `#$` can be
// resolved at runtime, and so that a predicate/subscript can index within a
// *sibling group* (elements sharing a parent). A path that uses none of those
// — statically decidable, see `translator#pathValueModeSteps` — can therefore
// run on a plain array of values: no tuple object per element, no `Map` and
// group arrays for the (single) grouping, no final `map(t => t.v)` copy.
//
// Every helper below is the value-mode twin of the tuple-mode helper named in
// its comment, and must stay behaviourally identical for eligible paths;
// `test/unit/path-fast-paths.test.js` asserts that differentially.
// ---------------------------------------------------------------------------

/** `seed` — array root spreads into one item per element. */
function vSeed(input) {
  if (input === undefined) return [];
  return Array.isArray(input) ? input : [input];
}

/** `seedSingle` — array root stays one opaque item. */
function vSeedSingle(input) {
  return input === undefined ? [] : [input];
}

/** `stepField` (flattening one level, dropping missing). */
function vStepField(values, name) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const sv = RT.field(values[i], name);
    if (sv === undefined) continue;
    if (Array.isArray(sv)) {
      for (let j = 0; j < sv.length; j++) if (sv[j] !== undefined) out.push(sv[j]);
    } else {
      out.push(sv);
    }
  }
  return out;
}

/** `stepWildcard`. */
function vStepWildcard(values) {
  return vExpandWith(values, RT.wildcard);
}

/** `stepDescendant`. */
function vStepDescendant(values) {
  return vExpandWith(values, RT.descendant);
}

function vExpandWith(values, stepFn) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const sv = stepFn(values[i]);
    if (sv === undefined) continue;
    if (Array.isArray(sv)) {
      for (let j = 0; j < sv.length; j++) if (sv[j] !== undefined) out.push(sv[j]);
    } else {
      out.push(sv);
    }
  }
  return out;
}

/**
 * `stepExpr` — an array result stays one nested item. Only a syntactically
 * bare array-constructor step gets this treatment (jsonata's `consarray`);
 * see `vStepFlatten` for every other expression step.
 */
function vStepExpr(values, fn) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const r = fn(values[i], undefined, undefined);
    if (r !== undefined) out.push(r);
  }
  return out;
}

/** `stepFlatten` — an array result flattens one level into the outer sequence. */
function vStepFlatten(values, fn) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const r = fn(values[i], undefined, undefined);
    if (r === undefined) continue;
    if (Array.isArray(r)) {
      for (let j = 0; j < r.length; j++) if (r[j] !== undefined) out.push(r[j]);
    } else {
      out.push(r);
    }
  }
  return out;
}

/**
 * A generic expression step in TERMINAL position. jsonata's `evaluateStep`
 * applies the same "one raw array result passes through verbatim" rule here
 * as it does for a terminal field step (`$data.$zip(one, two)` must stay
 * `[[1,5]]`, not flatten to `[1,5]`), and flattens only once two or more
 * source elements each produced a result (`o.(p^(v))`). See `finalizeRaw`.
 */
function exprFinal(tuples, fn, keepSingleton) {
  const raw = [];
  for (let i = 0; i < tuples.length; i++) {
    const t = tuples[i];
    const r = fn(t.v, t.p, t.b);
    if (r !== undefined) raw.push(r);
  }
  return finalizeRaw(raw, keepSingleton);
}

/** Value-mode twin of `exprFinal`. */
function vExprFinal(values, fn, keepSingleton) {
  const raw = [];
  for (let i = 0; i < values.length; i++) {
    const r = fn(values[i], undefined, undefined);
    if (r !== undefined) raw.push(r);
  }
  return finalizeRaw(raw, keepSingleton);
}

/**
 * `stepPredicate` with `global` semantics. Eligible paths only reach here
 * with a predicate whose result can never be a number (so sibling-group
 * indexing is unobservable) or with a single group anyway.
 */
function vFilter(values, condFn) {
  const out = [];
  const n = values.length;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (matchesPredicate(condFn(v, undefined, undefined, i, values), i, n)) out.push(v);
  }
  return out;
}

/** `stepSubscript` with `global` semantics (single group). */
function vSubscript(values, indexFn) {
  const out = [];
  const n = values.length;
  for (let i = 0; i < n; i++) {
    const raw = indexFn(values[i], undefined, undefined, i, values);
    if (raw === undefined) continue;
    let idx = Math.trunc(toNumber(raw));
    if (idx < 0) idx = n + idx;
    if (idx === i) out.push(values[i]);
  }
  return out;
}

/**
 * `fieldFinal`. Defers building the raw array until a *second* defined result
 * shows up: `x.f` over a single object — the most frequent terminal step in a
 * compiled expression — then allocates nothing at all.
 */
function vFieldFinal(values, name, keepSingleton) {
  let first;
  let raw = null;
  for (let i = 0; i < values.length; i++) {
    const sv = RT.field(values[i], name);
    if (sv === undefined) continue;
    if (raw !== null) {
      raw.push(sv);
    } else if (first === undefined) {
      first = sv;
    } else {
      raw = [first, sv];
    }
  }
  if (raw !== null) return finalizeRaw(raw, keepSingleton);
  if (first === undefined) return undefined;
  return Array.isArray(first) ? first : (keepSingleton ? [first] : first);
}

/** `wildcardFinal`. */
function vWildcardFinal(values, keepSingleton) {
  return vFinalWith(values, RT.wildcard, keepSingleton);
}

/** `descendantFinal`. */
function vDescendantFinal(values, keepSingleton) {
  return vFinalWith(values, RT.descendant, keepSingleton);
}

function vFinalWith(values, stepFn, keepSingleton) {
  const raw = [];
  for (let i = 0; i < values.length; i++) {
    const sv = stepFn(values[i]);
    if (sv !== undefined) raw.push(sv);
  }
  return finalizeRaw(raw, keepSingleton);
}

/** Seeds the initial tuple sequence from a path's root context value. */
function seed(input) {
  if (input === undefined) return [];
  const arr = Array.isArray(input) ? input : [input];
  return arr.map((v) => ({ v, p: undefined }));
}

/**
 * Seeds a single tuple wrapping `input` verbatim, *without* `seed`'s
 * array-spreading (each array element becoming its own root tuple).
 * Standalone `*`/`**` (not stepping across a longer path) treat an
 * array-valued `$` as one object-like value whose numeric indices are its
 * "keys" - unlike a bare `FieldRef`, which genuinely does treat an
 * array `$` as multiple implicit root items (matches jsonata: `Product`
 * over `[{Product:'a'},{Product:'b'}]` gives `["a","b"]`, but `*` over the
 * same input gives back the two objects unchanged).
 */
function seedSingle(input) {
  if (input === undefined) return [];
  return [{ v: input, p: undefined }];
}

/**
 * Seeds a tuple sequence from a path's root context value like `seed`, but
 * tags every produced tuple with an inherited parent tuple (`p`) and
 * `@$`/`#$` bindings object (`b`) instead of resetting both to none. Used
 * when a `ContextRef` (`$`, identity) source feeds a nested construct
 * (dotted group-by, sort, predicate, ...) evaluated *inside* an enclosing
 * per-element closure — `$` didn't lose its parent-chain/binding
 * associations just because this construct re-seeds a fresh tuple stream
 * from it.
 */
function seedWithBindings(input, p, b) {
  if (input === undefined) return [];
  const arr = Array.isArray(input) ? input : [input];
  return arr.map((v) => ({ v, p, b }));
}

function expand(tuples, stepValueOf) {
  const out = [];
  for (const t of tuples) {
    const sv = stepValueOf(t.v, t);
    if (sv === undefined) continue;
    if (Array.isArray(sv)) {
      for (const e of sv) if (e !== undefined) out.push({ v: e, p: t, b: t.b });
    } else {
      out.push({ v: sv, p: t, b: t.b });
    }
  }
  return out;
}

/**
 * Computes the *final value* of a path whose last step is a field/wildcard/
 * descendant navigation, given the tuples produced by every step before it.
 * Ports jsonata's `evaluateStep` `lastStep && result.length === 1` rule:
 * when exactly one input tuple produced a defined per-tuple result, that
 * raw result (array or not) becomes the path's value verbatim - untagged,
 * so it is never subject to further singleton-collapse even if it is a
 * one-element array. Only when two or more input tuples each produced a
 * result does per-tuple array flattening (then ordinary singleton collapse)
 * apply. This is what makes `{"a":[1]}.a` return `[1]` (the field's own
 * array value, whole) while `Account.Order.Product` (many Orders, one
 * Product array each) still flattens into one flat sequence. Must only be
 * used to produce a path's *terminal value* - never to build a tuple
 * stream consumed by a further step, predicate, sort, group-by, or
 * transform, all of which need one tuple per element regardless of how
 * many input tuples fed the step (they use `stepField`/`stepWildcard`/
 * `stepDescendant` + `expand` instead).
 */
function finalValue(tuples, stepValueOf, keepSingleton) {
  const raw = [];
  for (const t of tuples) {
    const sv = stepValueOf(t.v, t);
    if (sv !== undefined) raw.push(sv);
  }
  return finalizeRaw(raw, keepSingleton);
}

/**
 * Shared tail of every `*Final` helper: turns the per-tuple raw results into
 * the path's terminal value. Split out of `finalValue` so the hot field case
 * (`fieldFinal`) can run its own loop instead of allocating a `stepValueOf`
 * closure on every call.
 */
function finalizeRaw(raw, keepSingleton) {
  const n = raw.length;
  if (n === 0) return undefined;
  if (n === 1) {
    // The verbatim single-result passthrough only applies when that one raw
    // result is itself an array (real jsonata: `Array.isArray(result[0])`);
    // a scalar single result still goes through ordinary collapse, so `a[]`
    // on a scalar `a` still wraps it as `[a]` rather than returning `a` bare.
    const r = raw[0];
    if (Array.isArray(r)) return r;
    return keepSingleton ? [r] : r;
  }
  // Two or more raw results: flatten one level. When nothing needs
  // flattening (the common case — scalar field values) `raw` already *is*
  // the sequence, and `RT.collapse` of a >=2-element array returns it
  // unchanged, so the copy would be pure waste.
  let flat = true;
  for (let i = 0; i < n; i++) {
    if (Array.isArray(raw[i])) { flat = false; break; }
  }
  if (flat) return raw;
  const seq = [];
  for (let i = 0; i < n; i++) {
    const r = raw[i];
    if (Array.isArray(r)) {
      for (let j = 0; j < r.length; j++) if (r[j] !== undefined) seq.push(r[j]);
    } else {
      seq.push(r);
    }
  }
  return RT.collapse(seq, keepSingleton);
}

function fieldFinal(tuples, name, fallbackRoot, keepSingleton) {
  const raw = [];
  for (let i = 0; i < tuples.length; i++) {
    let sv = RT.field(tuples[i].v, name);
    if (sv === undefined && fallbackRoot !== undefined) sv = RT.field(fallbackRoot, name);
    if (sv !== undefined) raw.push(sv);
  }
  return finalizeRaw(raw, keepSingleton);
}

/**
 * Fast path for `fieldFinal(seed(v), name, undefined, keepSingleton)` /
 * `fieldFinal(seedSingle(v), ...)` — the shape the translator emits for a
 * lone field step off a bare context value (`name`, `$.name`), which is by
 * far the most frequent operation in a compiled expression (every predicate
 * body, every aggregate argument).
 *
 * When `v` is neither `undefined` nor an array, the tuple machinery is
 * provably identity: `seed`/`seedSingle` agree (one tuple), so `raw` has at
 * most one element, and `finalizeRaw` then returns an array result verbatim,
 * a scalar result as-is (or wrapped, under `keepSingleton`), and nothing at
 * all for a missing field. That collapses to a single `RT.field` call with
 * ZERO allocation, against 1 tuple object + 1 tuple array + 1 closure +
 * 2 result arrays for the general path. An array (implicit-mapping) or
 * missing `v` still takes the general path, where the seeding distinction
 * is observable (`seed` spreads an array root into one tuple per element,
 * `seedSingle` keeps it as one opaque item).
 */
function fieldOneOf(v, name, keepSingleton, single) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    const r = RT.field(v, name);
    if (keepSingleton && r !== undefined && !Array.isArray(r)) return [r];
    return r;
  }
  return fieldFinal(single ? seedSingle(v) : seed(v), name, undefined, keepSingleton);
}

/** `fieldFinal(seed(v), name, undefined, keepSingleton)` — array root spreads into one tuple per element. */
function fieldOne(v, name, keepSingleton) {
  return fieldOneOf(v, name, keepSingleton, false);
}

/** `fieldFinal(seedSingle(v), name, undefined, keepSingleton)` — array root stays one opaque item. */
function fieldOneSingle(v, name, keepSingleton) {
  return fieldOneOf(v, name, keepSingleton, true);
}

function wildcardFinal(tuples, keepSingleton) {
  return finalValue(tuples, (v) => RT.wildcard(v), keepSingleton);
}

function descendantFinal(tuples, keepSingleton) {
  return finalValue(tuples, (v) => RT.descendant(v), keepSingleton);
}

/**
 * `.name` step. `fallbackRoot`, when provided (path is in "tuple stream"
 * mode — a `@$`/`#$` binding occurred earlier in this same path), is
 * looked up for `name` when the per-element lookup misses, matching
 * jsonata's documented join idiom `Employee@$e.Contact` (`Contact` isn't a
 * field of an Employee, so it resolves against the root document instead).
 * Always flattens (via `expand`) — safe for both a mid-path step and a
 * tuple stream consumed further (predicate/sort/group-by/transform
 * sources); see `fieldFinal` for the terminal-value variant.
 */
function stepField(tuples, name, fallbackRoot) {
  // Hand-rolled rather than `expand(tuples, closure)`: this runs once per
  // path step per evaluation and the closure was a per-call allocation.
  const out = [];
  for (let i = 0; i < tuples.length; i++) {
    const t = tuples[i];
    let sv = RT.field(t.v, name);
    if (sv === undefined && fallbackRoot !== undefined) sv = RT.field(fallbackRoot, name);
    if (sv === undefined) continue;
    if (Array.isArray(sv)) {
      for (let j = 0; j < sv.length; j++) {
        if (sv[j] !== undefined) out.push({ v: sv[j], p: t, b: t.b });
      }
    } else {
      out.push({ v: sv, p: t, b: t.b });
    }
  }
  return out;
}

/**
 * Generic step for an arbitrary compiled sub-expression used as a bare path
 * step (e.g. `foo.{...}` group-by, `foo.[...]` array constructor,
 * `foo.(a+b)` parenthesized/binary expression): `fn(v, parentTuple,
 * tupleBindings)` is evaluated per element with `$` rebound to `v`. Unlike
 * `stepField`/`stepWildcard`/`stepDescendant`, an array-valued result is
 * kept as a single nested value (one output tuple per input element) rather
 * than flattened — only field/wildcard/descendant navigation auto-flattens
 * in JSONata; explicit constructs and general expressions do not.
 */
function stepExpr(tuples, fn) {
  const out = [];
  for (const t of tuples) {
    const v = fn(t.v, t.p, t.b);
    if (v === undefined) continue;
    out.push({ v, p: t, b: t.b });
  }
  return out;
}

/**
 * A bare path-step expression evaluated *within a tuple-mode path* (one
 * using `%`/`@$`/`#$` anywhere) - e.g. `Order.Product.[a,b]`,
 * `Employee@$e.(Contact)`. Like `stepExpr`, `fn` is evaluated per element
 * with `$` rebound; unlike `stepExpr`'s general "keep an array result
 * nested" rule, its array-valued result *flattens* into the outer
 * sequence - jsonata evaluates every step of a tuple-mode path through
 * its distinct `evaluateTupleStep`, which flattens any array result
 * unconditionally (no `.cons`/array-constructor-only exception, unlike
 * ordinary non-tuple-mode step evaluation).
 */
function stepFlatten(tuples, fn) {
  const out = [];
  for (const t of tuples) {
    const sv = fn(t.v, t.p, t.b);
    if (Array.isArray(sv)) {
      for (const e of sv) if (e !== undefined) out.push({ v: e, p: t, b: t.b });
    } else if (sv !== undefined) {
      out.push({ v: sv, p: t, b: t.b });
    }
  }
  return out;
}

/** `*` step. Always flattens; see `stepField`/`wildcardFinal`. */
function stepWildcard(tuples) {
  return expand(tuples, (v) => RT.wildcard(v));
}

/** `**` step. Always flattens; see `stepField`/`descendantFinal`. */
function stepDescendant(tuples) {
  return expand(tuples, (v) => RT.descendant(v));
}

/** `%` step — replaces each tuple with its own parent tuple (dropped if there is none). */
function stepParent(tuples) {
  const out = [];
  for (const t of tuples) if (t.p !== undefined) out.push(t.p);
  return out;
}

/**
 * `@$var` context-binding step. Real jsonata's `@$var` doesn't create a
 * separate navigational step - it tags the *preceding* step (here, the
 * step whose results these `tuples` already are) as a "focus" step: the
 * bound value is each of that step's individual results (`t.v`), but the
 * path's own continuing navigation position (`$`/`t.v` for every step
 * after this one) *reverts* to what it was *before* that step ran (`t.p`'s
 * value) - e.g. `library.loans@$l.books` binds each loan to `$l` but
 * keeps navigating from `library` (`loans`'s own input), so `.books`
 * resolves as `library.books`, not a (nonexistent) field of a loan.
 *
 * `%`'s own parent chain does *not* shift for an isolated bind (`t.p` is
 * kept as-is: e.g. after just `loans@$l`, `%` from an `$l`-bound tuple is
 * still `library`, matching a bind-free `loans.{...}`'s own `%`). But
 * jsonata's real ancestor resolution (`parser.js#resolveAncestry`/
 * `seekParent`) treats a *contiguous run* of `@$`-bound ("focus") steps
 * as a single unit that consumes exactly one `%` hop *for the whole run*,
 * landing on the run's own pre-run parent - not one hop per bind chained
 * in it (verified against real jsonata: `library.loans@$L.books@$B[...].
 * {'x':$keys(%)}` and a 3-deep `...customers@$C[...].{'x':$keys(%.%)}`
 * both land exactly on `library`/its own parent, never on an
 * intermediate per-bind "layer"). A bind continues the *same* run as the
 * one immediately preceding it exactly when its own source tuple (`t.p`)
 * is itself a prior bind's output (`t.p.g` set, only ever true for a
 * `stepContextBind` result) - in that case skip past `t.p` entirely
 * (`t.p.p`) so the whole run still costs only one hop; otherwise (this is
 * the run's first bind) keep `t.p` as-is.
 */
function stepContextBind(tuples, varName) {
  return tuples.map((t) => {
    const b = t.b ? Object.assign({}, t.b) : {};
    b[varName] = t.v;
    // No tracked parent (this tuple is straight from `seed`, e.g. `$@$i`):
    // the value "before" this step is the same identity value - reverting
    // is then a no-op, matching jsonata seeding `tupleBindings[ee]['@']`
    // from the same input the (identity) step then reads.
    if (t.p === undefined) return { v: t.v, p: undefined, b };
    // `.g` ("group anchor") records `t.p` - the tuple that produced `t`
    // via the *navigational* step just before this revert (e.g. a
    // specific loan, for its books) - as the sibling-grouping identity
    // going forward, separately from `.p` (which `%`/further navigation
    // needs). Reusing the (possibly run-skipping) `.p` for both would be
    // wrong: it is *shared by every sibling* of `t` (every tuple that
    // expanded from the same `t.p`, e.g. every loan sharing one
    // `library` parent) - fine for grouping tuples still at *this* level
    // (e.g. `#$il}` scoping every loan into one group), but merges each
    // sibling's *own subsequent* lineage (e.g. each loan's own books,
    // after `books` re-navigates from the reverted `library` value) back
    // into one group the moment they all revert to the same conceptual
    // ancestor value. `groupByParent` prefers `.g` over `.p` exactly
    // where it's set - i.e. only for a tuple *produced by* a revert -
    // and `expand` never propagates `.g` to a step's own children, so a
    // later, unrelated navigational step (like `books`) starts fresh from
    // the correct per-sibling `.p` again.
    const continuesRun = t.p.g !== undefined;
    return { v: t.p.v, p: continuesRun ? t.p.p : t.p, g: t.g !== undefined ? t.g : t.p, b };
  });
}

/**
 * `#$var` position-binding step: records the 0-based index under
 * `tuple.b[varName]`. When it is the *first* `#$var`/predicate/subscript
 * for its navigational step (jsonata's own `step.index`, assigned during
 * the per-outer-iteration expand, before any flattening), it is scoped to
 * each *sibling group* (tuples sharing the same parent tuple) - matching
 * `stepPredicate`/`stepSubscript`'s own default sibling-scoping.
 * `customers#$ic` nested under `loans@$l` re-iterates `customers` fresh
 * for every loan, so `$ic` must restart at 0 for each loan's own
 * customers, not keep counting across the whole flattened tuple sequence.
 * But when `global` is set - this `#$var` instead follows a
 * predicate/subscript *on the same step* (jsonata's `evaluateStages`
 * "index"-type stage, e.g. `books@$b#$ib[cond]#$ib2`'s `#$ib2`) - indices
 * are assigned once across the *whole* (already stage-filtered) tuple
 * array instead, matching that stage running after flattening.
 */
function stepPositionBind(tuples, varName, global) {
  const groups = global ? [tuples] : groupByParent(tuples);
  for (const siblings of groups) {
    siblings.forEach((t, i) => {
      t.b = t.b ? Object.assign({}, t.b) : {};
      t.b[varName] = i;
    });
  }
  return tuples;
}

/**
 * A bare variable reference used as a path step (`.$v` continuing after an
 * `@$v`/`#$v` binding): resolves per-tuple from `tuple.b[varName]` when
 * present, else falls back to `outerFn()` (the variable's normal lexical
 * value, which is the same for every tuple).
 */
function stepVariableStep(tuples, varName, outerFn) {
  return expand(tuples, (v, t) => {
    void v;
    return t && t.b && Object.prototype.hasOwnProperty.call(t.b, varName) ? t.b[varName] : outerFn();
  });
}


/** Partitions `tuples` into groups sharing the same sibling-grouping identity (`.g` if set - see `stepContextBind` - else `.p`), preserving first-seen order. */
function groupByParent(tuples) {
  const groups = [];
  const map = new Map();
  for (const t of tuples) {
    const key = t.g !== undefined ? t.g : t.p;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
      groups.push(bucket);
    }
    bucket.push(t);
  }
  return groups;
}

/**
 * Predicate step `[cond]`: `condFn(v, parentTuple, tupleBindings, index, siblings)`
 * is evaluated per element. A numeric result (or an array containing a
 * numeric result) selects by 0-based index (negative counts from the end)
 * rather than boolean-filtering, matching JSONata's predicate semantics.
 * Indexing is scoped to each *sibling group* (elements sharing the same
 * parent tuple) — `foo.bar[0]` selects the first `bar` within each `foo`,
 * not the first `bar` across a globally flattened sequence - *unless*
 * `global` is set, matching jsonata's own tuple-mode semantics: once a
 * path uses `%`/`@$`/`#$` anywhere, every later predicate/subscript
 * "stage" applies once across the *whole* flattened tuple stream instead
 * of per-outer-iteration (`evaluateTupleStep` expands and flattens every
 * outer tuple's own step result *before* running `expr.stages`, unlike
 * ordinary `evaluateStep`, whose per-input-item loop and stage
 * application are the same loop) - see the `joins` conformance group
 * (`library.loans@$l.books@$b[cond][1]`: `[1]` picks the second match
 * *overall*, not the second match within each loan).
 */
function stepPredicate(tuples, condFn, global) {
  const out = [];
  const groups = global ? [tuples] : groupByParent(tuples);
  for (const siblings of groups) {
    for (let i = 0; i < siblings.length; i++) {
      const t = siblings[i];
      const res = condFn(t.v, t.p, t.b, i, siblings);
      if (matchesPredicate(res, i, siblings.length)) out.push(t);
    }
  }
  return out;
}

/**
 * A numeric predicate result (or an array where *every* element is
 * numeric) selects by 0-based index; any other shape - including an
 * array mixing numbers with non-numeric values - falls back to an
 * ordinary boolean-truthy check on the whole result, matching jsonata's
 * own `isArrayOfNumbers` all-or-nothing gate (`evaluateFilter`): a
 * single stray non-number anywhere in the predicate array disqualifies
 * *every* number in it from being treated as an index.
 */
function matchesPredicate(res, index, length) {
  if (res === undefined) return false;
  const values = Array.isArray(res) ? res : [res];
  if (values.length > 0 && values.every((v) => typeof v === 'number')) {
    for (const v of values) {
      let idx = Math.trunc(v);
      if (idx < 0) idx = length + idx;
      if (idx === index) return true;
    }
    return false;
  }
  return RT.isTruthy(res);
}

/** `[n]` numeric array-subscript step folded onto a single path step; also sibling-group-scoped unless `global` is set (see `stepPredicate`). */
function stepSubscript(tuples, indexFn, global) {
  const out = [];
  const groups = global ? [tuples] : groupByParent(tuples);
  for (const siblings of groups) {
    for (let i = 0; i < siblings.length; i++) {
      const t = siblings[i];
      const raw = indexFn(t.v, t.p, t.b, i, siblings);
      if (raw === undefined) continue;
      let idx = Math.trunc(toNumber(raw));
      if (idx < 0) idx = siblings.length + idx;
      if (idx === i) out.push(t);
    }
  }
  return out;
}


/** Collapses the final tuple sequence into a JSONata result value. */
function collapseTuples(tuples, keepSingleton) {
  return RT.collapse(tuples.map((t) => t.v), keepSingleton);
}

/** Forces an array result even for zero/one tuples. */
function forceArrayTuples(tuples) {
  return tuples.map((t) => t.v);
}

module.exports = {
  seed,
  seedSingle,
  seedWithBindings,
  stepField,
  stepWildcard,
  stepDescendant,
  fieldFinal,
  fieldOne,
  fieldOneSingle,
  wildcardFinal,
  descendantFinal,
  stepParent,
  stepContextBind,
  stepPositionBind,
  stepVariableStep,
  stepExpr,
  stepFlatten,
  stepPredicate,
  stepSubscript,
  collapseTuples,
  // value mode (see the header block at the top of this file)
  vSeed,
  vSeedSingle,
  vStepField,
  vStepWildcard,
  vStepDescendant,
  vStepExpr,
  exprFinal,
  vExprFinal,
  vStepFlatten,
  vFilter,
  vSubscript,
  vFieldFinal,
  vWildcardFinal,
  vDescendantFinal,
  forceArrayTuples,
};
