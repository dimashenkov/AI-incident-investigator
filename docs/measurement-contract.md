# The contract for the six-scenario measurement

Written **before** the run, on 2026-09-10, as step 2 of the plan agreed with
Astra. Its purpose is that the result cannot be argued about afterwards: what
counts as success, what the answer will decide, and when the run stops.

A criterion written after the numbers are in is not a criterion.

## What is bought

Six scenarios that have **never** been measured, one execution each:

```
container-oom  conflicting-evidence  deployment-regression
application-startup-failure  cpu-throttling  insufficient-evidence
```

Six single runs establish **coverage**, not reliability. No claim about
variability may be made from them, and none will be written.

## The order, and the checkpoint

**One first, then five.** `container-oom` is bought alone. Then its recorded
artifact is read before anything else is spent.

| After the first artifact | What happens |
|---|---|
| the answer is recorded, readable, and scoreable | the remaining five are bought |
| the answer is a poor diagnosis | **that is a result** — the five are still bought |
| the record is missing, truncated, or cannot be scored | **stop.** Nothing more is bought until capture is fixed |

The distinction is Astra's, on 2026-09-10: a bad diagnosis is what we paid to
learn; an unusable record means we paid and learned nothing.

## The cap

The estimate is ~14 900 input and ~990 output tokens per execution, from the
recorded run of 2026-09-07 — three executions at 44 778 in and 2 966 out.
For six: **≈ 90 000 in, ≈ 5 900 out.**

**The cap is seven executions.** Six planned plus one, and the one is only for a
call that provably did not complete. A retry after a timeout is a NEW execution
and is counted against the cap; two retries stop the run.

The dollar figure cannot be given, and this says so rather than inventing it:
the webhook reply carries no usage, which is why the spend counter reports
eight runs it could not price.

## Scored on four axes, not one

One verdict hides the case that already happened: `image-pull-failure` gave the
right code three times out of three and never cited `deployment.image`, and a
single number would have called that either a pass or a failure. Neither is true.

| Axis | What is read | Where it comes from |
|---|---|---|
| **diagnosis** | is `root_cause_code` the one the scenario declares | `expected.json` `root_cause_code` |
| **citation** | are the `must_cite` refs present in the evidence | `expected.json` `must_cite`, 2 per scenario, 1 for insufficient-evidence |
| **restraint** | is confidence at or under the ceiling where one is declared | `conflicting-evidence` declares `max_confidence` 0.6 |
| **collection** | did every slot report, and does the thread say so when one did not | `incident.collection`, and the thread's own sentences |

Each is recorded separately. A run may be right on one axis and wrong on
another, and the record must show which.

## What the result decides

| Result | Decision |
|---|---|
| 5 or 6 diagnoses correct | the shape works; the next question is reliability, and that is a different purchase |
| 3 or 4 correct | targeted repair of the ones that failed, from the recorded answers, before anything else is bought |
| 2 or fewer correct | stop expanding. The three-specialist shape has not earned the next purchase, and the alternatives Astra named — one model over all three slices, or deterministic extraction plus one concluding model — become the question |
| citations missed on most scenarios | this is the `deployment.image` finding generalised: the prompt is not the lever. Enforce structurally or write it as a limitation. **No prompt rewrite.** |
| any scenario refused for a reason that is not the model's answer | a defect in the chain, not a measurement. It is fixed and that scenario is re-bought |

## What is NOT claimed from this run

* nothing about reliability or variability — one execution each
* nothing about a real cluster — every provider is simulated on purpose
* nothing about latency or cost per node — the reply carries no usage
* nothing about whether a human finds the thread useful — nobody has been asked
