'use strict';

/**
 * Sequence scan fusion — one pass over a bound sequence feeding every
 * operation the block performs on it.
 *
 * Analytical JSONata binds a sequence once and interrogates it many times:
 *
 *   ( $employees := company.departments.employees;
 *     $totalPayroll := $sum($employees.salary);
 *     $topSalary    := $max($employees.salary);
 *     $seniorCount  := $count($employees[level = "senior"]);
 *     $leadCount    := $count($employees[level = "lead"]);
 *     … )
 *
 * Each of those already compiles to a single allocation-free pass, but they
 * remain a dozen separate passes over the same elements, reading `salary` four
 * times and `level` five. **The unit of waste is the field read, not the
 * loop**: measured on the project benchmark, merging the loops while leaving
 * each predicate an opaque callback was worth 9%, and additionally sharing the
 * field reads was worth 60%.
 *
 * So this pass groups a block's operations by sequence and emits one hoisted
 * helper per group that reads each distinct field once per element and feeds
 * every accumulator from that read.
 *
 * <h2>What is absorbed</h2>
 *
 * | shape | slot |
 * |---|---|
 * | `$sum/$average/$max/$min($seq.field)` | one `H.scanAcc()` per field, shared by all four |
 * | `$count($seq[<pred>])` | the matching elements |
 * | `$seq[<pred>]` as a value | the matching elements |
 *
 * `<pred>` must be built only from the element's own top-level fields,
 * literals, and `=`, `!=`, `and`, `or` — see `absorbablePredicate`. That
 * restriction is not only about being able to hoist the reads: those four
 * operators cannot throw, so moving a predicate earlier cannot move an error
 * earlier with it. Aggregates get the same guarantee a different way — the
 * accumulator RECORDS a non-numeric value and `H.scanAgg` raises it where the
 * result is read, which is the original statement.
 *
 * An ordering comparison (`field < <= > >= literal`) CAN throw, so it is
 * absorbed only as the WHOLE predicate, and by the same record-and-raise
 * trick: `RT.cmpSafe` returns a sentinel where the operator would have thrown,
 * the loop keeps the first offending operand pair, and `H.cmpCheck`
 * reconstructs the identical T2009/T2010 at the read. It stays out of
 * `and`/`or` because a deferred throw underneath a short-circuit has no single
 * place to land.
 *
 * <h2>When it declines</h2>
 *
 * The scan runs unconditionally at the group's first use, so an operation may
 * only be absorbed from a position that is itself evaluated unconditionally.
 * `collectFrom` is a WHITELIST of such positions; a blacklist would fail open,
 * and failing open here means wrong answers. Also declined: a sequence not
 * bound exactly once earlier in this same block, a shadowed built-in name, a
 * bare `name(...)` path-step call, and any group too small to pay for the
 * helper it costs (`payoffOk`).
 */

const { GenCtx } = require('./gen-ctx');

/** Aggregates whose per-element fold is `H.scanPush`. */
const AGG_KINDS = new Set(['sum', 'average', 'max', 'min']);

/** Operators that can appear in an absorbed predicate: none of them can throw. */
const SAFE_PRED_OPS = new Set(['=', '!=', 'and', 'or']);

/** Operators absorbed only as the whole predicate, because they can throw. */
const ORDERING_OPS = new Set(['<', '<=', '>', '>=']);

const LITERALS = new Set(['StringLiteral', 'NumberLiteral', 'BooleanLiteral', 'NullLiteral']);

/**
 * True if `node` is a predicate this pass can re-emit with its field reads
 * hoisted, collecting the names it reads into `fields`.
 */
function absorbablePredicate(node, fields) {
  if (!node) return false;
  if (node.type === 'FieldRef') { fields.add(node.name); return true; }
  if (LITERALS.has(node.type)) return true;
  if (node.type === 'Parenthesized') return absorbablePredicate(node.inner, fields);
  if (node.type === 'BinaryOp') {
    return SAFE_PRED_OPS.has(node.op)
      && absorbablePredicate(node.left, fields) && absorbablePredicate(node.right, fields);
  }
  return false;
}

