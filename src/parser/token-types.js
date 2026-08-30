'use strict';

/**
 * Lexical token type tags for the JSONata expression language, ported from
 * JSonata2Java's `TokenType` enum (parser/lexer/TokenType.java).
 */
const TokenType = Object.freeze({
  // Literals
  STRING: 'STRING',
  NUMBER: 'NUMBER',
  TRUE: 'TRUE',
  FALSE: 'FALSE',
  NULL: 'NULL',
  REGEX: 'REGEX',

  // References
  DOLLAR: 'DOLLAR',
  DOLLAR_DOLLAR: 'DOLLAR_DOLLAR',
  VARIABLE: 'VARIABLE',

  // Identifiers
  IDENTIFIER: 'IDENTIFIER',

  // Arithmetic operators
  PLUS: 'PLUS',
  MINUS: 'MINUS',
  STAR: 'STAR',
  SLASH: 'SLASH',
  PERCENT: 'PERCENT',

  // String concatenation
  AMPERSAND: 'AMPERSAND',

  // Comparison operators
  EQUAL: 'EQUAL',
  NOT_EQUAL: 'NOT_EQUAL',
  LESS: 'LESS',
  LESS_EQUAL: 'LESS_EQUAL',
  GREATER: 'GREATER',
  GREATER_EQUAL: 'GREATER_EQUAL',

  // Boolean keywords
  AND: 'AND',
  OR: 'OR',
  IN: 'IN',
  NOT: 'NOT',

  // Conditional / binding
  QUESTION: 'QUESTION',
  QUESTION_COLON: 'QUESTION_COLON',
  QUESTION_QUESTION: 'QUESTION_QUESTION',
  COLON: 'COLON',
  COLON_ASSIGN: 'COLON_ASSIGN',

  // Path / step operators
  DOT: 'DOT',
  DOT_DOT: 'DOT_DOT',
  STAR_STAR: 'STAR_STAR',

  // Chain / transform
  TILDE_GT: 'TILDE_GT',

  // Other operators
  PIPE: 'PIPE',
  CARET: 'CARET',
  AT: 'AT',
  HASH: 'HASH',

  // Delimiters
  LPAREN: 'LPAREN',
  RPAREN: 'RPAREN',
  LBRACKET: 'LBRACKET',
  RBRACKET: 'RBRACKET',
  LBRACE: 'LBRACE',
  RBRACE: 'RBRACE',
  COMMA: 'COMMA',
  SEMICOLON: 'SEMICOLON',

  // End of input
  EOF: 'EOF',

  // Deferred lexer error — value holds "CODE: message", position holds the error site.
  ERROR: 'ERROR',
});

const KEYWORDS = Object.freeze({
  true: TokenType.TRUE,
  false: TokenType.FALSE,
  null: TokenType.NULL,
  and: TokenType.AND,
  or: TokenType.OR,
  in: TokenType.IN,
  not: TokenType.NOT,
});

/** Token types after which `/` means division rather than starting a regex literal. */
const DIVISION_CONTEXT = new Set([
  TokenType.NUMBER,
  TokenType.STRING,
  TokenType.TRUE,
  TokenType.FALSE,
  TokenType.NULL,
  TokenType.RPAREN,
  TokenType.RBRACKET,
  TokenType.RBRACE,
  TokenType.VARIABLE,
  TokenType.DOLLAR,
  TokenType.DOLLAR_DOLLAR,
  TokenType.IDENTIFIER,
]);

module.exports = { TokenType, KEYWORDS, DIVISION_CONTEXT };
