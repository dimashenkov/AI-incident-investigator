# Spec — what this project is, covers, runs on, and permits

This file is written from evidence on disk, not from intent. Every claim names the
file it came from. Where the honest answer is "not yet measured" or "unknown", it
says that. A spec that overstates coverage is the exact defect this project exists
to catch.

Numbers here are read from artifacts at a point in time and will change. The live
readiness figure comes from `node scripts/readiness.mjs --short`; the live spend
figure from `node scripts/spend.mjs`. Neither is reproduced as a fixed number in
this file.

---

## 1. What it is

A multi-agent Kubernetes incident investigator. A fake Datadog alert enters an
n8n workflow; three specialist agents (Kubernetes, Logs, Metrics) each read one
slice of a simulated incident; a Root Cause agent concludes; the result is posted
to a **real** Slack thread, and a two-way bot answers questions in it. **Every
other external system is deliberately simulated** — there is no real Datadog or
Kubernetes, and the cluster/logs/metrics are fixtures (`CLAUDE.md` §13 decision of
2026-09-05, "A prototype, and that is the scope"). Slack became real on 2026-09-12
(`CLAUDE.md` §13, "Real Slack + Langfuse Cloud"; `docs/slack-setup.md`), which
supersedes the earlier "there is no real Slack" — the app, channel, token and
posted reports are live (`docs/runs/2026-09-12-volume-full.json`). The
deterministic core (providers, scoring, correlation) lives in `src/`; the agent
prompts live in `prompts/`; the workflow is generated and deployed to n8n Cloud.

---

## 2. What it covers today

The set of causes the system can name is a **closed list of thirteen codes** in
`schemas/common.schema.json` (`$defs.causeCode`). `INSUFFICIENT_EVIDENCE` is
deliberately **not** in that list — it is a verdict about a whole incident, not a
cause an agent can hold (same file, `causeCode` description).

Each code has a scenario directory under `scenarios/` with an `expected.json`, and
a number in `scenarios/registry.json`. "Measured" below means a run record under
`docs/runs/` carries a machine-readable `scored` entry for that scenario; that is
the same evidence `scripts/readiness.mjs` counts (`scenariosMeasured`,
`readiness.mjs` lines 88–186). Knowing a result from prose is not recording it.

| Code | Scenario dir | Registry # | Measured with a model? |
|---|---|---|---|
| `CONTAINER_OOM` | `container-oom` | 1 | **Yes** — recorded `correct` (`docs/runs/2026-09-10-webhook-run-9.json`, `2026-09-11-webhook-run-6.json`) |
| `IMAGE_PULL_FAILURE` | `image-pull-failure` | 2 | **Yes**, with a caveat — right code but `must_cite` missed three times (`correct-without-its-evidence`, `docs/runs/2026-09-07-part2.json`; see `docs/measurement-contract.md` lines 51–53). Later `correct` (`2026-09-11-webhook-run-6.json`) |
| `READINESS_PROBE_FAILURE` | `readiness-probe-failure` | 3 | **Yes** — `correct` ×3 (`docs/runs/2026-09-07-part1c.json`) and again (`2026-09-11-webhook-run-7.json`) |
| `CPU_THROTTLING` | `cpu-throttling` | 4 | **Yes** — `correct` (`docs/runs/2026-09-10-webhook-run-9.json`, `2026-09-11-webhook-run-7.json`) |
| `APPLICATION_STARTUP_FAILURE` | `application-startup-failure` | 6 | **Yes** — once `correct` (`docs/runs/2026-09-10-webhook-run-9.json`); other runs right code but citation missed |
| `DEPLOYMENT_REGRESSION` | `deployment-regression` | 7 | **Yes**, after repair — `wrong` on 2026-09-10 (`webhook-run-2/4`), then `correct` (`docs/runs/2026-09-10-webhook-run-9.json`, `2026-09-11-webhook-run-7.json`). The `scored` field stores the verdict only, not a confidence; the 90% is PROGRESS.md prose, not a recorded number |
| `NODE_NOT_READY` | `node-not-ready` | 9 | **Yes — measured correct** (`docs/runs/2026-09-11-webhook-run-10.json`; readiness green) |
| `VOLUME_FULL` | `volume-full` | 10 | **Yes — measured correct** (`docs/runs/2026-09-11-webhook-run-9.json`; readiness green) |
| `DEPENDENCY_UNAVAILABLE` | `dependency-unavailable` | 11 | **Yes — measured correct** (`docs/runs/2026-09-11-webhook-run-9.json`; readiness green) |
| `CONNECTION_POOL_EXHAUSTED` | `connection-pool-exhausted` | 12 | **Yes — measured correct** (`docs/runs/2026-09-11-webhook-run-9.json`; readiness green) |
| `DNS_RESOLUTION_FAILURE` | `dns-resolution-failure` | 13 | **Yes — measured correct** (`docs/runs/2026-09-11-webhook-run-9.json`; readiness green). Deliberately logs-led |
| `NETWORK_POLICY_BLOCKED` | `network-policy-blocked` | 14 | **Yes — measured correct** (`docs/runs/2026-09-11-webhook-run-10.json`; readiness green). The event reports a silent drop; the diagnosis is forced across log, callee health and the drop metric |
| `CERTIFICATE_EXPIRED` | `certificate-expired` | 15 | **Yes — measured correct** (`docs/runs/2026-09-11-webhook-run-9.json`; readiness green) |

