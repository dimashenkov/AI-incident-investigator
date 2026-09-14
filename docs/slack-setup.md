# Real Slack — the app, the channel, and where the secret lives

Set up on 2026-09-12 through the browser, so the prototype can post to a real
Slack instead of the simulated `fake-slack` in `src/providers/slack.ts`. Nothing
here is a secret; the one secret (the bot token) is named but not written.

## What exists in Slack

| Thing | Value |
|---|---|
| workspace | `mitko` (team id `TUW1HPATD`) — the owner's own, 1 member |
| app | `incident-investigator`, App ID `A0C16FK1KSP` |
| bot user | `incidentinvestigator` |
| bot scopes | `chat:write`, `chat:write.public` |
| channel | `#incidents`, channel id `C0C1AQLTRM4` (public; the bot is a member) |

`chat:write.public` means the bot may post to any public channel without being
invited first; it was invited to `#incidents` anyway, which the two-way phase
(reading messages) will need.

## Where the secret and the id live

Not in this repo. Both are in `~/.config/ai-sre/n8n.env` (mode 600, gitignored,
outside the tree — the same store the n8n API creds use):

| Key | What |
|---|---|
| `SLACK_BOT_TOKEN` | the `xoxb-…` bot token — **never** committed or echoed |
| `SLACK_INCIDENTS_CHANNEL` | `C0C1AQLTRM4` |

Verified working on 2026-09-12 with `auth.test` (a read, not a message):
`ok:true, team:mitko, user:incidentinvestigator`.

## What is built (2026-09-12)

- The generated workflow POSTS the incident report to the real `#incidents`:
  Report → Slack gate → Slack lookup (`rowNotExists`) → Slack post
  (`chat.postMessage`) → Slack took → Slack ok → Slack record. Deduped by
  `incident_id` for the SEQUENTIAL retry; the concurrent race is the recorded
  SKIP-Redis limitation. Proven live in a scratch workflow before generation.
- The post is **Block Kit formatted** (`slackReport` in `src/core/thread.ts`,
  approved 2026-09-12): a header `🚨 <id> — <service>`, a context line
  `☸️ cluster · 🌐 namespace · 🧫 pod`, the agent thread lines with per-agent
  emoji, a divider, `🎯 Root cause: <CODE>`, and a confidence context line. The
  failing pod is chosen deterministically (a container not `ready` or with a
  `terminated` last state), never by the model. `slackReport` reads only this
  incident's own curated fields — cluster, namespace, the pod NAME, the thread —
  and never the observation blob, so the formatted message leaks no more than the
  plain thread did. The `blocks` are sent with the plain thread as the `text`
  fallback.
- **Credential** (created by the owner — entering a token is prohibited for the
  agent): a generic **Header Auth** `Authorization: Bearer <bot token>`, id
  `eOVr6fQ0yzz3yiwO`, name `Header Auth account`. The workflow references it by
  id+name; the token is never in the repo. NB: the HTTP node uses
  `authentication: genericCredentialType`, not `predefinedCredentialType` (the
  latter silently sent no header → `not_authed`).
- **Data table** `incident_threads` (id `HXGSOCOFnTmnAZtJ`, columns `incident_id`,
  `ts`) holds the mapping.

## What is NOT built yet

- One **live end-to-end run** (a model call → real report → `#incidents`) — it
  spends and waits for the owner's word. The chain itself is proven.
- **Langfuse traces**: the model field is captured (Collect); span timing + the
  Langfuse POST remain.

## Two-way receiving — the plumbing is live (2026-09-12)

Event Subscriptions are configured and verified. What was done, in order:

- **Socket Mode was ON and had to go OFF.** Socket Mode routes events over a
  WebSocket and disables the Request URL; an n8n HTTP webhook needs it off. The
  toggle is under Socket Mode in the app settings.
- **The listener workflow `slack-listener` (id `oMRowrkAwtnjTVIC`) was activated.**
  A production webhook (`/webhook/<path>`, not `/webhook-test/`) only answers when
  the workflow is ACTIVE. It was `active:false`; activated via the n8n API.
- **Request URL** = `https://dimitarshenkov.app.n8n.cloud/webhook/slack-events`,
  Verified. The Handle node echoes the `url_verification` challenge; probed with a
  direct curl before pasting, then Slack verified it (2 successful listener
  executions recorded).
- **Bot event** `message.channels` subscribed → Slack auto-added the
  **`channels:history`** scope.
- **App reinstalled** (owner asked; the OAuth Allow screen requested
  `chat:write, chat:write.public, channels:history`). Reinstall did NOT rotate the
  bot token — `auth.test` still `ok:true`, and `conversations.history` on
  `#incidents` returns `ok:true`, proving the new scope is granted. The posting
  credential `eOVr6fQ0yzz3yiwO` is untouched.

Bot user id (anti-loop): `U0C1ELPQCGH`. The Handle node drops anything with a
`bot_id`, from the bot user, or carrying a subtype — so the bot cannot answer
itself.

The reply brick is BUILT (2026-09-12), in the repo, reviewed and tested:

- **Logic** in `src/core/reply.ts` (pure, tested, mutation-covered): classify the
  event, gate (only a real, non-bot, threaded question with a channel), pull the
  report from `conversations.replies`, build the model messages, extract the
  answer.
- **Workflow** generated by `scripts/generate-listener.mjs` into
  `workflows/slack-listener.json`: Webhook(responseNode) → Handle → Is challenge
  (echo / ACK 200) → Should reply → **Seen event (dedup on `event_id`)** → Mark
  seen → Fetch thread → Build ask → Has report → **Ask model (gpt-5, SPENDS)** →
  Build reply → Has answer → Post reply (in the thread).
- **Duplicate delivery**: the `event_id` dedup (dataTable `listener_seen_events`,
  id `uBZvrUFgQcderwqF`, rowNotExists) drops a re-delivered event before the model
  — closing the SEQUENTIAL retry double-spend. The CONCURRENT case stays a stated
  limitation (same as SKIP-Redis: n8n runs webhooks in parallel, no atomic
  insert-if-absent). Grok found the earlier "ACK = dedup" claim false; fixed.

What is NOT done on the two-way side:

- **Deploy + go-live**: updating the live listener `oMRowrkAwtnjTVIC` to this
  reply version and activating it ARMS a model call per threaded question — so it
  waits for the owner's word (`harchi`). Until then the live listener is the
  receiving-only version (no model).
- **One live round-trip** of an actual answer, once armed.

## One design note carried from the setup

Slack owns the thread identifier: `chat.postMessage` returns a `ts` we cannot
choose. So the derived `thread-<incident>` id in `src/providers/slack.ts`
becomes a LOCAL key mapping to Slack's real `ts` — the thread↔incident invariant
(dod-5/dod-7) is re-anchored, not dropped, when the real provider lands.
