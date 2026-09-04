# AI SRE — Kubernetes Incident Debugging System (MVP)

Multi-agent система, която разследва Kubernetes инцидент и обяснява причината.

**Състояние: в разработка, чанк 0.** Още нищо не работи end-to-end.

## Какво прави

```
Fake Datadog alert
  → n8n
  → Kubernetes Agent ─┐
  → Logs Agent       ─┼→ Root Cause Agent → Fake Slack thread → Incident Chat
  → Metrics Agent    ─┘
```

Всичко външно е симулирано: няма реален Datadog, Kubernetes или Slack.
MVP-то е **read-only** — агентите препоръчват действия, не ги изпълняват.

## Къде какво стои

| Папка | Какво |
|---|---|
| `schemas/` | каноничният incident обект и всичко около него, като JSON Schema |
| `scenarios/` | fixture данните на петте сценария |
| `prompts/` | prompt-овете на агентите, version-controlled |
| `src/` | детерминистичното ядро — providers, scoring, correlation |
| `tests/` | сценарийни и integration тестове |
| `workflows/` | export копия на n8n workflow-ите |
| `docs/` | архитектура, incident модел, симулация, n8n, бъдеща production схема |

## Как се работи

`CLAUDE.md` е правилата. `PROGRESS.md` е дневникът — номерът на текущия кръг
се чете оттам, не се помни.

## Тайни

Нищо тайно не влиза в repo-то. n8n ключът стои в `~/.config/ai-sre/n8n.env`
с права `600`. Ключът на модела стои в n8n Credentials.