/** `$seq.field` — the only aggregate argument shape this pass absorbs. */
function seqDotField(node) {
  if (!node || node.type !== 'PathExpr' || node.steps.length !== 2) return null;
  const [a, b] = node.steps;
  if (a.type !== 'VariableRef' || b.type !== 'FieldRef') return null;
  return { varName: a.name, field: b.name };
}

/**
 * `field <op> literal` (either way round) as the WHOLE predicate — the shape
 * whose error can be deferred to the read. Returns `{ op, field, literal,
 * fieldLeft }`, or `null`.
 */
function orderingPredicate(node) {
  let n = node;
  while (n && n.type === 'Parenthesized') n = n.inner;
  if (!n || n.type !== 'BinaryOp' || !ORDERING_OPS.has(n.op)) return null;
  let left = n.left; let right = n.right;
  while (left && left.type === 'Parenthesized') left = left.inner;
  while (right && right.type === 'Parenthesized') right = right.inner;
  if (left.type === 'FieldRef' && LITERALS.has(right.type)) {
    return { op: n.op, field: left.name, literal: right, fieldLeft: true };
  }
  if (right.type === 'FieldRef' && LITERALS.has(left.type)) {
    return { op: n.op, field: right.name, literal: left, fieldLeft: false };
  }
  return null;
}

/** `$seq[<pred>]` — the only filter shape this pass absorbs. */
function seqPredicate(node) {
  if (!node || node.type !== 'PredicateExpr' || node.source.type !== 'VariableRef') return null;
  const fields = new Set();
  if (absorbablePredicate(node.predicate, fields)) {
    return { varName: node.source.name, predicate: node.predicate, fields, cmp: null };
  }
  const cmp = orderingPredicate(node.predicate);
  if (cmp) {
    fields.add(cmp.field);
    return { varName: node.source.name, predicate: node.predicate, fields, cmp };
  }
  return null;
}

/**
 * Plans fusion for one `Block`. Returns `null` when nothing is worth fusing,
 * else `{ groups, memo }` — `memo` maps an absorbed node (BY IDENTITY: two
 * occurrences of the same expression text are two separate operations, and
 * only the one planned for may be redirected) to `{ group, slot, read }`.
 */
