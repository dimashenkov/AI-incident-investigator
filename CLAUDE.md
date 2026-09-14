# How to work on a project — template

Copy this file into the new project as `CLAUDE.md`. It contains **only what does
not depend on the specific project**. The last section is a list of blank spots;
until they are filled in, it says what is missing there, not invented content.

The general rules live in `~/.claude/WORKING-RULES.md` and are read in every
project. Here is what must stay **in the repo**, so that it holds even when
`~/.claude` is not there — for another person, on another machine, in CI.

Every rule here is here because breaking it has already cost time or money.

**There are three kinds of content here, and they are not equally portable:**

| Kind | What you do with it in a new project |
|---|---|
| **rule** | carried over verbatim |
| **setting of this machine** | §9 (git, SSH) and §8 (hooks) — hold for this machine and this account, not for another person |
| **number from a past measurement** | carried over as *history*, not as expectation; a new measurement replaces it |

---

## 0.5 When two rules collide

They are written because they do collide for real, and each of the four has been
pointed out by an external review of this file.

**The order of precedence, top to bottom:**

1. **What cannot be undone** — stops everything else.
2. **What spends money** — is asked, always.
3. **What reaches other people** — is asked, unless it is an established habit.
4. **What is recorded** — commit, decision, rule: goes through review.
5. **Everything else** — act.

The collisions by name:

| Pair | Which wins |
|---|---|
| "act, don't ask" ↔ "concept before code" | **The concept**, but only above a minor edit. Minor means: behavior does not change, or the change is reversible with one reverse edit. When in doubt — it is not minor. |
| "act, don't ask" ↔ "every decision goes through review" | **The review**, but it is *before commit*, not before writing. Write freely; record after review. |
| "work while the agent reads" ↔ "nothing is recorded that the review has not seen" | Both. Work **on another file**; if you touched the reviewed one, the next round starts with "this changed under you". |
| "push without being told" ↔ "what reaches other people is asked" | **Push is the established habit** and therefore is not asked. Established means: the owner asked for it explicitly and repeatedly. A new channel — a package, a publication, a letter — is not established and is asked. |
| "every decision — every" ↔ "exception for mechanical edits" | The exception is narrow and is proved, not claimed: **there is nothing to adjudicate**. A rename without a change in behavior, a typo. When in doubt — it goes through review. |

---

## 0.6 What here nothing checks

A rule that sounds like a guarantee but is checked by nothing is exactly the
defect this file catches everywhere else. Therefore, explicitly:

| Claim | Who checks it |
|---|---|
| every diff has gone through review | **no one** — only my discipline |
| the objection is recorded verbatim | **no one** |
| memory is updated after each step | **no one** |
| there are no keys and tokens in the repo | **no one**, unless a scanner is put in |
| every fix has a test that would have caught it | **no one** |
| a verdict from a fixed scorer does not authorize the next part | **no one** — Codex, 2026-09-08: *"The scorer rule is prose only. The runner checks neither prerequisite verdicts nor scorer freshness."* The cheapest check he proposes: before dependent spending the result of the previous part is re-evaluated locally from the recorded answers, and the decision demands the documented result |
| the run reached the **correct** uploaded workflow | **no one**, while drift is red — `no-drift-from-baseline` says that what is uploaded diverges from the code, and no one ties that to the decision to pay |

The only thing that would check the first is a gate **outside** the agent: a git
hook on `pre-commit`, tied to the identity of the future commit. It is not built.
Until it is, the five above are discipline, not a mechanism — and are read that
way.

---

## 0. The form of every report — in brief

A report means: end of a step, an answer to "where are we", before a paid run,
after a commit. **And nothing else.**

Requested by the owner on 2026-09-09: "I don't want you to give me a report after
every simple question". A short question gets a short answer — without the cycle,
without the bars, without the money line. The diagram and the bars answer the
question "where are we"; glued onto an answer to "ok", they are noise that makes
the real report indistinguishable.

Then, in this order:

1. **The green echo** of the owner's message.
2. **The content** — tables, numbers, short.
3. **The ASCII diagram of the cycle**, whole, with the **round number** and the
   marked phase.
4. **The bars of the stages**, all groups.

Points 3 and 4 are not skipped and are not replaced with a paragraph about the
same thing. The paragraph has been asked for three times and does not answer the
question "where are we".

---

## 1. The language and form of the answers

**The owner writes in Bulgarian, in Latin script, with typos.** Read through
them, do not ask for clarification. Answer in Cyrillic.

**Repeat every one of his messages in green, before you answer.** The terminal
does not color his input and this cannot be configured anywhere. So the message
is repeated at the start of the answer as a `diff` block with a leading `+`,
which the highlighter draws green:

    ```diff
    + the message as it is written
    ```

Every message — not only the questions. In Cyrillic and with typos fixed: a
repetition that brings them back is harder to read than the original.

**The echo is his message and nothing else.** One `diff` block, his words, typos
fixed. Without a line of terms, without a note, without a heading, and without a
second green block after it.

**No green block anywhere except the echo.** A block with your words, glued to
his, reads as his message with an addition — whatever the markdown says. This has
been said three times. The term stays in English **inside the sentence**, not in
a separate block.

**The echo does not translate.** He writes `gate`, `commit`, `push` — the echo
returns them as `gate`, `commit`, `push`. Fixing a typo and translating a term
are different things, and only the first was requested.

**In the answer the term keeps its English name.** Especially when the repo calls
the thing that way in the code: `gate` is `gate`, not "porta" (the Bulgarian for
"gate") — the file is `gate.py`, and a reader who learned "porta" cannot find it.
A term with no code
behind it — variance, threshold — takes the English in parentheses on first
appearance and afterwards may be used in Bulgarian.

**Short answers.** A table instead of a paragraph. Numbers instead of adjectives.

**The `wait-what` skill is mandatory, and is not waited for to be invoked.**
Requested on 2026-09-07. The full rule is in `~/.claude/WORKING-RULES.md`; it
stays here because this file must hold even when `~/.claude` is not there.

The form holds for **every** explanation: a little context first, one statement
per sentence, plain words, and the project's vocabulary. The language stays
Cyrillic — the skill gives the style, not the language.

**A retelling does not mean the same thing said more slowly.** Name the danger,
not the mechanism. One concrete case instead of a general statement. Say what
follows from it for him.

The vocabulary of this project, when `CONTEXT.md` is missing: the terms that the
code and `PROGRESS.md` already use — incident, observation, finding, hypothesis,
invariant, mutation, `gate`, drift, readiness.

**If the owner writes `/wait-what`, it is a measurement, not a request:** the
previous answer did not land, and the cause is mine.

**Confidence is written in percent.** Requested by the owner on 2026-09-05: the
schema keeps it as `0.6`, but in the report it is written as **60%**. A number
between zero and one reads as an estimate, not as a share, and that is a needless
obstacle before a person who is looking at the result.

**Explain simply.** The owner does not program. Say what the thing means before
how it is called. First the problem, then the choice, then what was done. Name
the danger, not the mechanism: "this rule makes the tool stay silent about
something; if that is wrong for you, you lose a finding and don't understand"
instead of "the suppression has a cost in recall". The concrete case explains
more than the general statement.

---

## 2. The two drawings — every report ends with them

Not with a paragraph about the same thing. The paragraph has been asked for three
times and does not answer the question "where are we".

### 2.1 The cycle

Three stations and an arrow back. It is drawn **whole**, every time, with the
current station marked — not only the current box.

```
   ROUND N
   ┌─────────────┐      ┌─────────────┐      ┌──────────────────┐
   │   measure   │─────▶│   label     │─────▶│ fix or           │
   │  (measure)  │      │  (label)    │      │   LIMITATIONS    │
   └─────────────┘      └─────────────┘      └──────────────────┘
          ▲                                            │
          └────────────────────────────────────────────┘
      ▲ HERE — with one sentence why
```

**The round number is read from an artifact, not remembered.** A round is one
turn: measure → label → fix, and the next measurement starts the next one. A
number that is remembered drifts apart — exactly as "the re-measurement" was
counted as a fourth step and gave two numbers for one state.

Its place is the freeze record: the configuration that produced this result **is**
the round. If the project has generations (see §13), the generation number is the
round number and is not tracked in two places.

**If nothing on disk records it, that is said in the report** — "round 2, from
memory; nothing records it" — and it is entered as a defect in the bars. A number
with no source is a claim that nothing checks, and that is the defect this file
catches everywhere else.

| Station | What it means | Money |
|---|---|---|
| **measure** | produces numbers, not opinions | **spends** — requires asking |
| **label** | **every** failure gets a label, **before** code is touched | no |
| **fix or LIMITATIONS** | there is no third position | no |

**How the phase is marked.** An arrow `▲ HERE` under the station, and **one
sentence why**. Not two lines, not a list:

```
      ▲ HERE — the label for 20 alerts is not there yet
```

If the phase cannot be pointed to, that by itself is the report: write what the
obstacle is and which group of the bars it is in. "Between two stations" is not a
state — either you measure, or you label, or you fix.

**The re-measurement is not a fourth step** — it is measuring, and the next round
starts with it. A four-step drawing counts the same work twice and gives two
different numbers for one state.

### 2.2 The bars

**Four groups, not one.** A list with only the current work hides what is
deferred, and what is deferred is what disappears quietly.

