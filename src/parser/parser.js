'use strict';

/**
 * Recursive-descent parser for the JSONata expression language, ported from
 * JSonata2Java's `Parser.java`.
 *
 * Operator precedence (low -> high):
 *   1. `:=`                              variable binding
 *   2. `?:`                              conditional (ternary) / elvis / `??`
 *   3. `or`
 *   4. `and`
 *   5. `in`
 *   6. `= != < <= > >=  ~>`              comparison / function chaining (same level, left-associative - matches jsonata's own `operators` binding-power table, where `~>` and the comparison operators are both bp 40)
 *   7. `&`                               string concatenation
 *   8. `+ -`
 *   9. `* / %`
 *   10. unary `-` and `not`
 *   11. postfix: `.` `[pred]` `^(...)` `{k:v}` `|...|` call
 */

const { tokenize } = require('./lexer');
const { TokenType: T } = require('./token-types');
const N = require('../ast/nodes');
const { ParseError } = require('../errors');

const COMPARISON_OPS = {
  [T.EQUAL]: '=', [T.NOT_EQUAL]: '!=', [T.LESS]: '<',
  [T.LESS_EQUAL]: '<=', [T.GREATER]: '>', [T.GREATER_EQUAL]: '>=',
};

const TOKEN_TEXT = {
  [T.PLUS]: '+', [T.MINUS]: '-', [T.STAR]: '*', [T.SLASH]: '/', [T.PERCENT]: '%',
  [T.AMPERSAND]: '&', [T.EQUAL]: '=', [T.NOT_EQUAL]: '!=', [T.LESS]: '<',
  [T.LESS_EQUAL]: '<=', [T.GREATER]: '>', [T.GREATER_EQUAL]: '>=',
  [T.QUESTION]: '?', [T.QUESTION_COLON]: '?:', [T.QUESTION_QUESTION]: '??',
  [T.COLON]: ':', [T.COLON_ASSIGN]: ':=', [T.DOT]: '.', [T.DOT_DOT]: '..',
  [T.STAR_STAR]: '**', [T.TILDE_GT]: '~>', [T.PIPE]: '|', [T.CARET]: '^',
  [T.AT]: '@', [T.HASH]: '#', [T.LPAREN]: '(', [T.RPAREN]: ')',
  [T.LBRACKET]: '[', [T.RBRACKET]: ']', [T.LBRACE]: '{', [T.RBRACE]: '}',
  [T.COMMA]: ',', [T.SEMICOLON]: ';', [T.DOLLAR]: '$', [T.DOLLAR_DOLLAR]: '$$',
  [T.EOF]: 'end of expression',
};

/** Best-effort human-readable text for a token, for error-message `{{token}}` substitution. */
function tokenText(t) {
  if (t.value) return t.value;
  return TOKEN_TEXT[t.type] || t.type;
}

class Parser {
  constructor(tokens, source) {
    this.tokens = tokens;
    this.source = source;
    this.cursor = 0;
    this.transformPatternDepth = 0;
    this.lambdaTempCounter = 0;
  }

  static parse(expression) {
    const tokens = tokenize(expression);
    const parser = new Parser(tokens, expression);
    const result = parser.parseExpression();
    if (parser.peek().type !== T.EOF) {
      const t = parser.peek();
      if (t.type === T.COLON_ASSIGN) throw new ParseError('S0212', t.position);
      if (t.type === T.SEMICOLON) throw new ParseError('S0201', t.position, { token: ';' });
      if (t.type === T.LPAREN) {
        const inner = parser.peekAt(1);
        if (inner.type === T.QUESTION) throw new ParseError('T1008', t.position);
        throw new ParseError('T1006', t.position);
      }
      throw new ParseError('S0211', t.position, { token: tokenText(t) });
    }
    return result;
  }

  // ===== Precedence levels =====

  parseExpression() {
    return this.parseBinding();
  }

  parseBinding() {
    if (this.peek().type === T.VARIABLE && this.peekAt(1).type === T.COLON_ASSIGN) {
      const name = this.consume(T.VARIABLE).value;
      this.consume(T.COLON_ASSIGN);
      const value = this.parseBinding(); // right-associative
      return N.VariableBinding(name, value);
    }
    const lhs = this.parseConditional();
    if (this.peek().type === T.COLON_ASSIGN) {
      throw new ParseError('S0212', this.peek().position);
    }
    return lhs;
  }

