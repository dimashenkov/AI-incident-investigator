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

## Corrected on 2026-09-10 — `read` is ALLOWED, and paths are given

The owner, seeing a review whose prompt carried pasted code: *„you mean to say
you don't give Grok a files path — that's not ok."* He is right, and the reason
is the same one §6 gives for a hostile mandate: **when I paste excerpts, I am
choosing what the reviewer sees, and that is a map of what I already know.**

`read` was in `--disallowed-tools` below. Nothing measured required it — it was
written to make the answer come from the supplied text. The cost is a review of
my selection rather than of the code.

**The call now keeps `--sandbox read-only` and drops `read` from the deny list,
adds `--cwd <repo>`, and the prompt gives FILE PATHS instead of file contents:**

```bash
grok -p "<prompt naming the paths>" \
     --model grok-4.6 \
     --cwd /Users/dimitar/PROJECTS/AI-incident-investigator \
     --sandbox read-only \
     --disallowed-tools bash,edit,write,web_search,web_fetch \
     --no-plan --no-subagents --output-format json
```

`bash`, `edit` and `write` stay denied: the review must not run anything or
change anything. `read` is the only one that came back.

### The trap that costs a whole run, measured the same hour

Allowing `read` is **not enough**. The first attempt returned after one turn
with `"stopReason": "cancelled"` and this as its entire answer:

> I will read the files themselves and the diff, without taking the summary as true.

Its `thought` field showed it had decided to read the files and had drafted a
verdict; the tool call itself was never approved, because headless mode has
nobody to approve it, so the run was cancelled mid-answer. It still billed
weight: `total_cost_usd` **$0.0133** for an intention.

**A cancelled run does not look like a failure.** It prints a sentence in the
right language, on the right subject, and exits 0. Read `stopReason` before
reading the answer.

**Three runs were cancelled before the working shape was found, and the two
wrong guesses are worth as much as the answer:**

| Attempt | Flags | Result |
|---|---|---|
| 1 | the old shape — `read` in the deny list, code pasted into the prompt | `cancelled`, 6 turns, **$0.088** — it tried tools anyway |
| 2 | `--allowed-tools read` | **not a flag**; the name is `--allow`. Exit before any model call, $0 |
| 3 | `--allow read --permission-mode dontAsk` | `cancelled`, 2 turns, **$0.024** |
| 4 | `--permission-mode bypassPermissions` | `end_turn` — it read the file and answered |

`--permission-mode` takes `default`, `acceptEdits`, `auto`, `dontAsk`,
`bypassPermissions`, `plan`. **`dontAsk` does not mean "allow without asking" —
it denies**, and the run is cancelled mid-answer. `bypassPermissions` is the one
that lets the read through.

Nothing is loosened by that: `--sandbox read-only` and the deny list still make
writing and running impossible. What `bypassPermissions` removes is the prompt
that nobody is there to answer.

**The working shape:**

```bash
grok -p "<prompt naming the paths>" \
     --model grok-4.6 \
     --cwd /Users/dimitar/PROJECTS/AI-incident-investigator \
     --sandbox read-only \
     --disallowed-tools bash,edit,write,web_search,web_fetch \
     --permission-mode bypassPermissions \
     --no-plan --no-subagents --output-format json
```

**Verify it with a probe before spending a review on it.** One line — read
`package.json`, return the `name` — costs $0.016 of weight and tells you whether
reading works at all. Three cancelled reviews cost $0.125 and told nobody
anything.

**Ask for English.** Left alone it answered in Bulgarian, because the prompt
around it was. Not wrong, but the repository's reviews are in English.

The section below is the older shape, kept because its failure modes still
apply.

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
