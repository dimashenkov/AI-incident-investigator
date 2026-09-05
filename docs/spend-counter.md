# A spend counter that does not lie

Hand this file to an agent starting any project where a model, an API or a
metered service is called. It states what to build, why each part is there, and
the four ways such a counter goes wrong. Every rule here is here because
breaking it already produced a wrong number.

The owner's requirement, in one line: **at the end, know what the project cost.**

## The shape

One script, one command, read by a human and by CI:

```
node scripts/spend.mjs      # prints the report, exits 0 / 2
```

It reads **artifacts on disk**, never memory and never the conversation. A cost
an agent recalls is a cost an agent invented.

Each recorded run is one JSON file under `docs/runs/`, holding at least:

```json
{
  "when": "2026-09-05",
  "model": "gpt-4o-mini-2024-07-18",
  "totals": { "input_tokens": 823, "output_tokens": 260 }
}
```

Prices live **in the script**, as a table with the date each was read:

```js
export const PRICES = {
  "gpt-4o-mini-2024-07-18": { input: 0.15, output: 0.60, read: "2026-09-05" },
};
```

Written down rather than fetched. A price the script looks up makes the report
change under a reader for reasons that have nothing to do with the work. Stale
is visible; silently moving is not.

## The four ways it goes wrong

### 1. An unpriced run counted as zero

The most common, and it is the general defect of reading a missing value as
consent. A run whose model has no recorded price is **not a free run**.

Three states, never two: `measured`, `unknown`, and — for the file itself —
unreadable. An `unknown` carries a reason and **no number anyone could add up**:

```js
if (price === undefined) {
  return { state: "unknown", why: `no recorded price for ${model}; add it with the date it was read` };
}
```

The exit code follows: `0` when everything was priced, `2` when anything could
not be. A human reads the report; CI reads only the number.

When anything is unknown, the printed total says what it is:

```
    measured total: $0.0015
    1 run(s) could not be priced — the total above is a floor, not the answer
```

### 2. Money nobody paid, added in

**Classification comes from the billing arrangement, not from the tool's name.**

Codex, reviewing this file on 2026-09-05, named the way it would be misapplied:
another project may call the very same tools through a metered API, and then
they ARE spending. Do not copy a list of tool names out of here. For each tool
the project calls, answer one question and write the answer down:

> If we make one more call right now, does a bill go up?

* **Yes** → metered. Every call is recorded as an artifact and counted.
* **No, it is a flat fee** → subscription. Listed in the report, never summed.

The trap is the second kind. A per-call number reported by a flat-fee tool is
**not an expense** — it is what the call would have cost at API prices, a
measure of weight. It is the most tempting number in any such project because it
looks exactly like an invoice.

In THIS project the answer happened to be: n8n model calls are metered; Codex
and Grok are flat-fee subscriptions. In yours it may be the opposite. Write down
which, and the date you established it, so nobody re-derives it from the name.

So the report has two sections, and they are never summed:

```
  Paid model calls — real credits, from recorded runs:
    ...
  On a subscription, so not part of that number:
    <tool>  — flat monthly fee; one more run does not move the bill
```

### 3. A run nobody wrote down

A call that happened and was never recorded makes every total a floor while
looking like an answer. The counter cannot see it, and nothing will ever notice.

So: **the artifact is written when the call is made**, not at the end. If a past
call is being reconstructed from notes, the file says so in its own text —
`"recorded": "after the fact, from the round log"` — because a reconstructed
number and a captured one are different kinds of evidence.

### 4. A cost the counter cannot see, silently omitted

Some spending is invisible to the repository — most obviously the agent session
itself, billed to a plan the script cannot read. Whether it is the largest cost
is **not** something this file can tell you; it is not measured, and asserting
it would be the same defect the counter exists to prevent. What is certain is
that the counter cannot see it.

A total that omits an unmeasurable cost without saying so is the claim being
larger than the evidence, in the report whose entire job is to be an honest
number. So the report names what it cannot count:

```
  Not counted anywhere, and nothing here can count it:
    the agent session, billed to a plan rather than to this repository
```

List whatever else applies in your project: CI minutes, a hosted database, a
seat licence. The test is not "is it large" but "does the counter see it".

## The tests that make it real

A counter without these is decoration. Each of these fails if the corresponding
defect is reintroduced:

| Test | What it holds |
|---|---|
| prices a recorded run from its tokens and price | the arithmetic |
| says it could not establish rather than counting zero | four unpriceable shapes, each must be `unknown` and carry no number |
| reads every run on disk | the list is not a hand-written subset |
| prices every run actually on disk today | adding a run with an unpriced model fails loudly |
| keeps subscription tools out of the total | asserted against the report's OUTPUT, not the source text |
| names what it cannot count | asserted against the output, same reason |

Two of these deserve emphasis because they are easy to write vacuously:

* the "reads every run" test must assert `expect(onDisk.length).toBeGreaterThan(0)`
  first, or it passes on an empty directory forever;
* the "could not establish" test must assert `expect(r.usd).toBeUndefined()`,
  not only that the state is `unknown` — a state that says unknown while
  carrying a zero still gets summed by the next person;
* any test that greps the script's SOURCE for a sentence passes on the comment
  that explains the sentence. Codex found exactly that here: the report lines
  could be deleted while the phrases survived in the header comment. Run the
  report and assert against its output.

## What to write in the project's rules

Two sentences, in the file the agent reads every session:

> Every call that bills a metered service is recorded as a JSON artifact when it
> is made. `node scripts/spend.mjs` is the only answer to "what has this cost",
> and it separates metered spend from flat subscriptions rather than summing
> them.