  parseConditional() {
    const left = this.parseOr();
    if (this.peek().type === T.QUESTION) {
      this.consume(T.QUESTION);
      const then = this.parseConditional();
      let otherwise = null;
      if (this.peek().type === T.COLON) {
        this.consume(T.COLON);
        otherwise = this.parseConditional();
      }
      return N.ConditionalExpr(left, then, otherwise);
    }
    if (this.peek().type === T.QUESTION_COLON) {
      this.consume(T.QUESTION_COLON);
      return N.ElvisExpr(left, this.parseConditional());
    }
    if (this.peek().type === T.QUESTION_QUESTION) {
      this.consume(T.QUESTION_QUESTION);
      return N.CoalesceExpr(left, this.parseConditional());
    }
    return left;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.peek().type === T.OR) {
      this.consume(T.OR);
      left = N.BinaryOp('or', left, this.parseAnd());
    }
    return left;
  }

  parseAnd() {
    let left = this.parseIn();
    while (this.peek().type === T.AND) {
      this.consume(T.AND);
      left = N.BinaryOp('and', left, this.parseIn());
    }
    return left;
  }

  parseIn() {
    let left = this.parseComparison();
    while (this.peek().type === T.IN) {
      this.consume(T.IN);
      left = N.BinaryOp('in', left, this.parseComparison());
    }
    return left;
  }

  // `~>` (function chaining) is folded into this same loop, at the same
  // binding power as the comparison operators, matching jsonata's own
  // `operators` table (both bp 40) - NOT a separate looser-or-tighter
  // level. A run of consecutive `~>` collects into one flat `ChainExpr`
  // (mirroring the old dedicated `parseChain` level this replaces); a
  // `~>` immediately following an already-built `ChainExpr` (from an
  // earlier iteration of this same loop) extends it rather than nesting.
  parseComparison() {
    let left = this.parseConcat();
    for (;;) {
      const type = this.peek().type;
      if (Object.prototype.hasOwnProperty.call(COMPARISON_OPS, type)) {
        const op = COMPARISON_OPS[type];
        this.cursor++;
        left = N.BinaryOp(op, left, this.parseConcat());
      } else if (type === T.TILDE_GT) {
        const steps = left.type === 'ChainExpr' ? left.steps.slice() : [left];
        while (this.peek().type === T.TILDE_GT) {
          this.consume(T.TILDE_GT);
          steps.push(this.parseConcat());
        }
        left = N.ChainExpr(steps);
      } else {
        break;
      }
    }
    return left;
  }

  parseConcat() {
    let left = this.parseAddSub();
    while (this.peek().type === T.AMPERSAND) {
      this.consume(T.AMPERSAND);
      left = N.BinaryOp('&', left, this.parseAddSub());
    }
    return left;
  }

  parseAddSub() {
    let left = this.parseMulDiv();
    while (this.peek().type === T.PLUS || this.peek().type === T.MINUS) {
      const op = this.peek().type === T.PLUS ? '+' : '-';
      this.cursor++;
      left = N.BinaryOp(op, left, this.parseMulDiv());
    }
    return left;
  }

  parseMulDiv() {
    let left = this.parseUnary();
    while (this.peek().type === T.STAR || this.peek().type === T.SLASH || this.peek().type === T.PERCENT) {
      const op = this.peek().type === T.STAR ? '*' : this.peek().type === T.SLASH ? '/' : '%';
      this.cursor++;
      left = N.BinaryOp(op, left, this.parseUnary());
    }
    return left;
  }

  parseUnary() {
    if (this.peek().type === T.MINUS) {
      this.consume(T.MINUS);
      if (this.peek().type === T.NUMBER) {
        const v = this.parseDouble(this.peek().value, this.peek().position);
        this.cursor++;
        // Continue through the normal postfix chain (`-2[0]`, `-2.foo`,
        // `-2()`, ...) instead of returning the bare literal directly -
        // jsonata's own `prefix('-')` parses its operand at bp 70, which
        // still admits every postfix `led` (bp 75-80), so a trailing
        // postfix token binds to the (already-negated) literal here
        // exactly as it would to any other unary-minus operand (see the
        // `N.UnaryMinus(this.parseUnary())` branch below, which already
        // gets this for free via its own recursive `parseUnary` call
        // bottoming out at `parsePostfix`) - see CODE-REVIEW.md H4.
        return this.parsePostfix(N.NumberLiteral(-v));
      }
      return N.UnaryMinus(this.parseUnary());
    }
    if (this.peek().type === T.NOT) {
      this.consume(T.NOT);
      this.consume(T.LPAREN);
      const arg = this.parseExpression();
      this.consume(T.RPAREN);
      return N.FunctionCall('not', [arg]);
    }
    return this.parsePostfix();
  }

  parsePostfix(startNode) {
    let node = startNode !== undefined ? startNode : this.parsePrimary();
    // `[]` (empty brackets) is jsonata's "keep singleton array" marker: it
    // can appear anywhere in a path chain (`foo[].bar`, `foo[cond][].bar`,
    // `foo[][cond].bar`), but its effect is always the *same* - the whole
    // containing path's final result stays a 1-element array instead of
    // collapsing to a scalar - so it's collected here (never applied
    // in-place) and wrapped around the *finished* path once, at the end.
    let forceArray = false;
    let keepArrayOnHead = false;
    for (;;) {
      const type = this.peek().type;
      if (type === T.DOT) {
        node = this.parseDotStep(node);
      } else if (type === T.AT && this.peekAt(1).type === T.VARIABLE) {
        if (this.endsWithPredicateOrSubscript(node)) throw new ParseError('S0215', this.peek().position);
        if (node.type === 'SortExpr') throw new ParseError('S0216', this.peek().position);
        const varName = this.peekAt(1).value;
        this.cursor += 2;
        node = this.appendToPath(node, N.ContextBinding(varName));
      } else if (type === T.AT) {
        throw new ParseError('S0214', this.peek().position, { token: '@' });
      } else if (type === T.HASH && this.peekAt(1).type === T.VARIABLE) {
        const varName = this.peekAt(1).value;
        this.cursor += 2;
        node = this.appendToPath(node, N.PositionBinding(varName));
      } else if (type === T.HASH) {
        throw new ParseError('S0214', this.peek().position, { token: '#' });
      } else if (type === T.LBRACKET && this.peekAt(1).type === T.RBRACKET) {
        this.cursor += 2;
        forceArray = true;
        // jsonata's `keepArray` lands on the step the `[]` was written after.
        // Every step but a consarray path HEAD is evaluated per element, where
        // the flag is a no-op, so the only thing worth remembering is whether
        // it landed on the head: `[1,2][0][].$` is `[1]`, `[1,2][0].$[]` is
        // undefined. Nothing has been appended to a path yet iff `node` is not
        // already a `PathExpr`.
        keepArrayOnHead = node.type !== 'PathExpr';
      } else if (type === T.LBRACKET) {
        node = this.parseSubscriptOrPredicate(node);
      } else if (type === T.CARET) {
        // `^(...)` wraps its source in a path of its own, and only the `.`
        // production promotes a step's `keepArray` to that path - so a `[]`
        // written BEFORE the sort rides through it when what carries it is
        // itself path-shaped, and is dropped otherwise. Measured: `a.b[]^($)`
        // and `nums[0][]^($)` keep their array, while `1[]^($)`,
        // `$map(one,f)[]^($)`, `[1][]^($)` and `(a.b)[0][]^($)` all collapse.
        // `1^($)[]` is the other direction - a sort's own result IS a
        // sequence, so a `[]` on the sort node fires and gives `[1]`.
        if (forceArray && !isPathNode(node)) forceArray = false;
        node = this.parseSortExpr(node);
      } else if (type === T.LBRACE) {
        node = this.parseGroupBy(node);
      } else if (type === T.PIPE && this.transformPatternDepth === 0) {
        node = this.parseTransform(node);
      } else if (type === T.LPAREN) {
        node = this.desugarCallExpr(node);
      } else {
        break;
      }
    }
    if (!forceArray) return node;
    const fa = N.ForceArray(node);
    fa.keepArrayOnHead = keepArrayOnHead;
    // Whether `[]` does anything at all is decided on the SYNTACTIC shape, so
    // it has to be recorded here: the optimizer strips the `Parenthesized`
    // wrapper that distinguishes `(a.b)[]` (jsonata: `1`) from `a.b[]`
    // (jsonata: `[1]`).
    fa.sourceIsSequence = producesSequence(node);
    return fa;
  }

  endsWithPredicateOrSubscript(node) {
    let last = node;
    if (node.type === 'PathExpr' && node.steps.length > 0) last = node.steps[node.steps.length - 1];
    return last.type === 'PredicateExpr' || last.type === 'ArraySubscript';
  }

  appendToPath(node, step) {
    const steps = node.type === 'PathExpr' ? node.steps.slice() : [node];
    steps.push(step);
    return newPath(steps);
  }

  // ===== Postfix helpers =====

  parseDotStep(left) {
    // `X{...}.step` continues the PATH and leaves the group-by hanging off the
    // whole of it (`objs{"k":x}[0].k` groups `objs[0].k`, giving `{}`), for the
    // same reason a predicate folds in - see `isPathNode`. A *dotted*
    // (`foo.{...}`) group-by is a per-element step, not a path-level group, so
    // it is left alone.
    if (left.type === 'GroupByExpr' && !left.dotted && isPathNode(left.source)) {
      return regroup(left, this.parseDotStep(left.source));
    }
    left = asPathHead(left);
    this.consume(T.DOT);
    let right;
    if (this.peek().type === T.PERCENT) {
      this.cursor++;
      right = N.ParentStep();
    } else if (this.peek().type === T.STRING) {
      const t = this.consume(T.STRING);
      right = N.FieldRef(t.value);
    } else if (this.peek().type === T.NUMBER) {
      throw new ParseError('S0213', this.peek().position, { value: this.peek().value });
    } else if (this.peek().type === T.LBRACE) {
      // `.{...}` continuing a path is a *per-element* group-by (jsonata's
      // `{` NUD production, reached because `.`'s RHS parses a fresh
      // expression rather than `{`'s infix/aggregate production): each
      // element gets its own `{pairs}` object independently - contrast
      // `foo{...}` (no dot, `parsePostfix`'s own LBRACE branch), which
      // aggregates across the *whole* preceding sequence at once.
      right = N.GroupByExpr(N.ContextRef(), this.parseObjectBody());
      right.dotted = true;
    } else {
      right = this.parsePrimary();
    }
    const steps = left.type === 'PathExpr' ? left.steps.slice() : [left];
    // A quoted string heading a path denotes the FIELD of that name. When a
    // binding built the path first (`"z"@$e.$`) the head has not been through
    // `asPathHead` yet, and only the dot makes it a path.
    if (steps.length > 0) steps[0] = asPathHead(steps[0]);
    steps.push(right);
    return newPath(steps, undefined, true);
  }

  parseSubscriptOrPredicate(source) {
    if (source.type === 'GroupByExpr') {
      // `X{...}[p]` filters X and groups the result, because jsonata hangs the
      // group off the whole path - see `isPathNode`. Only a group-by over a
      // non-path is S0209.
      if (!isPathNode(source.source)) throw new ParseError('S0209', this.peek().position);
      return regroup(source, this.parseSubscriptOrPredicate(source.source));
    }
    this.consume(T.LBRACKET);
    const inner = this.parseExpression();
    if (this.peek().type === T.DOT_DOT) {
      this.consume(T.DOT_DOT);
      const to = this.parseExpression();
      this.consume(T.RBRACKET);
      return N.PredicateExpr(source, N.RangeExpr(inner, to));
    }
    this.consume(T.RBRACKET);
    if (inner.type === 'NumberLiteral') {
      if (source.type === 'PathExpr') {
        const steps = source.steps.slice();
        const lastStep = steps.pop();
        steps.push(N.ArraySubscript(lastStep, inner));
        return newPath(steps);
      }
      if (source.type === 'PredicateExpr' && source.source.type === 'PathExpr') {
        const steps = source.source.steps.slice();
        const lastStep = steps.pop();
        steps.push(N.ArraySubscript(N.PredicateExpr(lastStep, source.predicate), inner));
        return newPath(steps);
      }
      return N.ArraySubscript(source, inner);
    }
    if (source.type === 'PathExpr') {
      const lastStep = source.steps[source.steps.length - 1];
      if (lastStep.type === 'PositionBinding' || lastStep.type === 'ContextBinding') {
        const steps = source.steps.slice();
        steps.push(N.PredicateExpr(N.ContextRef(), inner));
        return newPath(steps);
      }
    }
    return N.PredicateExpr(source, inner);
  }

  parseSortExpr(source) {
    // `X{...}^(k)` sorts X and groups the result, for the same reason a
    // predicate does (see `parseSubscriptOrPredicate`).
    if (source.type === 'GroupByExpr' && isPathNode(source.source)) {
      return regroup(source, this.parseSortExpr(source.source));
    }
    this.consume(T.CARET);
    this.consume(T.LPAREN);
    const keys = [];
    do {
      let descending = false;
      if (this.peek().type === T.LESS) { this.consume(T.LESS); descending = false; }
      else if (this.peek().type === T.GREATER) { this.consume(T.GREATER); descending = true; }
      keys.push(N.SortKey(this.parseExpression(), descending));
    } while (this.tryConsume(T.COMMA));
    this.consume(T.RPAREN);
    return N.SortExpr(source, keys);
  }

  parseGroupBy(source) {
    if (source.type === 'GroupByExpr') throw new ParseError('S0210', this.peek().position);
    const pairs = this.parseObjectBody();
    return N.GroupByExpr(source, pairs);
  }

  parseTransform(source) {
    this.consume(T.PIPE);
    this.transformPatternDepth++;
    const pattern = this.parseExpression();
    this.consume(T.PIPE);
    const update = this.parseExpression();
    let del = null;
    if (this.tryConsume(T.COMMA)) del = this.parseExpression();
    this.transformPatternDepth--;
    this.consume(T.PIPE);
    return N.TransformExpr(source, pattern, update, del);
  }

  parseTransformLambda() {
    this.consume(T.PIPE);
    this.transformPatternDepth++;
    const pattern = this.parseExpression();
    this.consume(T.PIPE);
    const update = this.parseExpression();
    let del = null;
    if (this.tryConsume(T.COMMA)) del = this.parseExpression();
    this.transformPatternDepth--;
    this.consume(T.PIPE);
    return N.TransformLambda(pattern, update, del);
  }

  // ===== Primary expressions =====

  parsePrimary() {
    const t = this.peek();
    switch (t.type) {
      case T.STRING: this.cursor++; return N.StringLiteral(t.value);
      case T.NUMBER: this.cursor++; return N.NumberLiteral(this.parseDouble(t.value, t.position));
      case T.TRUE: this.cursor++; return N.BooleanLiteral(true);
      case T.FALSE: this.cursor++; return N.BooleanLiteral(false);
      case T.NULL: this.cursor++; return N.NullLiteral();
      case T.REGEX: {
        this.cursor++;
        const sep = t.value.lastIndexOf('/');
        return N.RegexLiteral(t.value.slice(0, sep), t.value.slice(sep + 1));
      }
      case T.DOLLAR_DOLLAR: this.cursor++; return N.RootRef();
      case T.DOLLAR: this.cursor++; return N.ContextRef();
      case T.VARIABLE: return this.parseVariableOrFunctionCall();
      case T.IDENTIFIER: return this.parseIdentifierOrFunctionCall();
      case T.AND: this.cursor++; return N.FieldRef(t.value);
      case T.OR: this.cursor++; return N.FieldRef(t.value);
      case T.IN: this.cursor++; return N.FieldRef(t.value);
      case T.STAR: this.cursor++; return N.WildcardStep();
      case T.STAR_STAR: this.cursor++; return N.DescendantStep();
      case T.PERCENT: this.cursor++; return N.ParentStep();
      case T.LPAREN: return this.parseParenthesised();
      case T.LBRACKET: return this.parseArrayConstructor();
      case T.LBRACE: return N.ObjectConstructor(this.parseObjectBody());
      case T.PIPE: return this.parseTransformLambda();
      case T.QUESTION: {
        this.cursor++;
        if (this.peek().type === T.LPAREN) {
          const lambda = this.parseLambda();
          if (this.peek().type === T.LPAREN) return this.desugarImmediateLambdaCall(lambda);
          return lambda;
        }
        return N.PartialPlaceholder();
      }
      case T.MINUS: return this.parseUnary();
      case T.NOT: return this.parseUnary();
      case T.EOF: throw new ParseError('S0207', t.position);
      case T.ERROR: throw new ParseError(t.value, t.position);
      default: throw new ParseError('S0211', t.position, { token: tokenText(t) });
    }
  }

  parseVariableOrFunctionCall() {
    const t = this.consume(T.VARIABLE);
    if (this.peek().type === T.LPAREN) return this.parseFunctionArgs(t.value, t.position);
    return N.VariableRef(t.value);
  }

  parseIdentifierOrFunctionCall() {
    const t = this.consume(T.IDENTIFIER);
    if ((t.value === 'function' || t.value === '\u03bb') && this.peek().type === T.LPAREN) {
      const lambda = this.parseLambda();
      if (this.peek().type === T.LPAREN) return this.desugarImmediateLambdaCall(lambda);
      return lambda;
    }
    if (this.peek().type === T.LPAREN) {
      // A bare (non-`$`-prefixed) identifier used as a callee - `name(args)`
      // - is jsonata's own "call the field named `name` looked up against
      // the current context" convention, not a builtin/lexical dispatch
      // (that is exclusively what `$name(args)` means); `.bare` tells the
      // translator to compile it that way. Whether the resolved callee
      // turns out non-callable (T1005/T1006/T1007/T1008, with a "did you
      // mean $name?" hint when `name` matches a known builtin) can only be
      // known once `$` is available, so that check is a *runtime* one -
      // see `lambda.js#callBareFunctionValue`.
      const call = this.parseFunctionArgs(t.value, t.position);
      call.bare = true;
      return call;
    }
    return N.FieldRef(t.value);
  }

  parseFunctionArgs(name, pos) {
    this.consume(T.LPAREN);
    const args = [];
    if (this.peek().type !== T.RPAREN) {
      do { args.push(this.parseExpression()); } while (this.tryConsume(T.COMMA));
    }
    this.consume(T.RPAREN);
    if (args.some((a) => a.type === 'PartialPlaceholder')) return N.PartialApplication(name, args);
    return N.FunctionCall(name, args, pos);
  }

  parseParenthesised() {
    this.consume(T.LPAREN);
    if (this.peek().type === T.RPAREN) {
      this.consume(T.RPAREN);
      return N.Block([]);
    }
    const exprs = [this.parseExpression()];
    while (this.peek().type === T.SEMICOLON) {
      this.consume(T.SEMICOLON);
      if (this.peek().type === T.RPAREN) break;
      exprs.push(this.parseExpression());
    }
    this.consume(T.RPAREN);
    const inner = exprs.length === 1 ? exprs[0] : N.Block(exprs);
    return N.Parenthesized(inner);
  }

  parseArrayConstructor() {
    this.consume(T.LBRACKET);
    const elements = [];
    if (this.peek().type !== T.RBRACKET) {
      const first = this.parseExpression();
      if (this.peek().type === T.DOT_DOT) {
        this.consume(T.DOT_DOT);
        elements.push(N.RangeExpr(first, this.parseExpression()));
      } else {
        elements.push(first);
      }
      while (this.tryConsume(T.COMMA)) {
        const elem = this.parseExpression();
        if (this.peek().type === T.DOT_DOT) {
          this.consume(T.DOT_DOT);
          elements.push(N.RangeExpr(elem, this.parseExpression()));
        } else {
          elements.push(elem);
        }
      }
    }
    this.consume(T.RBRACKET);
    return N.ArrayConstructor(elements);
  }

  parseObjectBody() {
    this.consume(T.LBRACE);
    const pairs = [];
    if (this.peek().type !== T.RBRACE) {
      do {
        const key = this.parseExpression();
        this.consume(T.COLON);
        const value = this.parseExpression();
        pairs.push(N.KeyValuePair(key, value));
      } while (this.tryConsume(T.COMMA));
    }
    this.consume(T.RBRACE);
    return pairs;
  }

  parseLambda() {
    this.consume(T.LPAREN);
    const params = [];
    if (this.peek().type !== T.RPAREN) {
      do {
        const p = this.peek();
        if (p.type !== T.VARIABLE) throw new ParseError('S0208', p.position, { value: p.value });
        this.cursor++;
        params.push(p.value);
      } while (this.tryConsume(T.COMMA));
    }
    this.consume(T.RPAREN);
    let signature = null;
    if (this.peek().type === T.LESS) signature = this.readTypeSignature();
    if (this.peek().type === T.GREATER) throw new ParseError('S0402', this.peek().position);
    this.consume(T.LBRACE);
    const body = this.parseExpression();
    this.consume(T.RBRACE);
    return N.Lambda(params, body, signature);
  }

  desugarImmediateLambdaCall(lambda) {
    this.consume(T.LPAREN);
    const args = [];
    if (this.peek().type !== T.RPAREN) {
      do { args.push(this.parseExpression()); } while (this.tryConsume(T.COMMA));
    }
    this.consume(T.RPAREN);
    if (lambda.type === 'Lambda' && lambda.signature) {
      return N.LambdaCall(lambda, args);
    }
    const tmpName = '__ln_' + this.lambdaTempCounter++;
    return N.Parenthesized(N.Block([
      N.VariableBinding(tmpName, lambda),
      N.FunctionCall(tmpName, args),
    ]));
  }

  desugarCallExpr(callee) {
    this.consume(T.LPAREN);
    const args = [];
    if (this.peek().type !== T.RPAREN) {
      do { args.push(this.parseExpression()); } while (this.tryConsume(T.COMMA));
    }
    this.consume(T.RPAREN);
    if (args.some((a) => a.type === 'PartialPlaceholder')) throw new ParseError('T1008', this.peek().position);
    const tmpName = '__call_' + this.lambdaTempCounter++;
    const calleeBinding = N.VariableBinding(tmpName, callee);
    // Distinguishes this synthetic "bind the callee expression, then call
    // it by name" desugaring from a genuine tail/path use of `%` - jsonata
    // never applies its compile-time ancestor-derivation check (S0217) to
    // a call's callee position (`%()` fails at *runtime* with T1006,
    // "attempted to invoke a non-function", not at compile time).
    calleeBinding.isCalleeBinding = true;
    return N.Parenthesized(N.Block([
      calleeBinding,
      N.FunctionCall(tmpName, args),
    ]));
  }

  /**
   * Signatures use bare punctuation (`?`, `:`, `-`, `+`) that the ordinary
   * lexer can misread as compound operators when adjacent - `n?:n>` lexes
   * `?:` as one `QUESTION_COLON` (elvis) token, silently dropping both
   * characters if reconstructed from token values/types. Scans the raw
   * source text directly instead (bracket-depth-tracking `<`/`>` only),
   * then fast-forwards the token cursor past whatever tokens the lexer
   * happened to carve the same region into.
   */
  readTypeSignature() {
    const startPos = this.peek().position;
    let i = startPos + 1;
    let depth = 1;
    while (i < this.source.length && depth > 0) {
      if (this.source[i] === '<') depth++;
      else if (this.source[i] === '>') depth--;
      i++;
    }
    const endPos = i;
    const sb = this.source.slice(startPos, endPos);
    while (this.cursor < this.tokens.length && this.tokens[this.cursor].position < endPos) this.cursor++;
    if (/[bnslu]</.test(sb)) throw new ParseError('S0401', startPos, { value: sb });
    return sb;
  }

  // ===== Token stream utilities =====

  peek() { return this.tokens[this.cursor]; }
  peekAt(offset) {
    const idx = this.cursor + offset;
    return idx < this.tokens.length ? this.tokens[idx] : this.tokens[this.tokens.length - 1];
  }
  consume(expected) {
    const t = this.tokens[this.cursor];
    if (t.type !== expected) {
      if (t.type === T.EOF) throw new ParseError('S0203', t.position, { value: expected });
      throw new ParseError('S0202', t.position, { value: expected, token: tokenText(t) });
    }
    this.cursor++;
    return t;
  }
  tryConsume(type) {
    if (this.peek().type === type) { this.cursor++; return true; }
    return false;
  }
  parseDouble(text, pos) {
    const v = Number(text);
    if (Number.isNaN(v)) throw new ParseError('S0102', pos, { token: text });
    return v;
  }
}


