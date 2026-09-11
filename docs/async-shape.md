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


## Measured on 2026-09-11, with three free GETs

Astra named three things this document had assumed. All three are now
established, by reading rather than by arguing.

| Assumed | Measured |
|---|---|
| the credential can read executions | `GET /executions?limit=3` → **200**, three rows returned |
| n8n is saving execution data | `GET /executions/{id}?includeData=true` → **200**, 320 KB of data |
| the fields the artifact needs are in there | the payload mentions **`raw_answers`** and **`usage_by_agent`** |

**And one trap that only a real call would have shown:** `?includeData=true` is
REQUIRED. Without it the response is still **200** and simply has no `data` key
at all. A reader written without that parameter would report „no answer" for a
finished execution — a missing field read as a missing answer, which is the
defect this project names everywhere else.

### The part that changes what B is worth

The executions behind today's two HTTP 524 timeouts are **`status: success`**.

The answers this project paid for and never received **exist**, and they are
readable. So B is not only the way to remove the deadline — it is also the way
to collect what has already been bought. Nothing is re-run to get them.

## Built on 2026-09-11, and the four defects the build carried

The shape above was reviewed once more after it existed rather than only as a
plan. Astra found four, all of them in code written the same hour, and all four
were true when checked against the source.

| Found | Why it mattered | What answers it |
|---|---|---|
| a single hit was reported as unique even with unread executions in the window, after a listing failure, and after the page bound cut the walk | the duplicate the scan promises to refuse could be in the execution nobody could read — and the answer handed back would be another attempt's measurement, scored as this one's | a fourth state, `one-unverified`: the id is reported because it is real, and uniqueness is stated as unestablished. The CLI prints the id and exits 3 rather than collecting |
| two runners could both pass the guard and both pay | reading a state is not holding it. Different record paths, different tokens, one key, two charges — and each record overwriting the other's evidence | an exclusive claim per key, `wx`, written before the call. The filesystem decides who wins, once, and the loser is told to collect instead |
| the file was fsynced and the directory entry was not | a host crash could keep the bytes and lose the entry that names them — and the entry is the charged guard and the token. Killing a process and killing a machine were being treated as one guarantee | the directory is fsynced too, and a filesystem that refuses says so on stderr instead of the word „durable" being claimed for something unconfirmed |
| an acknowledgement incremented the written-answers counter | „1 answer(s) written" printed with nothing written. The exit code stayed 2, so this was a false sentence rather than a false success — and the sentence is the part a person reads | the counter counts reports, and a mutation holds it there |

**Five mutations were added**, so each of these fails the gate if it comes back.
Four of the tests assert behaviour; two assert an ORDER OF STATEMENTS in the
runner, because the loop that spends money is not exported and refactoring it to
be testable is a larger change than the property being protected. That is said
in the tests themselves rather than implied — a source-order test proves source
order, and nothing more.

**And one test was rewritten because it could not fail.** The first version of
the durability test asserted `{ durable: true }` on a successful write, which
stays true with the directory fsync deleted. It now asserts the fsync is on the
directory of the path, and says in its own comment that no test here can pull
the power.

### And a fifth, found in the fix itself, while the gate was running

The claim directory was `dirname(recordAt)`, and `--record` accepts any path. So
two runners with different record paths would claim in different directories,
both succeed, and both pay. `wx` is exclusive per PATH, and the path had been
made variable — the same defect the claim was written to remove, one level up.

It is closed by the SIGNATURE, not by discipline: `claimKey(key, token)` has no
argument a caller can vary, and the ledger is `docs/runs/claims`. The one
override, `AI_SRE_CLAIMS_DIR`, exists so tests do not write into the real ledger
of bought keys, and the runner prints where it is pointing on every run —
an override nobody can see is the same hole wearing a different name.

**And the claim hid an older guard.** With the claims directory inside the
record's directory, a test that made that directory read-only stopped at the
claim instead of at the failed write — so the mutation that removes the
failed-write guard survived the gate. Fixing where the ledger lives fixed that
too, and it was checked by applying the mutation by hand and watching the named
test fail again.

This is the shape of the whole session: a guard added in front of an older guard
makes the older one unreachable, and the test that proves the older one still
passes — for the wrong reason.

## The review of B, in six rounds · 2026-09-11

B was built in about an hour. Reviewing it took longer, and the number worth
keeping is **18 defects in code written the same day**, every one of them mine.

| Round | Found | The worst one in it |
|---|---|---|
| 1 | 4 | one hit passed for uniqueness while part of the window was unread |
| 2 | 5 | the ledger of bought keys moved with `--record`, so it guarded nothing |
| 3 | 5 | containment by text: `/private/tmp` was refused against `/tmp` |
| 4 | 2 | **the cleanup could delete another runner's paid claim** |
| 5 | 2 | a real filesystem error carried no ownership mark, so the case the cleanup existed for could not be cleaned up |
| 6 | 4 | `unconfirmed` was returned and nothing read it |

**Round 4 is the one to remember.** `openSync` with `wx` can fail for reasons
that say nothing about the path — out of file descriptors — and the cleanup ran
anyway, unlinking a claim another runner had paid for, taking its recovery token
with it. A guard against paying twice that could delete the evidence of having
paid once.

The rule that came out of it: **unknown falls to not touching anything.** A
stranded half-claim is a key refused until a person looks. A deleted claim is a
second charge nobody can see.

### Three of the eighteen I found myself, and how

The review reads; I can run things. The difference produced a different kind of
finding.

| Found | How |
|---|---|
| the ledger moves with `--record` | reading my own hour-old code while the gate ran |
| a mutation that does not kill its test | applying it by hand — a second branch covered the same case |
| a real error carries no `created` field | following who throws what in production, not in the test |

The last one is the exact shape of the defect this project catches everywhere
else: **the test handed in an error with the mark on it, and the real filesystem
error has no such field.** So the fix worked in the test and not in life. The
answer was to export the writer that actually runs, and test that one.

### Why six rounds and not three

Each round read code the previous round had not seen, because each round's
findings produced new code. That is the pattern Grok warned about on 2026-09-08
— „a generator of refusals" — and it is the right pattern HERE, because nothing
in these six rounds blocked a paid run. It blocked a commit, which is free.

The signal that it was converging is not the count but the KIND: rounds 1–3
found defects that lose money, round 6 found one production defect and three
tests that assert too little.