```
DONE
  name                ████████████████████  the number that proves it

IN PROGRESS
  name                ██████░░░░░░░░░░░░░░  who does it · cost

NEXT
  name                ░░░░░░░░░░░░░░░░░░░░  what it needs · cost

DEFERRED, NOT CANCELLED
  name                ██████░░░░░░░░░░░░░░  cost · and what it waits on
```

Each line carries **a number or a cost**, not an adjective. Nothing leaves the
bars because it was decided to wait — the deferred stays in the fourth group with
the reason beside it, until it is done or explicitly cancelled.

Add a fifth group **WAITS ON YOU** only when there is something — and separate
"blocks" from "does not block", because that is the difference between "tell me
when you can" and "nothing runs until you say".

**The cycle is also shown before every paid run**, because the decision it serves
is exactly that.

---

## 3. How to act

**Nothing is spent without the owner's explicit "yes". This is mandatory and has
no exceptions.**

Not "when it is expensive", not "when I am not sure", not "when it is above some
sum". **Every** run that spends — a paid model, a paid measurement, a paid
package — is stopped and asked about. An "ok" answer to a previous message is not
authorization for the next run; the authorization is for the specific run that is
described.

Before the asking, this is shown, every time:

| Shown | Why |
|---|---|
| **the cycle**, whole, with the current station | the decision the asking serves is exactly "which station are we at" |
| **what exactly will be run** | which command, on what, how many cases |
| **the cost**, from measurement | from an artifact or from a previous run, not from judgment |
| **what question it answers** | a run without a hypothesis is not bought |
| **what happens if it is not run** | sometimes the answer is "nothing" and that saves the money |

If any of the five lines is missing, the asking is not ready.

### What requires the word, and what does not

Adjudicated by the owner on 2026-09-05, and it is **narrower** than what I had
written: *"it was about spending in n8n, not about Grok. Grok is run by the rules
and there is nothing to ask me."*

| Requires the word `harchi` | Runs without asking |
|---|---|
| **a run in n8n that calls a model** | **Grok** — on the owner's subscription, a fixed monthly fee |
| — | **uploading a workflow to n8n** — a description, not an execution |
| a direct call to the Anthropic or OpenAI API | **Codex** — on a subscription, not called with an API key |
| a new tool that draws money and is not yet in the table below | |

The grounds for the split, adjudicated by the owner on 2026-09-05: *"We don't
call Codex with an API here, so it is not spending. It is on subscription."* The
same holds for Grok. A subscription means **a fixed monthly fee** — one more run
does not raise the bill. The run in n8n is the other thing: it draws from credits
that run out, and each run has its own cost.

The number `total_cost_usd` that Grok returns **is not a bill** — it is what the
run would cost at API prices. It is recorded as a measure of weight, not as a
spend.

**The red block and the word hold for the left column.** The right is run, the
cost is reported, and that is it.

**Uploading is not execution, and that is the difference that must be said.** The
owner asked on 2026-09-05 whether `release` was spending. It was not, and the
check is the number: `spend --short` shows the same before and after. The chain
uploads the **description** of the workflow, pulls it back and compares
fingerprints — no model is called. The spending is the next step: someone presses
the webhook and the workflow calls the model.

| Action in n8n | Does it spend |
|---|---|
| create / update / get / delete of a workflow | **no** |
| `record-baseline`, `verify-deployment`, `release` | **no** |
| **execution** of a workflow with a model in it | **yes** |

The rule did not say this anywhere, and the question was well-founded: a list
that enumerates "a run in n8n", without saying which run, leaves half of the
actions undefined. Grok warned precisely about this — *"an n8n check that executes
the workflow and bills the model credential while looking like a status read."*

The rest of this section is recorded because it was learned expensively, and
holds for everything that **does** require the word.

### How you ask and with what word it is authorized

Codex, to the question whether "discuss it with Codex and Grok" was
authorization: **no** — *"let us decide reserves the decision; moreover,
permission cannot exist before the required five-line proposal identifies the
specific run."* The verdict holds even after the narrowing above: a sentence that
names a tool asks for preparation, not a run.

**The asking is a red block.** Chosen by the owner on 2026-09-05, after he fixed
my claim that the terminal colored nothing: it does color — through markdown. The
green echo is a `diff` block with a leading `+`; the same block with a leading `-`
is drawn **red**. Blue is not possible.

The form, verbatim, right before the five lines:

    ```diff
    - HARCHI · <tool> · $<cost> · waiting for the word "harchi"
    ```

The red is for visibility, not for authorization. The authorization is the word.

**The authorization is the word `harchi`.** Only it. Requested by the owner on
2026-09-05 and chosen because it does not happen by accident:

| Not authorization | Why |
|---|---|
| "ok", "go", "yes" | they are said to everything and were already taken as authorization once |
| the name of the tool | naming asks for preparation, not a run |
| the red block by itself | it is for visibility; the word is the authorization |
| authorization from a previous message | it holds for the run that is described, and for nothing else |

**One "harchi" is one run, and a retry is a new run.** Grok, 2026-09-05: *"one yes
authorizes one run; a retry is a new run."* A hung run that is run again after a
timeout **is billed a second time**, but is tracked as the same — that is the way
one authorization becomes three bills.

**Three things spend without looking like a purchase** — from the same review,
and all three are verifiable:

| Looks like | Is actually |
|---|---|
| a retry after a hang | a second payment for the same question |
| a "check" of an n8n workflow that **executes** it | draws from the credential while looking like a state read |
| a push that starts CI | minutes, paid elsewhere |

**A tool that is not in the table becomes the cheap path.** Grok said it as an
objection against its own rule — *"unnamed tools become the cheap path"* — and
that had already happened: `grok` was missing from the table "which commands spend
money" until the day I spent only with it. So the table below is filled in
**before** the first run of a new tool, not after it.

**There is no cheap path.** Codex proposed a threshold of $0.05 per message and
itself recorded its objection: *"it weakens no exceptions and makes correct
enforcement depend on … facts the agent still judges."* Rejected on that ground,
and Grok independently arrived at the same: a cheap path can exist **only as a
line written by the owner** in this rule — a tool, a ceiling in dollars from the
last measurement, a count per day — *"the agent may not invent, widen, or
classify them."* The threshold requires me to judge how much something costs, and
it is exactly my judgment that the rule takes away. Today's violation was for two
cents; if there were a threshold, it would have been allowed, and the same
judgment would hold for the expensive one too.

**And a subagent never spends** — this is in the prompt, by name, with the
commands.

### The double check before a paid run in n8n

Requested by the owner on 2026-09-05, after one Grok run found, in the isolation
check, a defect that three rounds of Codex had missed.

**Cancelled on 2026-09-10** — see "only Codex, without Grok" below. Until then it
held: **the payment asking is not posed until the three agree that we are
ready.** Requested by the owner on 2026-09-05, verbatim: *"never ask me for
payment if you haven't done a triple check with two Grok and Codex, and you don't
all agree that we are ready."*

This is stricter than the previous rule and the difference is important: a
**review** was asked for, now **agreement** is asked for. A review that has run
and said "not yet" does not open the asking — it closes it, until the findings are
closed.

| Not ready for asking | Ready |
|---|---|
| the reviews are not run | all three are run |
| someone found something that would waste the run | no one finds such a thing |
| the findings are fixed, but no one looked at the fix | the fix has gone through a round |

**The review holds for the run that is upcoming, not for one from before.**
Violated on 2026-09-06: I asked for money, showing the red block, while the two
Grok had looked at a state from two rounds back and had not seen either the gate,
or the skip, or the fixed wiring. The owner asked why I was not carrying out the
rule — and he was right.

The cost of not keeping it was measured at once: run the same hour, the two Grok
returned `no`. One traced the chain and pointed to a fragility that worked by
accident; the other showed that the run **does not close** two of the three things
I wanted it for, and proposed a cheaper run that answers more. That is, the asking
would have bought less than I claimed.

Violated once earlier too, in the opposite direction: I asked for the word
**before** the three had pronounced. The owner gave it, and after that all three
said "not yet" — and all three pointed to **the same thing**: `source_ref`,
started with `observation.`, because the payload sees the wrapper. The run would
have been refused at the first agent.

### What stops a paid run · adjudicated on 2026-09-08

**The scope of the three reviews is narrowed. Their number does not change, and
their right to stop the spending is removed only for one narrow class of
findings.**

Round 46 and round 47 ended with a refusal from the three, both times for defects
in `scripts/score-run.mjs`, `scripts/readiness.mjs` and `docs/next-measurement.md`
— zero in the chain. Grok, to the question whether we are not going in a circle:
*"Review of new code → finding → fix → new unreviewed code. It stops only at an
empty review. The observed frequency is a refusal every round. This is not a
brake — this is a generator of refusals."*

**The first version of this rule was a list of exempted files, and was rejected by
Grok the same day.** The objection, verbatim: *"Between the lists lives the runner
— the script that POSTs and records the «raw». It is in `scripts/`, it is not
named. The unnamed has no direction. The agent who wants a run puts it in «does not
stop»."* And the second: *"The new thing runs the three reviews, but takes away
their right to stop the spending for exactly this class of findings. The number is
theater."*

Both are true. So the rule is not a list of files, but **one question about the
finding**:

> Can this defect be fixed **after** the run, only from the recorded raw answers,
> without a new call?

| Answer | What follows |
|---|---|
| **yes, clearly and verifiably** | does not stop the run; is fixed later |
| **no** | stops |
| **not clear** | **stops** — the unestablished falls toward stopping, not toward authorization |