/** Parses `expression` and returns the root AST node; throws `ParseError` on invalid input. */
function parse(expression) {
  return Parser.parse(expression);
}


/**
 * True if evaluating `node` yields a *sequence*, which is what decides whether
 * a `[]` suffix does anything at all: jsonata's `keepArray` flag is only ever
 * consulted inside `evaluate`'s `isSequence(result)` branch, so `[]` on
 * anything else is a NO-OP - `1[]` is `1`, `{}[]` is `{}`, `([])[]` is `[]`,
 * `(a.b)[]` is `1` and `1+1[]` is `2`, whereas `s[]` is `["q"]`, `a.b[]` is
 * `[1]` and `[1,2][0][]` is `[1]`.
 *
 * Decided on the SYNTACTIC shape, and here rather than in the translator,
 * because the optimizer strips the `Parenthesized` wrapper that separates
 * `(a.b)[]` from `a.b[]`.
 *
 * Listed below are only the shapes whose result is provably NOT a sequence.
 * Everything else keeps the previous "wrap it" behaviour: several built-ins
 * (`$map`, `$filter`, `$keys`, `$spread`, `$each`, ...) really do return
 * sequences in jsonata, and a few (`$append`, `$lookup`, `$distinct`) decide
 * it from their arguments, so a syntactic answer for a call would be a guess.
 */
