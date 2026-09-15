# Defects found in AI-incident-investigator, while mining it for reuse

Found on 2026-09-15 by the prd-agent-n8n project, which read these workflows to
copy what already works. Everything below was read from the live n8n instance
(`dimitarshenkov.app.n8n.cloud`) and from recorded executions — nothing was
changed, nothing was executed, no money was spent.

Ordered by what costs you most.

---

## 1. Token counts are carried through eight nodes and then dropped

**Where:** `AI SRE — incident investigation` (`49T3pwFvfumqTdo7`) — the `Collect *`
nodes build `usage_by_agent`, the `Record *` nodes carry it faithfully, and then
`Record incident data` and `Record Datadog` store neither.

**Measured:** execution `506` (2026-09-14) ends with

```json
"usage_by_agent": {
  "kubernetes": {"prompt_tokens":4042,"completion_tokens":3794,"cached_tokens":3968},
  "logs":       {"prompt_tokens":1962,"completion_tokens":996, "cached_tokens":1792},
  "metrics":    {"prompt_tokens":2089,"completion_tokens":2078,"cached_tokens":1920},
  "root-cause": {"prompt_tokens":6007,"completion_tokens":2593,"cached_tokens":4096}
}
```

**Why it matters:** those numbers survive only inside the n8n execution record,
and **n8n prunes executions**. The repo's own rule says every paid call records
an artifact *at the time of the call* and one command totals it from disk. The
workflow does the expensive half — it computes the usage — and then throws it
away before anything durable sees it.

**Concretely:** ask "what did the last month cost" in six weeks and the honest
answer is unavailable for every run older than the retention window, with no
line anywhere saying so.

**Fix:** one data-table insert after `Conclude`, carrying `incident_id`,
`usage_by_agent`, `model_by_agent`, and the execution id. Nothing else in the
graph needs to change.

---

## 2. `Slack post` can throw and lose an investigation that was already paid for

**Where:** `AI SRE — incident investigation` → `Slack post`.

**What is missing:** the node has **no** `neverError`, **no** `fullResponse`, and
**no** `onError`. `Record incident data` and `Record Datadog` sit on parallel
branches off `Reported`.

**Concretely:** Slack returns HTTP 500. The node throws. Depending on execution
order the two record nodes may or may not have run. An incident has been
investigated, four model calls have been paid for, and the result is neither
posted nor reliably stored.

**Fix:** `options.response.response.neverError: true` + `fullResponse: true`, and
`onError: continueRegularOutput`. Then read `body.ok` rather than the status —
see the next item.

---

## 3. `chat.postMessage` answers HTTP 200 when it refuses

**Where:** both workflows post to Slack; `Slack took` / `Slack ok` in the
investigation checks `$json.ok === true` and is therefore **correct**, but
`Post reply` in `AI SRE — Slack listener` (`oMRowrkAwtnjTVIC`) does not check at
all.

**Concretely:** the bot is not in the channel. Slack replies `200` with
`{"ok": false, "error": "not_in_channel"}`. The listener treats the turn as
answered. The user sees nothing and the workflow reports success.

**Fix:** the same shape `Slack took` already uses — check `ok`, capture `error`,
and keep `ts` only when `ok` is true.

---

## 4. The dedupe marks an event seen BEFORE the work, so a crash consumes it

**Where:** `AI SRE — Slack listener` → `Seen event` (`rowNotExists`) → `Mark seen`
(`insert`) → `Fetch thread` → … → `Post reply`.

**Concretely:** the event is marked seen, then `Ask model` throws on an OpenAI
500. Slack retries the same `event_id`; `Seen event` now says "seen" and the lane
stops. The user got an acknowledgement and then permanent silence, and there is
no error workflow to say why.

**Fix, one of:** move `Mark seen` after `Post reply` (at-least-once: a duplicate
answer is better than none), or keep it where it is and add an error workflow
that deletes the row for the failed execution so the retry can proceed. The
prd-agent project took the second route.

---

## 5. The dedupe is not atomic, and cannot be

**Where:** same pair of nodes. n8n data tables have **no unique constraint**.

**Concretely:** Slack delivers `event_id=Ev0PABC` twice concurrently. Both
executions run `rowNotExists` before either insert lands, both see "new", both
make a **paid** model call, and both post.

**This is not fully fixable with the current primitives.** The early
acknowledgement makes it rare. Worth recording as a known limit rather than
fixing badly — the repo's own `src/providers/slack-post.ts` already states this
honestly in its header, so the workflow is behind its own documentation.

---

## 6. No retries anywhere, on any HTTP node, in either workflow

**Where:** zero `retryOnFail` / `maxTries` / `waitBetweenTries` across all 33 + 17
nodes.

**Concretely:** Slack returns `429` with `Retry-After: 3` on `Post reply`. The
answer is simply lost, though a three-second wait would have delivered it.

**Fix:** `retryOnFail: true, maxTries: 3` on the **Slack** calls only. Never on a
model call — a retry there is a second payment.

---

## 7. `Grok kubernetes` wires success and failure to the same node

**Where:** `AI SRE — incident investigation`. `Ask kubernetes` has
`onError: continueErrorOutput`, its error output goes to `Grok kubernetes`, and
**both** of Grok's outputs return to `Collect kubernetes`.

It works — `Collect` reads defensively and yields `reply: null`, and `Record`
then refuses with a correct reason. But "Grok answered" and "Grok failed" are
indistinguishable at the wire level, so no trace can ever say which happened.

**Fix:** split the branches. The fallback is a good pattern and worth keeping;
it just should be observable.

---

## 8. The listener has no tracing at all

No span, no duration, no usage, and `Ask model` / `Post reply` carry no
`onError`. Any failure after the acknowledgement is total silence with no record
anywhere.

**Fix:** the smallest useful version is one row per turn into a data table —
`ts`, `event_id`, `thread_ts`, `ok`, `error`, `duration_ms`. The investigation
workflow already computes most of this; the listener computes none of it.

---

## What is worth keeping exactly as it is

Said because a defect list reads like a verdict otherwise, and this is not one.

- **`redactSecrets` / `redactBlocks`** — a narrow denylist that deliberately does
  not eat bare `token=` or JWTs, because a service-account token is legitimate
  content an operator is asking about. Narrow is why it is safe to map over every
  string in a structure.
- **The `Record *` discipline** — a skip allowed only when the record says the
  slot is empty *and* the context failed for that reason; refusals that re-carry
  `raw_answers`, `usage_by_agent` and `model_by_agent` explicitly rather than
  dropping what was already paid for; and `if (j.state === "refused") return` as
  the first line, so an earlier refusal is never "recovered".
- **Defensive JSON extraction** in every `Collect *` — plain parse, then
  double-encoded, then fenced, then single-key unwrap, then `null`. The
  prd-agent project is copying this into its own parser.
- **The cross-provider fallback** itself. Expensive but real, and the right shape
  for a turn someone is waiting on.
