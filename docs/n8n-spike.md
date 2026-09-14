# n8n spike — what the Code node can really do

Measured on **2026-09-04** on `dimitarshenkov.app.n8n.cloud`, with **two**
executions of one temporary workflow that was deleted immediately afterwards.

Codex asked for this spike in the very first round of the plan, with a rationale
worth repeating: *"Credentials should validate—not first reveal—the architecture."*
It turned out right — three of the things below disprove assumptions that chunk 1
would have been written on.

The numbers here are from a **run**, not from documentation. Where the
documentation says otherwise, that is noted.

---

## 1. Modules go through an allowlist, not a blocklist

The message on refusal is `Module 'X' is disallowed` — the phrasing of a permitted
list, not a forbidden one.

**Nineteen names were tried; two passed.** This does not establish the whole
allowlist: it is not known how many modules are permitted, only that of these
nineteen, two load. Another module might pass; it is checked by trying, not by
assuming.

| Module | Result |
|---|---|
| `crypto` | **works** — `createHash('sha256')` returned a hash |
| `moment` | **works** |
| `node:crypto` | disallowed — the `node:` prefix does **not** pass, even though `crypto` passes |
| `util` `path` `buffer` `fs` `child_process` `http` `url` `zlib` `events` `assert` | disallowed |
| `luxon` `axios` `lodash` `ajv` `cheerio` `uuid` | disallowed |

**The most important row is `ajv`.** The project's validator rests on it, and it
**cannot be imported** into the Code node. See §5 for what follows from this.

## 2. What is missing from the global scope

| Global | Present? |
|---|---|
| `require` | **yes**, `typeof === "function"`; of 19 names tried it loaded two |
| `module` | yes, only with `exports` |
| `Buffer` `setTimeout` `TextEncoder` | yes |
| `process` | **no** — no node version, no `process.env` |
| `fetch` | **no** |
| `crypto` (global) | **no** — only through `require('crypto')` |
| `structuredClone` | **no** |
| `require.resolve` | **no** |

`process` is missing entirely, that is, **the runtime version is not
establishable from inside**. The language features do work, though: optional
chaining, nullish coalescing, `async`, `Map`, `TextEncoder` — all passed.

## 3. What n8n gives instead of them

| Name | What it is |
|---|---|
| `DateTime` | luxon, as a **global** — even though `require('luxon')` is forbidden |
| `$jmespath` | a function, global |
| `this.helpers` | `httpRequest`, `request`, `httpRequestWithAuthentication`, and four for binary data |

**HTTP requests are possible** — through `this.helpers.httpRequest`, not through
`fetch`.

## 4. Small things that cost time if you do not know them

* The execution time zone is **UTC**.
* `$node.name` gives `ERR:Referenced node doesn't exist` inside its own node.
* `$workflow.id`, `$execution.id` and `$execution.mode` work.
* The webhook receives a whole object with `headers`, `params`, `query`, `body` — the body
  is in `body`, not at the root.
* A workflow **must be active** for the webhook to be called through the API.
  Without `N8N_MCP_ACCESS_TOKEN` a workflow without a trigger cannot be run at all.
* The LangChain Code node **does not exist** on Cloud, only on self-hosted.
* Code node v2 also offers `pythonNative`, but Python has no `$` syntax and no
  helpers — only `_items` and `_item`. **Whether Python can import packages was not
  tried** — all trials were on JavaScript.

## 5. What follows for chunk 1

**The code is embedded, not imported.** The shared core **was not imported through
any of the tried mechanisms** — a package name through `require`. Relative and
absolute paths were not tried. `require('fs')` is disallowed, which is a reason to
expect that they will not work — but expectation is not measurement, and that is
not asserted here as established.

The workflow receives **generated, self-contained JavaScript**; the source of
truth stays one, but the artifact is inline.

**Validation cannot use ajv in the usual way.** `require('ajv')` is disallowed.
**It has been verified that ajv standalone works — see §6.**

The output is **one**, not two. A hand-written validator means the same rule in
two places, and that is forbidden by a recorded decision — "one validator, not
two", 2026-09-04. The next spike checks **ajv standalone**: ajv compiles the schema
ahead of time into pure JavaScript with no dependencies, which is embedded.

If this spike fails, that does **not** make the hand-written validator equivalent
automatically — it forces a reconsideration of the recorded decision, which is
separate work with a separate judgement.

**What stayed unestablished, on purpose:** maximum memory, maximum payload size,
execution timeout. Codex was explicit: one successful execution cannot establish
them, and a deliberate failure would waste the single measurement. They are
recorded as `could-not-establish`, not as assumed numbers.

---

# Spike 2 — ajv standalone in the Code node

Measured on **2026-09-04**, one execution, workflow deleted; the instance was
checked and is empty.

## 6. The result: it works

`ajv` compiles the schemas ahead of time into standalone JavaScript. How much of
it is really standalone:

| Step | Remaining `require` | Bytes |
|---|---|---|
| `standaloneCode` with `addFormats` | 2 — `ajv/dist/runtime/ucs2length`, `ajv-formats/dist/formats` | 126 640 |
| only `date-time` as a regex, without `ajv-formats` | 1 — `ucs2length` | 126 612 |
| `ucs2length` embedded by hand (808 bytes, 20 lines) | **0** | 126 809 |

The schemas use exactly **one** format — `date-time` — so the whole `ajv-formats`
falls away against one regex. `ucs2length` is twenty lines and is embedded.

## 7. Agreement with the live ajv over a chosen sample

Before anything at all was run, the generated artifact was compared with the live
ajv over sixteen objects — valid and invalid, and across all four schemas.

**They agree on all 16.** And that is exactly why the sentence must be read
carefully: this is a **smoke test, not proof of identical behaviour.** Sixteen
objects establish agreement over sixteen objects. What was not tried is not
established.

## 8. What the Code node execution showed

| Check | Result |
|---|---|
| 126 KB of code in `jsCode` | **accepted**; the workflow payload is 134 KB |
| all four validators are present | `v_incident`, `v_agent_result`, `v_conversation`, `v_remediation` |
| a valid incident passes | yes |
| an empty observation is refused | yes |
| a typo key at the top level is refused | yes |
| a wrong date format is refused | yes |
| **cross-file `$ref` to `common.schema.json` works** | yes — a cited source outside the list is refused |
| the error messages | **for the tried refusals** they match ajv: `instancePath`, `schemaPath`, `keyword`, `params` |

The second-to-last row is important: the shared definitions are in a separate
file, and the Code node has no filesystem. The standalone compilation embedded them
and the reference works.

## 9. How it is embedded in the node

The Code node has no module system: `exports` is `undefined`, and `module` carries
only an empty `exports`. The generated CommonJS is therefore wrapped:

```js
const module = { exports: {} };
const exports = module.exports;
(function (module, exports) {
  /* the generated code */
})(module, exports);
const V = module.exports;
```

## 10. A defect found during the check itself: the format became a second carrier

To drop `ajv-formats`, I registered `date-time` as **my own** regex. It looked
harmless, because the schemas use only this format. It is not.

Twenty strings compared against `ajv-formats`: **seven diverge**, and in both
directions.

| Input | `ajv-formats` | my regex |
|---|---|---|
| `2026-13-04T10:30:00Z` (month 13) | refuses | **accepts** |
| `2026-02-30T10:30:00Z` (February 30) | refuses | **accepts** |
| `2026-09-31T10:30:00Z` (September 31) | refuses | **accepts** |
| `2026-09-04T25:30:00Z` (hour 25) | refuses | **accepts** |
| `2026-09-04T10:60:00Z` (minute 60) | refuses | **accepts** |
| `2026-09-04 10:30:00Z` (space instead of `T`) | accepts | refuses |
| `2026-09-04T10:30:00+0200` (no colon) | accepts | refuses |

That is, the deployed validator would accept dates the local one refuses — **one
rule with two behaviours**, exactly the defect this project catches everywhere.

`ajv-formats` has two modes, and this explains the difference:

| Mode | What it does |
|---|---|
| `fast` | pure regex — embeddable as is |
| `full` (default) | a function: days in the month, leap year, `23:59:60` |

**A requirement for chunk 1, not a suggestion:** the format is defined in **one
place** in the repo and is used by both the local validator and the generator. No
own regex is written. If `fast` is chosen, that is a decision with a date and a
rationale, not a side effect of the wish to drop one `require`.

In the repo today there is **no** defect — `validate.ts` uses `addFormats`, and my
regex lived only in the spike script, which is deleted. The defect is in the plan
for the generator and is caught before it is written.

## 11. Embedding `ucs2length` is an unprotected transformation

The replacement is textual: `require("ajv/dist/runtime/ucs2length").default` is
searched for and the function is put in. If ajv is updated, this can break
**silently**:

| What can happen | Is it noticed |
|---|---|
| the replacement does not happen at all | **yes** — if the generator insists on zero remaining `require` |
| the replacement catches a different fragment | **not necessarily** |
| ajv changes the helper's behaviour, while the embedded copy stays frozen | **no** — unless exactly this input is tested |

**Requirements for the generator in chunk 1**, each of which is a check, not a note:

* exactly **one** replacement — neither zero nor two;
* **zero** remaining `require` in the artifact, as a success condition;
* differential tests over lengths in Unicode (surrogate pairs, emoji) and over the
  boundaries of `date-time`.

Without them, "I embedded it" is a claim that nothing checks.

## 12. What remains unmeasured

The upper bound for the size of `jsCode` — 126 KB pass, where the ceiling is has
not been searched for. The compilation time on each execution was not measured
separately. Both stay `could-not-establish`.