function producesSequence(node) {
  if (!node) return true;
  switch (node.type) {
    case 'StringLiteral':
    case 'NumberLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'RegexLiteral':
    case 'ArrayConstructor':
    case 'ObjectConstructor':
    case 'Lambda':
    case 'RangeExpr':
    case 'BinaryOp':
    case 'UnaryMinus':
    case 'ContextRef':
    case 'RootRef':
    case 'VariableRef':
    case 'VariableBinding':
    case 'Block':
    // A `(...)` block is not a path, however path-like its contents:
    // `(a.b)[]` is `1` where `a.b[]` is `[1]`.
    case 'Parenthesized':
    // A group-by produces an object, never a sequence.
    case 'GroupByExpr':
      return false;
    case 'PathExpr': {
      // `$@$e` is NOT a path in jsonata: its `@` production hangs the focus off
      // whatever the left side already was - here a bare `$`, a variable node -
      // and never wraps it, so `$@$e[]` is the input object. (`#` does wrap,
      // which is why `$#$i[]` keeps its array; and any real step, as in
      // `$@$e.a[]`, makes it a path again.)
      if (
        (node.steps[0].type === 'ContextRef' || node.steps[0].type === 'RootRef'
          || node.steps[0].type === 'VariableRef')
        && node.steps.slice(1).every((st) => st.type === 'ContextBinding')
      ) return false;
      // Every `.`-path evaluates through `evaluatePath`, which returns a
      // sequence whatever the last step is - unless a non-dotted group-by is
      // folded onto it, which replaces the result with a plain object.
      const last = node.steps[node.steps.length - 1];
      return !(last && last.type === 'GroupByExpr' && !last.dotted);
    }
    case 'FunctionCall':
    case 'PartialApplication':
      // Only these built-ins build their result with `createSequence`; every
      // other one returns a plain array, an object or a scalar, none of which
      // `keepArray` can touch. `$sum(x)[]` is `$sum(x)`, but `$keys(x)[]`
      // really does keep its singleton.
      return SEQUENCE_RETURNING_BUILTINS.has(node.name);
    case 'ChainExpr':
      // `a ~> $f()` carries `keepArray` on the apply node, whose result is
      // whatever the last stage returned.
      return producesSequence(node.steps[node.steps.length - 1]);
    case 'LambdaCall':
      // A lambda's result is its body's; unknowable from the call site, so
      // keep the previous behaviour.
      return true;
    default:
      // FieldRef/`*`/`**`/`%` (paths), a predicate or subscript stage and a
      // `^()` sort (each always a sequence, whatever its source - jsonata
      // parses all three as path steps), and everything not listed.
      return true;
  }
}

