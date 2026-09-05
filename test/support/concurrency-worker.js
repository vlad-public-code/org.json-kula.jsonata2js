'use strict';

/**
 * Worker body for `test/unit/concurrency-and-leaks.test.js`.
 *
 * Each of the four workers compiles the SAME two expression sources and
 * evaluates them in an interleaved loop against inputs derived from its own
 * worker id, checking every result. A worker has its own module registry, so
 * this is a genuine parallel exercise of the whole pipeline (parser →
 * optimizer → translator → `vm.compileFunction` → runtime) plus every piece of
 * module-level state the runtime keeps — the clock stack, the deadline and
 * depth stacks, and the two scan flags in `path.js`/`values.js`.
 */

const { parentPort, workerData } = require('worker_threads');
const j2js = require('../../src/index');

const { id, rounds } = workerData;

// Two expressions with different shapes: one analytical block that exercises
// scan fusion, aggregates and filters; one path/predicate/sort/string mix.
const EXPR_A = `(
  $e := items;
  $sum := $sum($e.n);
  $max := $max($e.n);
  $hot := $count($e[tag = "hot"]);
  $cold := $count($e[tag = "cold"]);
  { "sum": $sum, "max": $max, "hot": $hot, "cold": $cold }
)`;
const EXPR_B = 'items[n > 0]^(>n).(tag & ":" & $string(n))';

function input(seed) {
  return {
    items: Array.from({ length: 8 }, (_, k) => ({
      n: seed * 10 + k,
      tag: (seed + k) % 2 === 0 ? 'hot' : 'cold',
    })),
  };
}

/** Recomputed independently of the engine, so the check is not self-fulfilling. */
function expectedA(seed) {
  const it = input(seed).items;
  return {
    sum: it.reduce((a, x) => a + x.n, 0),
    max: Math.max(...it.map((x) => x.n)),
    hot: it.filter((x) => x.tag === 'hot').length,
    cold: it.filter((x) => x.tag === 'cold').length,
  };
}
function expectedB(seed) {
  return input(seed).items
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((x) => `${x.tag}:${x.n}`);
}

try {
  const a = j2js.compile(EXPR_A);
  const b = j2js.compile(EXPR_B);
  let checked = 0;
  for (let r = 0; r < rounds; r++) {
    const seed = id * 1000 + r;
    const gotA = a.evaluate(input(seed));
    const wantA = expectedA(seed);
    if (JSON.stringify(gotA) !== JSON.stringify(wantA)) {
      throw new Error(`worker ${id} round ${r}: A got ${JSON.stringify(gotA)} want ${JSON.stringify(wantA)}`);
    }
    const gotB = b.evaluate(input(seed));
    const wantB = expectedB(seed);
    if (JSON.stringify(gotB) !== JSON.stringify(wantB)) {
      throw new Error(`worker ${id} round ${r}: B got ${JSON.stringify(gotB)} want ${JSON.stringify(wantB)}`);
    }
    checked += 2;
  }
  parentPort.postMessage({ id, checked });
} catch (e) {
  parentPort.postMessage({ id, error: e.message });
}
