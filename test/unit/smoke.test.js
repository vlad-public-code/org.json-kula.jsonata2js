'use strict';

const assert = require('assert');
const j2js = require('../../src/index');

describe('smoke test', () => {
  it('evaluates 1+1', () => {
    assert.strictEqual(j2js.compile('1+1').evaluate(), 2);
  });

  // The generated filename is derived from the generated source (so V8's
  // compilation cache can hit on a repeated compile — see loader.js); two
  // compiles of the same expression must still be fully independent objects,
  // not a shared/cached JsonataExpression.
  it('compiles the same expression twice into independent expressions', () => {
    const a = j2js.compile('$x + Price');
    const b = j2js.compile('$x + Price');
    assert.notStrictEqual(a, b);
    a.assign('x', 10);
    b.assign('x', 100);
    assert.strictEqual(a.evaluate({ Price: 1 }), 11);
    assert.strictEqual(b.evaluate({ Price: 1 }), 101);
    assert.strictEqual(j2js.compile('$x + Price').evaluate({ Price: 1 }), undefined);
  });
});
