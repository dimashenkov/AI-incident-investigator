# Backlog — bricks awaiting their turn

Every brick here is recorded so it does not disappear quietly. The order is not a promise, but a list.
A brick leaves the backlog only when it is done or explicitly cancelled — not when it is
forgotten. The cost beside each says whether it requires the word `harchi` (spend).

---

## Brick · more useful scenarios beyond the 15 · REJECTED

**State:** ❌ REJECTED by the owner 2026-09-14: "I don't want new scenarios, 15 are enough". Recorded 2026-09-13; not built.

**What it is.** A scenario = folder `scenarios/<name>/` with five fixtures — `alert.json`,
`kubernetes.json`, `logs.json`, `metrics.json`, `expected.json` — plus a row in
`scenarios/registry.json`. No code, no model. Adding is **free**; you pay
only when the scenario is run live against the model (that is the eval, and
it requires `harchi`).

**Why more.** The 15 cover recognizable k8s failures. A useful new one is the one that
**tightens the judgment**, not the menu. A new code in the schema without a scenario is a longer
menu, not a broader scope — and the test `gives every code in the schema a scenario
that expects it` refuses it by name.

**Which are the candidates (stress on judgment, not recognition):**

| Candidate | What it checks that the 15 do not check |
|---|---|
| cascade: a dependency falls → the pool is exhausted → 500s | which is the **root**, not the last link — it tempts you to stop at the symptom |
| a cause outside k8s (application bug, not infra) | whether the agent admits "it is not infrastructural", instead of forcing the case into the nearest code |
| noisy neighbour / contention for a node resource | OOM/throttle of the **neighbour**, not of the alerted service — problemPod must not point to the wrong pod |
| eviction on node disk pressure | differs from `volume-full` (volume), here it is the node — easily conflated |
| 429 rate-limit from a dependency (not quota) | differs from `dependency-unavailable` — the service is alive but throttling |

**The two rules that every new one follows (learned expensively):**

1. **No label-shortcut.** An event's `reason` must not name the code
   (`VolumeFull`, `PacketDropped` …) — a real controller does not emit such, and the model
   hits the code without reasoning. The diagnosis lives in the **cited** `message`, not in
   `reason`. Grok, 2026-09-11.
2. **Winnable, verified locally end-to-end** before it counts as coverage — a fixture
   that no model can solve measures the prompt against an impossible question.

**Cost:** $0 to add. The eval then requires `harchi` (k≥3 on a new scenario).

---

## Bricks from Grok · 2026-09-13 · functionality, no new providers

The owner asked: what else useful can go in, **without a new cloud provider,
functionality only**. Grok ($0.18, subscription) returned five, ordered. The gap it
pointed out: the eval "read" **marks** (which scenario fails), but does not **diagnose**
(why and which agent) — that is, the next change to the prompt is still a guess, paid with
12 runs, only to find out you touched the wrong agent. The first three are free.