The third line is half the rule. A file that no one has classified is "not clear"
and **stops**.

**What a "yes" looks like in reality:** the arithmetic by which a recorded answer
becomes a verdict — counting citations, thresholds for confidence, how readiness
is summed. It reads a file that is already on disk, and is run again for free.

**What a "no" is, and each of these has been pointed out:**

| Finding | Why it is not fixed later |
|---|---|
| the protocol points to the wrong scenario, the wrong fixture or the wrong address | you pay for up to four calls on the wrong question; the re-computation does not birth the correct raw answers |
| the runner sends the wrong alert, loses or remakes the raw answer | "we will re-compute" has nothing to work on |
| something claims the deploy is in step, and it is not | you exercise someone else's workflow; the raw is its, not the chain's |
| a prompt, a schema or a node in the chain | the defect is in the run itself |

**The runner by name stops**, so that it is not decided again:
`scripts/run-scenarios.mjs` produces the raw, and the premise of the whole rule is
that the raw survives.

**Fixable evidence does not make the consequences fixable.** Codex, 2026-09-08, on
the second version of this rule: a scorer that by mistake reports part 1 as
entirely correct is **clearly fixable** from the raw answers — but the wrong
verdict has already **authorized part 2**, which the fixed verdict would forbid.
"The unclear stops" does not catch a clear "yes".

So the criterion holds for the **evidence**, not for the decisions made from it:

> A verdict produced by a scorer that was later fixed **does not authorize a next
> part**. Before every next spending the result is re-evaluated with the fixed
> scorer, and the decision is taken from the new number.

In practice: a scorer is fixed, the raw answers are re-evaluated, and only then is
it looked at whether the next part is bought. If the re-evaluation changes the
answer, the part is not bought.

**The cost, said out loud:** a run may turn out to be scored with a wrong scorer,
and then the scoring is done again from the recorded answers. This is cheap.
Paying again is not.

**What does not change:** the word `harchi` is the only authorization; one "harchi"
is one run.

### Cancelled on 2026-09-11 · the review is Astra

The owner, to the question who reviews: **`astra`**.

That is `gpt-6-astra`, run through `codex exec -m gpt-6-astra`. One review, and it
is this one. Grok is not run by default.

**The ground is measured, not a preference.** Today both were run, and both drew
correct findings — Grok drew the third reading of `container-oom`, the defect in
the scorer and the "parked bug" in one limitation; Astra rejected `must_support`
with reasons, fixed three of my exaggerated conclusions, and knocked down the
project's grounds for the async look. Neither of the two was empty.

The difference that counts: **Astra concedes when it is wrong, and says that my
question is the wrong one.** That is more useful than a finding.

**The form of the run:** `codex exec -m gpt-6-astra -s read-only
--skip-git-repo-check "PROMPT" < /dev/null 2>&1`, in the background, with the
hostile mandate from §6. Subscription — does not spend.

**Grok stays reachable and is run only when the owner asks for it.** Its form is
in `docs/grok-on-this-machine.md` and works: `--permission-mode
bypassPermissions`, `read` allowed, paths instead of pasted code.

### Cancelled on 2026-09-10 · one review, and it is with Grok

The owner said two things in one day, and the second is in force.

First: *"I think there is no need for a triple check, n8n is cheap, so only a
Codex check from now on, without Grok."* — that is **three reviews become one**.

Then, right after that: *"then do the checks with Grok, not with Codex."* — that
is **the review is Grok**.

**From now on the review is one, and it is Grok.** Codex is not run.

| Falls away | Stays |
|---|---|
| three reviews before a paid run | **one** |
| Codex | **Grok**, with the hostile mandate from §6 |
| "and all three agree that we are ready" | Grok having no finding that stops the run |
| — | the word `harchi`, and it is the only authorization |
| — | the criterion "what stops a paid run" above, unchanged |

The ground for the narrowing is his and is about **the cost of the run**, not the
quality of the review: the measured run costs cents, and three reviews before it
cost more waiting than the run costs money.

**The form of the Grok run is not shortened** — it is in
`docs/grok-on-this-machine.md`: `-p`, `--model grok-4.6`, `--sandbox read-only`,
`--disallowed-tools`, `--no-plan`, `--no-subagents`, `--json-schema`,
`--output-format json`. The key thing is that Grok answers **only from the passed
text**, so the prompt must carry the code — otherwise the run stops after the
introduction.

**Grok is on a subscription** — SuperGrok Lite, a fixed monthly fee. The number
`total_cost_usd` that it returns is weight, not a bill, and is not summed with the
n8n credits.

**What is lost, said out loud:** Codex has caught things that no one else has —
over the last two days eight of its findings were correct, including "an older
attempt outlives a newer measurement" and "the gate pulls Ajv at load". This risk
is accepted deliberately, because the scope is the owner's decision.

**The rest of this section is the history of the previous rule** and is read as
such — it does not hold from 2026-09-10.

**Until 2026-09-10 it held: before every paid run in n8n three reviews go through:
two with Grok and one with Codex.** Not one, not "if there is doubt" — three,
every time.

| Review | With what mandate |
|---|---|
| Grok · 1 | the code that the run will exercise |
| Grok · 2 | **another angle** — the tests that claim the code is protected |
| Codex | the whole diff before commit, by the form from §6 |

The two Grok reviews are two **different questions**. Two runs with the same
prompt are one measurement, paid for twice.

**And the three run at the same time, not one after another.** Discussed with the
owner on 2026-09-05. The ground is independence: a review that reads the code
after someone else's verdict either searches where it was pointed, or repeats work
already done. Today's case shows it — Codex reviewed the isolation three times and
approved it; Grok broke it on its first run. If Grok had seen "this is fixed and
accepted", it most likely would not have dug there.

Parallel is also cheaper in time: the waiting is one instead of three.

**The fix goes through one new round, not three.** When the findings are
processed, one review is run on what was fixed — usually the one that found it,
because it knows what it was looking for.

The ground is measured, not assumed: Codex reviewed the isolation three times and
approved. Grok, on its first run, showed that the check compares the payload with
**a repeated copy of its own source** — that is, it proves self-consistency, but
is called isolation. Contamination that is already in the slice passes. Verified
live, before acceptance: another client's password in the observation itself →
`clean`.

The form of the Grok run is in `docs/grok-on-this-machine.md` and is not
shortened: `-p`, `--model`, `--sandbox read-only`, `--disallowed-tools`,
`--no-plan`, `--no-subagents`, `--json-schema`. The key thing is
`--disallowed-tools read` — Grok answers from the text that is passed to it, and
the prompt must carry the code. Without this the run stops after the introduction
and costs nothing but time.

**The prompt to Grok is hostile, exactly as to Codex.** Requested by the owner on
2026-09-05. Not "review this" and not a list of my suspicions, but the same
mandate from §6: *assume there is a defect, and find it*, with a word limit, with
"if you find nothing, say so plainly", and with the explicit `No money`. The
difference between the two tools is in **the angle of the question**, not in the
tone: a soft review is more expensive than none, because it costs money and
returns confidence that was not earned.

**The cost is recorded.** `total_cost_usd` comes from the answer, not from
judgment. The first run: **$0.027**.

**Otherwise: act, don't ask.** Reversible and free — do it and then say. Asking
costs the owner more than running again costs you. Outside spending, only two
things are asked in advance: what reaches other people, and what cannot be undone.
Something is broken — fix it. A reported defect that you could have fixed turns
your work into someone else's to-do list.

**A question is a question.** "Why does this crash" is not "make it not crash".
"Should we use X" is not "move everything to X". When in doubt assume it is a
question: answer, then stop. The action is proposed with one sentence, not
started.

**The report is not a stop.** If I wrote "next is X", X starts in the same
message. The report says where we are; it does not ask for permission. The
**NEXT** and **IN PROGRESS** bars are not a list for approval — whatever in them is
free and reversible is done and then reported.

**The stopping shrinks to the spending action itself, not to the stage around it.**
I stopped before a whole chunk, because one thing in it calls a paid model — but
the structure, the prompts, the deterministic part and the tests were free and
stood untouched. Everything up to the spending command is done, and the asking
stands right before it, with the five lines from §3. Stopping before a whole stage
is shrinking the scope, and the scope is the owner's decision.

Recorded on 2026-09-04, after the owner said it twice: "I don't want it to repeat"
and "how come you stop again without a reason". It stays **here**, not in memory,
because §12 says why: a rule in memory is a pointer that is not executed.

**Done means done.** Five requested things are five delivered. If the fifth is
truly blocked, the remaining four are finished and the block is said with one
sentence. "I will continue in the next message" is not a state. Shrinking the
scope is the owner's decision, not yours.

**The concept before the code.** For everything above a minor edit: describe what
the parts are, how they talk and where it can break, wait for agreement, then
write.

**Work with the agents, don't wait for them.** A launched agent is background
work, not a pause. While it reads, you write — on another file, so you don't
collide. "I am waiting for the agent" is a report of a stop. The exception is only
a real dependency: its result decides what you write. Then you say **why**, not
only that you are waiting.

**Show progress during free work.** Local work prints nothing until it finishes,
and from the outside is indistinguishable from a stop. One line before a long
step, a report at each step, and a short "still running, N of M".

**Push without being told.** The chain is review → commit → push, and all three
are part of "done".

---

## 4. Verification

