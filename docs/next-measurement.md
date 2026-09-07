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
