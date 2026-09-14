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

**State:** OPEN (found 2026-09-14 by a subagent hunting the second carrier of the
`eval.mjs` scoring defect; the `eval.mjs` carrier was fixed in the same round).

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

**State:** OPEN (Grok implementation review, 2026-09-14). NOT started, because closing
it changes the PROMPTS and therefore needs a paid re-measurement — it is not a free fix.

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
