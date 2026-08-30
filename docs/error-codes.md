---
title: jsonata2js error-code reference
description: Every JSONata error code the compiler and runtime can raise, with its message template and whether this implementation throws it.
---

Every error jsonata2js can throw carries a JSONata-standard `.code` (see `src/errors.js`'s `ERROR_MESSAGES`, vendored verbatim from `jsonata`'s own error-code catalogue, plus one jsonata2js-specific addition — `U1002`, below). This table lists every code in that catalogue. Most are actively thrown by jsonata2js's own runtime/parser/optimizer/translator; a handful are catalogued but never thrown by this implementation (marked "not thrown" below): `D1011`/`D1012` (jsonata-interpreter-specific — jsonata2js's own timeout/recursion-depth guard uses `U1001` for both cases instead, see README.md's "Known limitations"), `S0206` (this parser never reaches an "unknown expression type" state — every token it fails to parse is reported through a more specific `S02xx`/`S0211` code instead), `D1013` (the `_jsonata_`-prefixed reserved-property-name check is not implemented — reference `jsonata` itself does not raise it for that input either, so this is a dead code in both projects, not a divergence), and `D2015` ("maximum sequence length exceeded" — jsonata2js has no sequence-length cap of its own).

| Code | Category | Message template | Notes |
|---|---|---|---|
| `D1001` | Evaluator (D1xxx) | Number out of range: {{value}} | |
| `D1002` | Evaluator (D1xxx) | Cannot negate a non-numeric value: {{value}} | |
| `D1004` | Evaluator (D1xxx) | Regular expression matches zero length string | |
| `D1009` | Evaluator (D1xxx) | Multiple key definitions evaluate to same key: {{value}} | |
| `D1011` | Evaluator (D1xxx) | Stack overflow. Check for non-terminating recursive function.  Consider rewriting as tail-recursive | *not thrown by this implementation — see intro* |
| `D1012` | Evaluator (D1xxx) | Evaluation timeout after {{value}} milliseconds. Check for infinite loop | *not thrown by this implementation — see intro* |
| `D1013` | Evaluator (D1xxx) | Object property names starting with _jsonata_ are reserved for internal use: {{value}} | *not thrown by this implementation — see intro* |
| `D2014` | Operator (D2xxx) | The size of the sequence allocated by the range operator (..) must not exceed 1e7.  Attempted to allocate {{value}}. | |
| `D2015` | Operator (D2xxx) | The maximum sequence length of {{value}} was exceeded. | *not thrown by this implementation — see intro* |
| `D3001` | Built-in function (D3xxx) | Attempting to invoke string function on Infinity or NaN | |
| `D3010` | Built-in function (D3xxx) | Second argument of replace function cannot be an empty string | |
| `D3011` | Built-in function (D3xxx) | Fourth argument of replace function must evaluate to a positive number | |
| `D3012` | Built-in function (D3xxx) | Attempted to replace a matched string with a non-string value | |
| `D3020` | Built-in function (D3xxx) | Third argument of split function must evaluate to a positive number | |
| `D3030` | Built-in function (D3xxx) | Unable to cast value to a number: {{value}} | |
| `D3040` | Built-in function (D3xxx) | Third argument of match function must evaluate to a positive number | |
| `D3050` | Built-in function (D3xxx) | The second argument of reduce function must be a function with at least two arguments | |
| `D3060` | Built-in function (D3xxx) | The sqrt function cannot be applied to a negative number: {{value}} | |
| `D3061` | Built-in function (D3xxx) | The power function has resulted in a value that cannot be represented as a JSON number: base={{value}}, exponent={{exp}} | |
| `D3070` | Built-in function (D3xxx) | The single argument form of the sort function can only be applied to an array of strings or an array of numbers.  Use the second argument to specify a comparison function | |
| `D3080` | Built-in function (D3xxx) | The picture string must only contain a maximum of two sub-pictures | |
| `D3081` | Built-in function (D3xxx) | The sub-picture must not contain more than one instance of the 'decimal-separator' character | |
| `D3082` | Built-in function (D3xxx) | The sub-picture must not contain more than one instance of the 'percent' character | |
| `D3083` | Built-in function (D3xxx) | The sub-picture must not contain more than one instance of the 'per-mille' character | |
| `D3084` | Built-in function (D3xxx) | The sub-picture must not contain both a 'percent' and a 'per-mille' character | |
| `D3085` | Built-in function (D3xxx) | The mantissa part of a sub-picture must contain at least one character that is either an 'optional digit character' or a member of the 'decimal digit family' | |
| `D3086` | Built-in function (D3xxx) | The sub-picture must not contain a passive character that is preceded by an active character and that is followed by another active character | |
| `D3087` | Built-in function (D3xxx) | The sub-picture must not contain a 'grouping-separator' character that appears adjacent to a 'decimal-separator' character | |
| `D3088` | Built-in function (D3xxx) | The sub-picture must not contain a 'grouping-separator' at the end of the integer part | |
| `D3089` | Built-in function (D3xxx) | The sub-picture must not contain two adjacent instances of the 'grouping-separator' character | |
| `D3090` | Built-in function (D3xxx) | The integer part of the sub-picture must not contain a member of the 'decimal digit family' that is followed by an instance of the 'optional digit character' | |
| `D3091` | Built-in function (D3xxx) | The fractional part of the sub-picture must not contain an instance of the 'optional digit character' that is followed by a member of the 'decimal digit family' | |
| `D3092` | Built-in function (D3xxx) | A sub-picture that contains a 'percent' or 'per-mille' character must not contain a character treated as an 'exponent-separator' | |
| `D3093` | Built-in function (D3xxx) | The exponent part of the sub-picture must comprise only of one or more characters that are members of the 'decimal digit family' | |
| `D3100` | Built-in function (D3xxx) | The radix of the formatBase function must be between 2 and 36.  It was given {{value}} | |
| `D3110` | Built-in function (D3xxx) | The argument of the toMillis function must be an ISO 8601 formatted timestamp. Given {{value}} | |
| `D3120` | Built-in function (D3xxx) | Syntax error in expression passed to function eval: {{value}} | |
| `D3121` | Built-in function (D3xxx) | Dynamic error evaluating the expression passed to function eval: {{value}} | |
| `D3130` | Built-in function (D3xxx) | Formatting or parsing an integer as a sequence starting with {{value}} is not supported by this implementation | |
| `D3131` | Built-in function (D3xxx) | In a decimal digit pattern, all digits must be from the same decimal group | |
| `D3132` | Built-in function (D3xxx) | Unknown component specifier {{value}} in date/time picture string | |
| `D3133` | Built-in function (D3xxx) | The 'name' modifier can only be applied to months and days in the date/time picture string, not {{value}} | |
| `D3134` | Built-in function (D3xxx) | The timezone integer format specifier cannot have more than four digits | |
| `D3135` | Built-in function (D3xxx) | No matching closing bracket ']' in date/time picture string | |
| `D3136` | Built-in function (D3xxx) | The date/time picture string is missing specifiers required to parse the timestamp | |
| `D3137` | Built-in function (D3xxx) | {{{message}}} | |
| `D3138` | Built-in function (D3xxx) | The $single() function expected exactly 1 matching result.  Instead it matched more. | |
| `D3139` | Built-in function (D3xxx) | The $single() function expected exactly 1 matching result.  Instead it matched 0. | |
| `D3140` | Built-in function (D3xxx) | Malformed URL passed to ${{{functionName}}}(): {{value}} | |
| `D3141` | Built-in function (D3xxx) | {{{message}}} | |
| `S0101` | Parse (S0xxx) | String literal must be terminated by a matching quote | |
| `S0102` | Parse (S0xxx) | Number out of range: {{token}} | |
| `S0103` | Parse (S0xxx) | Unsupported escape sequence: \{{token}} | |
| `S0104` | Parse (S0xxx) | The escape sequence \u must be followed by 4 hex digits | |
| `S0105` | Parse (S0xxx) | Quoted property name must be terminated with a backquote (`) | |
| `S0106` | Parse (S0xxx) | Comment has no closing tag | |
| `S0201` | Parse (S0xxx) | Syntax error: {{token}} | |
| `S0202` | Parse (S0xxx) | Expected {{value}}, got {{token}} | |
| `S0203` | Parse (S0xxx) | Expected {{value}} before end of expression | |
| `S0204` | Parse (S0xxx) | Unknown operator: {{token}} | |
| `S0205` | Parse (S0xxx) | Unexpected token: {{token}} | |
| `S0206` | Parse (S0xxx) | Unknown expression type: {{token}} | *not thrown by this implementation — see intro* |
| `S0207` | Parse (S0xxx) | Unexpected end of expression | |
| `S0208` | Parse (S0xxx) | Parameter {{value}} of function definition must be a variable name (start with $) | |
| `S0209` | Parse (S0xxx) | A predicate cannot follow a grouping expression in a step | |
| `S0210` | Parse (S0xxx) | Each step can only have one grouping expression | |
| `S0211` | Parse (S0xxx) | The symbol {{token}} cannot be used as a unary operator | |
| `S0212` | Parse (S0xxx) | The left side of := must be a variable name (start with $) | |
| `S0213` | Parse (S0xxx) | The literal value {{value}} cannot be used as a step within a path expression | |
| `S0214` | Parse (S0xxx) | The right side of {{token}} must be a variable name (start with $) | |
| `S0215` | Parse (S0xxx) | A context variable binding must precede any predicates on a step | |
| `S0216` | Parse (S0xxx) | A context variable binding must precede the 'order-by' clause on a step | |
| `S0217` | Parse (S0xxx) | The object representing the 'parent' cannot be derived from this expression | |
| `S0301` | Parse (S0xxx) | Empty regular expressions are not allowed | |
| `S0302` | Parse (S0xxx) | No terminating / in regular expression | |
| `S0401` | Parse (S0xxx) | Type parameters can only be applied to functions and arrays | |
| `S0402` | Parse (S0xxx) | Choice groups containing parameterized types are not supported | |
| `S0500` | Parse (S0xxx) | Attempted to evaluate an expression containing syntax error(s) | |
| `T0410` | Runtime type/signature (T0xxx) | Argument {{index}} of function {{token}} does not match function signature | |
| `T0411` | Runtime type/signature (T0xxx) | Context value is not a compatible type with argument {{index}} of function {{token}} | |
| `T0412` | Runtime type/signature (T0xxx) | Argument {{index}} of function {{token}} must be an array of {{type}} | |
| `T1003` | Runtime type (T1xxx) | Key in object structure must evaluate to a string; got: {{value}} | |
| `T1005` | Runtime type (T1xxx) | Attempted to invoke a non-function. Did you mean ${{{token}}}? | |
| `T1006` | Runtime type (T1xxx) | Attempted to invoke a non-function | |
| `T1007` | Runtime type (T1xxx) | Attempted to partially apply a non-function. Did you mean ${{{token}}}? | |
| `T1008` | Runtime type (T1xxx) | Attempted to partially apply a non-function | |
| `T1010` | Runtime type (T1xxx) | The matcher function argument passed to function {{token}} does not return the correct object structure | |
| `T2001` | Operator type (T2xxx) | The left side of the {{token}} operator must evaluate to a number | |
| `T2002` | Operator type (T2xxx) | The right side of the {{token}} operator must evaluate to a number | |
| `T2003` | Operator type (T2xxx) | The left side of the range operator (..) must evaluate to an integer | |
| `T2004` | Operator type (T2xxx) | The right side of the range operator (..) must evaluate to an integer | |
| `T2006` | Operator type (T2xxx) | The right side of the function application operator ~> must be a function | Also reused (same code, a different message) by `compileLibrary()` when a library export doesn't evaluate to a function value, and when a closed library's export is called after `close()` — see README.md. |
| `T2007` | Operator type (T2xxx) | Type mismatch when comparing values {{value}} and {{value2}} in order-by clause | |
| `T2008` | Operator type (T2xxx) | The expressions within an order-by clause must evaluate to numeric or string values | |
| `T2009` | Operator type (T2xxx) | The values {{value}} and {{value2}} either side of operator {{token}} must be of the same data type | |
| `T2010` | Operator type (T2xxx) | The expressions either side of operator {{token}} must evaluate to numeric or string values | |
| `T2011` | Operator type (T2xxx) | The insert/update clause of the transform expression must evaluate to an object: {{value}} | |
| `T2012` | Operator type (T2xxx) | The delete clause of the transform expression must evaluate to a string or array of strings: {{value}} | |
| `T2013` | Operator type (T2xxx) | The transform expression clones the input object using the $clone() function.  This has been overridden in the current scope by a non-function. | |
| `U1001` | Resource (U1xxx) | Expression evaluation timeout or stack overflow: Check for infinite loop or non-terminating recursive function | |
| `U1002` | Internal/loader (U1xxx) | Internal error: generated code failed to compile | jsonata2js-specific (not in jsonata's own catalogue) — thrown only if `vm.compileFunction` rejects the translator's own generated source as invalid JavaScript, which should never happen for any valid JSONata input (`src/loader/loader.js`, `src/index.js`). |
