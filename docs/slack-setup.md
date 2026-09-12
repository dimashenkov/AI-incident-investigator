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
- **Two-way** receiving (the chat bot): needs Event Subscriptions with a public
  request URL (an n8n webhook) and scopes like `channels:history`. Not started.
- **Langfuse traces**: the model field is captured (Collect); span timing + the
  Langfuse POST remain.

## One design note carried from the setup

Slack owns the thread identifier: `chat.postMessage` returns a `ts` we cannot
choose. So the derived `thread-<incident>` id in `src/providers/slack.ts`
becomes a LOCAL key mapping to Slack's real `ts` — the thread↔incident invariant
(dod-5/dod-7) is re-anchored, not dropped, when the real provider lands.
