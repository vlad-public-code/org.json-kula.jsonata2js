---
title: jsonata2js
---

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)]({{ site.github.repository_url }}/blob/main/LICENSE)

**[JSONata](https://jsonata.org) for JavaScript — translated to JavaScript source, not interpreted.**

Parses a JSONata expression once, generates a plain JavaScript function for it, and loads that function in-memory via Node's `vm.compileFunction` — evaluating a hot, repeatedly-used expression skips per-call parse/interpret overhead the way a compiler skips it, instead of tree-walking the AST on every call the way [`jsonata`](https://www.npmjs.com/package/jsonata) does. Repeated evaluation of a compiled expression is **around 45-56× faster** than the `jsonata` interpreter on a realistic analytical benchmark, and 9.5×-82× faster across the more targeted per-construct benchmarks (see [Performance](#performance)).

Ported from [jsonata-jvm-compiler](https://github.com/vlad-public-code/org.json-kula.jsonata-jvm-compiler) (same compile pipeline, same AST shape, same error-code contract) with runtime built-ins vendored from `jsonata`'s own pure-JS interpreter wherever the logic is interpreter-agnostic.

Zero required runtime dependencies. Node.js >= 18 (uses `node:vm`'s `compileFunction`).

## Install

```
npm install jsonata2js
```

## Quickstart

```js
const jsonata2js = require('jsonata2js');

const expr = jsonata2js.compile('Account.Order[Price > 100].OrderID');

const result = expr.evaluate({
  Account: {
    Order: [
      { OrderID: 'o1', Price: 50 },
      { OrderID: 'o2', Price: 150 },
    ],
  },
});
// => "o2"
```

Compile once, evaluate many times against different input — no re-parse:

```js
const total = jsonata2js.compile('$sum(items.price)');
for (const order of orders) {
  console.log(total.evaluate(order));
}
```

## Bindings

```js
const expr = jsonata2js.compile('$x & $greet(name)');

expr.assign('x', 41);                                  // permanent variable binding
expr.registerFunction('greet', (n) => `Hello, ${n}!`);  // permanent function binding

expr.evaluate({ name: 'Ada' });
// $x resolves to 41, $greet(...) calls the registered function

// One-shot bindings, scoped to a single evaluate() call:
expr.evaluate({ name: 'Ada' }, { x: 1 });
```

`registerFunction(name, fn, signature?)` accepts an optional JSONata-style `<params:return>` signature string. If given, argument count AND type are validated against it before every call (the same `T0410` argument-signature-mismatch enforcement built-ins get) — `fn.length` is used for arity only when no `signature` is given (needed for a variadic/rest-parameter function, where `fn.length` isn't reliable).

## Compiling a library

`compileLibrary` compiles a map of `{ exportName: 'jsonata expression source' }` (each expression must evaluate to a function value, typically a lambda literal) into a set of bound functions ready for `useLibrary`:

```js
const lib = jsonata2js.compileLibrary({
  double: 'function($x){ $x * 2 }',
  greet: 'function($n){ "Hello, " & $n }',
});

const expr = jsonata2js.compile('$double($greet(name).$length())');
expr.useLibrary(lib);
```

## Timeouts

```js
expr.setTimeout(1000); // throws U1001 if evaluation exceeds 1000ms
```

## Errors

Every thrown error is one of:

- `jsonata2js.ParseError` — invalid expression syntax (`S0xxx`); thrown by the lexer/parser, but never escapes `compile`/`compileAll` directly — see `JsonataCompilationError` below.
- `jsonata2js.JsonataCompilationError` — `compile`/`compileAll`/`compileLibrary` failed to produce a usable expression. Its `.cause` is the underlying `ParseError` for a syntax error; `compileAll`'s error additionally carries `.failures` (`{index, source, code, message}` per failing expression) and `.results` (the full-length array, populated at every index that DID compile) so a batch failure never silently discards what succeeded.
- `jsonata2js.JsonataEvaluationError` — thrown from inside a compiled expression at `evaluate()` time (`T0xxx`/`T1xxx`/`T2xxx` type errors, `D1xxx`/`D2xxx`/`D3xxx` runtime/built-in-function errors, `U1001` timeout/stack-overflow).
- `jsonata2js.JsonataLoadError` — internal error turning generated source into a callable function (code `U1002`); not reachable from valid JSONata input, and — unlike a syntax error — escapes `compile`/`compileAll` directly rather than being wrapped in a `JsonataCompilationError`.

All four extend `jsonata2js.JsonataError` and expose `.code` (see [the error-code reference](error-codes.html) for the full catalogue) plus any error-specific fields (`.token`, `.value`, `.position`, ...) as own enumerable properties.

```js
try {
  jsonata2js.compile('1 + + 2');
} catch (e) {
  e.code;    // "S0211"
  e.message; // 'The symbol "+" cannot be used as a unary operator'
}
```

## API

- `jsonata2js.compile(source): JsonataExpression`
- `jsonata2js.compileAll(sources: string[]): JsonataExpression[]` — throws a `JsonataCompilationError` (see [Errors](#errors)) identifying every failing expression if any fail, without discarding the ones that compiled.
- `jsonata2js.compileLibrary(definition: {[name]: string}, options?: {bindings?}): CompiledLibrary`
- `CompiledLibrary#close()` — after this, every export throws `T2006` instead of running.
- `JsonataExpression#evaluate(input, bindings?)`
- `JsonataExpression#assign(name, value)` → `this`
- `JsonataExpression#registerFunction(name, fn, signature?)` → `this`
- `JsonataExpression#useLibrary(library)` → `this`
- `JsonataExpression#setTimeout(ms)` → `this`
- `JsonataExpression#setMaxDepth(n)` → `this` (non-tail-recursion depth guardrail)
- `JsonataExpression#getSourceJsonata(): string`

Full type declarations: `jsonata2js.d.ts`.

## Conformance

The official JSONata conformance suite (vendored unmodified from `jsonata/test/test-suite` into `test/test-suite/`, 102 topic groups / 1686 cases) is run via:

```
npm run test:suite
```

jsonata2js passes **100% of the vendored suite** (102/102 groups, 1686/1686 individual assertions), and the runner exits non-zero if any case fails or if fewer cases than expected are discovered, so a regression here fails CI rather than just printing a lower percentage. `npm test` runs the unit-test suite (lexer/parser, and the runtime built-in modules exercised directly); `npm run test:bench` benchmarks compiled-expression throughput per construct against the `jsonata` interpreter; `npm run test:perf` runs the head-to-head analytical benchmark described below.

### Known limitations

- `registerFunction`'s optional `signature` validates argument **count and base type** (`s`/`n`/`b`/`a`/`o`/`f`/`x` codes, union types, `?`/`-`/`+` modifiers), matching the built-in signature grammar — it does not implement `jsonata`'s full XPath-style structural type system.
- `$now()`/`$millis()` are stable within one `evaluate()` call (including inside a nested `$eval`), but `setTimeout()`'s deadline is only checked at function-call/trampoline boundaries — a single long-running evaluation with no function calls (e.g. a huge `$count([1..N])`) can run past the configured deadline before it is next checked.
- `setTimeout()`/`setMaxDepth()` are both opt-in (no default limit); neither bounds native regex execution time, so a pathological user-supplied regex pattern can still run for a long time.

100% conformance against the vendored suite does not by itself prove there are zero remaining edge cases outside it — `$match`'s empty/singleton-result collapse (`$match(str, /no-match/)` must return `undefined`, not `[]`; a call that naturally yields exactly one match must return that bare `{match,index,groups}` object, not a one-element array, matching every other jsonata sequence-returning built-in) was found and fixed this way, not by a suite failure, since the suite's own `$match` cases only exercise multi-match results or immediately chain further field access that happens to auto-unwrap either shape.

## Performance

jsonata2js compiles expressions to a plain JavaScript function loaded via `vm.compileFunction`, so repeated evaluation skips per-call AST interpretation entirely — significantly faster than `jsonata`'s tree-walking interpreter for a hot, reused expression.

### Benchmark: jsonata2js vs [`jsonata`](https://www.npmjs.com/package/jsonata)

The benchmark compiles one expression once, then runs 100,000 evaluations against the same parsed JSON document (with a 1,000-evaluation warmup before timing) — same methodology, same expression, and the same input document as the JVM implementation's [`PerformanceComparisonTest`](https://github.com/vlad-public-code/org.json-kula.jsonata-jvm-compiler/blob/main/src/test/java/org/json_kula/jsonata_jvm/PerformanceComparisonTest.java), ported byte-for-byte (`test/performance/benchmark_expression.jsonata`, `test/performance/benchmark_input.json`). The expression is a realistic analytical query covering variable bindings, nested field navigation, array filtering, aggregation functions (`$sum`, `$count`, `$average`, `$max`, `$min`, `$distinct`), string operations, arithmetic, and a conditional.

Measured on Node.js v24.14.1, Windows 11, from `test/performance-comparison.js` (`npm run test:perf`) — side-by-side runs in one process, each warming up and timing both libraries back to back:

| Metric | jsonata2js | [`jsonata`](https://www.npmjs.com/package/jsonata) |
|---|---|---|
| Compilation | ~8 ms | ~2 ms |
| 100,000 evaluations | ~2,000 ms | ~110,000 ms |
| Throughput | **~48,000-51,000 eval/s** | ~950 eval/s |
| **Speedup** | **~45×-56× faster** | baseline |

Per-shape (`npm run test:bench`, same interpreter): path navigation 9.5×, predicate filter 27.6×, aggregation 50.4×, `$map`/`$count` 52.6×, sort 82.2×.

> `jsonata`'s own throughput varies noticeably more run-to-run (724-1,179 eval/s) than jsonata2js's, consistent with an async tree-walking interpreter re-allocating its evaluation environment/sequence objects on every one of the ~200 sub-expressions in this benchmark for every one of the 100,000 calls, versus a compiled function with no per-call interpretation overhead. The speedup *ratio* therefore moves more than jsonata2js's own absolute throughput does. Both libraries were verified to produce byte-identical JSON output before each benchmark run.

> Compilation is a one-time cost paid at startup. For any workload that reuses an expression more than a handful of times, the throughput advantage dominates. Compiling several expressions at once? Use [`compileAll`](#api) so a syntax error in one doesn't stop the others from compiling.

Reproduce it yourself:

```
npm run test:perf
```

The reference interpreter comes from the `jsonata` devDependency, so `npm install` is all it needs; set `J2JS_REF_JSONATA=/path/to/jsonata/src/jsonata.js` to measure against a local checkout instead. It is not part of `npm test` — a 100,000-call benchmark against an async interpreter takes well over a minute, which is exactly the cost being measured.

## Architecture

```
source string
  -> src/parser/lexer.js + src/parser/parser.js   (S0xxx errors)
  -> src/optimizer/optimizer.js                    (constant folding, structural simplification)
  -> src/translator/translator.js                  (AST -> JS source string)
  -> src/loader/loader.js (vm.compileFunction)      (JS source -> callable function)
  -> src/index.js (JsonataExpression#evaluate)      (bindings, timeout, error mapping)
```

Runtime support the generated code calls into lives under `src/runtime/`: `values.js` (missing/null/sequence/truthy/equality/arithmetic semantics), `path.js` (tuple-based path navigation with parent-chain and `@$`/`#$` binding tracking), `hof.js` / `structural.js` / `lambda.js` (higher-order functions, group-by/transform, `~>` chain + tail-call trampoline), `builtins.js` (the assembled function registry), and the individual built-in-function modules (`string.js`, `numeric.js`, `datetime.js`, `regex.js`, `codec.js`, `core.js`, `collections.js`, `objects.js`).

## Sibling implementations

The same parse → optimise → translate → compile pipeline exists for three host runtimes:

| Runtime | Project                                                                                                                                                                                           | Host code it generates | Speedup vs. that runtime's reference interpreter |
|---|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---|---|
| JVM | [jsonata-jvm-compiler](https://github.com/vlad-public-code/org.json-kula.jsonata-jvm-compiler) (Java 21)                                                                                          | Java source, compiled in-memory by `javac` | ~40× vs [JSONata4Java](https://github.com/IBM/JSONata4Java) |
| JavaScript | [jsonata2js](https://github.com/vlad-public-code/org.json-kula.jsonata2js) (this project)                                                                                                                                                                     | a JS function, loaded via `node:vm`'s `compileFunction` | ~45-56× vs [`jsonata`](https://www.npmjs.com/package/jsonata) |
| Python | [jsonata2py](https://pypi.org/project/jsonata2py/) ([source](https://github.com/vlad-public-code/org.json-kula.jsonata2py), [docs](https://vlad-public-code.github.io/org.json-kula.jsonata2py/)) | Python source, compiled by the host `compile()` | ~26× vs [`jsonata-python`](https://pypi.org/project/jsonata-python/) |

The JVM implementation is the original, and is the compiler behind [valem.run](https://valem.run/)'s reactive computation engine.


## License

MIT — see [LICENSE]({{ site.github.repository_url }}/blob/main/LICENSE). The vendored runtime logic comes from [`jsonata`](https://www.npmjs.com/package/jsonata) (MIT).

## See also

- [jsonata-jvm-compiler](https://vlad-public-code.github.io/org.json-kula.jsonata-jvm-compiler/) — the Java sibling this library is ported from.
- [jsonata2py](https://vlad-public-code.github.io/org.json-kula.jsonata2py/) — the Python sibling of the same pipeline.
- [tracked-json](https://vlad-public-code.github.io/org.json-kula.tracked-json/) — Jackson JsonNode wrapper that tracks each node's location (JsonPointer) through every navigation; includes JSONPath (RFC 9535) and JSON Patch (RFC 6902).
- [Valem](https://vlad-public-code.github.io/org.json-kula.valem/) — deterministic reactive computation runtime built on the Java sibling compiler.
- [Valem Sandbox](https://valem.run/) — the hosted, zero-install demo.
