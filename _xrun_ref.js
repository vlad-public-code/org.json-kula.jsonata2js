'use strict';
// Oracle: evaluates [{id, expr, input}] with the REFERENCE jsonata interpreter.
// Writes {id: {ok: value} | {err: "eval:CODE"}} to argv[3].
const fs = require('fs');
const jsonata = require('jsonata');

// Cycle-safe stringify: only ANCESTORS on the current path count as circular,
// so a value legitimately repeated in a sequence still serialises.
function safe(o) {
    const stack = [];
    return JSON.stringify(o, function (k, v) {
        if (typeof v === 'function') return '<fn>';
        if (v === undefined) return null;
        if (v !== null && typeof v === 'object') {
            while (stack.length && !Object.is(stack[stack.length - 1], this)) stack.pop();
            if (stack.some((a) => Object.is(a, v))) return '<circular>';
            stack.push(v);
        }
        return v;
    });
}

(async () => {
    const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const out = {};
    for (const c of cases) {
        try {
            const v = await jsonata(c.expr).evaluate(c.input);
            out[c.id] = { ok: v === undefined ? null : v };
        } catch (e) {
            out[c.id] = { err: `eval:${e.code || e.constructor.name}` };
        }
    }
    fs.writeFileSync(process.argv[3], safe(out));
})();
