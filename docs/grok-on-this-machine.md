# Using `grok` on this machine

> **Ported from another project.** Everything below the invocation was written
> for a Python repository and measured there. This repository has no `tools/`
> directory and not one Python file — `tools/grok_adjudicate.py`,
> `tools/classify_alarms.py` and the two pytest files named later have never
> existed here, and the cost figures ($0.19 for thirty adjudications, $0.15 for
> twenty codings) are that project's, not this one's. What transfers is the
> command, the flags and the failure modes; what does not is every path and
> every number. Marked on 2026-09-07 after a subagent checked each reference and
> found none of them on disk.
>
> One correction rather than a caveat: a line below says *"Every call spends the
> owner's money."* It does not. Grok runs on SuperGrok Lite, a fixed monthly
> fee, and `CLAUDE.md` §13 and `docs/spend-counter.md` both classify its
> `total_cost_usd` as weight rather than a bill. One more call does not raise
> the invoice.

Hand this file to an agent that has to run Grok here. It states what is
installed, the one shape of call that is used, and the four ways a call can look
successful while proving nothing.

## What is installed

| Thing | Value |
|---|---|
| binary | `/Users/dimitar/.local/bin/grok` |
| version | `grok 1.0.13 (5e9a58528b76)` — print it and record it, do not assume |
| product | Grok Build CLI (a TUI with a headless mode) |
| account | the owner's **SuperGrok Lite** subscription, already logged in |
| model asked for | `grok-4.6` |
| model that answers | `grok-4.6-build` — they differ; record the one that answered |

Authentication is interactive and already done. Do **not** run `grok login`,
`grok logout`, or anything that touches `~/.grok`. There is no API key and none
is to be created: the owner decided on 2026-08-30 that an API key is never used.

## The only call shape used here

One process per question. No session, no resume, no retry.

```bash
grok -p "<the whole prompt>" \
     --model grok-4.6 \
     --sandbox read-only \
     --disallowed-tools bash,edit,write,read,web_search,web_fetch \
     --no-plan \
     --no-subagents \
     --json-schema '<a JSON Schema>' \
     --output-format json
```

What each flag is for:

| Flag | Why it is there |
|---|---|
| `-p` | single-turn headless mode: one user message, prints to stdout, exits |
| `--model` | pins the model; without it the default can move under you |
| `--sandbox read-only` | the call must not write anything |
| `--disallowed-tools …` | it must answer from the text it was given, not go looking |
| `--no-plan` | stops the call turning into a planning session |
| `--no-subagents` | one call is one call; subagents make the cost unbounded |
| `--json-schema` | constrains the output; implies `--output-format json` |
| `--output-format json` | passed anyway, so the shape is stated and not inferred |

Working examples in this repository: `tools/grok_adjudicate.py::ask` and
`tools/classify_alarms.py::ask`. Copy the shape from there rather than
reinventing it.

### `--max-turns 1` does not work

Tried on 2026-09-05: the call comes back with **"max turns reached"** and no
answer. The model needs one step to work and one to answer. What the protocol
wants is one *user message*, and `-p` gives that by construction.

## Reading the reply

`--output-format json` prints one JSON object on stdout. The fields that matter:

| Field | What it is |
|---|---|
| `structuredOutput` | the answer, matching the schema you passed |
| `sessionId` | identifies the conversation; must differ between calls |
| `requestId` | identifies the response; must differ between calls |
| `num_turns` | steps the model took *inside* this one call |
| `stopReason` | `end_turn` on a normal finish |
| `modelUsage` | a mapping whose keys name the model that **served** the call |
| `total_cost_usd` | notional price of the call |

## Four ways a call proves nothing

Each of these was live in this repository and had to be fixed. Check for all
four; recording a field and never reading it is a claim nothing enforces.

1. **Decoded is not shaped.** A reply of `[]` or `"ok"` parses as JSON and then
   raises on the first `.get`. Check `isinstance(body, dict)` and refuse with a
   message, do not crash.

2. **A missing identifier is not agreement.** A reply with no `sessionId` still
   produced a verdict and exit 0 until this was checked. Require `sessionId` and
   `requestId` to be non-empty strings.

3. **A repeated identifier means one context answered twice.** If two calls come
   back with the same `sessionId`, they were not separate contexts; if they share
   a `requestId`, one answer is being counted twice. Both are refusals (exit 2),
   not booleans written into an artifact for nobody to read.

4. **`num_turns` is not evidence about context.** It measures the agent's
   internal loop inside a single invocation — a cost and runaway signal. A real
   reply came back with eleven turns on 2026-09-05. Record it; do **not** cap it,
   and never report a high count as "the context was not fresh". `modelUsage`
   also arrived once as a string rather than a mapping, so guard the `.keys()`.

## Cost, and the rule about it

Every call spends the owner's money. **A subagent never spends money** — if you
are a subagent, you do not run `grok` at all, and you do not run `claude`,
`tools/pair_corpus.py`, `tools/run_queue.py`, `tools/experiment.py run`,
`tools/injection_corpus.py`, `tools/grok_adjudicate.py` or
`tools/classify_alarms.py` either.

If you are the main agent: ask the owner before spending, every time, with the
number. Thirty adjudications cost about $0.19 measured; twenty codings about
$0.15. Record `total_cost_usd` from each reply rather than estimating.

## Testing code that calls `grok`

Replace the subprocess boundary, never the binary. `tests/test_grok_adjudicate.py`
and `tests/test_classify_alarms.py` both monkeypatch `subprocess.run` and hand
back a `CompletedProcess` with a JSON body, so the suite runs offline and spends
nothing. Copy that. A test that shells out to `grok` costs money on every run and
fails when the network is down.

`pytest` on this machine must go through a pipe, or the `rtk` hook rewrites it
and it dies:

```bash
PYTHONPATH=src python3 -m pytest tests/ -q 2>&1 | tail -3
```
