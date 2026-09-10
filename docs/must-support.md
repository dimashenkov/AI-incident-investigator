# `must_support` — designed, attacked twice, and NOT built

**Verdict, 2026-09-10, after two rounds with Astra: do not build this. Keep
`must_cite` and state its limitation.** Verbatim: *„Don't build the general
mechanism yet. It adds identity resolution and semantic parsers without
measuring reasoning."*

The design is kept, whole, because the reasons it was rejected are worth more
than the design was.

## The thing that started it, and it was not established

`container-oom` scores red: the model answered `CONTAINER_OOM` and cited
`lines[1].message` — *„heap usage 468Mi of 512Mi limit"* — rather than
`pods[0].containers[0].limits.memory`.

I wrote that the conclusion therefore rested on the memory limit and the check
was measuring too narrowly. **That was a claim larger than its evidence.** Astra,
round two: the log line does not say those 512Mi ARE the container's configured
memory limit. A heap limit and a container limit are different properties that
happen to hold the same number in this fixture. Nothing in the answer establishes
the equivalence, and no amount of entity binding or unit normalisation could.

The test that would settle it, and it is the one to write if this is ever
revisited: make the heap limit 512Mi while the container limit is 1Gi. The log
must NOT satisfy a requirement about the container limit.

## And a second thing I said that was false

I wrote that every fixture holds one pod with one container, so „first" and
„broken" always coincide. `scenarios/deployment-regression/kubernetes.json` holds
**two** pods, both with containers named `orders-api`. The index defect the owner
found is real; my account of why it is invisible was not.

Container name alone cannot distinguish replicas. Scoped identity —
namespace, pod, container — is what a future version would need.

## What is done instead

`must_cite` stays. Its limitation is stated where the gate prints limitations,
rather than fixed by a mechanism that would measure less than it appears to:
**a required citation names one canonical path, and an answer that reads the same
value from another place is recorded as a miss.** Those misses are reviewed by
hand, and the reviews say which they were.

The condition for revisiting, from the same review: build it when an alternate
observation **unambiguously** expresses the same property, and when the misses
obstruct a concrete decision. Neither is true today.

---

*Everything below is the design as it stood when it was rejected. It is not
implemented, and the corrections above override any sentence in it that says
otherwise — including every sentence about „grounding", which is exactly what
this rubric cannot measure.*

# `must_support` — what a scenario requires, and why not a path

> **Revised on 2026-09-10 after Astra attacked it: „Not sound yet."** The first
> draft called the number „grounded reasoning". It cannot be. An answer can cite
> the genuine 512Mi limit and then say *„the limit is irrelevant; the restart
> count proves OOM"* — path, entity and value all match, and the conclusion does
> not rest on the proposition at all.
>
> So the measure is renamed to what it measures: **required observations
> cited**. Whether the reasoning USES them is a different question, and this
> rubric does not answer it. Everything below is read with that name.

Written on 2026-09-10, before any code, after three purchases of the same six
scenarios returned the same numbers and two defects turned up in the MEASURE
rather than in the system.

## What is wrong with `must_cite`

A scenario declares the exact address a citation must name:

```
pods[0].containers[0].limits.memory
```

Two things break, and both are visible in today's recorded answers.

**It asks for a place, not a fact.** For `container-oom` the model answered:

```json
{ "fact": "heap usage 468Mi of 512Mi limit", "source_ref": "lines[1].message" }
```

The conclusion rests on the memory limit. The check says it does not, because
the limit was read from the log line that states it rather than from the
configuration field. Right answer, right grounds, recorded as a failure.

**It names an index, not an entity.** `pods[0].containers[0]` is the FIRST pod
and the first container. Every fixture holds one pod with one container, so the
first is always the broken one and the difference cannot be seen. The moment it
is not — ten pods, one killed — the correct citation is `pods[1]` and the check
calls a right answer wrong. The owner saw this from the plain description, on
2026-09-10, and it is the sharper of the two.

## What replaces it

A requirement declares a **proposition**, not an address:

```json
{
  "id": "memory-limit-of-the-killed-container",
  "says": "the memory limit of the container that was terminated is 512Mi",
  "entity": {
    "kind": "container",
    "where": { "path": "last_state.terminated.reason", "equals": "OOMKilled" },
    "expect": "exactly-one"
  },
  "value": "512Mi",
  "satisfied_by": [
    "pods[*].containers[*].limits.memory",
    "lines[*].message"
  ]
}
```