| # | Brick | What it gives | The honest limit | Effort | Money |
|---|---|---|---|---|---|
| 1 ✅ | **eval diagnosis, not just scoring** (DONE 2026-09-13, commit `d4aaa5c`) — `eval.mjs` to print the axis of the failure (wrong code / uncited / unqualified), the missed `must_cite` paths, the confusion of codes | the next edit has a **target**, not a guess. `node-not-ready` "correct code, other basis" is exactly this class | if you split k=3 across four axes, everything becomes "insufficient" — keep the majority, add the breakdown as a **detail** | S | **no** |
| 2 ✅ | **specialist scoring** (DONE 2026-09-13, commit brick #2) — whether the agent (k8s/logs/metrics) extracted the fixture path, separately from the conclusion | says **which prompt** to touch. On 2026-09-10 4 of 5 failures were extraction, not merging | `expected.json` becomes an oracle for extraction — freeze slot ownership from the `must_cite` prefixes, do not add a second expected | M | **no** |
| 3 ✅ | **test against the label-shortcut** (DONE 2026-09-13, `tests/label-shortcut.test.ts`) — a fixture `reason` must not be a spelling of `causeCode` (`VolumeFull`, `PacketDropped`) | stops the next paid run from being "reading the label" | real kubelet reasons (`OOMKilled`) are legitimate — forbid the spellings of the codes from the schema, not k8s reasons | S | **no** |
| 4 ✅ | **k=3 under set `2c121d3550c3` for the other 11 scenarios** (DONE 2026-09-14: 36 runs, ALL 15 scenarios at k=3, 0 sticky) | without it the keep-rule guards only 4 names; a fix for `node-not-ready` cannot be **kept** | ~33 live runs; HTTP 524; gpt-5 temperature default 1 | S / L | **yes · harchi** |
| 5 ✅ | **`eval.mjs --plan`** (DONE 2026-09-13) — before an edit prints "to keep, buy k=3 on {these green} + {these sticky}" | the owner sees the **cost** of the change before writing it | "proposed subset" is a cheat — print the real keep-rule requirement, not a discount | S | **no** |

**Rejected by Grok as theater:** confidence derived from the number of findings (a second number no one has calibrated); hardening of the simulation (retries, Redis lock, live Datadog, many incidents in one execution — pretends the fixtures are a cluster); enforcing `must_cite` in the schema (kills the canary that the model ignored an instruction); open cause codes (the scorer dies).

**The order Grok recommends:** 1 → 2 on the existing baseline (no model), **before** buying anything at all. The diagnosis makes the paid run targeted.

---

## Brick · redaction of the report path too (the first Slack post) · free

**State:** ✅ DONE 2026-09-14 (Grok review clear). A shared `src/core/redact.ts` guards both Slack posts (report + reply) from one source; the Report node redacts slack_text + Block Kit blocks; the listener Build reply redacts the answer. 1087 tests.

**What it is.** `redactSecrets` currently guards only the reply path (the bot's answers). The first
Slack post — the incident report itself — is assembled from `slackReport` (thread.ts) and
cites `finding.fact` and `message` lines. It **does not pass** through `redactSecrets`, so
a secret that an agent cites in the report reaches Slack before the bot answers.

**Why it is free and does not require duplication.** `buildRuntime` splices the core files into the
prelude of every node. One shared redactor (e.g. `src/core/redact.ts`,
spliced everywhere) covers both the reply path and `slack_text`, from **one** source — not
a second copy in thread.ts.

**Why it is deferred, not impossible.** The report is also in `slack_blocks` (Block Kit), not
only in `slack_text`. Closing it means redacting the structure of the blocks too, not
only the text — separate work, with care not to break the Block Kit format.

**Cost:** $0. Guards against a real deploy leak; in the prototype the fixtures have no secrets.

---

## Brick · fallback provider for the model in the agents · needs a decision first

**State:** ✅ COMPLETED AND PROVEN LIVE (2026-09-13). Code + deploy + full live test. exec 414: routing proven (Grok fired, but 403 without credits). The owner added xAI credits; exec 415: state CONCLUDED, CONTAINER_OOM correct, model_by_agent = all 4 grok-4.3 — the whole chain concluded through Grok. The fallback is proven end-to-end (routing AND answer). grok-4.3 id confirmed live. This is the open
question "Fallback of the model provider" from 2026-09-05 (PROGRESS.md) — left as
"let it be", now raised for the backlog.

**What it is.** The agent calls one model (OpenAI, through a credential in n8n). If it falls or
refuses, the investigation stops. The brick: a second model to fall over to.

**The honest caveat — this IS a new provider.** The other backlog bricks are "no new
provider"; this one breaks it deliberately, at the owner's request. So a second credential,
a second billing path, and — the important thing for the eval loop — **two runs on different providers are
not comparable** (as gpt-5 temperature default 1 already makes the runs incomparable; a second
model adds a second axis of variance).

**The decision that must come BEFORE code (2026-09-05):** whether a second model is even needed, and
if so — does it fall **silently** to it, or **say the first refused**. The second is
what the project wants everywhere: "I couldn't" is not glued to "here is the answer". A silent
fallback hides the first model's refusal — exactly the signal the eval loop measures.

**The decision, taken 2026-09-13 — in full:**

1. **Announced refusal, not silent.** The switch is recorded as a state ("primary
   refused: <reason> → switched to secondary"), not merged with a normal answer.
   The basis is the project's ethos, measured repeatedly: a blind switch makes
   an obedient and a disobedient model indistinguishable.
2. **The second provider is Grok** (`grok-4.6`) — decided by the owner. Grok is on a
   subscription (SuperGrok Lite, fixed fee), so it does not add a credit-billing path
   like OpenAI.

**The open questions for the build (not for the decision):**

* **How n8n Cloud reaches Grok — checked 2026-09-13, and it hits a rule.** Grok on
  this machine is **SuperGrok Lite, logged in interactively through the CLI** (`docs/grok-on-this-machine.md`),
  and there is a recorded decision from 2026-08-30: **"there is no API key and one is never created."**
  n8n Cloud (remote) calls only the xAI HTTP API, which requires exactly such a key. That is,
  the Grok we have is **not reachable from n8n**. Three exits, the choice is the owner's:
  (a) keep the rule → Grok is not an in-workflow fallback; (b) an exception → a metered xAI
  key for n8n; (c) a fallback **outside** n8n — the local runner, on a primary failure,
  asks the CLI Grok (keeps the rule, but only the local path, not the uploaded workflow).
* **Comparability in the eval loop.** A run answered by Grok is not comparable with the gpt-5
  baseline. The provenance already records the model that answered (`model`, null if
  missing); the fallback must mark the run so the keep-rule does not compare it
  with the primary-baseline.
* **The seam in the code.** The model-call nodes have no `onError`, so a provider error
  **brings down the execution** and `unestablished` is recorded without a reason. The announced refusal +
  the switch to Grok require exactly this error-branch, tested live.

**What is free:** the record of the decision ($0). The build requires a credential (owner)
+ error-branch + live test — it is not free. The brick stays **open** with a **ready
decision**; the code awaits the word.

---

## Brick · SPEC.md refresh · free

**State:** DONE 2026-09-13. Recorded 2026-09-13 (Grok README review).

**What it is.** `SPEC.md` is from the earlier phase and now contradicts reality in two
places: §1 says "fake Slack … there is no real Datadog, Kubernetes, or Slack", but since
2026-09-12 Slack is **real**; §2 holds seven scenarios (`node-not-ready` …
`certificate-expired`) as "built, not yet measured", while readiness counts them **green**
(measured). An external reader, sent to SPEC, reads the opposite of the README.

**The fix.** §1 to reflect the real Slack (simulated remain cluster/logs/metrics/
Datadog); §2 the status of the seven to become "measured" with a citation to the records. Every
claim to point to the artifact it comes from — the ethos of SPEC.

**Cost:** $0. The README already qualifies SPEC as an earlier phase, so it does not mislead
until then.

## Brick · readiness is model-blind when picking the latest verdict · latent

**State:** PARTIAL — the demotion guard is in, the marker is not yet written (2026-09-14). `latestScoredPerScenario` now processes PRIMARY records (gpt-*, or naming no model) before non-primary ones, so a grok record — IF it carries `model_by_agent` naming a non-gpt model — claims a scenario only where nothing primary established it. `recordIsPrimary` (tested) reads `model_by_agent`/`model`; the demotion logic is proven in `tests/readiness.test.ts`.

**The remaining half (Grok, 2026-09-14): the recording path does NOT stamp the model into `docs/runs`.** `recordInto`/`recordShape` write no `model_by_agent`, and every current `docs/runs` scored record names no model — so a LIVE grok-fallback record, once scored and recorded, is still unmarked → treated as primary → still wins by date. The tests set the field by hand, so they prove the classifier, not the live path. The guard is therefore LATENT: it closes the defect only once a scored `docs/runs` record carries the model marker. Full closure = stamp `model_by_agent` (from the answer's own field, which the workflow already produces) into the scored run record at write time. Recorded honestly rather than claimed fixed.

`scripts/readiness.mjs` `latestScoredPerScenario` picks the newest run record per
scenario purely by the record's `when`, ignoring `model_by_agent`. So a gpt-5
verdict and a grok-fallback verdict for the same scenario are interchangeable
evidence. A newer grok-fallback record scoring `conflicting-evidence` `wrong` would
overwrite an older gpt-5 `correct` and drag readiness RED off the fallback (and the
reverse — a grok `correct` masking a gpt-5 regression — is equally possible).

**Why it is latent, not live:** no grok *scenario-answer* run has a non-empty
`scored` map recorded yet — the only `grok-4.6` records in `docs/runs/` are review
runs with `scored:{}`. It becomes live the first time a grok fallback answer run is
scored and recorded (the fallback is proven, exec 415, so the path is reachable).

**The fix when it is due:** either carry the model into the run record's `scored`
map and have readiness prefer/segregate by the primary (`gpt-*`) family, or at least
refuse to let a non-primary-model record supersede a primary one. Mirrors the
`eval.mjs` `bucketOf` fix (a fallback is a different configuration), and the correct
pattern already exists in `src/core/review.ts` (`versionStamp` folds the model into
`core_sha`, so a grok review never shares a bucket with a gpt-5 one).

## Brick · the four-agent split leaks the cause into the extractors · needs a paid run

**State:** ✅ RESOLVED AND VERIFIED LIVE (2026-09-14). The paid re-measurement ran: all 15 scenarios at `#40`, k=1, on the deployed (b) workflow, scored **15 correct, 0 wrong** — no regression. Every answer was `gpt-5`/`gpt-5-mini` (serial submission, no 429/grok contamination); `conflicting-evidence#40` concluded CONTAINER_OOM at 0.55 (below `container-oom#40`'s 0.9 and the 0.6 ceiling); `insufficient-evidence#40` refused. Evidence: `docs/answers/2026-09-14-option-b-verify.json`. A k=3 reliability baseline under the (b) prompt set was then established too (2026-09-14, `harchi`): attempts #41 and #42 for all 15, SERIAL (30 executions, zero grok), under the (b) prompt set `2af733c60b5d` — **15 scenarios, 0 sticky, 0 below k=3** (`node scripts/eval.mjs`; answers in `docs/answers/2026-09-14-option-b-k3.json` + the #40 file). conflicting-evidence is `pass [3/3]` under (b). So (b) is now the reliability baseline, replacing the pre-(b) set `2c121d3550c3`. The rest of this brick is the history of how it was decided.

**State (history):** RESOLVED IN CODE, awaited a paid re-measurement (2026-09-14). Grok
adjudicated the fork to **(b)** with evidence: the extractors named a cause 28 times
across the green baseline (kubernetes `CONTAINER_OOM` 4×, the extend 24×), so (a) —
forbidding them — would break exactly what 15/15 already does. (b) fixes only
`prompts/root-cause-agent.md`: the false "forbidden to diagnose / empty by design /
none of them was allowed" is removed (two carriers, 28 lines apart — Grok caught the
second), replaced with "a specialist may hand you a candidate you WEIGH, not copy".
A negative test (`tests/agents.test.ts`) now guards the claim's ABSENCE. Extractors
unchanged; the two cause-code enums stay equal; workflow regenerated; 1093 tests pass;
Grok cleared the commit. **What still needs `harchi`:** the prompt changed, so the k=3
baseline `2c121d3550c3` no longer applies — a paid re-run confirms all 15 still answer
correctly under the new prompt set. That measurement is the owner's spend decision.

**The leak.** The three extractor prompts (`prompts/kubernetes-agent.md`,
`prompts/logs-agent.md`, `prompts/metrics-agent.md`) still enumerate all 13 cause codes
and allow a hypothesis "when the observation states the cause"; the schema
(`schemas/agent-result.schema.json`) accepts a non-empty `hypotheses` from any agent.
Root-cause is told those lists are empty (`prompts/root-cause-agent.md`). Meanwhile
`src/core/configuration.ts` + `src/core/slice.ts` hand the concluder code-read
observations, and `src/core/merge.ts` lets those refs satisfy citations.

**What it really is (verified 2026-09-14): a contradiction between the prompts.**
`prompts/root-cause-agent.md:103` tells the concluder the specialists are "forbidden
to diagnose" and their `hypotheses` lists are "empty by design"; but
`prompts/kubernetes-agent.md:245` (and logs/metrics) tell each specialist to "return a
hypothesis ONLY when your own observation states the cause outright" (e.g. `OOMKilled`).
Both cannot hold: a specialist that names the cause fills a list the concluder was told
is always empty, so `gpt-5-mini` can name the cause and `gpt-5` weighs a handed verdict
without its prompt acknowledging it.

**Why it matters (attribution, not a wrong answer today).** `gpt-5-mini` (a collector)
can NAME the cause; then `gpt-5` (the concluder) only weighs a handed verdict, or cites
a field no specialist extracted — and `WHERE TO EDIT` points at the wrong prompt. The
baseline is all-green at k=3, so this is a latent correctness/attribution risk, not a
live wrong answer.

**A hard constraint on any fix (tested, 2026-09-05):** the two cause-code enums
(`schemas/common.schema.json` `causeCode` and the agent-result `hypotheses` code list)
must stay EQUAL — a code an agent cannot propose makes a scenario unsolvable
(`CPU_THROTTLING` was recordable while no agent could propose it). `tests/agents.test.ts`
enforces this in both directions. So Grok's literal "move the 13-code list into root-cause
only" is NOT free to take — it collides with this decision.

**The fork the owner must pick (both change prompts -> both need a paid re-measurement):**
- (a) Make the extractors TRULY never diagnose: delete the "states the cause outright"
  permission from the three extractor prompts; the concluder prompt already claims this.
  Cleaner separation, closest to Grok's intent — but the enum stays shared (a).
- (b) Keep the narrow "states the cause outright" permission and FIX the concluder prompt:
  remove the false "forbidden to diagnose / empty by design", so it acknowledges a
  specialist may hand it a candidate it must still weigh.

Free either way but not enough on its own: extend specialist scoring to score extraction
on green scenarios too, so a concluder handed the answer is visible.

**Why it is not free.** The first two items change the extractor and root-cause prompts.
A prompt change invalidates the k=3 baseline (`2c121d3550c3`): to know the agent still
answers all 15 correctly, the eval must be re-run with a model — that SPENDS, and needs
the owner's `harchi`. So this brick is a code change that is cheap to write but cannot be
accepted without a paid measurement, which is the owner's decision. `eval.mjs --plan`
prints exactly what that re-run would cost before it is bought.

## Brick · Slack bot sensitive-data exposure · reviewed 2026-09-14

A subagent + Grok hunted the "the bot leaks sensitive data if asked" class. **The
architecture is the right control and it is intact:** the reply bot answers ONLY from
the already-posted, already-redacted incident report (`replyMessages(reportText,
question)`; the raw-observation fetch node was removed 2026-09-13), so an in-thread user
cannot extract more than the thread already shows them. Cross-incident is closed
(`incident_id` is an ownership boolean, never a fetch key); raw observations are
unreachable; the reply post is redacted (`redactSecrets`) before it leaves.

**Done (input-side guard, this brick):** the reply system prompt now refuses to reveal a
secret/credential/token/password/key verbatim and to obey a question that says to
disregard the rules (`src/core/reply.ts`; test in `tests/reply.test.ts`). It is PROMPT
TEXT, not an enforced control — Grok named trivial bypasses ("summarise including any
tokens", "decode the JWT", "first 20 chars"). It closes the "no input-side guard at all"
gap; it is not a real control. The real containment is still the redacted-report-only
input.

**Left open, honestly (real-deploy only; the prototype's fixtures carry no real secrets):**
- The shared redactor `redact.ts` is a narrow denylist that DELIBERATELY keeps JWTs / bare
  `token=` / k8s service-account tokens readable (tested at `tests/redact.test.ts` as
  evidence an operator may need). NOT reversed — reversing it would redact legitimate
  evidence in the report too. So a real-deploy report containing such a shape could be
  restated by the bot despite the refusal instruction.
- No Slack request-signature (HMAC `x-slack-signature`) verification on the listener
  webhook (`generate-listener.mjs`): anyone who learns the URL can forge events →
  unauthenticated model spend + spoofed bot posts (NOT data exfil — the reply lands in the
  real channel, not the attacker's). Production hardening, out of the prototype scope.
- Latent footgun: the incident report post has an un-redacted raw fallback
  `text: slack_text || thread.join(...)` (`generate-workflow.mjs:644`), safe today only
  because `redactSecrets` never empties non-empty content.

## Brick · the 8 defects prd-agent-n8n filed · adjudicated and fixed 2026-09-15

Another project (prd-agent-n8n) read our LIVE workflows while mining them for reuse and
filed 8 defects (`DEFECTS-FOUND-BY-PRD-AGENT.md`). All 8 were verified true against the
code. Grok adjudicated which belong in a prototype — the principle it set: **fix what
LIES or LOSES something already paid for**; do not fix a race that needs Redis.

**Fixed (6):**
- **#2** `Slack post` had no neverError/fullResponse/onError: a Slack 500 threw and an
  already-paid investigation was neither posted nor reliably stored (the Record nodes are
  on parallel branches). Now it keeps a non-2xx as data and the run continues; `Slack took`
  reads `body.ok`.
- **#3** the listener's `Post reply` never checked Slack's `ok` — chat.postMessage answers
  200 with `{"ok":false,"error":"not_in_channel"}`, so the bot went silent while the
  workflow reported success. Now `Reply took` → `Trace turn`, the same ok-shape the
  incident workflow already used.
- **#6** zero retries anywhere. Now `retryOnFail: 3` on the SLACK calls only (`Slack post`,
  `Fetch thread`, `Post reply`) — NEVER on a model call, where a retry is a second bill.
  A test asserts no `Ask *` / `Grok *` node retries.
- **#1** `usage_by_agent` was computed and then dropped — it survived only in the n8n
  execution record, which n8n prunes, breaking this repo's own "record every paid call as
  an artifact" rule. New `Record usage` node upserts it into the incident table.
- **#8** the listener had no tracing at all: any failure after the ACK was silence. Now
  every turn writes `ok` / `error` / `reply_ts` / `execution_id` onto its `event_id` row,
  including the turn where nothing was posted.
- **#7** `Grok <agent>` wired success and failure to the same Collect, so no trace could
  say which happened. A marker node (`Grok <agent> failed`, `grok_error: true`) on the
  error output makes it observable — not a second Collect, which would duplicate the
  defensive unwrap.

**Refused (#4)** — prd-agent proposed moving `Mark seen` after `Post reply`, or an error
workflow that deletes the row. Grok refused both: on a Slack retry the first trades a lost
answer for a SECOND PAID gpt-5 call, and the second races the retry. `Mark seen` stays
before `Ask model`; the cost (a crashed turn consumes its event_id, and the user asks
again with a new one) is the accepted one.

**Skipped (#5)** — the dedupe is not atomic and cannot be with n8n data tables. Already a
recorded limitation (2026-09-12); unchanged.

**Grok blocked the implementation THREE times, each time rightly**, and each is a lesson
worth keeping: (1) `Record usage` was first placed SERIALLY between Conclude and Report —
an n8n dataTable can REPLACE the item with the written row (which is why the listener reads
`$('Handle')` after its insert), and `Report` refuses anything not `concluded`, so the store
could have swallowed the whole report: four paid calls spent, nothing posted. It is a
parallel LEAF now. (2) The local harness had been relaxed to "walk through an on-line
dataTable, carrying the item unchanged" — a claim that would have HIDDEN exactly that
defect. Reverted. (3) The two writers of the incident row then blanked each other: an n8n
defineBelow upsert wipes the columns it does not name, so whichever landed last deleted the
other's. Both now name all five columns, and a test asserts their column sets are EQUAL so
they cannot drift apart again in either direction.

**Not verified live:** the workflows are deactivated and these fixes are deployed nowhere.
What a paid run would establish: that a Slack 500 no longer kills the stores, that an
`ok:false` is no longer counted as answered, and that the usage row is actually written.
That needs the owner's `harchi`; it was not asked for here.

## Brick · the smoke run found a column the live table does not have · 2026-09-15

The one paid smoke execution (exec 525) ran the WHOLE chain — four agents, Conclude,
Report, **Slack post**, Slack took, Slack ok, Slack record — and then failed at
`Record incident data` with:

```
Validation error with data table request: unknown column name 'usage'
```

The generator was changed to write `usage` / `models` / `execution_id` into the incident
data table (finding #1), but **those columns do not exist in the live table** — it has only
`incident_id` and `data`. Nothing in the repo could have caught this: the deterministic
tests read the generated JSON, and the JSON is correct; only the live table knows its own
schema. Grok blocked the column wiring three times, each time rightly, and neither of us
asked the question that mattered — whether the columns exist at all. Absence is not consent.

**What the run DID establish, and it is not nothing:** the six rewiring changes did not
break the working path. Slack post ran, `Slack took` and `Slack ok` ran after it, and
`Slack record` ran — so the `fullResponse` / `body.ok` change did not silently kill the
delivery. That was the biggest risk of the change and it is now measured.

**Closed the same hour:** the columns were added. The n8n PUBLIC API does accept them —
`POST /data-tables/{id}/columns` with `{name, type}` returns 201; only the MCP tool wrapper
claimed it could not (it routes column actions through the instance-level MCP server, which
this instance has disabled). `incident_data` (`rKZEwVRRLB3Xb6LR`) now has
`incident_id, data, usage, models, execution_id`; the listener's seen table
(`uBZvrUFgQcderwqF`) got `ok, error, reply_ts, execution_id` for `Trace turn`.

**Still UNVERIFIED, honestly:** that `Record usage` actually writes the row. The two runs
after the columns were added (`container-oom#52`, `#53`) were ACCEPTED by the webhook — a
200 with a submission token — and created NO execution, the documented stale-webhook shape,
so they cost nothing and proved nothing. Deactivate+activate did not restore it; only a
bare probe POST started a workflow. One execution on a healthy webhook would close it.
