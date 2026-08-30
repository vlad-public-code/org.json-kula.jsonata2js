'use strict';

/**
 * Hand-written tokenizer for the JSONata expression language, ported from
 * JSonata2Java's `Lexer.java` (string/number/keyword scanning, division-vs-
 * regex disambiguation via the previous token's type), with regex-literal
 * scanning replaced by jsonata's own `scanRegex` algorithm (src/parser.js) —
 * bracket/brace/paren-depth-aware, backslash-parity-aware closing-slash
 * detection, forced trailing `g` flag — since that is the exact behavior
 * the vendored official conformance suite exercises.
 */

const { TokenType, KEYWORDS, DIVISION_CONTEXT } = require('./token-types');
const { ParseError } = require('../errors');

function isDigit(c) {
  return c >= '0' && c <= '9';
}
function isIdentStart(c) {
  return /[A-Za-z_]/.test(c) || (c && c.codePointAt(0) > 127 && /\p{L}/u.test(c));
}
function isIdentPart(c) {
  return isIdentStart(c) || isDigit(c);
}

function tok(type, value, position) {
  return { type, value: value === undefined ? '' : value, position };
}

class Lexer {
  constructor(src) {
    this.src = src;
    this.pos = 0;
    this.lastToken = null;
  }

  tokenize() {
    const tokens = [];
    while (this.pos < this.src.length) {
      this.skipWhitespaceAndComments();
      if (this.pos >= this.src.length) break;
      const start = this.pos;
      const c = this.src[this.pos];
      let token;
      switch (c) {
        case '+': this.pos++; token = tok(TokenType.PLUS, '', start); break;
        case '-': this.pos++; token = tok(TokenType.MINUS, '', start); break;
        case '/': token = this.lexSlashOrRegex(start); break;
        case '%': this.pos++; token = tok(TokenType.PERCENT, '', start); break;
        case '&': this.pos++; token = tok(TokenType.AMPERSAND, '', start); break;
        case '?': token = this.lexQuestion(start); break;
        case ',': this.pos++; token = tok(TokenType.COMMA, '', start); break;
        case ';': this.pos++; token = tok(TokenType.SEMICOLON, '', start); break;
        case '(': this.pos++; token = tok(TokenType.LPAREN, '', start); break;
        case ')': this.pos++; token = tok(TokenType.RPAREN, '', start); break;
        case '[': this.pos++; token = tok(TokenType.LBRACKET, '', start); break;
        case ']': this.pos++; token = tok(TokenType.RBRACKET, '', start); break;
        case '{': this.pos++; token = tok(TokenType.LBRACE, '', start); break;
        case '}': this.pos++; token = tok(TokenType.RBRACE, '', start); break;
        case '@': this.pos++; token = tok(TokenType.AT, '', start); break;
        case '^': this.pos++; token = tok(TokenType.CARET, '', start); break;
        case '|': this.pos++; token = tok(TokenType.PIPE, '', start); break;
        case '#': this.pos++; token = tok(TokenType.HASH, '', start); break;
        case '=': this.pos++; token = tok(TokenType.EQUAL, '', start); break;
        case '*': token = this.lexStar(start); break;
        case '.': token = this.lexDot(start); break;
        case ':': token = this.lexColon(start); break;
        case '<': token = this.lexLess(start); break;
        case '>': token = this.lexGreater(start); break;
        case '!': token = this.lexBang(start); break;
        case '~': token = this.lexTilde(start); break;
        case '$': token = this.lexDollar(start); break;
        case '"':
        case "'": token = this.lexString(start); break;
        case '`': token = this.lexBacktickIdentifier(start); break;
        default:
          if (isDigit(c)) token = this.lexNumber(start);
          else if (isIdentStart(c)) token = this.lexIdentifierOrKeyword(start);
          else throw new ParseError('S0205', start, { token: c });
      }
      tokens.push(token);
      this.lastToken = token.type;
    }
    tokens.push(tok(TokenType.EOF, '', this.pos));
    return tokens;
  }

  lexQuestion(start) {
    this.pos++;
    if (this.src[this.pos] === ':') { this.pos++; return tok(TokenType.QUESTION_COLON, '', start); }
    if (this.src[this.pos] === '?') { this.pos++; return tok(TokenType.QUESTION_QUESTION, '', start); }
    return tok(TokenType.QUESTION, '', start);
  }

