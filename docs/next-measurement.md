# The protocol for the next paid run, written before it

Written 2026-09-07, before asking for the word. The order matters: a success
criterion decided after the numbers arrive is not a criterion, it is a reading.

Codex, 2026-09-07, refusing a seventh single run: *"there is no score out of five
that solves this… another run risks becoming the seventh prompt-edit trigger
rather than an evaluation."*

## What this run is for

One question, and it is not "does it work":

> **Does the completeness rewrite make the Kubernetes agent report the
> configuration value alongside the symptom — and do the three scenarios nobody
> has ever asked a model produce the answers their fixtures were built around?**

## What is frozen before it starts

Nothing in this list may be edited between the deploy and the last answer. If
any of it changes, the run is void and the money is spent for nothing.

| Frozen | Why it matters |
|---|---|
| `prompts/*.md` | the thing being measured |
| `scenarios/*` | the questions being asked |
| `scripts/score-run.mjs` | the marking scheme |
| the deployed workflow | one deployment, or the runs are not comparable |

## Corrected on 2026-09-08, before anything was bought

A subagent was given one mandate — *find every reason this run would come back
uninterpretable* — and ran the eight scenarios locally end to end. All eight are
winnable, which the protocol assumed and had not checked. Six things in this
document were wrong, and three of them would have wasted the run.

| What this document said | What was measured |
|---|---|
| three attempts of one scenario are recorded | `answers.json` is keyed by SCENARIO, so three attempts collapse to the last, silently. Fixed below: each attempt is its own key |
| 48 calls, ~$0.015–0.020 | **43 calls** for the twelve-run plan — and that plan itself was superseded on 2026-09-08 by the three-part staging below, which buys 10 runs and 30–40 calls |
| the criterion is decided in advance | it was decided for `image-pull-failure`'s three attempts and **not** for `readiness-probe-failure`'s. Three of the twelve runs had no verdict named. Fixed below |
| item 3 closes if confidence is lowered | a refusal at **0.95** scored `correct`, so the item could have read as closed by a run in which confidence went UP. The scorer refuses that since 2026-09-08 |
| `deployment-regression` is reachable | reachable, but the kubernetes prompt said to report events showing something WRONG — and a rollout says `Normal`. An obedient agent dropped the only evidence the scenario is scored on. Fixed in the prompt |
| eleven readiness checks move | **six.** The three Definition-of-Done items need a hand edit and named tests, and two of the eight scenarios are not bought at all |

**The runner exists since 2026-09-08:** `scripts/run-scenarios.mjs` issues the
calls and writes both files as each answer arrives. This paragraph said there was
none for a day after it was written, in the same document that describes what it
writes — a stale sentence beside a live one.

What is still hand-entered is the **token count and the cost**, and only because
the webhook does not carry them. They are written as `null` with the reason, and
`spend` reports a floor rather than a total. That is the gap, and it is stated
here rather than discovered after paying.

## Corrected again on 2026-09-08, after all three reviewers said no

The rule is that the three must AGREE before money is asked for. They did not.

| Who | What they refused |
|---|---|
| **Codex** | the per-attempt key was written in THIS document and not in the code — `scoreAll` enumerated directories and read the bare name, so every `#1` key was ignored in silence |
| **Grok · 1** | item 3 closes under two different outcomes, so whatever the model returns reads as success. And the table says ≤60% closes it while the paragraph below says it must be LOWER than container-oom — a run at 55% on both satisfies one and fails the other |
| **Grok · 2** | `correct` is recorded for an answer the scenario is built to refuse: the dissent requirement is met by two well-shaped objects whose FACTS are never read |

Two of the three are fixed in code. The third is not fixable in code, and is
handled below by saying which question this run answers and which it does not.

## Bought in three parts, not one

Grok's objection, and it is right: the protocol says a wrong readiness attempt
stops everything else, so paying for everything up front buys runs that a bad
first result makes meaningless.

| Part | Chain runs | Calls | Bought only if |
|---|---|---|---|
| 1 · `readiness-probe-failure` ×3 | 3 | ~9 | — |
| 2 · `image-pull-failure` ×3 | 3 | ~9 | part 1 came back fully correct |
| 3 · `conflicting-evidence`, `container-oom`, `application-startup-failure`, `deployment-regression`, one each | 4 | ~13 | part 2 settled the rewrite either way |

**A part is bought from a verdict the CURRENT scorer produced.** If the scorer
was corrected after an earlier part was scored, that part is re-scored from its
recorded answers first, and the decision is taken from the new number. A verdict
produced by a scorer that has since been fixed authorises nothing — Codex,
2026-09-08: the evidence being recoverable does not make the SPENDING it
authorised recoverable.

