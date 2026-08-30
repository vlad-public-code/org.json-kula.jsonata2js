'use strict';

/**
 * Head-to-head performance comparison between jsonata2js and the official
 * `jsonata` tree-walking interpreter — same methodology as JSonata2Java's
 * `PerformanceComparisonTest` (`c:\vlad-projects\java\JSonata2Java\src\test\java\
 * org\json_kula\jsonata_jvm\PerformanceComparisonTest.java`), same benchmark
 * expression and input document, ported byte-for-byte from that test's
 * `src/test/resources/benchmark/` fixtures.
 *
 * The benchmark:
 *   1. Each library compiles the expression once (compilation time is
 *      reported separately, NOT included in the evaluation throughput figure).
 *   2. 1,000 warmup evaluations run untimed, then 100,000 timed evaluations
 *      against the same pre-parsed JSON document.
 *   3. Wall-clock elapsed time and throughput (evaluations/second) are printed.
 *   4. Both libraries must agree on every field of the result, confirming
 *      the expression evaluates correctly in both.
 *
 * Not part of `npm test` (this takes tens of seconds - `jsonata`'s async
 * per-call interpretation of a ~200-line expression against 100,000
 * iterations is slow by design, that's exactly what's being measured).
 *
 * Run: node test/performance-comparison.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
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

const EVALUATIONS = 100_000;
const WARMUP_ROUNDS = 1_000;

const expressionSource = fs.readFileSync(path.join(__dirname, 'performance/benchmark_expression.jsonata'), 'utf8');
const input = JSON.parse(fs.readFileSync(path.join(__dirname, 'performance/benchmark_input.json'), 'utf8'));

function fmtMs(ns) {
  return (Number(ns) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function throughput(ns) {
  return EVALUATIONS / (Number(ns) / 1e9);
}

function fmtNum(n, digits) {
  return n.toLocaleString('en-US', { maximumFractionDigits: digits === undefined ? 0 : digits });
}

async function main() {
  // ---- Compilation ----
  let t0 = process.hrtime.bigint();
  const j2jsExpr = j2js.compile(expressionSource);
  const j2jsCompileNs = process.hrtime.bigint() - t0;

  t0 = process.hrtime.bigint();
  const jsonataExpr = jsonata(expressionSource);
  const jsonataCompileNs = process.hrtime.bigint() - t0;

  console.log('\n=== Compilation ===');
  console.log(`  jsonata2js : ${fmtMs(j2jsCompileNs)} ms`);
  console.log(`  jsonata    : ${fmtMs(jsonataCompileNs)} ms`);

  // ---- Correctness ----
  const j2jsResult = j2jsExpr.evaluate(input);
  const jsonataResult = await jsonataExpr.evaluate(input);

  console.log('\n=== Correctness ===');
  try {
    assert.strictEqual(j2jsResult.company, 'Acme Corporation', 'jsonata2js: company');
    assert.strictEqual(jsonataResult.company, 'Acme Corporation', 'jsonata: company');

    assert.strictEqual(j2jsResult.founded, 1985, 'jsonata2js: founded');
    assert.strictEqual(jsonataResult.founded, 1985, 'jsonata: founded');

    // Total employees (5 + 7 + 4 + 3 = 19)
    assert.strictEqual(j2jsResult.workforce.totalEmployees, 19, 'jsonata2js: totalEmployees');
    assert.strictEqual(jsonataResult.workforce.totalEmployees, 19, 'jsonata: totalEmployees');

    // Department count
    assert.strictEqual(j2jsResult.workforce.departments, 4, 'jsonata2js: departments');
    assert.strictEqual(jsonataResult.workforce.departments, 4, 'jsonata: departments');

    // Active product count (P001..P007 minus P004 = 6)
    assert.strictEqual(j2jsResult.catalog.active, 6, 'jsonata2js: active products');
    assert.strictEqual(jsonataResult.catalog.active, 6, 'jsonata: active products');

    // Delivered orders (ORD-001, ORD-003, ORD-006)
    assert.strictEqual(j2jsResult.orders.delivered, 3, 'jsonata2js: delivered orders');
    assert.strictEqual(jsonataResult.orders.delivered, 3, 'jsonata: delivered orders');

    // SKU count (P001..P007 appear in orders: P001,P003,P006,P005,P002,P007,P004 = 7)
    assert.strictEqual(j2jsResult.orders.skuCount, 7, 'jsonata2js: skuCount');
    assert.strictEqual(jsonataResult.orders.skuCount, 7, 'jsonata: skuCount');

    assert.ok(j2jsResult.summary.startsWith('Company Acme Corporation'), `jsonata2js: unexpected summary: ${j2jsResult.summary}`);
    assert.ok(jsonataResult.summary.startsWith('Company Acme Corporation'), `jsonata: unexpected summary: ${jsonataResult.summary}`);

    // Real jsonata tags constructed objects with `Object.create(null)` and
    // marks some result arrays with a non-JSON `.sequence` property -
    // invisible over JSON (which is what any consumer of a JSON-to-JSON
    // transform actually sees) but not `assert.deepStrictEqual`-equal to
    // jsonata2js's plain objects/arrays - compare serialized form instead.
    assert.strictEqual(JSON.stringify(j2jsResult), JSON.stringify(jsonataResult), 'jsonata2js and jsonata must produce identical JSON output');
    console.log('  Both libraries agree on every field of the result object (identical JSON output).');
  } catch (e) {
    console.log(`  MISMATCH: ${e.message}`);
    process.exitCode = 1;
  }

  // ---- Benchmarks (side-by-side, one process, same warmup discipline as PerformanceComparisonTest) ----
  for (let i = 0; i < WARMUP_ROUNDS; i++) {
    j2jsExpr.evaluate(input);
    await jsonataExpr.evaluate(input);
  }

  let start = process.hrtime.bigint();
  for (let i = 0; i < EVALUATIONS; i++) {
    j2jsExpr.evaluate(input);
  }
  const j2jsElapsed = process.hrtime.bigint() - start;

  start = process.hrtime.bigint();
  for (let i = 0; i < EVALUATIONS; i++) {
    await jsonataExpr.evaluate(input);
  }
  const jsonataElapsed = process.hrtime.bigint() - start;

  const j2jsThroughput = throughput(j2jsElapsed);
  const jsonataThroughput = throughput(jsonataElapsed);
  const ratio = j2jsThroughput / jsonataThroughput;

  console.log(`\n=== Side-by-side comparison (${fmtNum(EVALUATIONS)} evaluations) ===`);
  console.log(`  jsonata2js   ${fmtNum(j2jsThroughput).padStart(12)} eval/s   (${fmtNum(Number(j2jsElapsed) / 1e6)} ms total)`);
  console.log(`  jsonata      ${fmtNum(jsonataThroughput).padStart(12)} eval/s   (${fmtNum(Number(jsonataElapsed) / 1e6)} ms total)`);
  console.log(`  Speedup: jsonata2js is ${(ratio > 1 ? ratio : 1 / ratio).toFixed(2)}x ${ratio > 1 ? 'faster' : 'slower'} than jsonata`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
