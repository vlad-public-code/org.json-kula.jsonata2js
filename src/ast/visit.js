'use strict';

const { NODE_TYPE_SET } = require('./node-types');

/**
 * Dispatches `node` to `handlers['visit' + node.type](node, ctx)`, mirroring
 * JSonata2Java's `AstNode.accept(Visitor<R,C> visitor, C ctx)`.
 *
 * `handlers` need not be exhaustive; a missing handler falls back to
 * `handlers.visitDefault(node, ctx)` when present, else throws — this keeps
 * partial visitors (e.g. an optimizer pass that only rewrites a few node
 * types) safe by construction instead of silently no-op-ing on typos.
 */
function visit(astNode, handlers, ctx) {
  if (!astNode || typeof astNode.type !== 'string') {
    throw new TypeError(`visit: expected an AST node, got ${JSON.stringify(astNode)}`);
  }
  if (!NODE_TYPE_SET.has(astNode.type)) {
    throw new TypeError(`visit: unknown AST node type "${astNode.type}"`);
  }
  const key = 'visit' + astNode.type;
  const fn = handlers[key];
  if (typeof fn === 'function') return fn(astNode, ctx);
  if (typeof handlers.visitDefault === 'function') return handlers.visitDefault(astNode, ctx);
  throw new TypeError(`visit: no handler for AST node type "${astNode.type}" (define ${key} or visitDefault)`);
}

module.exports = { visit };