/**
 * The jsonata built-ins whose result is a *sequence* (`functions.js`, every
 * `this.createSequence()` site) rather than a plain array/object/scalar - the
 * only ones a `[]` suffix can act on. `$append` is not one of them: it returns
 * `arg1.concat(arg2)`, and `concat` drops the sequence flag - or one argument
 * verbatim when the other is absent, so `$append(1, nope)[]` is `1`.
 * `$lookup` is not either; it is handled directly by
 * `translator.js#genForceArray`, which is the only way to tell its two shapes
 * apart. `$distinct` stays for want of evidence: it builds a sequence only
 * from a sequence input, which this port does not track.
 */
// `$eval` is NOT one: it hands back whatever the evaluated expression
// returned, so `$eval("1")[]` is `1` (§12.3 of the conformance note).
const SEQUENCE_RETURNING_BUILTINS = new Set([
  'map', 'filter', 'keys', 'spread', 'each', 'match', 'distinct',
]);


/**
 * True if jsonata's `processAST` would give `node` `type: 'path'`. A bare name
 * counts (`objs` is a one-step path); a block, literal, constructor or call
 * does not.
 *
 * jsonata attaches a group-by to the PATH, not to a step, so a `[...]` or
 * `^()` written after `X{...}` lands on `X`'s last step and runs BEFORE the
 * grouping - `objs{"k":x}[0]` is `{"k":1}`. S0209 is reached only when the
 * group-by's source is not a path, because then the group really is on the
 * node the suffix would attach to.
 */
