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
| 48 calls, ~$0.015–0.020 | **43 calls.** Three scenarios ask 3 agents, not 4, because a `__nothing` slot skips its agent. ~$0.0174 at the measured $0.000405 a call |
| the criterion is decided in advance | it was decided for `image-pull-failure`'s three attempts and **not** for `readiness-probe-failure`'s. Three of the twelve runs had no verdict named. Fixed below |
| item 3 closes if confidence is lowered | a refusal at **0.95** scored `correct`, so the item could have read as closed by a run in which confidence went UP. The scorer refuses that since 2026-09-08 |
| `deployment-regression` is reachable | reachable, but the kubernetes prompt said to report events showing something WRONG — and a rollout says `Normal`. An obedient agent dropped the only evidence the scenario is scored on. Fixed in the prompt |
| eleven readiness checks move | **eight.** The three Definition-of-Done items need a hand edit and named tests; no run moves them |

**One thing nothing in this repository does yet:** issue the calls and write the
record. There is no runner. `recordInto` writes only the scored states, so the
token counts, the cost and `normalised` are hand-entered afterwards — which this
document's last section says must not happen. That is a gap, and it is stated
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

| Part | Calls | Bought only if |
|---|---|---|
| 1 · one `readiness-probe-failure` | 3 | — |
| 2 · three `image-pull-failure` | 9 | part 1 came back fully correct |
| 3 · the three never-asked scenarios, one each | ~10 | part 2 settled the rewrite either way |

Part 1 is the cheap question with the largest consequence: it was correct three
times out of three on 2026-09-07, so a wrong answer now is a REGRESSION, and
nothing else should be measured until its cause is known.

## What item 3 needs, said once

The table below closed item 3 on two different outcomes. It closes on ONE:

> `conflicting-evidence` comes back with a confidence **strictly lower** than
> `container-oom` in the same run, with dissent recorded from a different source.

A refusal is an acceptable ANSWER and does not close item 3, because a refusal
states no confidence to compare. If the run refuses, the item stays open and
the reason is that the comparison was not available — not that it failed.

**Nothing here moves Definition-of-Done items 2, 3 or 10 by itself.** They are
`covered: false` and readiness reads that flag and the test report; closing them
needs a hand edit and named tests that pass. This run moves **eight** of the
nineteen readiness checks — the scenarios — and no more.

## What is asked

Eight scenarios, one attempt each, on one deployment.

The two that a previous run left uncertain — `image-pull-failure` and
`readiness-probe-failure` — get **three** attempts, because a single attempt
cannot separate a fix from a lucky draw and that is what stopped the last run
from being accepted.

Total: 8 + 4 extra attempts = 12 chain runs.

## The criterion, decided now

| Result | Verdict |
|---|---|
| `image-pull-failure` cites `deployment.image` in **3 of 3** attempts | the rewrite worked |
| it cites it in 1 or 2 of 3 | **not** a fix — it is variance, and the prompt is not touched again on that basis |
| it cites it in 0 of 3 | the seventh rule failed like the six before it; the answer is a different mechanism, not a seventh rewording |

| `readiness-probe-failure` result | Verdict |
|---|---|
| fully correct in **3 of 3** | it is settled; it stops being re-run |
| correct in 1 or 2 of 3 | the earlier 3-of-3 was luck, and the scenario goes back on the list |
| wrong in any attempt | a regression against a scenario that was passing, and the cause is found before anything else is measured |

**Each attempt is its own key.** `answers.json` maps a name to an answer, so
three attempts under one scenario name keep only the last — measured on
2026-09-08, and the attempt that DID cite the missing path was the one thrown
away. Write them as `image-pull-failure#1`, `#2`, `#3`, score each, and record
all twelve in ONE run record: `latestScored` returns a single record, so a
second file would send the other seven scenarios back to unestablished.

| Result | Verdict |
|---|---|
| `application-startup-failure` → `APPLICATION_STARTUP_FAILURE` | the code is reachable |
| → `CONTAINER_OOM` | the fixture's decoy worked and the chain reasons from restart count instead of the termination reason |
| `deployment-regression` → `DEPLOYMENT_REGRESSION` | a cause with no pod-level symptom is reachable |
| `conflicting-evidence` → `CONTAINER_OOM` at 60% or below with dissent from metrics, **or** `INSUFFICIENT_EVIDENCE` with evidence stated | Definition of Done item 3 closes |
| → `CONTAINER_OOM` above 60% | the model does not lower confidence under conflict, and the item stays open with a measured reason |

**The comparison that item 3 actually rests on:** the confidence on
`conflicting-evidence` must come back **lower** than on `container-oom`, which
poses the same cause without contradiction. Equal numbers mean the ceiling was
met by accident.

## What is recorded, and when

`node scripts/score-run.mjs <answers.json> --record docs/runs/<date>-<name>.json`

at the moment the answers arrive, not afterwards from memory. The run record
carries the token counts, the cost, and the scorer's own states — so
`scripts/readiness.mjs` stops reporting eight unestablished scenarios and starts
reporting what was actually answered.

## What happens if it is not run

Eleven of the nineteen readiness checks stay unestablished, including every
scenario and three Definition-of-Done items. Nothing else in the repository can
move them: they are the items whose evidence is a model's answer.

## Estimated cost

From the last comparable run: **$0.0085 for 21 calls**. Twelve chain runs at
four calls each is 48 calls, so roughly **$0.015 – $0.020**. The figure is from
`docs/runs/2026-09-07-repeated-measurement.json`, not from an estimate.
