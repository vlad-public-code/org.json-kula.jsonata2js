// Type definitions for jsonata2js
// Mirrors the style of jsonata's own `jsonata.d.ts`.

declare namespace jsonata2js {
  /** Base of every error jsonata2js throws; `.code` is a JSONata-standard error code (see docs/error-codes.md). */
  class JsonataError extends Error {
    code: string;
    [extra: string]: unknown;
  }

  /** Thrown by `compile`/`compileAll` on invalid expression syntax (S0xxx codes). */
  class ParseError extends JsonataError {
    position: number;
  }

  /** Thrown by `compile`/`compileAll`/`compileLibrary` when compilation fails end-to-end. `.cause`, when set, is the underlying `ParseError` for a syntax error, and `.position` is copied through from it. `compileAll`'s error additionally carries `.failures`/`.results` identifying every failing expression without discarding the ones that compiled. */
  class JsonataCompilationError extends JsonataError {
    cause?: Error;
    position?: number;
    failures?: Array<{ index: number; source: string; code: string; message: string }>;
    results?: Array<JsonataExpression | undefined>;
  }

  /** Internal: generated JS source failed to load; never reachable from valid JSONata input. */
  class JsonataLoadError extends JsonataError {
    cause?: Error;
  }

  /** Thrown from inside a compiled expression at `evaluate()` time (T0xxx/T1xxx/T2xxx/D1xxx/D2xxx/D3xxx/U1001). */
  class JsonataEvaluationError extends JsonataError {
    token?: string;
    value?: unknown;
    value2?: unknown;
    position?: number;
  }

  type Bindings = Record<string, unknown>;

  /** A JSONata function value: a native JS function usable as a JSONata callback/registered function. */
  type JsonataFunction = (...args: unknown[]) => unknown;

  interface CompiledLibrary {
    readonly __jsonataLibraryExports: Record<string, JsonataFunction>;
    /** Closes the library: every export throws `T2006` instead of running from this point on. */
    close(): void;
  }

  class JsonataExpression {
    /** Evaluates the compiled expression against `input`, with optional one-shot `bindings`. */
    evaluate(input: unknown, bindings?: Bindings): unknown;

    /** Binds `name` to `value` for every future `evaluate()` call on this expression. Returns `this`. */
    assign(name: string, value: unknown): this;

    /**
     * Registers a native JS function as a callable JSONata function value.
     * `signature` (optional) is a `<params:return>` string; when given,
     * argument count and type are validated against it before every call
     * (declared arity also comes from it, used instead of `fn.length` when
     * `fn.length` is unreliable, e.g. a variadic/rest-parameter function).
     * Returns `this`.
     */
    registerFunction(name: string, fn: JsonataFunction, signature?: string): this;

    /** Merges every export of `library` (a plain `{name: fn}` object or a `compileLibrary()` result) as bound functions. Returns `this`. */
    useLibrary(library: CompiledLibrary | Record<string, JsonataFunction>): this;

    /** Sets an evaluation wall-clock timeout in milliseconds; throws `U1001` past the deadline. Returns `this`. */
    setTimeout(ms: number): this;

    /** Sets a non-tail-recursion depth guardrail (weighted by each called function's estimated evaluation cost, not a flat count); throws `U1001` past it. Returns `this`. */
    setMaxDepth(n: number): this;

    /** Returns the original JSONata source text this expression was compiled from. */
    getSourceJsonata(): string;
  }

  /** Compiles a single JSONata expression string. Throws `JsonataCompilationError` on invalid input. */
  function compile(exprSource: string): JsonataExpression;

  /** Compiles multiple JSONata expression strings; returns compiled expressions in the same order when every one succeeds. If any fail, throws a `JsonataCompilationError` whose `.failures`/`.results` identify which failed and preserve every expression that DID compile - see `JsonataCompilationError`. */
  function compileAll(exprSources: string[]): JsonataExpression[];

  /**
   * Compiles a library definition (`{ exportName: 'jsonata expression source' }`,
   * each expression evaluating to a function value) into a `CompiledLibrary`
   * suitable for `JsonataExpression#useLibrary`.
   */
  function compileLibrary(
    definition: Record<string, string>,
    options?: { bindings?: Bindings }
  ): CompiledLibrary;
}

export = jsonata2js;
