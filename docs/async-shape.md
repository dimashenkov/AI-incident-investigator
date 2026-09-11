# B — the chain stops answering inside the HTTP response

> **Attacked on 2026-09-11 and corrected. The central claim was wrong:**
> acknowledgement does NOT remove the may-have-been-charged ambiguity. n8n can
> accept the request, begin charging, and lose its own 200; or the runner can die
> before it saves the id. A received 200 means **accepted**, not answered, and
> the durable pre-call guard stays until reconciliation.
>
> And the contrast this document drew between „polling" and „reading once later"
> is false — reading status is read-only either way. What matters is not how
> often it is read but that reading cannot execute anything.

Written on 2026-09-11, before any code, after the measurement closed C.

## What the measurement said

| Run | Model shape | Result |
|---|---|---|
| 1 | four × `gpt-5` | HTTP 524. The execution COMPLETED at ~183s; the gateway cut at ~100s |
| 2 | `gpt-5` + three × `gpt-5-mini` | arrived |
| 3 | the same split | HTTP 524 |

Two runs of one shape, one each side of the line. So the chain sits **on** the
limit, and the limit belongs to n8n Cloud's gateway, not to this project.

The reason is measured, not guessed: `gpt-5` defaults to medium reasoning and
spent 9 152 hidden reasoning tokens in the first run. Reasoning tokens are time.

## What B changes, and what it must not

**The webhook answers immediately.** It acknowledges the alert and returns. The
investigation continues, and the answer is written where a reader can fetch it.

What must NOT change: the runner still ends up with the same recorded answer,
the same `raw_answers`, the same `usage_by_agent`, the same `payloads_sent`. If
the artifact changes shape, every scored run before today becomes incomparable,
and this project has already lost comparability once today.

## The part that is easy to get wrong

The runner has to learn that the answer is ready. Two shapes, and only one of
them is honest here:

| Shape | Why |
|---|---|
| the runner polls until an answer appears | **this is the trap.** Every interruption becomes „called, may have been charged", the guard blocks the key, and a human has to read the execution — which is exactly the loop this project has been in three times today |
| n8n writes the answer somewhere the runner reads ONCE, later | the call is over the moment the webhook returns 200. There is nothing in flight to be ambiguous about |

So: the webhook returns 200 with an identifier. The workflow, when it finishes,
writes the finished document. The runner reads it by identifier, once, whenever
it likes — and a failure to read is a failure to READ, not a call that may have
been charged.

## What „writes it somewhere" means here, and the honest constraint

n8n Cloud has no filesystem this machine can reach, and this prototype has no
database — by decision, recorded on 2026-09-05. Three candidates:

| Where | What it costs |
|---|---|
| back to a second webhook on this machine | needs this machine reachable from the internet. It is not, and making it so is not a prototype's business |
| n8n's own execution record, read through the API | **no new moving parts.** The runner already talks to the n8n API to deploy and to compare drift, with a credential that exists. The answer is in the execution; the only new thing is reading it by id |
| an external store — Slack, S3, a data table | a new dependency, a new credential, and a new thing that can be stale |

The second is the one that fits: the identifier is the n8n execution id, the
runner polls the EXECUTION LIST rather than the model, and polling an execution
list costs nothing — it is a status read, not a paid run. The distinction is the
whole point: today's guard exists because a retry of a PAID call is a second
charge. Re-reading a finished execution is not.

## Where this can break, said before it is built

| Risk | What answers it |
|---|---|
| „status read" quietly executes the workflow | `CLAUDE.md` already names this: an n8n check that executes the workflow bills the model while looking like a status read. The reader must use the executions endpoint and never the webhook |
| the execution id is not known when the webhook returns | if n8n cannot hand it back, the runner must find the execution by the incident id it sent — and that is a search, which can match the wrong one. Then the incident id must travel in the execution's data, checked on read |
| the answer is read from an execution that is still running | three states, not two: finished, running, failed. „Still running" is not „no answer" |
| the shape of the recorded artifact drifts | the runner writes the same file it writes today, from the fetched document, and the existing tests hold the shape |

## What is NOT in scope

Making the chain faster. B removes the deadline; it does not make a reasoning
model cheaper or quicker, and the 9 152 reasoning tokens stay exactly where they
are.


## The five corrections, and what each one changes

**1. „The executions endpoint" is not precise enough to be safe.** Only
`GET /api/v1/executions` and `GET /api/v1/executions/{id}`. Retry operations on
an execution EXECUTE work, and a webhook probe can too. The reader exposes no
retry and no execute, and follows no redirects.

And a correction to this document's own reasoning: the scripts cited as „already
talking to the n8n API" use the **workflow** endpoints, for deployment and
drift. An existing credential does not establish that it can read execution
DATA. That is unverified, and it is the first thing to check — free, with a
single GET.

**2. The incident id cannot identify a submission.** `planFor` sends the same
alert for `scenario#1` and `scenario#2`, so two attempts share an incident
identity, and finding an execution by it proves nothing about **freshness** — it
can hand back an older answer. A unique submission token is written **before**
the POST, carried outside the model's inputs, and bound to the execution id.
Recovery scopes by workflow and token, walks pagination, and **rejects multiple
matches**. Zero matches means unresolved — never permission to resubmit.

**3. The guard stays.** This is the correction that matters most, because the
first version of this document claimed the opposite.

**4. The artifact needs an extraction contract, not a hope.** The exact final
report item is saved — `raw_answers`, `usage_by_agent`, `payloads_sent`,
verbatim. Never reconstructed from intermediate nodes, and never the
acknowledgement or the API envelope. It requires n8n to be SAVING execution
data and to still hold it, so „read it whenever it likes" is unsupported: four
states, not two — pending, failed, unavailable, and completed-with-document.
Extraction is tested against the artifact fixtures already on disk.

**5. There is no simpler shape.** Streaming heartbeats would need verified
gateway and n8n support and cannot be assumed to beat a hard deadline. Local
orchestration bypasses the gateway but changes what is being measured — the
deployed chain would no longer be the thing under test.

**Verdict: build the corrected shape** — durable submission identity, the guard
preserved, repeatable GET retrieval, and the report payload unchanged.
