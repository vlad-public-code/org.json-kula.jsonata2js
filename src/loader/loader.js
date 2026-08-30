'use strict';

/**
 * In-memory loader (design.md D5): turns generated JS source into a
 * callable function via Node's built-in `vm.compileFunction`, chosen over
 * ambient `new Function` because it accepts a `filename` for stack traces
 * and does not leak into global scope — no `.class`/`.js` file ever
 * touches disk, mirroring JSonata2Java's in-memory `javac` pipeline.
 */

const vm = require('vm');
const { JsonataLoadError } = require('../errors');

/**
 * FNV-1a over the generated source. The filename is part of V8's compilation
 * cache key, so a counter-based unique name (what this used to emit) made
 * every compile of the *same* expression a full recompile: 0.78 ms versus
 * 0.02 ms with a stable name, measured over 50 compiles of
 * `test/performance/benchmark_expression.jsonata`. Hashing the body keeps
 * distinct expressions distinguishable in stack traces while letting a
 * repeated compile of identical generated code hit the cache. A hash
 * collision only mislabels a stack frame — V8 keys the cache on the source
 * text as well, so it cannot return the wrong function.
 */
function sourceTag(body) {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Compiles `{params, body}` (as produced by `translator.translate`) into a
 * callable JS function. Throws `JsonataLoadError` (`U1002`) if the
 * generated source is not valid JS syntax — never reachable from a valid
 * JSONata expression, but the mapping avoids a second exception hierarchy
 * for what is, from the caller's perspective, still "compilation failed".
 */
function loadFunction(params, body, sourceLabel) {
  const filename = `jsonata2js-generated-${sourceTag(body)}.js`;
  try {
    return vm.compileFunction(body, params, {
      filename,
      lineOffset: 0,
    });
  } catch (e) {
    throw new JsonataLoadError(
      'U1002',
      `Internal error: generated code failed to compile${sourceLabel ? ` for "${sourceLabel}"` : ''}: ${e.message}`,
      e
    );
  }
}

module.exports = { loadFunction };
