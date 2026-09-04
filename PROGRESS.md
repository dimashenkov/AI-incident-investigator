# Дневник на кръговете

Един ред на кръг. **Номерът на кръга се чете оттук, не се помни.**

Кръг = построй → тест, който пада без поправката → acceptance gate → Codex → commit.
Чанкът се затваря, когато acceptance gate-ът мине И Codex каже „proceed".

| Чанк | Кръг | Какво се построи | Тест | Acceptance | Codex | Commit |
|---|---|---|---|---|---|---|
| план | 1 | планът и работният процес | — | — | **6 дефекта** | — |
| 0 | 1 | структура, incident.schema.json | *(предстои)* | — | — | — |

---

## Отсъдите, дословно

Подканите и суровите отговори на Codex **не влизат в repo-то** (CLAUDE.md §6).
Съдържанието им влиза тук като изречение, с датата.

### План · кръг 1 · 2026-09-04 · Codex gpt-5.6-sol · 6 094 токена

Заглавието на отсъдата: **„There are material defects. Do not proceed unchanged."**

| # | Възражението, дословно | Прието? | Какво стана |
|---|---|---|---|
| 1 | „Option C is not yet one source of truth… n8n Cloud becomes a mutable competing source as soon as UI edits are allowed." | да | добавя се **drift detection**: export на deployed workflow, нормализация, сравнение с генерирания. Несъответствие = провал, не предупреждение. |
| 2 | „The chunk-2 isolation test proves only the index's behavior… Model-output assertions alone are insufficient because a model may ignore leaked data." | да | unit тестът остава; добавя се **черна кутия в чанк 5**, която проверява *сглобения context*, не само отговора. |
| 3 | „Credentials should validate—not first reveal—the architecture." | да | **n8n spike без credentials** преди чанк 1: node типове, JS runtime в Code node, лимити, формат на import/export. Непроверените допускания се маркират като такива. |
| 4 | „The cycle's closing condition is circular… A reviewer's silence is not proof." | да | цикълът получава **пета станция — acceptance gate**, отделна от прегледа: декларираните проверки се пускат, командите и резултатите се записват, включително „не можах да установя". |
| 5 | „Pure local Python is unreachable from n8n Cloud without hosting, so Option C currently lacks an execution model." | да | **обръща се решението за език: TypeScript, не Python.** Логиката е един пакет, изпълняван локално с node и в n8n Code node. Проверено срещу фактите: n8n Cloud върви в облака, локален Python му е недостижим. |
| 6 | Десет неща в Definition of Done, които описаните тестове не покриват. | да | влизат дословно като списък в `incident-testing` skill-а. |

**Точка 6 — десетте непокрити неща, дословно:**

1. Every intermediate object validates against the canonical schema.
2. All five scenarios and `INSUFFICIENT_EVIDENCE`.
3. Confidence reduction under conflicting evidence.
4. `risk` and `requires_approval`.
5. Exact one-to-one thread/incident invariants, including unknown and duplicate thread IDs.
6. No cross-incident data in assembled prompts.
7. The created Slack thread is durably linked, not merely returned.
8. Provider substitutability.
9. Read-only/no-remediation behavior.
10. The deployed workflow — not merely local code — produces the required result.

**Какво нищо не проверява още:** че тези шест поправки наистина са влезли. Това
е дефектът от точка 4, приложен към самата поправка. Чанк 0 го затваря с
acceptance gate, който чете този файл.