  lexStar(start) {
    this.pos++;
    if (this.src[this.pos] === '*') { this.pos++; return tok(TokenType.STAR_STAR, '', start); }
    return tok(TokenType.STAR, '', start);
  }

  lexDot(start) {
    this.pos++;
    if (this.src[this.pos] === '.') { this.pos++; return tok(TokenType.DOT_DOT, '', start); }
    return tok(TokenType.DOT, '', start);
  }

  lexColon(start) {
    this.pos++;
    if (this.src[this.pos] === '=') { this.pos++; return tok(TokenType.COLON_ASSIGN, '', start); }
    return tok(TokenType.COLON, '', start);
  }

  lexLess(start) {
    this.pos++;
    if (this.src[this.pos] === '=') { this.pos++; return tok(TokenType.LESS_EQUAL, '', start); }
    return tok(TokenType.LESS, '', start);
  }

  lexGreater(start) {
    this.pos++;
    if (this.src[this.pos] === '=') { this.pos++; return tok(TokenType.GREATER_EQUAL, '', start); }
    return tok(TokenType.GREATER, '', start);
  }

  lexBang(start) {
    this.pos++;
    if (this.src[this.pos] === '=') { this.pos++; return tok(TokenType.NOT_EQUAL, '', start); }
    throw new ParseError('S0204', start, { token: '!' });
  }

  lexTilde(start) {
    this.pos++;
    if (this.src[this.pos] === '>') { this.pos++; return tok(TokenType.TILDE_GT, '', start); }
    throw new ParseError('S0204', start, { token: '~' });
  }

  lexDollar(start) {
    this.pos++;
    if (this.src[this.pos] === '$') { this.pos++; return tok(TokenType.DOLLAR_DOLLAR, '', start); }
    const nameStart = this.pos;
    while (this.pos < this.src.length && isIdentPart(this.src[this.pos])) this.pos++;
    const name = this.src.slice(nameStart, this.pos);
    if (name === '') return tok(TokenType.DOLLAR, '', start);
    return tok(TokenType.VARIABLE, name, start);
  }

  // -- Slash: division or regex literal --------------------------------------

  lexSlashOrRegex(start) {
    if (this.lastToken !== null && DIVISION_CONTEXT.has(this.lastToken)) {
      this.pos++;
      return tok(TokenType.SLASH, '', start);
    }
    return this.lexRegex(start);
  }