function planScanFusion(block, ctx, builtinNames) {
  const stmts = block.expressions;

  // 1. Names bound exactly once in this block, with the statement that binds
  //    them. A rebound name is not this pass's to move.
  const bindCount = new Map();
  const bindAt = new Map();
  for (let i = 0; i < stmts.length; i++) {
    const e = stmts[i];
    if (e.type !== 'VariableBinding') continue;
    bindCount.set(e.name, (bindCount.get(e.name) || 0) + 1);
    if (!bindAt.has(e.name)) bindAt.set(e.name, i);
  }
  const boundOnce = (name) => bindCount.get(name) === 1;

  // A built-in shadowed by a binding in this block, or lexically outside it,
  // is no longer the built-in.
  const usable = (name) => builtinNames.has(name)
    && !bindCount.has(name)
    && !ctx.isLexicallyBound(GenCtx.jsName('v_', name));

  const groups = new Map(); // varName -> group
  const memo = new Map();

  const groupFor = (varName, stmtIndex) => {
    if (!boundOnce(varName)) return null;
    const at = bindAt.get(varName);
    if (at === undefined || at >= stmtIndex) return null; // not bound earlier here
    let g = groups.get(varName);
    if (!g) {
      g = { varName, firstStmt: stmtIndex, aggFields: new Map(), preds: [], slots: 0, ops: 0 };
      groups.set(varName, g);
    }
    return g;
  };

  /** Absorbs `node` whole if it is one of the three shapes; else false. */
  const tryAbsorb = (node, stmtIndex) => {
    if (node.type === 'FunctionCall' && !node.bare && node.args.length === 1) {
      if (AGG_KINDS.has(node.name) && usable(node.name)) {
        const m = seqDotField(node.args[0]);
        const g = m && groupFor(m.varName, stmtIndex);
        if (g) {
          let slot = g.aggFields.get(m.field);
          if (slot === undefined) { slot = g.slots++; g.aggFields.set(m.field, slot); }
          g.ops++;
          memo.set(node, { group: g, slot, read: (v) => `H.scanAgg(${v}, ${JSON.stringify(node.name)})` });
          return true;
        }
      }
      if (node.name === 'count' && usable('count')) {
        const m = seqPredicate(node.args[0]);
        const g = m && groupFor(m.varName, stmtIndex);
        if (g) {
          const slot = g.slots++;
          g.preds.push({ slot, predicate: m.predicate, fields: m.fields, cmp: m.cmp });
          g.ops++;
          const read = m.cmp ? (v) => `H.countOf(H.cmpCheck(${v}))` : (v) => `H.countOf(${v})`;
          memo.set(node, { group: g, slot, read });
          return true;
        }
      }
      return false;
    }
    const m = seqPredicate(node);
    const g = m && groupFor(m.varName, stmtIndex);
    if (g) {
      const slot = g.slots++;
      g.preds.push({ slot, predicate: m.predicate, fields: m.fields, cmp: m.cmp });
      g.ops++;
      const read = m.cmp
        ? (v) => `RT.collapse(H.cmpCheck(${v}), false)`
        : (v) => `RT.collapse(${v}, false)`;
      memo.set(node, { group: g, slot, read });
      return true;
    }
    return false;
  };

  // 2. Walk each statement through the unconditional-position whitelist.
  const collectFrom = (node, stmtIndex) => {
    if (!node || typeof node !== 'object') return;
    if (tryAbsorb(node, stmtIndex)) return; // absorbed whole; do not descend
    switch (node.type) {
      case 'VariableBinding':
        collectFrom(node.value, stmtIndex);
        return;
      case 'Parenthesized':
        collectFrom(node.inner, stmtIndex);
        return;
      case 'FunctionCall':
        // Every built-in evaluates all of its arguments; a lambda call may not
        // (thunked tail calls), so only built-ins are descended into.
        if (!node.bare && usable(node.name)) for (const a of node.args) collectFrom(a, stmtIndex);
        return;
      case 'BinaryOp':
        // `and`/`or` compile their right operand to a thunk.
        if (node.op !== 'and' && node.op !== 'or') {
          collectFrom(node.left, stmtIndex);
          collectFrom(node.right, stmtIndex);
        }
        return;
      case 'UnaryMinus':
        collectFrom(node.operand, stmtIndex);
        return;
      case 'ArrayConstructor':
        for (const el of node.elements) collectFrom(el, stmtIndex);
        return;
      default:
        // Lambdas, conditionals, transforms, paths, group-bys, object
        // constructors, … are not descended into.
    }
  };

  for (let i = 0; i < stmts.length; i++) collectFrom(stmts[i], i);

  // 3. Payoff guard: a fused scan costs a helper and a result array, and saves
  //    a pass per operation plus a field read per operation that SHARES a
  //    field. Two operations on two different fields save only the passes,
  //    which does not pay for the code.
  const kept = [...groups.values()].filter(payoffOk);
  if (kept.length === 0) return null;
  for (const [node, entry] of memo) if (!kept.includes(entry.group)) memo.delete(node);
  return { groups: kept, memo };
}

function payoffOk(g) {
  if (g.ops >= 3) return true;
  if (g.ops !== 2) return false;
  const names = new Set();
  for (const f of g.aggFields.keys()) names.add(f);
  for (const p of g.preds) for (const f of p.fields) names.add(f);
  return names.size < g.ops; // the two operations share a field
}

/**
 * Emits the fused helper for `group` and returns its source. `seqExpr` is the
 * parameter name the sequence arrives on.
 *
 * Reads are keyed by (name, accessor): an aggregate reads through `RT.field`
 * and a predicate through `P.fieldOne`, which differ for an element that is
 * itself an array, so a field used by both is read once for each rather than
 * shared across the two.
 */
