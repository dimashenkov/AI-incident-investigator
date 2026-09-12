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

## What is NOT built yet

- The real Slack **provider** in code — `src/providers/slack.ts` is still the
  simulated one. Posting a real incident report, and the thread/incident link
  against Slack's own `ts`, is the next code step (concept first).
- **Two-way** receiving (the chat bot): needs Event Subscriptions with a public
  request URL (an n8n webhook) and scopes like `channels:history`. Not started.
- For n8n to post, the token goes into **n8n Credentials**; the env file is for
  local runs and for handing the value to n8n.

## One design note carried from the setup

Slack owns the thread identifier: `chat.postMessage` returns a `ts` we cannot
choose. So the derived `thread-<incident>` id in `src/providers/slack.ts`
becomes a LOCAL key mapping to Slack's real `ts` — the thread↔incident invariant
(dod-5/dod-7) is re-anchored, not dropped, when the real provider lands.
