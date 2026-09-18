'use strict';

/**
 * Retention probe for `compileLibrary().close()` (jsonata2js.md M-3), run in
 * its own process under `--expose-gc` so a collection can actually be forced.
 *
 *   node --expose-gc library-retention-probe.js [libraries]
 *
 * Each library is compiled with a large per-library `bindings` payload, which
 * the expression's permanent environment - and therefore its evaluated lambda's
 * captured `ENV` - retains for its lifetime. The probe keeps ONLY each
 * library's exported function (the shape a real caller ends up in:
 * `useLibrary()` copies the exports out and the `CompiledLibrary` object is
 * dropped), then closes every library and forces a collection.
 *
 * Before the fix, `close()` only flipped a flag — each export still closed
 * over the function value, and through it the whole `JsonataExpression` and
 * its permanent bindings — so every payload stayed reachable. Prints one JSON
 * line: `{ libraries, payloadSlots, afterBuild, afterClose, closedExports }`,
 * heap bytes after a forced collection.
 */

const j2js = require('../../src/index');

const LIBRARIES = Number(process.argv[2] || 150);
const PAYLOAD_SLOTS = 50000; // a plain JS array, so the payload lands in the JS heap the probe measures

function heap() {
  global.gc();
  global.gc(); // a second pass collects what the first one's finalizers freed
  return process.memoryUsage().heapUsed;
}

const kept = [];
const libs = [];
for (let i = 0; i < LIBRARIES; i++) {
  // A fresh payload per library, bound into that library's own expression.
  const payload = new Array(PAYLOAD_SLOTS).fill(i);
  const lib = j2js.compileLibrary(
    { f: 'function($a) { $a & $count($big) }' },
    { bindings: { big: payload } }
  );
  libs.push(lib);
  kept.push(lib.__jsonataLibraryExports.f);
}

// Sanity: the exports work before close.
if (typeof kept[0]('a') !== 'string') throw new Error('library export did not evaluate');

const afterBuild = heap();
for (const lib of libs) lib.close();
libs.length = 0;
const afterClose = heap();

// `kept` must stay reachable across the measurement - that is the whole point.
let stillCallable = 0;
for (const fn of kept) {
  try {
    fn('a');
  } catch (e) {
    if (e.code === 'T2006') stillCallable++;
  }
}

process.stdout.write(JSON.stringify({
  libraries: LIBRARIES,
  payloadSlots: PAYLOAD_SLOTS,
  afterBuild,
  afterClose,
  closedExports: stillCallable,
}) + '\n');
