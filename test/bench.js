'use strict';

/**
 * Benchmarks compiled-expression evaluation throughput against the
 * `jsonata` tree-walking interpreter for a representative expression set
 * (design.md task 10.5). Run: `npm run test:bench`.
 */

const path = require('path');
const j2js = require('../src/index');

// Resolves the reference `jsonata` interpreter from the `jsonata`
// devDependency (portable across checkouts - see CODE-REVIEW.md M10),
// with an optional J2JS_REF_JSONATA override (a path to a local checkout's
// `src/jsonata.js`, for comparing against an unreleased/modified build).
// Unlike before, an unavailable reference now FAILS the script (exit 1)
// instead of silently exiting 0 having measured nothing.
let jsonata;
try {
  jsonata = process.env.J2JS_REF_JSONATA ? require(path.resolve(process.env.J2JS_REF_JSONATA)) : require('jsonata');
} catch (e) {
  console.error(`Reference "jsonata" interpreter not available (${e.message}).`);
  console.error('Install devDependencies with `npm install`, or set J2JS_REF_JSONATA=/path/to/jsonata/src/jsonata.js.');
  process.exit(1);
}

const data = {
  Account: {
    Order: Array.from({ length: 200 }, (_, i) => ({
      OrderID: `order${i}`,
      Product: Array.from({ length: 3 }, (_, j) => ({ ProductID: i * 3 + j, Price: (i + j) * 1.5, Quantity: j + 1 })),
    })),
  },
};

const cases = [
  ['path navigation', 'Account.Order.Product.ProductID'],
  ['predicate filter', 'Account.Order.Product[Price > 50].ProductID'],
  ['aggregation', '$sum(Account.Order.Product.(Price * Quantity))'],
  ['map/filter', '$map(Account.Order, function($o){ $count($o.Product[Price>10]) })'],
  ['sort', 'Account.Order.Product^(Price)[0].ProductID'],
];

async function main() {
  for (const [label, expr] of cases) {
    const j2jsExpr = j2js.compile(expr);
    const jsonataExpr = jsonata(expr);

    // warm up
    j2jsExpr.evaluate(data);
    await jsonataExpr.evaluate(data);

    const N = 2000;
    let t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) j2jsExpr.evaluate(data);
    let t1 = process.hrtime.bigint();
    const j2jsMs = Number(t1 - t0) / 1e6;

    t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) await jsonataExpr.evaluate(data);
    t1 = process.hrtime.bigint();
    const jsonataMs = Number(t1 - t0) / 1e6;

    console.log(
      `${label.padEnd(20)} jsonata2js: ${(j2jsMs / N).toFixed(4)}ms/call  jsonata: ${(jsonataMs / N).toFixed(4)}ms/call  speedup: ${(jsonataMs / j2jsMs).toFixed(2)}x`
    );
  }
}

main();
