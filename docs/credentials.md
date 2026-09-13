# n8n Credentials — кой за кой е

n8n съпоставя credential по **id**, не по име — затова това е референцията, а имената
в UI може да са подвеждащи. Обновявай тук, щом добавиш credential.

Инстанция: `https://dimitarshenkov.app.n8n.cloud`. Ключовете **не** влизат тук — само
id, име, тип и предназначение.

| id | име в n8n | тип | за какво | ползва се от |
|---|---|---|---|---|
| `fcCTZNZiEZhLkGHD` | OpenAI account | `openAiApi` | **primary модел** (gpt-5 заключава, gpt-5-mini събира) — **метериран, харчи** | incident workflow (Ask k8s/logs/metrics/root-cause), listener (Ask model) |
| `eOVr6fQ0yzz3yiwO` | Header Auth account | `httpHeaderAuth` (`Authorization: Bearer <slack bot token>`) | **Slack** — постване на доклада и отговорите, четене на нишката | incident workflow (Slack post), listener (Fetch thread, Post reply) |
| `Sreprau5RgIFeMqG` | grok | `httpHeaderAuth` (`Authorization: Bearer <xai key>`) | **fallback модел** (xAI Grok, model `grok-4.3` — $1.25/$2.50 за 1M, най-евтиният чист; id-то се потвърждава на първо живо извикване) — създаден 2026-09-13, **метериран, харчи**; **още не е вързан** (0 ползвания) | — (предстои error-branch) |

**Бележки:**

* Двата „Header Auth" в UI лесно се бъркат: `eOVr6fQ0yzz3yiwO` е **Slack**,
  `Sreprau5RgIFeMqG` е **grok**. Slack-ият още се казва „Header Auth account" (генерично);
  да се преименува на „slack" иска и промяна на `SLACK_CREDENTIAL.name` в
  `scripts/generate-workflow.mjs` + redeploy, иначе drift (n8n пази по id, но
  генерираният JSON носи и името). Затова засега се разчита на този документ.
* Кои харчат: OpenAI и grok са метерирани API ключове. Slack не вика модел — не харчи.
* Константите в кода: `OPENAI_CREDENTIAL`, `SLACK_CREDENTIAL` в
  `scripts/generate-workflow.mjs`; `GROK_CREDENTIAL` ще се добави при error-branch-а.