Total if all three are bought: **10 chain runs**, and the last section says what
each of them answers. `cpu-throttling` and `insufficient-evidence` are NOT
bought: both were answered correctly on 2026-09-07, neither is a comparator for
anything asked here, and re-buying an answer nobody doubts is spending to see
the same thing twice.

**Part 1 buys three attempts, not one, because the criterion below asks for
three.** The first staging bought one and then judged it against a 3-of-3 rule —
Codex and Grok both named it on 2026-09-08, and it is the same defect as buying
a measurement that cannot answer the question it is bought for. Part 1 is still
the cheap question with the largest consequence: `readiness-probe-failure` was
correct three times out of three on 2026-09-07, so a wrong answer now is a
REGRESSION, and nothing else is measured until its cause is known.

**Part 3 carries `container-oom` because item 3 is a COMPARISON.** The closing
condition needs the confidence on `conflicting-evidence` against the confidence
on `container-oom` in the same run; buying only the first leaves the comparison
unavailable, so the item could not close whatever the model returned. It was
missing from the first staging.

## What item 3 needs, said once

The table below closed item 3 on two different outcomes. It closes on ONE:

> `conflicting-evidence` comes back with a confidence **strictly lower** than
> `container-oom` in the same run, with dissent recorded from a different source.

A refusal is an acceptable ANSWER and does not close item 3, because a refusal
states no confidence to compare. If the run refuses, the item stays open and
the reason is that the comparison was not available — not that it failed.

**Nothing here moves Definition-of-Done items 2, 3 or 10 by itself.** They are
`covered: false` and readiness reads that flag and the test report; closing them
needs a hand edit and named tests that pass. This run moves **six** of the
nineteen readiness checks — six of the eight scenarios — and no more.

## What is asked

Ten chain runs on one deployment, in the three parts above, and no more.

The two that a previous run left uncertain — `readiness-probe-failure` and
`image-pull-failure` — get **three** attempts each, because a single attempt
cannot separate a fix from a lucky draw and that is what stopped the last run
from being accepted. `container-oom` is bought once as the comparator item 3
needs. The two scenarios never asked live — `application-startup-failure` and
`deployment-regression` — get one attempt each, which establishes whether their
code is reachable and nothing more.

`cpu-throttling` and `insufficient-evidence` are not bought, and their readiness
checks stay unestablished. **This run moves six of the eight scenario checks,
not eight.** Ten runs answer ten questions; a figure that moved further than
that would be counting runs nobody paid for.

## The criterion, decided now

| Result | Verdict |
|---|---|
| `image-pull-failure` cites `deployment.image` in **3 of 3** attempts | the rewrite worked |
| it cites it in 1 or 2 of 3 | **not** a fix — it is variance, and the prompt is not touched again on that basis |
| it cites it in 0 of 3 | the seventh rule failed like the six before it; the answer is a different mechanism, not a seventh rewording |

| `readiness-probe-failure` result | Verdict |
|---|---|
| **any** attempt scores `wrong` | a regression against a scenario that was passing; the cause is found before anything else is measured, and parts 2 and 3 are not bought |
| no attempt wrong, and fewer than 3 fully correct | the earlier 3-of-3 was luck; the scenario goes back on the list |
| fully correct in **3 of 3** | it is settled; it stops being re-run |

Read top to bottom, first row that matches. The earlier version let one wrong
attempt satisfy both "luck" and "regression", which are different decisions
about whether to spend more.

**Each attempt is its own key.** `answers.json` maps a name to an answer, so
three attempts under one scenario name keep only the last — measured on
2026-09-08, and the attempt that DID cite the missing path was the one thrown
away. Write them as `image-pull-failure#1`, `#2`, `#3`, and score each.

**One record holds all three parts, and each part is added to it as it
arrives.** `latestScored` returns a single record, so a second file would send
the earlier parts back to unestablished — and writing part 2 over part 1 with
`--replace` orphans it just as completely. The third door is
`--record docs/runs/<file>.json --add`: it fills a key the record does not
answer yet, leaves an established verdict standing, and refuses to turn one
established verdict into a different one without `--replace`. So the record is
written when each part arrives, which is what keeps the numbers out of my
hands.

| Result | Verdict |
|---|---|
| `application-startup-failure` → `APPLICATION_STARTUP_FAILURE` | the code is reachable |
| → `CONTAINER_OOM` | the fixture's decoy worked and the chain reasons from restart count instead of the termination reason |
| `deployment-regression` → `DEPLOYMENT_REGRESSION` | a cause with no pod-level symptom is reachable |
| `conflicting-evidence` → `CONTAINER_OOM` **strictly below** the confidence on `container-oom` in this same run, with dissent recorded from a different source | item 3 has its **evidence**; the item itself closes only by a hand edit to `scripts/definition-of-done.mjs` and a named test that passes, which no run does by itself |
| → `CONTAINER_OOM` at or above `container-oom` | the model does not lower confidence under conflict; the item stays open with a measured reason |
| → `INSUFFICIENT_EVIDENCE` | an acceptable ANSWER, and item 3 stays open: a refusal states no confidence to compare |

