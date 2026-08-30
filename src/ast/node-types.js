'use strict';

/**
 * Every AST node "type" tag jsonata2js's parser can produce, ported 1:1 from
 * JSonata2Java's `AstNode` sealed interface (parser/ast/AstNode.java).
 *
 * jsonata2js represents AST nodes as plain tagged objects (`{ type, ... }`)
 * instead of Java sealed records; NODE_TYPES documents the full set so the
 * optimizer/translator's `visit` dispatcher can enforce exhaustiveness.
 */
const NODE_TYPES = Object.freeze([
  // Literals
  'StringLiteral',
  'NumberLiteral',
  'BooleanLiteral',
  'NullLiteral',
  'RegexLiteral',

  // References
  'ContextRef',
  'RootRef',
  'VariableRef',

  // Path steps
  'FieldRef',
  'WildcardStep',
  'DescendantStep',
  'ParentStep',
  'PositionBinding',
  'ContextBinding',

  // Constructors
  'ArrayConstructor',
  'ObjectConstructor',

  // Path expressions
  'PathExpr',
  'PredicateExpr',
  'ArraySubscript',

  // Operators
  'BinaryOp',
  'UnaryMinus',

  // Functions and lambdas
  'FunctionCall',
  'Lambda',
  'LambdaCall',

  // Variable binding
  'VariableBinding',

  // Control flow
  'ConditionalExpr',
  'Block',

  // Range, sort, group-by
  'RangeExpr',
  'SortExpr',
  'GroupByExpr',

  // Chaining and transform
  'ChainExpr',
  'TransformExpr',
  'TransformLambda',

  // Postfix / misc operators
  'Parenthesized',
  'ForceArray',
  'ElvisExpr',
  'CoalesceExpr',
  'PartialPlaceholder',
  'PartialApplication',
]);

const NODE_TYPE_SET = new Set(NODE_TYPES);

module.exports = { NODE_TYPES, NODE_TYPE_SET };
