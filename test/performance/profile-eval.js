'use strict';

/**
 * CPU-profiling driver for the compiled-expression evaluation hot path.
 * Profiles jsonata2js alone (no reference interpreter), so the profile is
 * not contaminated by another library's frames or IC state.
 *
 * Usage:
 *   node --cpu-prof --cpu-prof-interval=100 --cpu-prof-dir=.prof \
 *        test/performance/profile-eval.js [iterations]
 */

const fs = require('fs');
const path = require('path');
const j2js = require('../../src');

const expr = fs.readFileSync(path.join(__dirname, 'benchmark_expression.jsonata'), 'utf8');
const input = JSON.parse(fs.readFileSync(path.join(__dirname, 'benchmark_input.json'), 'utf8'));
const N = Number(process.argv[2] || 20000);

const compiled = j2js.compile(expr);

// warm up: reach steady-state tier before the timed/profiled region
let sink = 0;
for (let i = 0; i < 1000; i++) sink ^= JSON.stringify(compiled.evaluate(input)).length;

const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) sink ^= (compiled.evaluate(input) ? 1 : 0);
const t1 = process.hrtime.bigint();

const ms = Number(t1 - t0) / 1e6;
console.log(`${N} evaluations in ${ms.toFixed(1)} ms -> ${(N / (ms / 1000)).toFixed(0)} eval/s (sink=${sink})`);
console.log(JSON.stringify(process.memoryUsage()));