function isPathNode(node) {
  if (!node) return false;
  switch (node.type) {
    case 'PathExpr':
    case 'FieldRef':
    case 'WildcardStep':
    case 'DescendantStep':
    case 'ParentStep':
    case 'PositionBinding':
    case 'ContextBinding':
      return true;
    case 'PredicateExpr':
    case 'ArraySubscript':
    case 'SortExpr':
      return isPathNode(node.source);
    default:
      return false;
  }
}

/** Rebuilds `group` around a source rewritten by `f` (see `isPathNode`). */
function regroup(group, inner) {
  const g = N.GroupByExpr(inner, group.pairs, group.pos);
  g.dotted = group.dotted;
  return g;
}


/**
 * Rewrites a bare quoted string heading a path into the field reference it
 * denotes. `"a.b".c` selects the field literally named `a.b`, while
 * `("a.b").c` selects field `c` of the string value - the parenthesised form
 * is a value, and yields nothing. Only the parser can tell them apart: it
 * still holds the `Parenthesized` wrapper the optimizer folds away.
 *
 * Subscripts, predicates and the other stages sit between the name and the dot
 * without changing what the head denotes: `"a"[0].b` still reads field `a`.
 */
function asPathHead(node) {
  if (!node) return node;
  if (node.type === 'StringLiteral') return N.FieldRef(node.value, node.pos);
  if (
    node.type === 'PredicateExpr' || node.type === 'ArraySubscript' || node.type === 'ForceArray'
    || node.type === 'SortExpr' || node.type === 'GroupByExpr'
  ) {
    const head = asPathHead(node.source);
    if (head !== node.source) return Object.assign({}, node, { source: head });
  }
  return node;
}