One row closes it, and the other two say why it did not. The earlier table had
two closing rows and a 60% ceiling beside a comparison it could contradict — a
run at 55% on both satisfied the ceiling and failed the comparison. The ceiling
is not the criterion; the comparison is.

## What is recorded, and when

`node scripts/score-run.mjs <answers.json> --record docs/runs/<date>-<name>.json`

at the moment the answers arrive, not afterwards from memory. The run record
carries the scorer's own states. It does NOT carry the token counts or the
cost: the webhook returns the chain's report and the Collect nodes keep only the
reply, so both are written as `null` with the reason, and `spend` reports a
floor. This sentence claimed all three until 2026-09-09, two sections after the
one that says the opposite. So
`scripts/readiness.mjs` stops reporting six of the eight scenarios as
unestablished and starts reporting what was actually answered. The other two are
not bought and stay unestablished, which is the honest reading of a question
nobody asked.

## What happens if it is not run

Thirteen of the nineteen readiness checks stay unestablished: eight scenarios
and five Definition-of-Done items. **Eleven** of those thirteen wait on money;
the other two wait on code nobody has written. The two numbers are different
questions and this line used to give the money number as the total — the exact
conflation `scripts/readiness.mjs` records as already fixed once. Nothing else in the repository can
move them: they are the items whose evidence is a model's answer.


## When a call may have been charged and nothing came back

The runner writes `called, no reply recorded — this key may have been charged`
into the run record BEFORE it posts, and leaves it there for any failure that
does not prove the request was refused at the door. A later run reads every
record in `docs/runs/` and **refuses** that key.

That refusal has no automatic way out, and that is a limitation rather than a
mechanism: a person has to look. The steps, so the way out is not invented under
pressure:

1. Open the n8n execution list for that workflow and find the execution whose
   time matches the record's `when` and the key's position in `keys`.
2. **If it ran:** copy the final report into the answers file under that key.
   The refusal then changes to "already carries an answer", which is correct —
   it was paid for and it is kept.
3. **If it did not run:** edit that run record and change the outcome to
   `not executed — checked in n8n on <date>`. Keep the original sentence beside
   it; the record is evidence, and evidence that is edited without saying so is
   worse than none.
4. Only then issue the key again.

**Never resolve it by writing a new attempt number.** `key#2` is a new question
and a new charge, and it leaves the first one unexplained forever.

## Estimated cost

From the last comparable run: **$0.0085 for 21 calls**, which is **$0.000405 a
call**. The figure is from `docs/runs/2026-09-07-repeated-measurement.json`, not
from an estimate.

Ten chain runs. A scenario whose slot reports an established absence skips that
agent, so a run is 3 or 4 calls, not always 4 — between 30 and 40 calls.

| Part | Chain runs | Calls | At $0.000405 |
|---|---|---|---|
| 1 | 3 | 9–12 | $0.0036 – $0.0049 |
| 2 | 3 | 9–12 | $0.0036 – $0.0049 |
| 3 | 4 | 12–16 | $0.0049 – $0.0065 |
| **all three** | **10** | **30–40** | **$0.012 – $0.016** |

Each part is asked for on its own, with its own word. One `харчи` is one part.

## The result, and the decision it forced · 2026-09-09

Part 2 was bought and measured: `image-pull-failure` returned the right code
**3 of 3**, and cited `deployment.image` **0 of 3**.

By the criterion written above — before the run, not after — that is the third
row: *the seventh rule failed like the six before it; the answer is a different
mechanism, not a seventh rewording.*

**The decision is LIMITATIONS, not an eighth rewrite of the prompt.** It is
already carried, word for word, by an entry that predates this measurement:

> that an agent cites what a scenario was built around — the prompt asks,
> nothing enforces, and the scorer reports the miss rather than refusing the
> answer

Nothing new is added to that list, because nothing new was learnt about what the
system can decide. What is new is the **number**, and it is written here so the
same rewrite is not attempted an eighth time on the strength of having
forgotten: seven consecutive attempts, the last three measured live, and the
citation was never produced.

**What would reopen it:** a mechanism, not a wording — the scorer refusing an
answer that omits a `must_cite` field, which is a rule nobody has agreed to and
which would turn a note into a gate. That is a decision for the owner, and it is
not taken here.