| Field | What it is for |
|---|---|
| `says` | the proposition in words, so a human reading a failure knows what was missing |
| `entity` | WHICH container: a path, an operator, a value, and how many are expected. Never an index |
| `value` | what the observation holds; a citation carrying a different value does not satisfy it |
| `satisfied_by` | the paths that may carry it, **enumerated in advance** |

## The three rules that keep this from becoming agreement

Astra, 2026-09-10, on the danger: a requirement widened to fit whatever the model
happened to do stops measuring anything.

1. **`satisfied_by` is frozen before the run.** It is written from what the
   fixture contains, never from what an answer produced. A path added after
   seeing an answer is a rubric agreeing with its subject.
2. **The value must match.** A citation resolving to a different value fails,
   whichever path it names. This is what stops `heap usage 468Mi` from
   satisfying a requirement about the container's limit: 468 is not 512, and
   heap is not the container's memory.
3. **Rejection is tested, not assumed.** For every requirement there is a case
   with the wrong value, a case naming the wrong entity, and a case citing an
   irrelevant path. If none of the three fails, the requirement measures nothing.

## What is kept, and why both numbers stay

The exact-path count does **not** disappear. It is reported beside the new one:

| Number | What it answers |
|---|---|
| `must_support` satisfied | did the conclusion rest on the facts the scenario is built around |
| exact-path citations | did the answer name the canonical address |

They are never added. The first is about grounding; the second is about
spelling, and a system that grounds correctly while spelling differently is a
different thing from one that does neither.

## The old scores are not rewritten

Every recorded run keeps the verdict it was given. Rescoring under the new
rubric produces a **second, named** result beside the first. Astra: *„This is a
measurement correction, not a system improvement."* A number that changes because
the ruler changed must never look like a number that changed because the thing
got better.

## Where this can break

| Risk | What answers it |
|---|---|
| `satisfied_by` grows until everything satisfies everything | it is frozen before the run, and the three rejection tests fail if it is too wide |
| the entity cannot be identified in a slice that has no terminated container | the requirement is not satisfied, and that is the correct answer, not an error |
| two containers both match the entity | the requirement names them all and is satisfied by any; a scenario needing one is a scenario needing a sharper `identified_by` |
| the wildcard makes a path match something unintended | the value check still has to pass, and the rejection tests cover it |


## The four corrections from that review, written into the rules

**1. The name.** The number is *required observations cited*. Not grounded
reasoning: an answer can cite the limit and argue the limit is irrelevant, and
this rubric cannot tell. If the reasoning link is ever wanted, it is a second
requirement — an explicit conclusion-to-finding link, checked separately.

**2. The entity carries an operator, a value and a count.**
`{ path, equals, expect: "exactly-one" }`. Two matches with different limits must
not silently become „any": for a proposition about THE killed container, two
candidates mean the requirement is **unsatisfied and says so**. Zero matches is
unsatisfied too, and is distinguished from a fixture that could never satisfy it.

And the trap Astra named: **if the identifying field IS the thing in question,
selecting by it assumes the answer.** For `container-oom` the terminated reason
is itself part of what must be shown, so the entity is selected by identity —
the container name — and the reason is then tested, not used to pick.

**3. The value is compared after typed normalisation, declared per field.**
`512Mi` and `536870912` are equal only if the second is bytes. `0.44` and
`0.4400` are the same reading. Whole-string equality rejects the log line that
legitimately carries the limit; substring matching accepts
*„heap limit 512Mi, container limit 1Gi"*. So each `satisfied_by` path declares
how its value is extracted and normalised, frozen with the path.

**4. The two numbers get fixed reporting rules.** The primary metric and its
denominator are declared in advance; both are always published, each with the
rubric version that produced it; and the exact-path count is labelled
**diagnostic**, not a quality measure. It is also not „exact": `citationCovers`
accepts descendants today, so the old name was already wider than it sounded.

## The bug this will have if written carelessly

Astra, on the most likely subtle failure, and it is exactly what I would have
written: *„a disconnected existential join — some entity matches AND some
allowed citation contains 512Mi."* Both halves must bind to the **same entity
and the same observation**.

The tests that catch it: two containers with the same name and different limits,
shuffled indices so the broken one is not first, and a log line ambiguous
between them.

## And one requirement this rubric cannot express yet

`deployment-regression` needs a **temporal relation**: the rollout happened
BEFORE the first error. Citing both messages independently does not establish
the ordering, and no proposition of the shape above says „A precedes B". Named
here rather than quietly approximated; it stays on `must_cite` until a temporal
requirement is designed.