**Verify, instead of assuming.** If the question is solved with a command — run
it. "It is probably because…" is a signal to stop and to look. This holds also for
your own code: a docstring and a comment describe what was intended, not what the
code does today.

**The numbers come from measurement, not from expectation.** Cost, time, coverage
— from an artifact or a log, not from judgment.

**Do not change a design from one observation.** N=1 is not a measurement.

**And do not accept a fix from one run.** Adjudicated by Codex on 2026-09-07,
after six live runs, each of which fixed one thing and broke another: *"there is
no score out of five that solves this… another run risks becoming the seventh
prompt-edit trigger rather than an evaluation."*

A live measurement that must establish that a fix works is **repeated**: the same
input, several times, on a frozen prompt. The success criterion is written
**before** the run. A single run says "it worked today", not "it is fixed", and
the difference between the two is a whole week of rounds.

**When a fix moves responsibility from the model into the code, it kills a
canary.** Grok, 2026-09-06: the refused citation was the **only** evidence that
the model ignored an instruction given twice in its own words. After the
normalization an obedient and a disobedient model record the same, and a further
change in the prompt cannot be measured against that failure.

The answer is not a return to the refusal — but **counting**. A run with zero
normalized citations and a run with four are different runs, and the number says
it.

**And the generalization itself is refused as a policy.** "The prompt does not
converge, the code always works" has no brake: with it every future failure of the
model is moved into the code, until nothing is owed to the model. The true thing is
the narrower one: **only the wrapper that the system itself puts around the
observation is normalized.** Every other dialect is refused.

**Every fix comes with a test that would have caught the bug.** Not a test that
the code works — a test that the specific failure does not come back.

**Verify that the new test really fails without the fix.** Bring the defect back in
mind or in a copy and see whether the test changes. A test that passes with the
defect too is decoration — and it is much easier to write than it looks.

**Watch out for a test that passes on an empty set.** `assert not X`, where `X` is
always empty, and `any(...)` over an empty generator always pass. If the test only
has meaning while something exists, write it as a precondition:

```python
assert "sonnet_gate" in undefined, (
    "this test only has meaning while some step is undefined; "
    "if all have a criterion, delete it, instead of it passing on empty")
```

**Test the chain, not the links.** A rule with a test for the schema, for the
aggregation and for the scope, but without a test **that it blocks**, is a rule
with zero coverage over the only thing it does.

**When you fix something, look for its second carrier.** The same logic in two
places; the same expression in code and in a test fixture; the same statement in a
message, in a docstring and in a **test name**. Fixing only the one pointed out is
the most common way for the defect to stay.

---

## 5. Absence is not consent

The most common defect, and it comes out in ever new places:

```python
if expected and recorded and recorded != expected:   # the missing passes
bool(row.get("passed"))                              # missing → False; "false" → True
body if isinstance(body, list) else []               # an object is iterated as nothing
glob("results/*.json")                               # results in subfolders are not seen
raw.get("flag") is True                              # "true" and 1 are read as turned off
yaml.safe_load(text)                                 # a duplicated key: the last wins, silently
for name in record:                                  # a deleted record has nothing to contradict with
```

**Require the needed, do not forbid the impossible.** "The check is turned off,
but something claims it checked" is refusable; "the check is turned off" is what is
actually happening.

**Distinguish "I could not verify" from "it is clean".** Different answers and
different exit codes. A crash must never exit with the success code.

**Three states, not two.** `done` / `not done` / `cannot be established`. The
third is reported separately and has its own exit code. Gluing it to the second
turns "I don't know" into "no".

---

## 6. Review

**The consultation is mandatory, and is not summoned by the money.** This is a
rule, not a judgment: not "when you are unsure", not "on a big change", not
"before a paid run". Every decision goes through an external review — **every**.

What a decision means here:

| Goes through review | Example |
|---|---|
| a change in code | every diff before commit |
| a change in a rule or a decision | rewriting a sentence in the decisions |
| a label of a failure | "this is defect X", and not Y |
| a choice of scope | what goes in and what stays outside a measurement |
| closing an open question | including when the owner delegated it |
| an answer "there is nothing to do" | the most dangerous, because it leaves no trace |

**Not for approval, but for objection**, and the objection is recorded verbatim.

The ground is measured and not theoretical: **every time it was decided without
review, something came out.** In one day with nine rounds over twenty defects came
out, of which two critical — and not one was in what I had asked about.

**Nothing is recorded that the review has not seen.** If you change the file while
the review reads, the verdict is for a state that no longer exists — say it in the
next round.

**There is only one exception:** a trivial mechanical edit, where there is nothing
to adjudicate — a typo, a rename without a change in behavior. If you hesitate
whether it is such, it is not.

**The review is hostile, not an answer to my questions.** The artifact is given
and a mandate: **assume there is a defect, and find it.** A list of my suspicions
is a map of what I already know, and directs the attention exactly there.

A round of questions stays a fitting thing only at a real fork — the two
possibilities are known and the question is which of them. This is adjudication,
not a hunt.

**The unit is the commit.** Nothing is recorded that the review has not seen. The
chain is: write → put the diff before the review → act on the verdict → commit.

**Never describe the code to the review — point it to the code.**

**The verdicts are checked against the code, not followed blindly.**

**A subagent reads standing code with a hostile mandate, not only writes new.**
The external review looks at the diff and finds what you broke now; the subagent
looks at the code that stands and finds defects from months ago. The mandate is a
specific class of defect.

**An agent's finding is a hypothesis, not a result.** It is verified before it is
accepted.

### Working with Codex — the exact setup

> **Cancelled on 2026-09-10.** The external review is **Grok**, not Codex — the
> owner decided so the same day, and the decision is in "one review, and it is with
> Grok" above. Everything in this section stays as a **reference**: if Codex ever
> comes back, this is how it is run. It is not run today.
>
> The form of the Grok run is in `docs/grok-on-this-machine.md`. What is
> **carried over** from here and holds for Grok too is the prompt: a hostile
> mandate, a word limit, "if you find nothing, say so plainly", and the explicit
> `No money` with the names of the commands.

Until then: Codex was the external review. It is **on a separate account** and does
not touch this session's limit — but "on another account" does not mean free, it
means elsewhere.

**The command, always this one:**

```bash
codex exec -s read-only --skip-git-repo-check "<the prompt>" < /dev/null 2>&1
```

| Part | Why it is mandatory |
|---|---|
| `-s read-only` | writes nothing; never `--force`, never `--yolo` |
| `--skip-git-repo-check` | otherwise it refuses in some trees |
| `< /dev/null` | otherwise it hangs on stdin — see the trap below |
| `2>&1` | the verdict comes out partially on stderr |

It is run **in the background** (`run_in_background`), because one round is
minutes, and waiting is a stop.

**A trap, measured on 2026-09-04:** `codex exec` hangs with "Reading additional
input from stdin…" and does not return. The cause is one `<` sign in the text of
the prompt — the shell reads it as a redirection. So: `< /dev/null` at the end, and
**no `<`, `>` and backticks in the prompt**. Write `check ACTION`, not
`check <action>`. Without the redirection it does not fail, but **waits** — which
from the outside is indistinguishable from a long review and costs the whole
waiting, before anyone looks.

**The form of the prompt.** Not a list of my suspicions — that is a map of what I
already know:

```
Assume there is a defect and find it. Under 400 words.

Repository <path>. Uncommitted: <the files>. Gate before the commit.

<what changed, briefly and without describing the code>

Attack it. In particular: <2–5 concrete questions, each attacking a decision of mine>

If you find nothing, say so plainly and say commit.

No money: do not run <the commands that spend>.
```

Three things in this form do the work and all three are learned the hard way:

* **a word limit** — otherwise the verdict spills and the important thing sinks;
* **"if you find nothing, say so plainly"** — otherwise it produces a finding,
  because it was asked for a finding;
* **the explicit "no money"** — with the names of the commands, not "don't spend".

**The Codex model is chosen — with a name from the account's list.** Adjudicated on
2026-09-06, after I first concluded the opposite from four identical errors. The
error was mine: I was guessing names (`gpt-5-codex`, `gpt-5`, `o3`) instead of
reading which list the account has.

**The list is on disk:** `~/.codex/models_cache.json`. Today: `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini`. Every name outside it
is refused — this is a server check, not a missing feature.

**`-m` is not passed.** Adjudicated by the owner on 2026-09-06, after through most
of the project the reviews were exactly that way. The server chooses.

The attempt with an explicit model stays recorded, because it is measured and
useful: the account's list is in `~/.codex/models_cache.json` (today `gpt-5.6-sol`,
`-terra`, `-luna`, `gpt-5.5`, `gpt-5.4-mini`), `-m` works with a name from there,
and none of this asks for an API key. If a choice is ever needed, this is how it is
done.

**The cost of the missing `-m`:** two runs are not strictly comparable, if the
server changes the model under us. Accepted deliberately — the scope is the
owner's decision.

**The two error messages are different and that is the diagnosis:**

| Name | Answer |
|---|---|
| `astra` | "not supported when using Codex with a ChatGPT account" — the name does not exist |
| `gpt-6-astra` | **"requires a newer version of Codex"** — the version stops; about the account **nothing is known** |

**The codex limit is on the ACCOUNT, not on the model — established on
2026-09-11.** Astra (`gpt-6-astra`) returned "You've hit your usage limit … try
again at Sep 15th". The switch to `gpt-5.6-sol` returned the **same** error, at
once. That is, when codex is at the limit, no model from `~/.codex/models_cache.json`
is available — `-m` does not bypass the limit. The only external review that
remains is **Grok** (a separate subscription, SuperGrok Lite). Don't waste runs
trying other codex models, once one has returned a limit.

