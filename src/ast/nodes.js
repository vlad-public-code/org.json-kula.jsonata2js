'use strict';

/**
 * Plain-object AST node factories, one per JSonata2Java `AstNode` record
 * (parser/ast/AstNode.java). Each factory returns `{ type, ...fields }`.
 *
 * Every node also carries an optional `pos` (0-based source character
 * offset of the first token) used for runtime error messages/positions;
 * it has no bearing on evaluation semantics.
 */

function node(type, fields, pos) {
  const n = { type, ...fields };
  if (pos !== undefined) n.pos = pos;
  return n;
}

const Nodes = {
  StringLiteral: (value, pos) => node('StringLiteral', { value }, pos),
  NumberLiteral: (value, pos) => node('NumberLiteral', { value }, pos),
  BooleanLiteral: (value, pos) => node('BooleanLiteral', { value }, pos),
  NullLiteral: (pos) => node('NullLiteral', {}, pos),
  RegexLiteral: (pattern, flags, pos) => node('RegexLiteral', { pattern, flags }, pos),

  ContextRef: (pos) => node('ContextRef', {}, pos),
  RootRef: (pos) => node('RootRef', {}, pos),
  VariableRef: (name, pos) => node('VariableRef', { name }, pos),

  FieldRef: (name, pos) => node('FieldRef', { name }, pos),
  WildcardStep: (pos) => node('WildcardStep', {}, pos),
  DescendantStep: (pos) => node('DescendantStep', {}, pos),
  ParentStep: (pos) => node('ParentStep', {}, pos),
  PositionBinding: (varName, pos) => node('PositionBinding', { varName }, pos),
  ContextBinding: (varName, pos) => node('ContextBinding', { varName }, pos),

  ArrayConstructor: (elements, pos) => node('ArrayConstructor', { elements }, pos),
  // KeyValuePair is a plain `{ key, value }` tuple, not a discriminated AST node
  // (mirrors AstNode.KeyValuePair, which does not implement AstNode either).
  KeyValuePair: (key, value) => ({ key, value }),
  ObjectConstructor: (pairs, pos) => node('ObjectConstructor', { pairs }, pos),

  PathExpr: (steps, pos) => node('PathExpr', { steps }, pos),
  PredicateExpr: (source, predicate, pos) => node('PredicateExpr', { source, predicate }, pos),
  ArraySubscript: (source, index, pos) => node('ArraySubscript', { source, index }, pos),

  BinaryOp: (op, left, right, pos) => node('BinaryOp', { op, left, right }, pos),
  UnaryMinus: (operand, pos) => node('UnaryMinus', { operand }, pos),

  FunctionCall: (name, args, pos) => node('FunctionCall', { name, args }, pos),
  Lambda: (params, body, signature, pos) => node('Lambda', { params, body, signature: signature || null }, pos),
  LambdaCall: (lambda, args, pos) => node('LambdaCall', { lambda, args }, pos),

  VariableBinding: (name, value, pos) => node('VariableBinding', { name, value }, pos),

  ConditionalExpr: (condition, then, otherwise, pos) =>
    node('ConditionalExpr', { condition, then, otherwise: otherwise || null }, pos),
  Block: (expressions, pos) => node('Block', { expressions }, pos),

  RangeExpr: (from, to, pos) => node('RangeExpr', { from, to }, pos),
  // SortKey is a plain `{ key, descending }` tuple (mirrors AstNode.SortKey).
  SortKey: (key, descending) => ({ key, descending: !!descending }),
  SortExpr: (source, keys, pos) => node('SortExpr', { source, keys }, pos),
  GroupByExpr: (source, pairs, pos) => node('GroupByExpr', { source, pairs }, pos),

  ChainExpr: (steps, pos) => node('ChainExpr', { steps }, pos),
  TransformExpr: (source, pattern, update, del, pos) =>
    node('TransformExpr', { source, pattern, update, delete: del || null }, pos),
  TransformLambda: (pattern, update, del, pos) =>
    node('TransformLambda', { pattern, update, delete: del || null }, pos),

  Parenthesized: (inner, pos) => node('Parenthesized', { inner }, pos),
  ForceArray: (source, pos) => node('ForceArray', { source }, pos),
  ElvisExpr: (left, right, pos) => node('ElvisExpr', { left, right }, pos),
  CoalesceExpr: (left, right, pos) => node('CoalesceExpr', { left, right }, pos),
  PartialPlaceholder: (pos) => node('PartialPlaceholder', {}, pos),
  PartialApplication: (name, args, pos) => node('PartialApplication', { name, args }, pos),
};

module.exports = Nodes;