  /**
   * Ports jsonata's `scanRegex` (src/parser.js): scans to the first `/` at
   * bracket depth 0 with an even number of preceding backslashes, tracking
   * depth across `(`/`[`/`{` and their closers (an escaped bracket, i.e.
   * immediately preceded by `\`, never changes depth). S0301 on an empty
   * pattern, S0302 if no terminating `/` is found. Flags: `i`/`m` only, a
   * forced trailing `g` is added when the pattern/flags are compiled to a
   * RegExp (see `runtime/function-value.js#compileRegexLiteral`) — here we
   * just capture the raw flags text.
   */
  lexRegex(start) {
    this.pos++; // consume opening '/'
    const patternStart = this.pos;
    let depth = 0;
    const isClosingSlash = (i) => {
      if (this.src[i] !== '/' || depth !== 0) return false;
      let backslashes = 0;
      while (this.src[i - (backslashes + 1)] === '\\') backslashes++;
      return backslashes % 2 === 0;
    };
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (isClosingSlash(this.pos)) {
        const pattern = this.src.slice(patternStart, this.pos);
        if (pattern === '') throw new ParseError('S0301', start);
        this.pos++; // consume closing '/'
        const flagsStart = this.pos;
        while (this.src[this.pos] === 'i' || this.src[this.pos] === 'm') this.pos++;
        const flags = this.src.slice(flagsStart, this.pos);
        return tok(TokenType.REGEX, pattern + '/' + flags, start);
      }
      if ((c === '(' || c === '[' || c === '{') && this.src[this.pos - 1] !== '\\') depth++;
      if ((c === ')' || c === ']' || c === '}') && this.src[this.pos - 1] !== '\\') depth--;
      this.pos++;
    }
    throw new ParseError('S0302', start);
  }

  // -- String literals --------------------------------------------------------

  lexString(start) {
    const quote = this.src[this.pos];
    this.pos++;
    let sb = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === quote) {
        this.pos++;
        return tok(TokenType.STRING, sb, start);
      }
      if (c === '\\') {
        this.pos++;
        if (this.pos >= this.src.length) throw new ParseError('S0101', start);
        const esc = this.src[this.pos++];
        switch (esc) {
          case '"': sb += '"'; break;
          case "'": sb += "'"; break;
          case '\\': sb += '\\'; break;
          case '/': sb += '/'; break;
          case 'b': sb += '\b'; break;
          case 'f': sb += '\f'; break;
          case 'n': sb += '\n'; break;
          case 'r': sb += '\r'; break;
          case 't': sb += '\t'; break;
          case 'u': sb += this.readUnicodeEscape(this.pos - 2); break;
          default: throw new ParseError('S0103', this.pos - 2, { token: esc });
        }
      } else {
        sb += c;
        this.pos++;
      }
    }
    // Deferred: let the parser report a higher-level error if one triggers first.
    return tok(TokenType.ERROR, 'S0101', start);
  }

  readUnicodeEscape(errorPos) {
    if (this.pos + 4 > this.src.length) throw new ParseError('S0104', errorPos);
    const hex = this.src.slice(this.pos, this.pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ParseError('S0104', errorPos);
    this.pos += 4;
    return String.fromCharCode(parseInt(hex, 16));
  }

  // -- Backtick identifiers -----------------------------------------------------

  lexBacktickIdentifier(start) {
    this.pos++;
    const nameStart = this.pos;
    while (this.pos < this.src.length && this.src[this.pos] !== '`') this.pos++;
    if (this.pos >= this.src.length) throw new ParseError('S0105', start);
    const name = this.src.slice(nameStart, this.pos);
    this.pos++;
    return tok(TokenType.IDENTIFIER, name, start);
  }

  // -- Numbers ------------------------------------------------------------------

  lexNumber(start) {
    const begin = this.pos;
    while (this.pos < this.src.length && isDigit(this.src[this.pos])) this.pos++;
    if (this.src[this.pos] === '.' && isDigit(this.src[this.pos + 1])) {
      this.pos++;
      while (this.pos < this.src.length && isDigit(this.src[this.pos])) this.pos++;
    }
    if (this.src[this.pos] === 'e' || this.src[this.pos] === 'E') {
      this.pos++;
      if (this.src[this.pos] === '+' || this.src[this.pos] === '-') this.pos++;
      if (!isDigit(this.src[this.pos])) throw new ParseError('S0102', start, { token: this.src.slice(begin, this.pos) });
      while (this.pos < this.src.length && isDigit(this.src[this.pos])) this.pos++;
    }
    const numStr = this.src.slice(begin, this.pos);
    if (isIdentStart(this.src[this.pos] || '')) {
      throw new ParseError('S0201', start, { token: numStr + this.src[this.pos] });
    }
    const val = Number(numStr);
    if (!Number.isFinite(val)) throw new ParseError('S0102', start, { token: numStr });
    return tok(TokenType.NUMBER, numStr, start);
  }

  // -- Identifiers and keywords ---------------------------------------------------

  lexIdentifierOrKeyword(start) {
    const begin = this.pos;
    while (this.pos < this.src.length && isIdentPart(this.src[this.pos])) this.pos++;
    const text = this.src.slice(begin, this.pos);
    const kw = KEYWORDS[text];
    if (kw && Object.prototype.hasOwnProperty.call(KEYWORDS, text)) return tok(kw, text, start);
    return tok(TokenType.IDENTIFIER, text, start);
  }

  // -- Whitespace and comments -----------------------------------------------------

  skipWhitespaceAndComments() {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (/\s/.test(c)) {
        this.pos++;
      } else if (c === '/' && this.src[this.pos + 1] === '*') {
        this.skipBlockComment();
      } else {
        break;
      }
    }
  }

  skipBlockComment() {
    const start = this.pos;
    this.pos += 2;
    while (this.pos + 1 < this.src.length) {
      if (this.src[this.pos] === '*' && this.src[this.pos + 1] === '/') {
        this.pos += 2;
        return;
      }
      this.pos++;
    }
    throw new ParseError('S0106', start);
  }
}

/** Tokenizes `source` and returns all tokens including a terminal EOF token. */
function tokenize(source) {
  return new Lexer(source).tokenize();
}

module.exports = { tokenize, Lexer };