**Verified anew on 2026-09-09, and the old record was untrue.** The installed
version is **0.153.4**, and the list in `~/.codex/models_cache.json` contains
`gpt-6-astra` — that is, the account has it. What was recorded until then ("it
requires 0.153.0+, the installed is 0.149.0, about the account nothing is known")
was true for its day and went stale, without anyone coming back to check it.
Today's list: `codex-auto-review`, `gpt-5.5`, `gpt-5.6-luna`, `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-6-astra`, `gpt-reserve`.

**The decision does not change from this:** `-m` is not passed, the server
chooses. If a choice is ever needed, `gpt-6-astra` is now reachable and this asks
for nothing else.

The lesson is for the file, not for the model: **a number or a version, recorded
once, goes stale silently.** They are read anew, before they are cited.

**The rounds do not end at the first.** Five to nine is normal: every round finds
what the previous did not. The verdict is checked against the code **before** it is
accepted — Codex has been right many times and wrong on a wrong premise.

**When the review is enough.** Not "when I get tired" and not a fixed number:

| Stops, when | Does not stop, when |
|---|---|
| the round finds nothing and says so plainly | the round found only small things — they too are fixed |
| the last question gets "commit" | I decide that the finding is insignificant |
| the findings start being about things outside the scope | I run out of patience |

**The last round asks one thing:**

> Is there anything for which you would block the commit? Not a list of wishes, but
> an error in what goes in. If there is not — say so plainly and say commit.

**When I do not agree with the verdict.** It is not followed blindly and is not
ignored silently. It is checked against the code; if the code refutes it, that is
said in the next round with the line from the code, not with an argument. If a
disagreement remains after that, it goes to the owner with both positions — it is
not decided by me.

**Codex does not see what you changed while it reads.** If you edit during the
round, the verdict is for a state that no longer exists. Either wait, or say it in
the next prompt: "two things changed under you, read them again".

**Nothing connected to Codex goes into the repo.** Neither the prompts, nor the
verdicts as files. Their content goes in — as a sentence in the decision, with the
date.

### The recurring own defect

Recorded separately, because it comes out every round: **fixing a defect through
the same defect one level up.**

* A claim that nothing checks, fixed with a new claim that nothing checks.
* A contradictory rule, "fixed" with a tool that would have frozen the
  contradiction.
* An open question, closed with my reconciling formulation, presented as a reading
  of what is already decided.
* The same question, recorded as a question — but with the first variant deleted.
* A new decision, recorded in the text, while the old paragraph that says the
  opposite stays three places below.

**How it applies:** when a fix ends with the file claiming something new, check
whether someone decided that claim, or whether it came with the fix. If it came
with the fix — it is yours, and is signed as yours or goes to the owner. **A
question with a missing branch is an answer.**

---

## 7. Subagents

**A subagent is run without a reminder, when the task is a review, an audit, a
defect hunt or a traversal of many files.** Requested by the owner on 2026-09-07.
The mandate is **one class of defect**, not a file — measured on this project: a
narrow mandate returned 11 of 11 correct findings, and on 2026-09-07 three parallel
subagents drew 28 findings, including a rule that the prompt requires and **nothing**
checks, and a debt that waits for a file that no one writes. A general review
returns prose.

The hook `~/.claude/hooks/suggest_subagents.py` reminds; it does not run — a hook
can only allow, refuse or add text.

**No subagent spends money.** It is written explicitly in the prompt, with the
names of the commands that are forbidden.

**And it does not touch the files through which other work goes.** They are
enumerated by name.

**An agent is run for limited work and with an explicit reason.** The model is
chosen by how uncertain and hard to verify the task is, not by its label.

**A package in motion is checked, before more is added.**

---

## 8. The machine

**Never `git checkout -- <file>`, `git stash` or `git restore`, to undo a
change.** They return the file to HEAD and throw away every unsaved work in it,
including what a subagent is writing at the moment. Undo with the reverse edit.

The same holds for `git reset --hard`, `git clean -f` and `rm -r` on the root or
the home folder.

**Every refusal says what to do instead.** A refusal with no way out is bypassed
with a reformulated command, which is worse than not refusing.

**Record the machine traps, as soon as they come out.** A command that behaves
differently on this machine; a tool that hangs on stdin; a hook that rewrites the
command.

### Hooks — what is configured and why

Registered in `~/.claude/settings.json`, that is, they hold in **every** project.
The scripts are in `~/.claude/hooks/`.

| Event | Command | Does it block |
|---|---|---|
| `PreToolUse` · `Bash` | `rtk hook claude` | no — rewrites the command |
| `PreToolUse` · `Bash` | `python3 ~/.claude/hooks/guard_bash.py` | **yes** |
| `PostToolUse` · `Write\|Edit\|NotebookEdit` | `python3 ~/.claude/hooks/check_edit.py` | no |
| `Stop` | `python3 ~/.claude/hooks/finish_check.py` | an unreadable file, a forgotten `breakpoint()`, **or a promise without action** |
| `Stop` | `python3 ~/.claude/hooks/spend_preflight.py` | **only asking for `harchi` without a cleared review of the same run** |
| `Stop` | `python3 ~/.claude/hooks/waiting_status.py` | **a launched background process (not `sleep`) without a launched 2-min heartbeat** |
| `UserPromptSubmit` | `printf` with a reminder about the green echo | no |

**`guard_bash.py`** refuses the commands that the rules forbid by name:
`git checkout -- <path>`, `git restore`, `git stash` (except `list` and `show`),
`git reset --hard`, `git clean -f`, and `rm -r` on the root or the home folder.

Three things it deliberately **does not** do, and each is recorded in it:

* **it does not parse the shell** — a command can hide anything behind a variable
  or a subshell; a guard that pretends to understand the shell gives confidence it
  has not earned. It matches by the written words and says so;
* **it does not refuse what it could not read** — an unintelligible payload gives
  no decision, not a refusal. A guard that blocks on ambiguity is turned off, and
  then it guards nothing;
* **it refuses the command, not the intention** — every message says what to do
  instead.

**The two hooks on `Bash` are two deliberately.** Measured: `rtk hook claude`
returns `allow` exactly for `git checkout --`, `git stash` and `git push --force` —
that is, the commands that the rules forbid by name are the only ones that anyone
actively runs. **The refusal of the second hook beats the allow of the first**;
verified live, not assumed.

**`check_edit.py`** — syntax, then the linter that the repo **declares** (not the
assumed one), and only on the file that was just written.

**`finish_check.py` also blocks a promise without action.** Added on 2026-09-06 at
the owner's request, after I wrote "I'm running the three now" and stopped, without
running them. The rule had it — in §3, twice — and I still broke it. **A rule that
nothing checks is a rule that I cite while breaking it.**

It blocks exactly one form and nothing else: the last thing said is a first-person
promise, and **after it not a single tool was run**. Three things explicitly **do
not** block, and each is a boundary, not an omission:

| Does not block | Why |
|---|---|
| a promise, followed by a call | the promise is fulfilled |
| a promise, while the owner's word is awaited | it is not due now — recognized by "waits for the word", "requires the word", "tell me" |
| a message that cannot be read | the unreadable is not evidence of anything |

**Verified live, not only as a function.** The owner: "check whether the hook
catches you, otherwise it is decoration" — and he was right that the test of the
function is not a test of the hook. Between the two stand three things: is it
registered, does Claude Code pass `transcript_path`, and does the format of the
record match.

| Verified | How |
|---|---|
| registered | the `Stop` block in `~/.claude/settings.json` |
| blocks on a promise without action | it was given input in the same way → `decision: block` |
| runs on a promise **with** action, on a report, on waiting | the same, three cases |
| does not block on a missing or unreadable path | "I could not verify" is not a reason to lock the session |
| **Claude Code passes `transcript_path`** | the hook records `~/.claude/hooks/last-stop.txt` on **every** stop; read after a real stop on 2026-09-06 at 17:50 — `transcript_path: yes`, and the last text was my message verbatim |

The last is the only one that is not seen from the inside, so it is recorded
instead of assumed. If it ever says `NO` there, the check cannot work and the hook
is exactly the decoration the owner warned about.

**`finish_check.py`** — facts before a stop. Deliberately **not** a "quality gate":
it does not know what the task was, so it cannot choose "the appropriate tests",
and a choice with a report "they passed" over the wrong scope is exactly the defect
that is caught everywhere else.

Three boundaries the hook **does not** cross, and each was requested:

| Does not do | Why |
|---|---|
| **does not run the tests** | a suite of minutes after every edit is removed by the first person in a hurry |
| **does not fix and does not format** | the file on disk becomes different from the one the agent thinks it wrote |
| **does not refuse when it could not verify** | a hook that blocks on ambiguity is turned off — and then it guards nothing |

**`spend_preflight.py` blocks asking for `harchi` without a cleared review.**
Requested by the owner on 2026-09-11, after I asked for the word several times,
before the review had cleared the specific run. The rule had it in §3 — and I still
broke it. A rule that nothing checks is a rule that I cite while breaking it.

How it works: the review records a machine-readable verdict
`out/spend-preflight.json` — `{when, reviewer, keys, verdict, blocking}`. The hook
fires only when the last thing said is the red block `- HARCHI … waiting for the
word "harchi"`, and it blocks, unless the verdict: exists, says `verdict: clear`
with empty `blocking`, is fresher than an hour, and one of its `keys` appears in
the asking itself. A verdict for another run does not clear this one.

The boundary, honestly: the hook is inside the reviewed, so it checks that the step
has gone and declared itself clean — **not** that the review was correct. That
stays with me and with the text of the review. Three things it deliberately does
not do, each like the other two Stop hooks: it does not spend and does not run a
review; it does not touch the network and does not write; and it stays silent when
it cannot read the transcript or the cwd — "I could not verify" is not "something
is wrong". In another project the red block does not appear, so there it is mute.
Eight cases verified live, before it was recorded here.

**`waiting_status.py` stops a silent stop during waiting.** Requested by the owner
on 2026-09-12: "when we are waiting for something, a status every 2 min, what we
are waiting for". A hook cannot launch a timer itself — it fires on an event, not
on a clock. So it does not print the status; it refuses the waiting to start
without a launched heartbeat. **It fires by what the turn LAUNCHED, not by the
text:** if in the turn a background process was started that is not `sleep`
(Grok/Codex review, gate, poll), and no background `sleep` heartbeat was launched —
it blocks. The first version fired by text ("I am waiting for Grok") and hit two
false blocks on a report that only MENTIONS Grok in a plan; so now the launched
process is watched. A report or a question to the owner does not launch a
background process → they are never blocked, whatever they say. Boundaries like the
other Stop hooks: it stays silent on an unreadable transcript, on a turn without a
launched background process, and on an already launched heartbeat; it does not
sleep, does not spend, does not touch the network. Seven cases verified live,
including the real format in which the tool_results are "user" lines.

**A hook does not replace the external review.** `Stop` is inside the reviewed: it
can say what stands in the tree, it cannot establish that a review was done, nor
that what was reviewed is what went in. For that a gate **outside** the agent is
needed — a git hook on `pre-commit`, tied to the identity of the future commit.

**If you add a hook in the project's `.claude/settings.json`**, it is read only if
the folder had a settings file at the start of the session. Otherwise: `/hooks`
once, or a restart. This is not seen by anything and looks like a broken hook.

---

## 9. Git and GitHub on this machine

Verified on 2026-09-04.

**There is no global git identity.** `git config --global user.email` is empty, and
that is deliberate. The identity is set **for each repo separately**:

```bash
git config user.name  "Dimitar"
git config user.email "dimitar.shenkov@gmail.com"
```

**This email, not the other.** `dimitar.shenkov@gmail.com` is for the commits.
`neda.vacheva@gmail.com` is the email of the Claude account and was used once by
mistake in the first commit. It is not used for authorship.

**The authentication is by SSH, not by token.**

| | |
|---|---|
| key | `~/.ssh/id_ed25519_github` — ed25519, **without a passphrase** |
| public | `~/.ssh/id_ed25519_github.pub`, already uploaded to GitHub |
| configuration | the block `Host github.com` in `~/.ssh/config` with `IdentitiesOnly yes` |
| user | `dimashenkov` |

`IdentitiesOnly yes` is the important thing: without it ssh tries all keys in turn
and GitHub refuses, before it reaches the correct one.

**The remote is set by SSH, not by HTTPS:**

```bash
git remote add origin git@github.com:dimashenkov/<repo-name>.git
ssh -T git@github.com     # check: it should greet with dimashenkov
```

**For a new repo in GitHub** — it must exist there before the first push. The
creation is with the owner: either through the interface, or with `gh repo create`,
which asks for interactive input. Interactive commands are proposed with a `!`
prefix, so that he runs them in the session.

**The commit messages end with:**

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: <the session address>
```

**There are no keys and tokens in the repo.** If the project needs such a one, it
comes from the environment and is recorded in `.gitignore`, before the file
exists.

---

## 10. Money and limit

**Asking before spending is mandatory** — the rule is in section 3 and is repeated
here, because this is the section someone reads when they are about to run
something. Five lines before the asking: the cycle, what exactly, the cost, what
question it answers, what happens if it is not run.

**Measure before you cut.** The number is taken from an artifact or from `/usage`;
"this is probably the expensive part" is a signal to stop and to look.

**Check what is already running, before you launch a new one.** Two things at once
give incomparable results and a double bill.

**A cosmetic change does not justify a new run.** Do not buy a separate measurement
without a hypothesis and a threshold for the decision.

**Do not cancel a task that has already done work.** What is paid is paid; the
cancellation only throws away the result.

**A refused run is a missing value, not a clean result.**

**Whatever can be deterministic is not paid for.** The model answers only questions
that require reading and reasoning.

---

## 11. The context of the conversation

**The compaction is automatic and is not a loss.** When the conversation grows,
part of it is summarized and the summary comes in the next window together with the
uncompacted. The work continues — there is no need to wrap up earlier, nor to
announce "my context is running out". Announcing this is a stop, and a stop costs
more.

**Before context is thrown away, what must survive is recorded.** `/clear` between
tasks is reasonable, but a project catches defects precisely because someone
remembers an earlier decision. The order is: compact → record in memory or in the
repo → clean.

**What survives by itself and what does not:**

| Survives | Does not survive |
|---|---|
| whatever is in the repo | what I thought through and rejected |
| whatever is in memory | why a decision was taken that way |
| the git history | what was awaiting an answer |

The second column is exactly the list of what is recorded **before** the cleaning.

### `ENABLE_TOOL_SEARCH`

The only context setting that is measured and worth it.

```json
{ "env": { "ENABLE_TOOL_SEARCH": "true" } }
```

The definitions of the tools do not come in all at once — they are loaded on
demand. Free, and it is a built-in setting, not an external tool.

**18,200 tokens for 23 requests** — this is a **historical record** from
2026-08-31, not an expectation for a new project. The number is from a log that is
no longer produced; today's configuration does not reproduce it. It is carried over
as "this was measured once", not as "this much you will save".

It lives in `.claude/settings.local.json` of the project, which is gitignored —
that is, **it does not reach the clone**. If the project is new, it is set anew.

### External compressor — measured and removed

A trial and a refusal on 2026-08-31. The number it advertised turned out to be
someone else's:

| What it reported | Tokens | Who produced it |
|---|---|---|
| `tool_saved` | 18,200 | **not the compressor** — `ENABLE_TOOL_SEARCH`, which it had written into the settings and then counted as its own |
| `tok_saved` | 1,878 | its own compression: **2.7%** |

Nine tenths of the advertised number is free and asks for nothing. The remaining
2.7% do not justify the proxy in the path of every request — it sees the whole
conversation and forwards the authentication token, and for a project that judges
security, that must be a decision, not a side effect of a trial.

**The condition for it to come back:** a heavy run, where the saving is plausibly
double-digit. The conversation is not the load that matters; a review with a big
diff is.

**The general rule that this case illustrates:** measure before you cut. Two days
of compacting the packages optimized 2% of the problem and slowed down the work.

### The ceilings on reading

Two different limits cut the same thing and only one of them is seen. **The numbers
below are constants in the code of that project, not universal ceilings** — in a
new project they are found anew:

| Ceiling | How much it was there | Is it seen |
|---|---|---|
| on the tool | ~120,000 characters | **no** — up to a point it was not recorded anywhere |
| on the workspace | 512 KiB | yes |

The result of the invisible one was "checked and clean" over half a change. The
rule that is carried over is **not the numbers**: when two ceilings cut one thing
and only one is recorded, the second produces full confidence over half an input.

**Do not conclude completeness from reading file by file, nor from the list of
changed files** — they answer a different question. If a file is cut off, read it
in windows, instead of raising the ceiling globally.

---

## 12. Memory

**Record after each step, not at the end.** A step means a closed thing: a finished
measurement, a round with a review that pulled out a defect, a decision.

Memory is for what the repo does not remember — why a decision was taken, what was
refuted, what was awaiting an answer.

**Rules are not written in memory.** There they are a pointer that is not executed.
The rules live in this file and are read verbatim each session.

**Before you throw away context, record what must survive.**

---

## 13. This project — filled in

Filled in on 2026-09-04, after chunk 0 reached the acceptance gate. A blank spot is
not plugged with invention: where there is still no measurement, it says **none**.

### The tools — a question to a tool

| Question | Tool | Does it spend |
|---|---|---|
| where we are in the cycle, what the round number is | `PROGRESS.md` — read, not remembered | no |
| whether the promised is done | `node scripts/acceptance-gate.mjs` | no |
| whether the code works | `npx vitest run` | no |
| whether the types tighten | `npx tsc --noEmit` | no |
| what stands uncommitted | `git status --short` | no |
| how much the project cost | `node scripts/spend.mjs` — from artifacts, not from memory | no |
| how ready the project is | `node scripts/readiness.mjs` — from artifacts, not from judgment | no |
| whether there is a defect in what goes in | Codex, the command below | **yes, another account** |

`npm run gate` and `npx vitest run` answer **different** questions. The tests say
whether the code works; the gate says whether the promised is built. A test that no
one has written does not fail — it is simply not there, and everything looks green.

### The external review

```bash
codex exec -s read-only --skip-git-repo-check "PODKANATA" < /dev/null 2>&1
```

It is run **in the background**. Forbidden flags: `--force`, `--yolo`, everything
that gives writing. The form of the prompt is in §6 and is not shortened: a hostile
mandate, a word limit, "if you find nothing, say so plainly", and the explicit
`No money` with the names of the commands.

### Which commands spend money

Goes verbatim into every prompt to a subagent and to Codex:

```
do not run npm install, do not run npx, do not run grok,
do not run codex, do not call any paid API, do not run any network command
```

| Command | Who pays | Measured cost |
|---|---|---|
| `grok -p ...` | **subscription** — SuperGrok Lite, a fixed fee | `total_cost_usd` $0.010 – $0.027 — **weight, not a bill** |
| `codex exec` | **subscription** — not called with an API key, a fixed fee | not reported |
| execution of an n8n workflow with a model | the key in n8n Credentials | 823 in / 260 out on the first |
| every direct call to the Anthropic or OpenAI API | the owner's account | — |

**One figure in the report, the breakdown only on a question.** Requested by the
owner on 2026-09-05: *"I want it to give me only one figure, and only if I ask to
give me a breakdown. This figure in the report I want to come out."*

| When | What is shown |
|---|---|
| **every report** | `node scripts/spend.mjs --short` — one line, at the end, before the bars |
| **every report** | `node scripts/readiness.mjs --short` — the readiness, with a bar and a percent, next to the money figure |
| **on a question "how much does it cost"** | `npm run spend` — the whole breakdown |

**The qualification travels with the figure, not with the breakdown.** If some run
could not be priced, one line says *floor* and how many runs. Otherwise the only
place where the number is read is also the only one that does not admit what it is
missing.

The counter does not run continuously and there is no need: it reads files and
exits in milliseconds. What keeps the number correct is **the artifact being
written at the call itself**, not the counter being running. So:

**How much it has cost so far:** `node scripts/spend.mjs`. It reads the recorded
runs from `docs/runs/`, separates the measurement from the subscription, and exits
with **2**, if some run could not be priced — because "I could not judge" is not
zero. The full instruction, portable to another project, is in
`docs/spend-counter.md`.

**Every paid call is recorded as an artifact, when it is made.** A call that no one
recorded makes every sum **a floor**, but looks like an answer. The first call from
2026-09-05 was recorded after the fact, from the journal, and its file says so — a
reconstructed number and a captured number are different evidence.

**The only thing that really draws money is n8n.** The other two are on a
subscription and stand in the table so that it is clear what is **not** a spend — a
list that enumerates only one thing looks incomplete, until it says why it is only
one.

`npm install` and `npx` do not cost money, but they touch the network and can
change `node_modules` under a current review — so they stand in the ban for
subagents.

### The language of the repo

**Since 2026-09-14 the repo is English-only.** The owner's rule, verbatim:
all documents in English, only the chat with the owner is Bulgarian. No
committed file contains Cyrillic — verified with
`git ls-files | ... perl -CSD -ne 'exit 1 if /\\p{Cyrillic}/'`, which prints
nothing. Before that day `PROGRESS.md`, `CLAUDE.md`, and `README.md` were in
Bulgarian; they were translated in place, structure 1:1.

| In English | In Bulgarian |
|---|---|
| everything committed — code, names, comments, docstrings; `PROGRESS.md`, `CLAUDE.md`, `README.md`, `SPEC.md`, and every `docs/` file; JSON schemas and their `description`; names and text of the tests; commit messages; the prompts to the reviewer | the spoken conversation with the owner — **not** committed |

The reason the comments are in English is the same for which `gate` is not
translated: the reader who searches for the line in the code searches for the
English word. The same reason now covers the prose: a repo that another person,
another machine, or CI reads must not carry a language half its readers cannot.

### The decisions that are not reconsidered

| Date | Decision | The grounds |
|---|---|---|
| 2026-09-04 | **TypeScript, not Python** | n8n Cloud offers both JavaScript and native Python in the Code node — that is, Python is **not** unreachable, as was thought initially. Measured: `require` works, but through an allowlist — of 19 tried names `crypto` and `moment` passed; `ajv` and the remaining 16 tried names are disallowed. So the core is **not imported through the tried JavaScript mechanisms** and the workflow gets generated, self-contained code. Whether Python can import packages **has not been tried**. TypeScript stays the source language, because JavaScript is the native runtime of the Code node and the repo is already on Node. *The grounds were corrected on 2026-09-04 after a spike; see `docs/n8n-spike.md`. The decision does not change.* |
| 2026-09-04 | **One validator, not two** | "valid" must mean the same thing in a unit test and in production. A second validator with a different draft support is the defect with the second carrier. |
| 2026-09-04 | **Three states in the code, four exit codes in the gate** | `valid` / `invalid` / `unchecked` in the validator. The gate has four, because `1` covered both "it failed" and "it failed, and the rest was not established at all": `0` clean, `1` a failure with everything else established, `2` unestablished, `3` both. A human reads the report; CI reads only the number. |
| 2026-09-04 | **The MVP is read-only** | the schema refuses `executed: true`, so that it falls loudly on the day something executes an action. |
| 2026-09-05 | **The priority, globally** | The owner, verbatim: "the priority is that the prototype works, then whoever wants can make it work in a real environment". This is an **ordering**, not a note: work that does not bring "the five scenarios pass end to end in n8n" closer is not done, however well-founded it is by itself. Verified live the same day — I proposed `kind` for a real Kubernetes locally, the owner himself found the hole ("if n8n cannot read from kind, what is the point"), the tools were uninstalled and a cluster was not created. The remaining three uncovered things from the Definition of Done wait for the same thing: a model run, that is, the prototype itself. |
| 2026-09-05 | **A prototype, and that is the scope** | The owner: "this is a prototype, there is no way it talks to a real cluster" and "I want maximum quality as for a prototype in n8n". So: everything external is **simulated deliberately**, it is not an omission, and is not entered as a limitation that waits for a fix. The boundary of the review is **the scope**, not the strictness: every way is searched for by which the prototype silently claims something untrue about its own work — "I did not check", presented as "clean" — and no evidence for a real cluster is searched for, nor hardening for production. Grok's objection from 2026-09-05 ("you accept a product that never talked to a real cluster") is **answered with this decision**, it did not remain open. |
| 2026-09-05 | **The stopping is not written by the agent** | Three independent opinions (Codex, Grok ×2) arrive at one: a rule tied to the gate, to the number of tests or to the number of review rounds is gaming — today's day proves it, because each of the four rounds started with `gate exit 0` and pulled out real defects. Grok · 2 found the hole in the merge too: **if the agent writes the list that the owner will try, a demo over fixtures passes for the request.** So: the owner writes on one sheet what he will try, the agent does not write it and does not edit it; the agent points to a commit; the owner tries exactly those things. The reviews stay **inside the work** — they pulled out 9 defects on 2026-09-05 — but **are not** the stopping. Cost of the decision: $0.0248 for the two Grok runs. |
| 2026-09-11 | **The model is `gpt-5`** | The owner, verbatim: *"there is nothing to ask me, we will use gpt5"*. Decided after a comparison: `gpt-4o-mini` gave 2 of 6 clean, `gpt-4o` — 5 of 6, and the citations jumped from 7/11 to 10/11 **without a single change in the prompt**. `gpt-5` is the next step for the same reason: the only unrefuted explanation for `contradicted_by` in **0 of 30** hypotheses is capacity. **The cost, accepted deliberately:** `gpt-5` refuses `temperature: 0` with HTTP 400, so the field is not sent and the default 1 holds — **two runs of this model are not comparable**, and a difference between them may be the sampling itself. This is the 13th declared limitation. It is not reconsidered and is not asked again. |
| 2026-09-04 | **Drift detection, not trust** | the deployed workflow is exported and compared with the generated; a mismatch is a failure, not a warning. *Not built yet.* |
| 2026-09-12 | **Real Slack + Langfuse Cloud, everything in the cloud** | The owner decided to connect the prototype to a real Slack and to keep traces. The choice is **n8n Cloud + Slack (a real app in workspace mitko) + Langfuse Cloud** — all three public, so they reach each other. Self-hosting Langfuse with Docker was rejected for the same reason as kind on 2026-09-05: **n8n Cloud is remote and cannot read `localhost` of the machine**; a public address asks for a tunnel (fragile) or a VM (money). The cluster stays simulated; only Slack becomes real outside. This **changes** the recorded "everything external is simulated" (2026-09-05), changed by the owner in deed (app, channel, token, a test post on 2026-09-12; see `docs/slack-setup.md`). Grok review 2026-09-12: the thread must NOT be a store (a view without structure, breaks one-collection); Langfuse holds the structured incident object by `incident_id`; the durable index `ts ↔ incident_id` for idempotency must NOT rely on Langfuse's 30-day window, it asks for its own durable store (n8n Data Table). This index is built first, with a race test, BEFORE the first posting. |
| 2026-09-12 | **Without Redis for the prototype — SKIP, with a recorded limitation** | The question: is Upstash Redis needed for an atomic lock of the thread↔incident index. Grok: **SKIP**. It is measured that n8n Cloud runs the webhooks in parallel and Data Table has no atomic insert-if-absent, so two **simultaneous** signals for one incident can open two Slack threads. But in the prototype the incident is fired by the owner/eval runner one at a time, not by an alerter with duplicates — the race that Redis stops almost does not happen. Upstash is a 4th cloud + a secret + a point of breakage (a fallen Redis stops the demo), for a path the demo does not go through — the same logic with which kind was rejected on 2026-09-05. `DurableThreadIndex` and `AtomicStore` **are not thrown out**: they are the seam, and on the day with a real CAS store only the adapter is changed. A substitute without Redis: Data Table lookup + a deterministic `incident_id` closes the **serial** repeated fire (finds the row, does not post a second thread), but **not** the simultaneous one. **The limitation, recorded honestly (the SKIP trap):** the live path has no atomic lock; dod-5 "one-to-one" is proven only on `MemoryStore`, not on the live parallel path; if two simultaneous signals for one incident are run, Slack can show two threads, while the code claims one. The demo fires one incident at a time. Without this sentence SKIP is "I did not check", presented as "clean". |

### The thresholds and the acceptance boundaries

**One threshold is recorded and is enforced, the others are not there.**
`scenarios/conflicting-evidence/expected.json` carries `max_confidence: 0.6`, and
the schema enforces `0.5` for a refusal — the scorer reads the stricter one and
fails a run above it. This is a **chosen** threshold, not a measured one: no run
has established it. The other boundary stays binary: `npm run gate` exits 0. A
number for confidence, for a count of scenarios or for variance will be entered
here only when it comes out of a measurement — a threshold with no conclusion
becomes load-bearing and no one remembers where it came from.

### Where the number comes from, while the gate runs

The rule "a status every 5 minutes with a number" is in `~/.claude/WORKING-RULES.md`
and holds everywhere. What **was not** recorded anywhere is how the number is
obtained here — and precisely for that I stayed silent for six minutes on
2026-09-10, until the owner asked.

**`node scripts/acceptance-gate.mjs` prints nothing until it finishes.** The file
into which you redirect it stands with zero lines through the whole run. From the
outside this is indistinguishable from a stopped process.

The number comes from another place:

```bash
# which mutation is applied at the moment
python3 -c "import json;print(json.load(open('out/mutation-in-flight.json'))['id'])"

# and which one in order it is
node -e 'import("./scripts/mutations.mjs").then(m=>{
  const i=m.MUTATIONS.findIndex(x=>x.id===process.argv[1]);
  console.log(i+1,"of",m.MUTATIONS.length);})' "<the id above>"

