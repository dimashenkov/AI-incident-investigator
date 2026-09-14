# n8n Credentials — which is for which

n8n matches a credential by **id**, not by name — so this is the reference, and the names
in the UI may be misleading. Update here as soon as you add a credential.

Instance: `https://dimitarshenkov.app.n8n.cloud`. The keys do **not** go here — only
id, name, type, and purpose.

| id | name in n8n | type | for what | used by |
|---|---|---|---|---|
| `fcCTZNZiEZhLkGHD` | OpenAI account | `openAiApi` | **primary model** (gpt-5 concludes, gpt-5-mini gathers) — **metered, spends** | incident workflow (Ask k8s/logs/metrics/root-cause), listener (Ask model) |
| `eOVr6fQ0yzz3yiwO` | Header Auth account | `httpHeaderAuth` (`Authorization: Bearer <slack bot token>`) | **Slack** — posting the report and the replies, reading the thread | incident workflow (Slack post), listener (Fetch thread, Post reply) |
| `Sreprau5RgIFeMqG` | grok | `httpHeaderAuth` (`Authorization: Bearer <xai key>`) | **fallback model** (xAI Grok, model `grok-4.3` — $1.25/$2.50 per 1M, the cheapest clean one; the id is confirmed on the first live call) — created 2026-09-13, **metered, spends**; **not yet wired** (0 uses) | — (error-branch pending) |

**Notes:**

* The two "Header Auth" in the UI are easily confused: `eOVr6fQ0yzz3yiwO` is **Slack**,
  `Sreprau5RgIFeMqG` is **grok**. The Slack one is still called "Header Auth account" (generic);
  renaming it to "slack" also requires a change to `SLACK_CREDENTIAL.name` in
  `scripts/generate-workflow.mjs` + redeploy, otherwise drift (n8n keeps by id, but
  the generated JSON also carries the name). So for now this document is relied on.
* Which spend: OpenAI and grok are metered API keys. Slack does not call a model — it does not spend.
* The constants in the code: `OPENAI_CREDENTIAL`, `SLACK_CREDENTIAL` in
  `scripts/generate-workflow.mjs`; `GROK_CREDENTIAL` will be added with the error-branch.
