'use strict';

/**
 * `$now()` / `$millis()` support.
 *
 * jsonata fixes a single "current timestamp" once per top-level `evaluate()`
 * call (see jsonata/src/jsonata.js: `timestamp = new Date()` is captured
 * right before the expression tree is evaluated, and every `$now()`/
 * `$millis()` call within that one evaluation reads the same fixed value —
 * they do NOT each call `Date.now()` independently).
 *
 * Integration contract for the code-generation/public-API layer:
 *   Call `createClock()` exactly ONCE per top-level `evaluate()` invocation
 *   (never once per `$now()`/`$millis()` call site within that evaluation),
 *   and `pushClock()` it for the duration of that call (`popClock()` in a
 *   `finally`). Pass the returned `.now`/`.millis` methods in as the
 *   runtime implementations bound to the generated code's `$now`/`$millis`
 *   calls for that single evaluation. A fresh `evaluate()` call must call
 *   `createClock()` again to get a new snapshot. `$eval` (which compiles
 *   and runs a second expression *within* the current evaluation) MUST
 *   read `currentClock()` instead of calling `createClock()` itself -
 *   otherwise `$now()`/`$millis()` observably disagree between the outer
 *   expression and an `$eval`'d one in the same evaluation (see
 *   CODE-REVIEW.md M1).
 */

// Lazily required: formatting `$now()` needs `datetime.js`, but taking the
// timestamp snapshot does not, and an expression that never calls `$now()`
// with a picture string should not pull 50 KB of picture-string machinery
// into `require('jsonata2js')` (see builtins.js's own lazy `DT`).
let _fn_fromMillis = null;
const fromMillis = (millis, picture, timezone) => {
  if (_fn_fromMillis === null) _fn_fromMillis = require('./datetime').fn_fromMillis;
  return _fn_fromMillis(millis, picture, timezone);
};

/**
 * @returns {{now: function(string=, string=): string, millis: function(): number}}
 *   `now(picture, timezone)` — `$now()`, formats the snapshot via `fn_fromMillis`.
 *   `millis()` — `$millis()`, the snapshot in epoch milliseconds.
 */
function createClock() {
  const snapshotMillis = Date.now();

  return {
    now(picture, timezone) {
      return fromMillis(snapshotMillis, picture, timezone);
    },
    millis() {
      return snapshotMillis;
    }
  };
}

// Stack of active per-top-level-evaluate() clock snapshots, supporting
// nested `$eval` calls (mirrors `lambda.js`'s `_deadlineStack`/
// `_maxDepthStack`): `$eval` must NOT call `createClock()` itself - doing
// so takes a second, later `Date.now()` snapshot, breaking the "one fixed
// timestamp per top-level evaluate()" contract documented above (see
// CODE-REVIEW.md M1) - it instead reuses whatever the innermost active
// `evaluate()` call already pushed here.
const _clockStack = [];

function pushClock(clock) {
  _clockStack.push(clock);
}

function popClock() {
  _clockStack.pop();
}

/**
 * The innermost active top-level `evaluate()`'s clock snapshot. Falls back
 * to a fresh one-off `createClock()` if none is active (defensive: e.g. a
 * unit test calling `$eval`-driving code directly, outside a real
 * `JsonataExpression#evaluate()` call).
 */
function currentClock() {
  return _clockStack.length > 0 ? _clockStack[_clockStack.length - 1] : createClock();
}

module.exports = { createClock, pushClock, popClock, currentClock };
