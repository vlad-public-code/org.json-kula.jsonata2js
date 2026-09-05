'use strict';

/**
 * In-memory loader (design.md D5): turns generated JS source into a callable
 * function via `new Function`, with a `//# sourceURL=` comment for stack
 * traces — no `.class`/`.js` file ever touches disk, mirroring JSonata2Java's
 * in-memory `javac` pipeline. See `loadFunction` for why not
 * `vm.compileFunction`.
 */

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
    // `new Function` with a trailing `//# sourceURL=` rather than
    // `vm.compileFunction`: the latter RETAINS about 2 KB per distinct source
    // for the life of the process (measured; `vm.compileFunction` keeps host
    // state per compilation that a dropped function does not release), which
    // for a service compiling a stream of user-supplied expressions is an
    // unbounded leak. `new Function` retains ~77 bytes, and the `sourceURL`
    // comment puts the same generated-file name in stack traces. Neither form
    // can see or add to any enclosing scope: every dependency arrives as a
    // parameter.
    //
    // The name is still derived from the body, so identical generated code
    // produces identical source text and keeps hitting V8's compilation cache.
    // It costs ~25 µs more per DISTINCT expression than `vm.compileFunction`,
    // paid once at compile time; the leak it removes was permanent.
    // eslint-disable-next-line no-new-func
    return new Function(...params, `${body}
//# sourceURL=${filename}`);
  } catch (e) {
    throw new JsonataLoadError(
      'U1002',
      `Internal error: generated code failed to compile${sourceLabel ? ` for "${sourceLabel}"` : ''}: ${e.message}`,
      e
    );
  }
}

module.exports = { loadFunction };
