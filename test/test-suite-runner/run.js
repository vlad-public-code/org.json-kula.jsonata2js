'use strict';

/**
 * Conformance runner mirroring jsonata's own `test/run-test-suite.js`
 * resolution/assertion logic (design.md D7 / capability
 * `conformance-and-documentation`), driven entirely by the vendored JSON
 * fixtures under `test/test-suite/` — no case's expected outcome is
 * hard-coded here.
 */

const fs = require('fs');
const path = require('path');
const j2js = require('../../src/index');

const SUITE_DIR = path.join(__dirname, '..', 'test-suite');
const GROUPS_DIR = path.join(SUITE_DIR, 'groups');
const DATASETS_DIR = path.join(SUITE_DIR, 'datasets');

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadDatasets() {
  const datasets = {};
  for (const name of fs.readdirSync(DATASETS_DIR)) {
    if (!name.endsWith('.json')) continue;
    datasets[name.replace('.json', '')] = readJSON(path.join(DATASETS_DIR, name));
  }
  return datasets;
}

function resolveDataset(datasets, testcase) {
  if (Object.prototype.hasOwnProperty.call(testcase, 'data')) return testcase.data;
  if (testcase.dataset === null) return undefined;
  if (Object.prototype.hasOwnProperty.call(datasets, testcase.dataset)) return datasets[testcase.dataset];
  throw new Error(`Unable to find dataset ${testcase.dataset}`);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  if (typeof a === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  return false;
}

function containsSubset(actual, expected) {
  if (actual === null || typeof actual !== 'object') return actual === expected;
  for (const k of Object.keys(expected)) {
    if (!deepEqual(actual[k], expected[k])) return false;
  }
  return true;
}

function collectCases(groupDir, groupName) {
  const files = fs.readdirSync(groupDir).filter((f) => f.endsWith('.json'));
  const cases = [];
  for (const f of files) {
    const spec = readJSON(path.join(groupDir, f));
    const arr = Array.isArray(spec) ? spec : [spec];
    for (const c of arr) {
      if (!c.description) c.description = f;
      c._group = groupName;
      c._file = f;
      if (c['expr-file']) {
        c.expr = fs.readFileSync(path.join(groupDir, c['expr-file']), 'utf8');
      }
      cases.push(c);
    }
  }
  return cases;
}

function runCase(datasets, testcase) {
  let expr;
  try {
    expr = j2js.compile(testcase.expr);
    if (testcase.timelimit && testcase.depth) {
      expr.setTimeout(testcase.timelimit);
      expr.setMaxDepth(testcase.depth);
    }
  } catch (e) {
    if (testcase.code) {
      if (e.code !== testcase.code) {
        return { ok: false, reason: `expected compile error code ${testcase.code}, got ${e.code}: ${e.message}` };
      }
      if (Object.prototype.hasOwnProperty.call(testcase, 'token') && e.token !== testcase.token) {
        return { ok: false, reason: `expected token ${JSON.stringify(testcase.token)}, got ${JSON.stringify(e.token)}` };
      }
      return { ok: true };
    }
    return { ok: false, reason: `unexpected compile error ${e.code}: ${e.message}` };
  }

  const dataset = resolveDataset(datasets, testcase);
  let result;
  let thrown;
  try {
    result = expr.evaluate(dataset, testcase.bindings);
  } catch (e) {
    thrown = e;
  }

  if (Object.prototype.hasOwnProperty.call(testcase, 'undefinedResult')) {
    if (thrown) return { ok: false, reason: `unexpected throw ${thrown.code}: ${thrown.message}` };
    if (result !== undefined) return { ok: false, reason: `expected undefined, got ${JSON.stringify(result)}` };
    return { ok: true };
  }
  if (Object.prototype.hasOwnProperty.call(testcase, 'result')) {
    if (thrown) return { ok: false, reason: `unexpected throw ${thrown.code}: ${thrown.message}` };
    if (!deepEqual(result, testcase.result)) {
      return { ok: false, reason: `expected ${JSON.stringify(testcase.result)}, got ${JSON.stringify(result)}` };
    }
    return { ok: true };
  }
  if (Object.prototype.hasOwnProperty.call(testcase, 'error')) {
    if (!thrown) return { ok: false, reason: `expected a thrown error, evaluation succeeded with ${JSON.stringify(result)}` };
    if (!containsSubset(thrown, testcase.error)) {
      return { ok: false, reason: `error mismatch: expected to contain ${JSON.stringify(testcase.error)}, got code=${thrown.code} message=${thrown.message}` };
    }
    return { ok: true };
  }
  if (Object.prototype.hasOwnProperty.call(testcase, 'code')) {
    if (!thrown) return { ok: false, reason: `expected code ${testcase.code}, evaluation succeeded with ${JSON.stringify(result)}` };
    if (thrown.code !== testcase.code) {
      return { ok: false, reason: `expected code ${testcase.code}, got ${thrown.code}: ${thrown.message}` };
    }
    if (Object.prototype.hasOwnProperty.call(testcase, 'token') && thrown.token !== testcase.token) {
      return { ok: false, reason: `expected token ${JSON.stringify(testcase.token)}, got ${JSON.stringify(thrown.token)}` };
    }
    return { ok: true };
  }
  return { ok: false, reason: 'testcase has no result/undefinedResult/error/code field' };
}
function main() {
  const datasets = loadDatasets();
  const groupNames = fs.readdirSync(GROUPS_DIR).filter((n) => fs.statSync(path.join(GROUPS_DIR, n)).isDirectory());
  const groupResults = [];
  let totalPass = 0;
  let totalFail = 0;
  const failures = [];

  for (const groupName of groupNames) {
    const cases = collectCases(path.join(GROUPS_DIR, groupName), groupName);
    let pass = 0;
    let fail = 0;
    for (const c of cases) {
      let outcome;
      try {
        outcome = runCase(datasets, c);
      } catch (e) {
        outcome = { ok: false, reason: `runner threw: ${e.stack}` };
      }
      if (outcome.ok) {
        pass++;
        totalPass++;
      } else {
        fail++;
        totalFail++;
        failures.push({ group: groupName, file: c._file, description: c.description, expr: c.expr, reason: outcome.reason });
      }
    }
    groupResults.push({ group: groupName, pass, fail, total: cases.length });
  }

  const totalCases = totalPass + totalFail;

  groupResults.sort((a, b) => b.fail - a.fail);
  for (const g of groupResults) {
    if (g.fail > 0) console.log(`FAIL ${g.group}: ${g.pass}/${g.total}`);
  }
  console.log('---');
  console.log(`TOTAL: ${totalPass}/${totalCases} (${totalCases === 0 ? 'NaN' : ((100 * totalPass) / totalCases).toFixed(1)}%)`);
  console.log(`Groups fully passing: ${groupResults.filter((g) => g.fail === 0).length}/${groupResults.length}`);

  // A pruned/empty suite must not read as success: floor the expected case
  // count so "no cases ran" can never be silently indistinguishable from
  // "every case passed" (see CODE-REVIEW.md C3).
  const MIN_EXPECTED_CASES = 1600;
  if (totalCases < MIN_EXPECTED_CASES) {
    totalFail += 1; // ensure the floor breach itself counts as failure below
    failures.push({
      group: '(suite integrity)',
      file: '',
      description: 'fixture-count floor',
      expr: '',
      reason: `only ${totalCases} case(s) discovered under ${GROUPS_DIR}; expected at least ${MIN_EXPECTED_CASES} - the vendored suite looks pruned or missing`,
    });
    console.log(`FLOOR BREACH: only ${totalCases} case(s) discovered, expected at least ${MIN_EXPECTED_CASES}`);
  }

  const verboseLimit = process.env.J2JS_VERBOSE_FAILURES ? Number(process.env.J2JS_VERBOSE_FAILURES) || 50 : 50;
  for (const f of failures.slice(0, verboseLimit)) {
    console.log(`\n[${f.group}/${f.file}] ${f.description}\n  expr: ${f.expr}\n  ${f.reason}`);
  }
  if (failures.length > verboseLimit) {
    console.log(`\n...and ${failures.length - verboseLimit} more failure(s). Set J2JS_VERBOSE_FAILURES=<n> to see more.`);
  }

  return { totalPass, totalFail, groupResults, failures };
}

if (require.main === module) {
  const { totalFail } = main();
  if (totalFail > 0) {
    process.exitCode = 1;
  }
}

module.exports = { main };
