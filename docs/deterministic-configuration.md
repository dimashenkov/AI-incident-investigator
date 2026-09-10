# Configuration read by code, not by a model

Chosen by the owner on 2026-09-10, after the six-scenario measurement showed one
cause behind four of the five reds.

## What the measurement showed

| Scenario | The citation the scenario is built around | Who reported it |
|---|---|---|
| `container-oom` | `pods[0].containers[0].limits.memory` | **nobody** |
| `application-startup-failure` | `pods[0].containers[0].last_state.terminated.reason` | **nobody** |
| `image-pull-failure` (2026-09-07) | `deployment.image` | **nobody** |
| `deployment-regression` | the healthy baseline before the jump | **nobody** |

Not lost between agents: the concluding agent receives every specialist result
in full, and in `container-oom` it restated all nine findings it was given. The
field was never extracted. Seven prompt rewrites did not change that, which is
why the prompt is not the lever.

## The rule, and what it is NOT

**Extraction is by KIND OF FIELD, never by what a scenario expects.**

If the code extracted the `must_cite` list, the measurement would stop measuring
the model and start measuring the extractor. Astra named it on 2026-09-10:
scenario-specific expectations must not become an oracle supplied to the
investigator.

The kinds, chosen because each is a stable part of a contract rather than a
symptom:

| Kind | Where it lives |
|---|---|
| resource limits and requests | `pods[].containers[].limits.*`, `requests.*` |
| the image a deployment runs | `deployment.image` |
| the last termination of a container | `pods[].containers[].last_state.terminated.*` |
| readiness of a container | `pods[].containers[].ready` |
| the first and last point of a series | `series[].points[0]`, `series[].points[N-1]` |

The last one is what `deployment-regression` needed: not a value, a before and
an after.

## Revised on 2026-09-10, after Astra attacked it

His verdict: *„Build the extractor as an observation producer. Do not build
automatic evidence endorsement."* Five corrections, all accepted.

**1. These kinds were chosen from the failures, and that has a name.** Not
coincidence — benchmark-informed development. It becomes an oracle the moment
scenario identity or the expected answer selects what is extracted. So: the
rules are frozen, they apply to **every** matching field — healthy values,
unrelated containers, series nobody asked about — and these six scenarios become
**regression cases**, not evidence that the mechanism generalises.

And the output size is not bounded by five kinds; it is bounded by how many
containers and series a slice holds. Said so it is not discovered later.

**2. The citation axis does not die, it splits — and the two are never added.**

| Number | What it is |
|---|---|
| **model citation recall** | required refs the MODEL cited ÷ all required refs |
| **extraction-only coverage** | required refs the code supplied and the model never cited ÷ the same denominator |

There are **11 required-reference obligations across the six scenarios**. Their
union must never be reported as „citation success": the union measures whether
the evidence was AVAILABLE, and neither number establishes that the conclusion
used it correctly.

**3. `cited_by` was conflating two different things** — who produced a fact, and
who chose it to support a conclusion. Split. And the bigger correction:
extraction happens **after the specialists and BEFORE the conclusion**, the
concluding agent is given those facts, and it must reference them explicitly.
Appending a fact to the evidence after the conclusion would be a document
asserting support that nobody weighed.

The specialists' isolation is untouched. What changes is what the concluding
agent receives — so that baseline is versioned, and the change is measured, not
assumed.

**4. The series endpoints stay, the interpretation does not.** Choosing the first
and last point is extraction. Calling them „before and after the rollout" is
interpretation, and it needs the event's timestamp to be true at all. Endpoints
carry their timestamps, units and identity; the rollout comparison is a separate
derivation with its inputs cited. Endpoints alone **do not** establish a healthy
baseline, and this file no longer says they do.

**5. What extraction cannot fix, from the same recordings.**
`conflicting-evidence` was GIVEN the low-memory findings and still chose the OOM
evidence and asserted 80%. That is a selection failure, and no extractor
touches it. `deployment-regression` abstained; appending endpoints afterwards
cannot establish that it would have diagnosed correctly.

So the extractor is worth building, and it is **not** the fix for the reds. It
removes one explanation — „the field was never there" — so the next measurement
can tell that apart from „the model had it and did not use it".

## Where it goes, and how it stays honest

Extracted facts are NOT laid at a model's door. They are carried separately,
and every consumer can tell which is which:

```
finding.cited_by = "model"        the agent said it
finding.cited_by = "extraction"   the code read it from the slice
```

**Both are counted, separately, forever.** A run where the model cited the limit
itself and a run where only the extractor did are different runs, and the number
says so. This is the canary rule already written into this project: when a fix
moves responsibility from the model to the code, the proof that the model was
disobedient disappears — unless it is counted.

## Where this can break, said before it is built

| Risk | What happens |
|---|---|
| extraction runs on every slot | the evidence bloats and the thread becomes unreadable |
| extraction changes the specialist's payload | the isolation check compares payload to slice, and the drift baseline moves |
| the code disagrees with the model about the same field | two findings for one fact, and the reader cannot tell which to trust |
| `src/core` files are transpiled into the n8n Code node | the extractor may not import anything |

The first is answered by the kinds above being few. The second by extracting
AFTER the specialist answers, never into its payload. The third by keeping
`cited_by` and preferring the model's wording when both exist. The fourth by
writing it with no imports, like `merge.ts` and `slice.ts`.

## What this does not claim

It does not make a diagnosis correct. It supplies the ground a correct diagnosis
should have stood on, and records that the code supplied it.


## What is lost on purpose, and was not written down until asked

Astra, round four on 2026-09-10, pointed out two silences. Both are deliberate;
neither was stated, and a deliberate loss nobody wrote down reads as an
oversight the first time somebody hits it.

**An empty value produces no fact.** `deployment.image: ""` is read as nothing,
so „explicitly blank" and „absent" collapse into one for this channel. The
alternative — emitting an empty fact — made the extractor and its checker
disagree, which blocked an honest incident. A reader who needs the distinction
has the observation itself; this channel does not carry it.

**A key that cannot be spelled in a path is skipped.** `nvidia.com/gpu` is a
real Kubernetes resource name, and a dot inside a key means something else in
`a.b[0].c`. Extraction skips such keys rather than emit a ref no reader can
follow. A hyphen IS spelled — `ephemeral-storage` is real too, and the grammar
refused it until round four, so extraction emitted a fact its own checker
rejected and an honest incident could not assemble a context.

Both are held by tests: what extraction produces, the checker accepts, for every
scenario slice on disk.
