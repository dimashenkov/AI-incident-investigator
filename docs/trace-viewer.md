# The trace viewer — local, read-only

A local web view of the incident runs, written here instead of running Langfuse
(owner, 2026-09-12; Grok reviewed the shape the same day). One n8n execution is
one RUN — a node pipeline, not a Langfuse-shaped trace — so the viewer renders the
execution node-by-node and never invents a join the data does not have.

## Run it

```bash
set -a; . ~/.config/ai-sre/n8n.env; set +a
node scripts/trace-viewer.mjs        # http://127.0.0.1:7333
```

`N8N_WORKFLOW_ID` (the incident workflow) selects which runs are listed. Ctrl-C to
stop.

## What it is

- **Source:** the n8n incident executions, read through the existing helpers
  (`recentExecutions`, `executionWithData` in `collect-execution.mjs`) — no second
  path to the API, no new store.
- **Backend** (`scripts/trace-viewer.mjs`): Node, two GETs only —
  `/api/runs` (list) and `/api/runs/:id` (one execution's data). Binds `127.0.0.1`
  only; the `N8N_API_KEY` stays server-side; nothing is written to disk.
- **Frontend** (`public/trace-viewer.html`): plain HTML/CSS/JS. The conversation
  (thread), then the run timeline node-by-node — each node expandable to its full
  recorded JSON (args on the input nodes, results on Collect, latency from the
  node's `executionTime`), agent calls badged, failures in red, and a raw
  execution-JSON toggle. Missing values stay missing.

## The rules it keeps (Grok, 2026-09-12)

- **No annotations, no database, no cache** — the spec's "do NOT". It only reads.
- **The submission token is stripped** — execution data carries
  `x-submission-token` in the webhook headers; `stripToken` redacts it before the
  page sees it (tested in `tests/trace-viewer.test.ts`).
- **Only the incident workflow's runs** are listed, never the `slack-listener`.
- It does NOT reuse `documentFrom` (Report-only, blank on failed runs); it reads
  the whole `runData`, so the runs you most want to scan — the failures — are the
  ones it shows in full.

## What it already caught

On its first run it surfaced a real bug: `datadogMockRecord` read the alert from
`incident.alert`, but the alert lives at `incident.source.alert` — so every
severity silently defaulted to SEV-3. Fixed, with a test and a mutation.