function emitScan(group, fresh) {
  const seq = fresh('sq');
  const values = fresh('sv');
  const n = fresh('sn');
  const el = fresh('se');
  const i = fresh('si');

  const decls = [];
  const body = [];
  const slotVars = new Array(group.slots);

  for (const [field, slot] of group.aggFields) {
    const v = fresh('sa');
    slotVars[slot] = v;
    decls.push(`const ${v} = H.scanAcc();`);
    const r = fresh('sf');
    body.push(`const ${r} = RT.field(${el}, ${JSON.stringify(field)});`);
    body.push(`if (${r} !== undefined) H.scanPush(${v}, ${r});`);
  }

  // One `P.fieldOne` read per distinct field any predicate needs.
  const predRead = new Map();
  for (const p of group.preds) {
    for (const f of p.fields) {
      if (predRead.has(f)) continue;
      const r = fresh('sp');
      predRead.set(f, r);
      body.push(`const ${r} = P.fieldOne(${el}, ${JSON.stringify(f)}, false);`);
    }
  }
  for (const p of group.preds) {
    const v = fresh('sl');
    decls.push(`const ${v} = [];`);
    if (!p.cmp) {
      slotVars[p.slot] = v;
      body.push(`if (P.matchesPredicate(${emitPred(p.predicate, predRead)}, ${i}, ${n})) ${v}.push(${el});`);
      continue;
    }
    // An ordering comparison keeps the FIRST offending operand pair instead of
    // throwing where the loop runs; the slot then carries the error to the read.
    const bad = fresh('sb');
    const ba = fresh('sx');
    const bb = fresh('sy');
    const t = fresh('sc');
    const f = predRead.get(p.cmp.field);
    const lit = literalCode(p.cmp.literal);
    const left = p.cmp.fieldLeft ? f : lit;
    const right = p.cmp.fieldLeft ? lit : f;
    decls.push(`let ${bad} = false, ${ba}, ${bb};`);
    body.push(`const ${t} = RT.cmpSafe(${left}, ${right}, ${JSON.stringify(p.cmp.op)});`);
    body.push(`if (${t} === RT.CMP_BAD) { if (!${bad}) { ${bad} = true; ${ba} = ${left}; ${bb} = ${right}; } }`);
    body.push(`else if (P.matchesPredicate(${t}, ${i}, ${n})) ${v}.push(${el});`);
    slotVars[p.slot] = `(${bad} ? H.cmpBad(${ba}, ${bb}, ${JSON.stringify(p.cmp.op)}) : ${v})`;
  }

  return `(${seq}) => {
const ${values} = P.vSeed(${seq});
const ${n} = ${values}.length;
${decls.join('\n')}
for (let ${i} = 0; ${i} < ${n}; ${i}++) {
const ${el} = ${values}[${i}];
${body.join('\n')}
}
return [${slotVars.join(',')}];
}`;
}

/**
 * Re-emits an absorbed predicate against the pre-read field locals. Mirrors
 * `translator#genBinaryOp` for exactly the operators `absorbablePredicate`
 * admits; anything else never reaches here.
 */
/** A predicate literal, as JS source. */
function literalCode(node) {
  return node.type === 'NullLiteral' ? 'null' : JSON.stringify(node.value);
}

function emitPred(node, reads) {
  switch (node.type) {
    case 'FieldRef': return reads.get(node.name);
    case 'StringLiteral':
    case 'NumberLiteral':
    case 'BooleanLiteral': return JSON.stringify(node.value);
    case 'NullLiteral': return 'null';
    case 'Parenthesized': return emitPred(node.inner, reads);
    case 'BinaryOp': {
      const l = emitPred(node.left, reads);
      if (node.op === 'and') return `RT.and(${l}, () => (${emitPred(node.right, reads)}))`;
      if (node.op === 'or') return `RT.or(${l}, () => (${emitPred(node.right, reads)}))`;
      const r = emitPred(node.right, reads);
      return node.op === '=' ? `RT.eq(${l}, ${r})` : `RT.ne(${l}, ${r})`;
    }
    default:
      throw new Error(`scan-fusion: unexpected predicate node "${node.type}"`);
  }
}

module.exports = { planScanFusion, emitScan };
