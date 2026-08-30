'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { tokenize } = require('../../src/parser/lexer');
const { TokenType: T } = require('../../src/parser/token-types');
const { parse } = require('../../src/parser/parser');

function types(src) {
  return tokenize(src).map((t) => t.type);
}

describe('parser/lexer', () => {
  it('tokenizes every operator/keyword', () => {
    assert.deepStrictEqual(types('1 + 1 - 1 * 1 / 1 % 1 & 1 = 1 != 1 < 1 <= 1 > 1 >= 1'), [
      T.NUMBER, T.PLUS, T.NUMBER, T.MINUS, T.NUMBER, T.STAR, T.NUMBER, T.SLASH, T.NUMBER,
      T.PERCENT, T.NUMBER, T.AMPERSAND, T.NUMBER, T.EQUAL, T.NUMBER, T.NOT_EQUAL, T.NUMBER,
      T.LESS, T.NUMBER, T.LESS_EQUAL, T.NUMBER, T.GREATER, T.NUMBER, T.GREATER_EQUAL, T.NUMBER, T.EOF,
    ]);
    assert.deepStrictEqual(types('and or in not'), [T.AND, T.OR, T.IN, T.NOT, T.EOF]);
    assert.deepStrictEqual(types('?: ?? := .. ** ~> ^ @ #'), [
      T.QUESTION_COLON, T.QUESTION_QUESTION, T.COLON_ASSIGN, T.DOT_DOT, T.STAR_STAR,
      T.TILDE_GT, T.CARET, T.AT, T.HASH, T.EOF,
    ]);
  });
  it('lexes regex literal with unescaped slash inside a character class', () => {
    const toks = tokenize('/[a/b]+/');
    assert.strictEqual(toks[0].type, T.REGEX);
    const sep = toks[0].value.lastIndexOf('/');
    assert.strictEqual(toks[0].value.slice(0, sep), '[a/b]+');
  });
  it('lexes regex literal with i/m flags', () => {
    const toks = tokenize('/ab+/im');
    const sep = toks[0].value.lastIndexOf('/');
    assert.strictEqual(toks[0].value.slice(sep + 1), 'im');
  });
  it('division vs regex disambiguation by preceding token', () => {
    assert.deepStrictEqual(types('4/2'), [T.NUMBER, T.SLASH, T.NUMBER, T.EOF]);
    assert.strictEqual(tokenize('/x/')[0].type, T.REGEX);
  });
});

describe('parser/parser', () => {
  it('parses path navigation with predicate and context binding', () => {
    const ast = parse('Account.Order@$o[Price>100].$o.OrderID');
    assert.strictEqual(ast.type, 'PathExpr');
    assert.ok(ast.steps.some((s) => s.type === 'ContextBinding'));
  });
  it('parses group-by and transform together in a chain', () => {
    const ast = parse("Account.Order{OrderID: Product} ~> |$|{'total': $sum(Price)}|");
    assert.strictEqual(ast.type, 'ChainExpr');
    assert.strictEqual(ast.steps[0].type, 'GroupByExpr');
    assert.strictEqual(ast.steps[1].type, 'TransformLambda');
  });
  it('unclosed string literal throws S0101 at/after the opening quote', () => {
    assert.throws(() => parse('"unterminated'), (e) => e.code === 'S0101' && e.position >= 0);
  });
  it('unexpected second + throws with a syntax-error code', () => {
    assert.throws(() => parse('1 + + 2'), (e) => e.code === 'S0211');
  });
  it('every construct in the language grammar parses', () => {
    const exprs = [
      '1+1', '2 + 3 * 4 - 5 / 2 % 3', 'Account.Order.OrderID', 'Account.Order[Price>100].Product',
      '$match(x, /[a/b]+/)', 'Account.Order{OrderID: Product} ~> |$|{"t":$sum(Price)}|',
      '($x := 5; $x + 1)', 'function($x){$x*2}(5)', '$map([1,2,3], function($v){$v*2})',
      '[1..5]', '$sort([3,1,2], function($a,$b){$a>$b})', 'a and b or c', 'a in [1,2,3]',
      'not(true)', '{"a":1}.a', '$$.$', 'a ? b : c', 'a ?: b', 'a ?? b', '$foo(?, 1)',
      'x[]', '-5', '-x', 'x % y', '`a b`.c', "Account.Order^(>OrderID, <Product)",
    ];
    for (const e of exprs) {
      assert.doesNotThrow(() => parse(e), `expected ${e} to parse`);
    }
  });
});

describe('parser/parser against vendored S0xxx fixtures', () => {
  const dir = path.join(__dirname, '..', 'test-suite', 'groups', 'errors');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const spec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const cases = Array.isArray(spec) ? spec : [spec];
    for (const c of cases) {
      if (!c.code || !/^S0/.test(c.code)) continue;
      it(`${f}: ${c.expr} -> ${c.code}`, () => {
        assert.throws(() => parse(c.expr), (e) => e.code === c.code);
      });
    }
  }
});