# since when it runs
ps -o etime= -p "$(pgrep -f 'node scripts/acceptance-gate' | head -1)"
```

The line in the report looks like this:

```
gate50 · 06:15 · mutation 91 of 265 · empty-scores-counted-as-a-scored-run
```

The file exists for another reason — it is written **before** the source is
touched, so that a next run can return a mutation left over from a killed process
(see the trap in the table below). That it also does the work as a progress counter
is a side effect, but it is the only one available.

**If the file is not there**, the gate is between mutations or has not reached them
yet — that too is said, instead of staying silent.

### The machine traps of this project

| Trap | What it does | The way out |
|---|---|---|
| a test that calls `runGate()` with the real checks | one of them runs `vitest`, which runs the test again — **hangs**, does not fail | the gate puts `ACCEPTANCE_GATE_CHILD` on every child and refuses if it sees it |
| `git status --porcelain` without `--untracked-files=all` | an untracked folder is reported as `keys/`; a file inside is invisible | `-uall`, always, when something is searched for by name |
| `git status --porcelain -z` on a rename | gives **two** paths; the second is without a prefix and `slice(3)` eats its start | the record with `R` or `C` consumes the next field whole |
| `codex exec` and the redirection sign in the prompt | **hangs**, does not fail — from the outside indistinguishable from a long review | `< /dev/null` at the end; no angle brackets and backticks in the text |
| `npm run X` | prints `npm notice` lines that contaminate every `grep` over the output | call the script directly with `node`, when you read the output machine-wise |
| `npm run X` through a pipe | `$?` is the code of the last command in the pipe, not of the script | run it without a pipe and then read `$?` |
| `out/` | gitignored — the gate's result **does not survive a clone** | the evidence goes into `PROGRESS.md` as a line with a date and an exit code |
| `vitest` run while the gate runs in the background | the gate mutates files; a suite run at the same time reads a **deliberately broken** tree and reports failures that do not exist | one work on the tree at a time. If the gate runs in the background, you wait for it to finish, instead of running something else. Measured on 2026-09-07: four "failures" from a mutation in `src/agents/slice.ts` that was not mine |
| **stale from 2026-09-10** — the gate was on the edge of the 10-minute limit | every mutation ran the **whole** set: 265 × 735 tests ≈ 20 minutes, and twice it was killed midway, leaving a broken file | every mutation runs only the file that declares its named test — `filesDeclaring` reads the report that the gate has already produced. Measured on the same tree: **20m08s → 3m45s**, and the caught are **266 of 266** against 265 of 265. An empty list means "I could not narrow" and runs the whole set: narrowing on doubt would be "I checked less", and precisely that is guarded by the new test and the new mutation |
| the gate is on the edge of the harness's 10-minute limit | 232 mutations by the whole suite each ≈ 25–60 minutes (95 were ≈ 10; the count grows and this number with it); on interruption an applied mutation remains | run it **in the background** (`run_in_background`), not in the foreground. Measured on 2026-09-06: two consecutive runs were killed by the timer, the second left a broken `prompts/kubernetes-agent.md` |
| an interrupted run of the gate | the mutation check breaks a file and returns it in `finally`; **on a killed process `finally` is not executed** and the file stays deliberately broken. On 2026-09-05 a mutation survived in `prompts/kubernetes-agent.md`, telling the model that the code is whatever it seems to it | the mutated text is written in `out/mutation-in-flight.json` **before** the source is touched; the next run returns it and **says it out loud**. It worked live on 2026-09-06 — `REPAIRED a killed mutation run had left prompts/kubernetes-agent.md broken` — the first real case, not a test. It restores only on an exact match and only inside the repo. If you interrupted the gate — run it again, before you look at anything at all |
| `git add -A`, then more edits | the review said commit, but **the index was from before the fixes**: `git status` shows `MM`, which is easily read as "recorded". Codex caught it on 2026-09-05 — exactly the state that the review had rejected would have gone in | you do not stage before the review; before commit always `git add -A` and then `git diff --name-only \| wc -l` — zero means the index equals the tree |
| `until ! pgrep -f acceptance-gate; do sleep; done` | **never finishes** — the command line of the waiting shell itself contains "acceptance-gate", that is, `pgrep` sees itself. Three such hung for 12 hours each on 2026-09-09 and looked like "the gate still runs" | search for the **process**, not the string: `pgrep -f "node scripts/acceptance-gate"`. The same holds for every wait by a command name |
| SSH to GitHub on port 22 | **hangs and exits on timeout** from this network; `git push` fails with "Could not read from remote repository", which looks like a lack of rights | GitHub gives the same endpoint on **port 443**: in `~/.ssh/config` the block `Host github.com` points to `HostName ssh.github.com` and `Port 443`. The key of `[ssh.github.com]:443` is added with `ssh-keyscan` and matches the published ed25519 key. Measured on 2026-09-05 |
| `git push ... 2>&1 \| tail` | `$?` is the code of `tail`, not of `push` — prints "exit=0" over a failed push | no pipe, when you read the output; run the command bare and then `echo $?`. The same trap as with `npm run X` |
| `grok --output-format json` | the output is **several** JSON objects one after another, not one; `json.loads` over the whole text fails with "Extra data" | read with `JSONDecoder().raw_decode` in a loop and take the last object with `structuredOutput`; `total_cost_usd` is there with a **space** after the colon, that is, `grep -o '"total_cost_usd":[0-9.]*'` catches nothing |
| release before deploy | the gate refuses on drift, and drift is true for **every** change worth uploading; that is, the gate blocks the release, and the release was the only thing that clears the gate | `releaseMayProceed` runs **only** `no-drift-from-baseline` and **only** in state `fail`; everything else, including `unknown`, stops the chain. Measured on 2026-09-05, by getting into it |
| **the gate pays for its own mutation** | the mutation `the-env-file-overriding-a-chosen-value` removes the line that says "the environment beats `.env`". Then the gate runs the file declaring its test — and in the same file are the tests that run the **real** runner. `.env` overwrites the local address with the paid one. **Three paid executions on every run of the gate**, established on 2026-09-11 after 23 unauthorized executions and 553,506 tokens | two latches, and the second does not depend on anything the test happens to set: `.env` is read only in `main()`, and **a non-local address requires `AI_SRE_LIVE=1`, given by the command, not by the file** |
| **`.env`, read on import** | every vitest worker that pulls in the runner carries the paid address in its own environment; a child launched with `{ ...process.env }` without an explicit address inherits it — **without needing a mutation** | the reading is inside `main()`. An import must not change the environment of the process that made it |
| `set -- $pair` in a loop | **zsh does not split by words** on an unquoted expansion; `$1` becomes the whole string. Three calls went to `/executions/333%20cpu-throttling%235` and returned 400 | run the commands one by one, or use a real array |
| **re-measurement of the same scenario** | the runner refuses: the old record still holds the mark for the scenario key, so a new run with the same key looks like an unpaid repetition of the same question | use a new attempt key scenario#2. A different key is a different submission, with its own token and its own claim; the old record stays valid. Measured on 2026-09-11 |
| n8n on HTTP 429 from OpenAI | shows "The service is receiving too many requests from you" and proposes retry — **even when the cause is zero credit** | the real cause is in `error.description` and `messages[0]` of the execution: `insufficient_quota`, `credit_balance_exhausted`. Read them, not the title. Measured on 2026-09-05. |