/**
 * Marks an array constructor heading a path with `pathHead`, reaching through
 * every stage the head can carry (a sort, a predicate, a subscript, a `[]` or
 * a group-by) because all of those hang OFF the constructor in jsonata, which
 * still sees it as `steps[0]`. `[1][0].x` is flagged; `([1])[0].x` is not, and
 * that parenthesis is the only thing separating them - which is why this has
 * to happen in the parser (the optimizer folds the wrapper away).
 */
function flagPathHead(step) {
  if (!step) return step;
  if (step.type === 'ArrayConstructor') {
    step.pathHead = true;
    return step;
  }
  if (
    step.type === 'SortExpr' || step.type === 'ArraySubscript'
    || step.type === 'PredicateExpr' || step.type === 'GroupByExpr' || step.type === 'ForceArray'
  ) {
    flagPathHead(step.source);
  }
  return step;
}

/**
 * Builds a `PathExpr`. `fromDot` says the `.` production built it, and two
 * rules hang off that and off nothing else (§20.1 of the conformance note):
 *
 * - **The literal step check.** jsonata refuses a number or `true`/`false`/
 *   `null` ANYWHERE in a multi-step path built by `.` - `1[].$`, `true.x` and
 *   `a.true` are all S0213 - but a path a BINDING built never reaches that
 *   filter, so `1@$e` and `1#$i` are legal and evaluate to `1`. A
 *   parenthesised literal (`a.(1)`) is a block, not a literal step, and stays
 *   legal either way.
 * - **The consarray head mark.** processAST sets `firststep.consarray` inside
 *   `case '.'`, so `[1,2]#$i@$e` (no dot: an ordinary tuple step, the context
 *   once per element) and `[1,2]#$i@$e.$` (the dot makes a path, the head
 *   short-circuits as a value) get different answers.
 */
function newPath(steps, pos, fromDot) {
  if (fromDot && steps.length > 1) {
    for (const step of steps) {
      // Through the stages a step carries, because those hang off the literal
      // rather than replacing it: `1[0].$` is S0213 as much as `1.$` is.
      let base = step;
      while (
        base.type === 'ForceArray' || base.type === 'PredicateExpr' || base.type === 'ArraySubscript'
        || base.type === 'SortExpr' || base.type === 'GroupByExpr'
      ) base = base.source;
      if (base.type === 'NumberLiteral' || base.type === 'BooleanLiteral' || base.type === 'NullLiteral') {
        throw new ParseError('S0213', base.pos, { value: base.type === 'NullLiteral' ? null : base.value });
      }
    }
    flagPathHead(steps[0]);
  }
  return N.PathExpr(steps, pos);
}

module.exports = { parse, Parser, producesSequence };
