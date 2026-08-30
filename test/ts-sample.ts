import jsonata2js = require('../jsonata2js');

const expr = jsonata2js.compile('Account.Order.OrderID');
const result: unknown = expr.evaluate({ Account: { Order: [{ OrderID: 1 }] } });

expr.assign('x', 41);
expr.registerFunction('greet', (n: unknown) => `Hello, ${n}`);
expr.useLibrary({ double: (x: unknown) => (x as number) * 2 });
expr.setTimeout(1000);
const src: string = expr.getSourceJsonata();

const lib = jsonata2js.compileLibrary({ double: 'function($x){ $x * 2 }' }, { bindings: { y: 1 } });
expr.useLibrary(lib);

try {
  jsonata2js.compile('bad (');
} catch (e) {
  // compile() always throws JsonataCompilationError, never ParseError
  // directly (ParseError only ever appears as its `.cause`) - see
  // README.md's Errors section / CODE-REVIEW.md M8.
  if (e instanceof jsonata2js.JsonataCompilationError) {
    const code: string = e.code;
    const pos: number | undefined = e.position;
  }
}

console.log(result, src);