Two scenarios exercise **behaviour**, not a new cause:

| Scenario dir | Registry # | What it tests | Measured? |
|---|---|---|---|
| `insufficient-evidence` | 5 | the agent must refuse to name a cause when evidence is thin (`scenarios/insufficient-evidence/expected.json`) | **Yes** — `correct` (`docs/runs/2026-09-10-webhook-run-9.json`) |
| `conflicting-evidence` | 8 | restraint: name `CONTAINER_OOM` at **lowered** confidence (ceiling 0.6) or refuse, with dissent in the evidence (`scenarios/conflicting-evidence/expected.json`) | **Yes** — `correct` (`docs/runs/2026-09-11-conflicting-vs-oom-pair.json`): CONTAINER_OOM at 0.55, below the 0.6 ceiling and below container-oom's 0.92 on the same prompt, citing the memory series that argues against it |

Status of the chain as a whole: it has run end-to-end through the deployed
workflow (`README.md` lines 5–6; `docs/runs/` records). The scored runs above are
single executions per scenario, which establish **coverage, not reliability** —
no claim about variability is made from them (`docs/measurement-contract.md`
lines 18–20, 77).

---

## 3. What it does NOT cover

These are real Kubernetes failure modes. The table in PROGRESS.md ("What it covers
and what it does not · 2026-09-11") names them; the danger it records is not that they are
absent but that an agent facing an unknown case may **press it into the nearest
code**, which looks like an answer.

**Built, not yet measured — none remain.** The seven codes that were in this state
(`NODE_NOT_READY`, `VOLUME_FULL`, `DEPENDENCY_UNAVAILABLE`,
`CONNECTION_POOL_EXHAUSTED`, `DNS_RESOLUTION_FAILURE`, `NETWORK_POLICY_BLOCKED`,
`CERTIFICATE_EXPIRED`) were measured on 2026-09-11 and are recorded `correct` (§2;
`docs/runs/2026-09-11-webhook-run-9.json` and `-10.json`; readiness counts all
fifteen scenarios green). What that measurement establishes is **coverage, not
reliability**: each is a single scored run per scenario, so it shows the agents can
reach the code, not that they do so repeatably. The `gpt-5` non-determinism and the
k=3 protocol (`docs/next-measurement.md`; `src/core/eval.ts`) are the answer to
reliability, and the k=3 baseline now covers all fifteen scenarios under the current prompt set `2af733c60b5d` (option (b); `docs/answers/2026-09-14-option-b-verify.json` + `-option-b-k3.json`; 0 sticky). The pre-(b) set `2c121d3550c3` (`2026-09-14-baseline-extend.json`) is its predecessor.

**No code at all — absent from `schemas/common.schema.json` `causeCode` and from
`scenarios/registry.json` (next free number is 16):**

- **Storage beyond a single full volume** — `VOLUME_FULL` covers a full PVC and
  nothing else; a detached, read-only, or degraded volume has no code.
- **Node / cluster-level faults beyond the one built case.** `NODE_NOT_READY`
  covers a node going `NotReady`; a failing control plane, an unreachable
  API server, and general scheduling exhaustion have no code.
- **Stateful-set- and cronjob-specific failures** — no scenario or code.
- **Multi-service incidents** — out of scope by design (see §4): the isolation
  guarantees rest on one incident per execution.
- **Anything the thirteen codes do not name** — the fault space of a real
  cluster is far larger than thirteen codes, and an unknown case still risks
  being pressed into the nearest known one. That risk is the reason each new code
  enters whole, with a scenario that measures it, rather than as a bare enum
  entry (§6).

---

## 4. Deliberate boundaries

These are simulated or limited **on purpose**. They are recorded decisions, not
gaps waiting on work.

| Boundary | What it means | Where it is decided |
|---|---|---|
| No real cluster | every provider is simulated; the project is a prototype | `CLAUDE.md` §13, 2026-09-05 ("A prototype, and that is the scope"); `README.md` line 29 |
| Read-only | agents recommend actions, never execute them; the schema **refuses `executed: true`** so the day something acts, it fails loudly | `CLAUDE.md` §13, 2026-09-04 ("The MVP is read-only"); `schemas/remediation.schema.json` `executed` (`const: false`) |
| One incident per execution | all isolation (`collection_id`, `requested_for`, one-to-one thread, namespace match) compares against a single request; two incidents in one process would have no unambiguous owner | PROGRESS.md, "Can several incidents at once" (2026-09-11) — parallel *separate* executions are measured; multiple incidents in one execution is "no, and deliberately" |
| Confidence is the model's own assertion | there is no calibrated scale behind the number; the schema caps a refusal at `maximum` 0.5 and the `conflicting-evidence` scenario caps its answer at `max_confidence` 0.6 — two ceilings on the same number (there is no floor, no `minimum`), both *chosen*, not measured | `CLAUDE.md` §13, "The thresholds and acceptance boundaries"; `scenarios/conflicting-evidence/expected.json` |
| No atomic thread lock on the live path | one Slack thread per incident is guaranteed only under the in-memory index (`MemoryStore`); the live path has **no compare-and-swap**, because n8n Data Table has no atomic insert-if-absent and n8n Cloud runs webhooks concurrently (measured 2026-09-12). Two **simultaneous** signals for one incident could open two threads. The demo fires one incident at a time; `DurableThreadIndex`/`AtomicStore` are the seam for a real CAS store (Upstash Redis) the day it is added | `CLAUDE.md` §13, 2026-09-12 ("No Redis for the prototype"); Grok review |

The review boundary follows from the prototype decision: the question asked of the
code is "does it ever quietly claim something false about its own work", not "does
it work against a real cluster" (`CLAUDE.md` §13, 2026-09-05).

---

## 5. What the numbers mean

**Readiness** (`scripts/readiness.mjs`) has **three states**, not two: green
(established and passing), unestablished (nobody has asked), red (established and
failing). Unestablished is its own count, never folded into failure or dropped
from the denominator (`readiness.mjs` lines 9–14). The percentage is **rounded
down** and the bar's leftover cells never go to green — a bar that padded with
green would report work nobody did (`readiness.mjs` lines 539–543, 581–590). The
figure is read from disk at a moment and changes as runs and code change; it is
not quoted as a fixed number here.

**Spend** (`scripts/spend.mjs`, `docs/spend-counter.md`) reports a **floor**: a
run whose model has no recorded price is counted as `unknown` with no number, not
as zero (`docs/spend-counter.md` lines 44–61). Only `gpt-4o-mini-2024-07-18` has
a recorded price (`docs/spend-counter.md` lines 32–38). The **dollar cost of the
`gpt-5` runs is UNESTABLISHED**: the webhook reply carries no usage, so those runs
cannot be priced — the measurement contract recorded the counter reporting **eight
runs it could not price** as of 2026-09-10 (`docs/measurement-contract.md` lines
45–48). That count is historical and will change. Flat-fee subscriptions (Codex,
Grok) are listed but never summed into the credit total (`docs/spend-counter.md`
lines 70–99).

**Model.** The decision of 2026-09-11 is `gpt-5` (`CLAUDE.md` §13, "The model is
`gpt-5`"). A recorded limitation travels with it: `gpt-5` refuses
`temperature: 0`, so the default of 1 applies and **two runs of this model are not
strictly comparable** — a difference between them may be sampling alone. Under load
the chain sits on n8n Cloud's gateway timeout (HTTP 524), which is why recent runs
used a `gpt-5` + `gpt-5-mini` split and why the answer is now fetched from the n8n
execution record rather than awaited in the HTTP response
(`docs/async-shape.md` lines 16–28, 128–151).

---

## 6. How coverage grows

One code at a time, each entering **whole**. `NODE_NOT_READY` was the first to go
through the full process (PROGRESS.md, "The first new case: NODE_NOT_READY ·
2026-09-11"):

1. the code added to `schemas/common.schema.json` `causeCode`;
2. a scenario directory under `scenarios/` with `expected.json`;
3. the distinguishing rule written into **all four** prompts
   (`prompts/kubernetes-agent.md`, `logs-agent.md`, `metrics-agent.md`,
   `root-cause-agent.md`) so the new cause can be told apart from its neighbours;
4. a number appended in `scenarios/registry.json` (append-only; numbers are never
   reused);
5. a test that a code **cannot exist without a scenario** — "gives every code in
   the schema a scenario that expects it" — proven to catch a bare code
   (demonstrated with `VOLUME_FULL`, PROGRESS.md);
6. a mutation, so the new test fails the gate if the guarantee regresses;
7. the acceptance gate (`node scripts/acceptance-gate.mjs`) passing;
8. a release / deploy, with drift detection comparing the deployed workflow to the
   generated one (`CLAUDE.md` §13, 2026-09-04 "Drift detection, not trust").

A new code is not coverage until it has **also been measured with a model**
(`docs/measurement-contract.md`). Adding a code without a scenario is "a longer
menu, not a wider scope" — a longer menu, not a wider scope (PROGRESS.md). All
thirteen codes and the two behavioural scenarios have now been measured `correct`
at least once (§2; readiness counts fifteen scenarios green) — but a single scored
run per scenario is **coverage, not reliability**; the k=3 protocol
(`src/core/eval.ts`) is the answer to reliability, and its baseline now covers all
fifteen scenarios (k=3, 0 sticky) under the current prompt set `2af733c60b5d` (option (b)).

---

## 7. Tools — what it is built from and runs on

**Language and host.** TypeScript on Node, deployed into an n8n Cloud Code node.
The decision is recorded: TypeScript, not Python, because JavaScript is the Code
node's native runtime and the repo is already on Node; Python is reachable in the
Code node but imports through a two-name allowlist only, so the core cannot be
carried in that way (`CLAUDE.md` §13, 2026-09-04, "TypeScript, not Python"). The
Code node has no filesystem and no `require` outside that allowlist, which is why
`scripts/workflow-runtime.mjs` assembles everything — the standalone validators
built from `schemas/`, `src/core/merge.ts` transpiled in-process, and the four
prompt files verbatim — into embedded JavaScript rather than reading anything at
run time (`workflow-runtime.mjs` lines 1–18).

**The four model agents** (prompts in `prompts/`, version-controlled):

| Agent | Prompt | Role |
|---|---|---|
| Kubernetes | `prompts/kubernetes-agent.md` | reads the cluster-state slice |
| Logs | `prompts/logs-agent.md` | reads the log slice |
| Metrics | `prompts/metrics-agent.md` | reads the metrics slice |
| Root Cause | `prompts/root-cause-agent.md` | concludes from the three reports |

The first three **extract** (read one slice, report what is in it); the judgement
is the concluding agent's (`scripts/generate-workflow.mjs` lines 263–268).

**The model, two of them since 2026-09-11** (`scripts/generate-workflow.mjs` lines
244–267; `CLAUDE.md` §13): `gpt-5` **concludes** and `gpt-5-mini` **collects**.
The split is measured, not tidy: `gpt-5` produced dissent at 0.35 confidence where
two smaller models over eight prompt rounds had produced `contradicted_by` in none
of thirty hypotheses, but four sequential `gpt-5` calls took 183 s against a ~100 s
gateway cut, and 6 272 of 9 152 hidden reasoning tokens were spent by the three
collection agents on work that is extraction, not reasoning — so collection moved
to the smaller model. **`temperature: 0` is refused by `gpt-5` (HTTP 400), so the
field is not sent and the default of 1 applies; two runs on this model are not
strictly comparable** (`scripts/generate-workflow.mjs` lines 73–75;
`scripts/acceptance-gate.mjs` lines 972–975).

**n8n as the runtime.** The workflow is generated by
`scripts/generate-workflow.mjs` and its deployed export is `workflows/incident.json`.
The webhook answers with `responseMode: "onReceived"` — it acknowledges the alert
and returns immediately rather than holding the HTTP connection open for the
investigation, which removes the gateway deadline (`generate-workflow.mjs` lines
338–343; `workflows/incident.json` line 16). The answer is then read back from the
n8n execution record (see `collect-execution.mjs` below).

**The deterministic scripts** (these run locally on Node; they do not reason):

| Script | What it does |
|---|---|
| `scripts/run-scenarios.mjs` | the **paid runner** — it POSTs a scenario's alert to the webhook and records the run. The only script that can cause a model call, and gated (see §8) |
| `scripts/collect-execution.mjs` | a **GET-only reader** that collects an answer already paid for: exactly `GET /executions?workflowId=…` and `GET /executions/{id}?includeData=true`, never the webhook and never a retry endpoint; `includeData=true` is required or a finished execution reads as "no answer" (`collect-execution.mjs` lines 1–23) |
| `scripts/score-run.mjs` | scores a recorded answer on four axes — diagnosis, citation, restraint, collection (`docs/measurement-contract.md` lines 50–64) |
| `scripts/readiness.mjs` | the readiness figure, from artifacts on disk (see §5) |
| `scripts/spend.mjs` | the spend counter, from recorded runs (see §5) |
| `scripts/acceptance-gate.mjs` | checks that what was promised is built, and runs the mutation check |
| `scripts/mutation-fanout.mjs` | runs the mutation gate in parallel across worker copies (the full mutation set — 325 as of this writing, read from `scripts/mutations.mjs`, not a fixed number — across worker copies; measured 540 s sequential → 68 s at 305 mutations, `docs/async-shape.md`) |

**The review tools.** The external review is **Astra** — `gpt-6-astra`, run through
`codex exec -m gpt-6-astra` (`CLAUDE.md` §13, "the review is Astra", 2026-09-11).
**Grok** is reachable when the owner asks for it (`docs/grok-on-this-machine.md`).
Both are on a **subscription**, a flat monthly fee — one more run does not move a
bill — so they are listed in the spend report but never summed into the metered
total (`docs/spend-counter.md` lines 70–99; `CLAUDE.md` §13 cost table).

---

## 8. Permissions — what may and may not happen, and who authorizes it

**Money.** The only thing that spends is an **n8n execution that calls a model**;
its credits are billed to the key in n8n Credentials (`CLAUDE.md` §13 cost table;
§3 "What asks for the word"). Creating, updating, uploading, or reading a workflow does
**not** spend — "uploading is not execution" (`CLAUDE.md` §3). Grok, Astra, and Codex
are subscription, not metered (same table).

The single authorization is the **literal word `harchi` from the owner**. Not "ok",
not "yes", not the tool's name, not a permission from a previous message — only that
word, and **one `harchi` authorizes one run**; a retry after a timeout is a new run
and needs the word again (`CLAUDE.md` §3, "The authorization is the word `harchi`"). Before
asking, five lines are shown: the cycle, what exactly will run, the cost, the
question it answers, and what happens if it is not run (`CLAUDE.md` §3). What stops
a paid run is judged per finding, and "not clear" stops it (`CLAUDE.md` §3, "What
stops a paid run").

**`AI_SRE_LIVE=1` on the command line.** `scripts/run-scenarios.mjs` may call an
address off this machine **only** when `AI_SRE_LIVE=1` is in the invocation's
environment, and it is **refused if it arrives from the `.env` file** — that file
is read by every invocation, including tests, so a value set there is rejected by
name (`run-scenarios.mjs` lines 85–117). This is the code form of the `harchi` rule:
a paid call must be an explicit act, and no test can reach a paid instance.

**Read-only MVP.** The remediation schema's `executed` field is `const: false`,
required, always false — a tripwire: the day anything sets it to true, every
validator fails loudly, and an absent field is refused too so read-only compliance
is never assumed in silence (`schemas/remediation.schema.json` `executed`;
`CLAUDE.md` §13, 2026-09-04). State-changing actions additionally require approval
in the schema (`remediation.schema.json` `allOf`).

**No subagent and no review ever spends.** This is written into every review and
subagent prompt, with the forbidden commands named verbatim — `do not run npm
install, do not run npx, do not run grok, do not run codex, do not call any paid
API, do not run any network command` (`CLAUDE.md` §13, "Which commands spend money";
§7, "No subagent spends money").

**Every change goes through external review before commit, and the review is
adversarial** — the mandate is "assume there is a defect and find it", not a reply
to the author's own questions (`CLAUDE.md` §6; WORKING-RULES "The review is adversarial").
Nothing is committed that the review did not see.

**The three hooks** (registered in `~/.claude/settings.json`, so they apply in every
project; `CLAUDE.md` §8):

| Hook | What it checks | Blocks? |
|---|---|---|
| `guard_bash.py` | the named-forbidden commands: `git checkout -- <path>`, `git restore`, `git stash` (except `list`/`show`), `git reset --hard`, `git clean -f`, `rm -r` on root or home | **Yes** |
| `check_edit.py` | syntax, then the linter the repo declares, on the just-written file only | No |
| `finish_check.py` | facts before stopping: an unreadable file, a left `breakpoint()`, a first-person promise with no following tool call, a red test suite with no green after it, or announced free work under `NEXT` that the turn never started | **Yes**, for those cases |

No hook runs the test suite, none reformats or fixes, and none refuses when it could
not check — a hook that blocks on uncertainty gets turned off and then guards
nothing (`CLAUDE.md` §8). A hook is inside the thing being checked; it cannot
establish that a review happened — that needs a gate outside the agent, which is
not yet built (`CLAUDE.md` §0.6, §8).
