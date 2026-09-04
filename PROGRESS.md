# Дневник на кръговете

Един ред на кръг. **Номерът на кръга се чете оттук, не се помни.**

Кръг = построй → тест, който пада без поправката → acceptance gate → Codex → commit.
Chunk-ът се затваря, когато acceptance gate-ът мине И Codex каже „proceed".

| Chunk | Кръг | Какво се построи | Тест | Acceptance | Codex | Commit |
|---|---|---|---|---|---|---|
| план | 1 | планът и работният процес | — | — | **6 дефекта** | — |
| 0 | 1 | 4 схеми, validate.ts, acceptance gate | 43/43 ✓ | PASS · exit 0 (4 проверки) | **6 дефекта · do not commit** | — |
| 0 | 2 | 6-те поправки, recursion guard | 53/53 ✓ | exit 2 · 5 проверки | **5 дефекта · do not commit** | — |
| 0 | 3 | LIMITATIONS/DEBT, porcelain парсър, `-uall` | 63/63 ✓ | PASS · exit 0 · 5 проверки | **2 дефекта · do not commit** | — |
| 0 | 4 | мутационна проверка, `mutations.mjs` | 69/69 ✓ | PASS · exit 0 · 6 проверки | — | — |
| 0 | 5 | стягане на 4-те схеми + cross-field инварианти | 83/83 ✓ | PASS · exit 0 | **1 дефект · block commit** | — |
| 0 | 6 | един носител на state-changing типовете | 102/102 ✓ | PASS · exit 0 | **1 дефект · block commit** | — |
| 0 | 7 | композиран type enum, 0 дублирани enum-а | 104/104 ✓ | PASS · exit 0 | **1 дефект · block commit** | — |
| 0 | 8 | `common.schema.json`, `refs.test.ts`, 5-а мутация | 111/111 ✓ | PASS · exit 0 | **2 дефекта · block** | — |
| 0 | 9 | allowlist вместо забрана, percent-decode | 112/112 ✓ | PASS · exit 0 | **1 дефект · block** | — |
| 0 | 10 | `readFreshReport`, `.gitignore` дупка | 116/116 ✓ | PASS · exit 0 | **1 дефект · block** | — |
| 0 | 11 | по две имена на запис, истински glob | 118/118 ✓ | PASS · exit 0 | **1 дефект · block** | — |
| 0 | 12 | тестът пита своя образец, не който и да е | 118/118 ✓ | PASS · exit 0 | **1 дефект · block** | — |
| 0 | 13 | и двете посоки на доказателството | 124/124 ✓ | PASS · exit 0 | — | — |
| 0 | 14 | 5 находки от втори субагент | 126/126 ✓ | PASS · exit 0 | **commit** | — |
| spike | 1 | n8n Code node — какво наистина може | 2 изпълнения на живо · workflow изтрит | — | **commit** | ✅ c9fce55 |
| 1 | 1 | част 1: сглобяване · `build-core.mjs` | 138/138 ✓ | exit 2 | **3 дефекта · do not commit** | — |
| 1 | 2 | част 2: генератор · `generate-workflow.mjs` | 154/154 ✓ | exit 2 | **1 блокиращ · do not commit** | — |
| 1 | 3 | сглобяване в паметта, поведенчески тестове | **161/161 ✓** · 10 мутации | **exit 2** · 7 проверки | **commit** | ✅ |
| spike | 2 | ajv standalone в Code node | **16/16 съвпадение върху избраните fixtures** + 1 изпълнение | — | *(предстои)* | *(предстои)* |
| 0 | 15 | `minProperties` на наблюденията | **128/128 ✓** · `tsc` 0 грешки | **PASS · exit 0** · 6 проверки · 8 мутации | **commit** | ✅ |

---

### Състоянието на диска · 2026-09-04 · chunk 0 затворен

| Какво | Число |
|---|---|
| `schemas/` | 5 файла · 0 дублирани enum-а |
| `src/schema/validate.ts` | схема + инварианти, които слизат във вградените документи |
| `scripts/acceptance-gate.mjs` | 6 проверки · четири изходни кода |
| `scripts/mutations.mjs` | 8 записани дефекта, всеки с теста си |
| тестове | **128 минават**, 4 файла |
| `npx tsc --noEmit` | 0 грешки |
| `node scripts/acceptance-gate.mjs` | **PASS · exit 0** |
| Codex | **commit**, на 12-и и потвърдено на 14-и кръг |

**Какво излезе за деня:** 15 кръга, 13 от които намериха дефект. Общо **32
находки** — 24 от Codex, 16 от два субагента, 5 намерени от мен, и няколко
извадени от самите поправки в момента на писането им. Нула фалшиви от субагентите.

**Дефектът, който се повтори осем пъти:** правило върху категория, приложено или
тествано само върху част от нея. Изходът беше един и същ всеки път — един
носител, откриване вместо изброяване, allowlist вместо забрана, и въпросът
„коя посока на твърдението всъщност ми трябва".

**Следва:** chunk 1. В `DEBT` чакат drift detection и формата на наблюденията,
и двете с падеж chunk 1 — от следващия chunk нататък gate-ът ще излиза 2, докато
не бъдат написани.

---

## Chunk 1 — обхватът, отсъден на 2026-09-04

Концепцията беше дадена на Codex преди да се пише код. Той поправи три неща и
поправките са приети.

### Частите

```
   schemas/ + src/                    източникът на истината
        │
        │  1. СГЛОБЯВАНЕ
        ▼
   out/core.js                        126 KB, нула зависимости
        │
        │  2. ГЕНЕРИРАНЕ
        ▼
   workflows/incident.json            производен артефакт, влиза в git
        │
        │  качва се в n8n
        ▼
   deployed workflow  ─── 3. DRIFT ──▶ различно = провал
        ▲
        │  4. ПРОВАЙДЪРИ (стеснени)
   scenarios/ fixture данни
```

| Част | Какво прави |
|---|---|
| 1. сглобяване | схеми + ядро → един самодостатъчен JS файл |
| 2. генериране | артефактът → workflow JSON |
| 3. drift | export → нормализация → сравнение; разлика е провал, не предупреждение |
| 4. провайдъри | **стеснено**: по една fake реализация, fixture-и от сценарии, изрични схеми за трите observation слота |

### Трите поправки на Codex

| Предложих | Отсъдата, дословно |
|---|---|
| част 4 → отделен chunk | *„Keep part 4 in chunk 1, but narrow it to the minimum contract-closing slice… Moving all of part 4 would leave due chunk-1 debt unresolved and make the chunk boundary contradict the recorded commitment."* |
| workflow JSON е източникът на истината | *„The checked-in workflow cannot itself be the single source of truth. The generator, schemas, deterministic core, and workflow template are authoritative; the workflow JSON is a reproducible derived artifact."* |
| gate прави drift при всяко пускане | *„The gate should establish locally… generated workflow and a saved normalized deployment export compare equal… A fresh live check is required for release or intentional deployment changes, not every test run."* |

### Какво затваря chunk 1

`gate exit 0` **и** една записана безплатна жива проверка. Gate-ът установява
локално:

* пресглобяването не дава разлика;
* точно една замяна на `ucs2length` и нула останали `require`;
* диференциалните тестове между локалния и генерирания validator минават;
* изходът на всеки fake провайдър минава срещу схемата на своя слот;
* генерираният workflow и **записан нормализиран export** съвпадат.

Живата проверка — качване, изпълнение на сценарий само от fixture-и, повторен
export, доказано съвпадение след нормализация — се прави при release или нарочна
промяна на deployment-а, **не** при всяко пускане. Записът ѝ прави обикновените
проверки възпроизводими локално.

### Къде се чупи първо

**Drift detection.** *„'Normalize instance-specific IDs and credential
references' is exactly a rule over a category likely to be enforced through a
partial list. A newly introduced ID-bearing field, nested credential reference,
node metadata field, or order-sensitive array will create either false drift
or—worse—erase meaningful drift."*

Оттам две изисквания:

* нормализацията е **structural path-based allowlist**; непозната разлика е
  провал, не мълчание;
* credential референции **не се махат изцяло** — нормализира се само
  непрозрачното id, а типът, наличието и мястото се сравняват.

**Второ по риск: част 4.** Схема, изведена само от днешните fixture-и, твърди
„формата на провайдъра", покривайки извадката. Наричат се **fixture договори**,
докато не са установени истинските варианти на отговорите.

### Записана несигурност

Codex: *„I am uncertain whether n8n import/export itself consumes a relevant
quota; the spikes establish execution cost, not that administrative API
operations are free."* Не се предполага, че е безплатно.

---

## Отсъдите, дословно

Подканите и суровите отговори на Codex **не влизат в repo-то** (CLAUDE.md §6).
Съдържанието им влиза тук като изречение, с датата.

### Spike · n8n Code node · 2026-09-04 · 2 изпълнения на живо

Пълните находки: `docs/n8n-spike.md`. Тук е само какво промени в решенията.

**Три допускания паднаха:**

| Допускане | Какво излезе |
|---|---|
| „Python е недостижим от n8n Cloud" — основанието за избора на TypeScript | **невярно**: Code node v2 предлага `pythonNative`. Решението стои, но защото ядрото не се внася през **пробваните JavaScript механизми**, а JavaScript е родният runtime. Python import **не е пробван**. Основанието е поправено в `CLAUDE.md` §13 и в отсъда 5 по-долу. |
| „модули не могат да се зареждат" | **непълно**: `require` съществува и работи, но през **allowlist**. От 19 пробвани имена минаха две — `crypto` и `moment`; останалите връщат `Module 'X' is disallowed`. Колко общо са позволени **не е установено**. |
| „логиката е един пакет, изпълняван и локално, и в Code node" | **не се получи през пробваните механизми** — име на пакет през `require`. Път, относителен или абсолютен, не е пробван. Един източник на истината, но артефактът е **генериран inline код**. |

**Най-скъпата находка: `ajv` е забранен.** Validator-ът на chunk 0 стъпва на
него и не може да бъде внесен в Code node.

Изходът е **един**, не два, и Codex посочи защо: ръчно писан validator е едно
правило на две места, а това вече е забранено от записано решение („един
validator, не два"). Следващият spike проверява **ajv standalone** — предварително
компилиран чист JavaScript без зависимости. Провал там не прави ръчния вариант
равностоен, а принуждава преразглеждане на записано решение.

**Какво остана неустановено, нарочно:** памет, размер на payload, timeout.
Отсъдата на Codex беше изрична: едно успешно изпълнение не може да ги установи, а
нарочен провал би изхабил единственото измерване. Записани са като
`could-not-establish`, не като предположени числа.

**Цена:** 2 изпълнения от квотата на плана. Workflow-ът беше активен около една
минута с webhook на случаен път, после деактивиран и изтрит; инстанцията е
проверена и е празна.

### Chunk 1 · части 1–2 · 2026-09-04 · Codex, 3 кръга

**Кръг 1 — три дефекта.** Най-важният има последица, която не бях видял:

*„`buildCore()` runs during module collection. If it throws, no `it(...)` cases
are registered… the mutation gate cannot prove its required named test caught the
defect; `namedTestFailed()` sees no assertion and calls the mutation 'survived'."*

Тоест счупен build не просто скриваше кой инвариант е паднал — караше
мутационната машинария да **докладва обратното на истината**. Сега build-ът се
вика лениво, вътре в тестовете, и провалът е именуван тест.

Другите две: броят на замените доказва само че търсеният низ се е срещнал N пъти
— грешен модул или обвивка дават същия брой; и „нула `require`" твърдеше повече,
отколкото regex-ът проверява.

**Проверката за `require` веднага произведе фалшив положителен.** Разширих я до
всяко споменаване на думата, и build-ът отказа добър артефакт — защото описание
на схема в това repo съдържа английската дума „require" в изречение. Стеснена до
синтаксис на извикване: дума, следвана от отваряща скоба, каквото и да стои
между тях. Тестове покриват интервал, коментар и template literal, и че думата в
изречение **не** пали.

**Кръг 2 — блокиращ дефект в част 2.**

*„`generate()` reads the existing `out/core.js` without rebuilding it. The
comparison test therefore proves only: committed workflow == workflow generated
from whatever core happens to be in `out/`. A schema change can leave both the
committed workflow and `out/core.js` stale, and the test still passes."*

Плюс: gate-ът пускаше тестовете **преди** build-а, тоест можеше да провери стария
workflow и после да обнови артефакта.

Поправено в корена: `generate()` сглобява **в паметта**, така че между
източника и workflow-а няма файл, който да остарее. Редът в gate-а също е
обърнат — сглобяване, после тестове.

**И вторият му отговор беше дефект.** `$input.first().json.body` хвърля при нула
елемента и **мълчаливо изхвърля всички след първия**, в нод, настроен да работи
върху *всички* елементи. Сега нодът обхожда всички, връща по един резултат с
индекс, а празен вход дава празен изход — празно пускане не е нито грешка, нито
успех.

**Най-полезната му забележка беше за тестовете:** *„tests assert code substrings
and static shape, not executable zero/multi-item behavior"*. Тест, който чете
код, не е тест, който го пуска. Сега `runNode` изпълнява генерирания нод с
подставен `$input`, и шест теста проверяват поведение: по един резултат на
елемент, празен вход, непозната схема, липсващо тяло, пренесени грешки, и че
един провалил се елемент не скрива останалите.

**Кръг 3: commit.**

### Spike 2 · ajv standalone · 2026-09-04 · 1 изпълнение

Пълните находки: `docs/n8n-spike.md` §6–10. **Работи.**

Въпросът беше дали validator-ът на chunk 0 може да стигне до Code node, след като
`require('ajv')` е disallowed. Може — предварително компилиран.

| Стъпка | Останали `require` |
|---|---|
| `standaloneCode` както е | 2 |
| само `date-time` като regex вместо целия `ajv-formats` | 1 |
| `ucs2length` вграден на ръка — 808 байта | **0** |

126 809 байта самостоятелен JavaScript, нула зависимости.

**Съвпадението е проверено преди пускането:** генерираният артефакт срещу живия
ajv, шестнайсет обекта, по четирите схеми — съвпадат по всичките шестнайсет.
Това е **проба за дим, не доказателство за еднакво поведение**: шестнайсет обекта
установяват съгласие върху шестнайсет обекта.

**В Code node:** 126 KB минават, и четирите validator-а работят, пробваните
откази са верни, а съобщенията за грешка при тях съвпадат с ajv. Най-важното — **cross-file препратката
към `common.schema.json` действа**, макар в нода да няма файлова система:
компилацията я е вградила.

**Отпада отвореният въпрос от spike 1.** Пътят е един и е проверен; ръчно писан
validator не се обсъжда, защото решението „един validator, не два" не е било
поставяно под съмнение.

**Дефект, намерен при самата проверка.** За да отпадне `ajv-formats`, бях
регистрирал `date-time` като свой regex. Сравнен с `ajv-formats` върху двайсет
низа: **седем се разминават, в двете посоки** — моят приема месец 13, 30
февруари, 31 септември, час 25 и минута 60; отказва интервал вместо `T` и
отместване без двоеточие. Deployed validator-ът щеше да приема дати, които
локалният отказва.

**Изискване към chunk 1:** форматът се дефинира на едно място и се ползва и от
двете страни. Свой regex не се пише. В repo-то днес дефект няма — `validate.ts`
ползва `addFormats`, а regex-ът живя само в spike скрипта, който е изтрит.

**Второ изискване към chunk 1: вграждането на `ucs2length` е текстова замяна и
може да се счупи тихо при обновяване на ajv.** Генераторът настоява за точно една
замяна и нула останали `require`, плюс диференциални тестове върху Unicode
дължини и границите на `date-time`. Иначе „вградих го" е поредното твърдение,
което нищо не проверява.

**Неизмерено:** къде е таванът за размер на `jsCode` (126 KB минават, границата
не е търсена) и колко струва компилацията при всяко изпълнение.

### Chunk 0 · кръг 14 · 2026-09-04 · Codex gpt-5.6-sol · 15 170 токена

*„I see no commit-blocking error. The schema change correctly rejects `{}` while
preserving `null` and populated objects, and the debt wording now matches the
remaining work. **Commit.**"*

Отбелязано ограничение, което той сам казва: *„My local rerun was prevented by
the read-only sandbox, not by the repository."* Всичките четиринайсет кръга бяха
статичен преглед — Codex нито веднъж не можа да пусне тестовете. Пусканията са
мои и са записани тук с числата си.

**Chunk 0 е затворен.** Acceptance gate: exit 0. Codex: commit.

### Chunk 0 · кръг 12 · 2026-09-04 · Codex gpt-5.6-sol · 40 920 токена

Дословно: *„No commit-blocking defect found in the uncommitted chunk. The
accepted fixes correctly cover the reported holes, including embedded agent
invariants and both evidence-reference fields. **Commit.**"*

Първият кръг за деня, който не намери нищо — на дванайсети опит.

### Chunk 0 · кръг 13 · 2026-09-04 · Codex gpt-5.6-sol · 12 251 токена

Не се записа веднага. Докато кръг 12 четеше, беше добавен ред в `DEBT`, а
правилото е, че нищо не се записва, което прегледът не е видял. Кръгът беше
кратък и само за тази промяна.

Отсъдата отхвърли собственото ми решение: *„Yes—the specific `{}` loophole should
be fixed now with `minProperties: 1`; that does not require knowing
provider-specific fields. Full observation shapes can remain chunk-1 debt."*

Бях записал целия въпрос като дълг, защото формата на наблюденията зависи от
провайдъри, които още ги няма. Вярно е за формата, но не и за празния обект:
`{}` казва „събрах, и ето какво намерих", носейки точно това, което `null` вече
казва честно. Отказът на празното не иска да знае какво връща провайдърът.

Затворено веднага с `minProperties: 1`; дългът се сви до пълната форма.

### Chunk 0 · кръг 11 · 2026-09-04 · Codex gpt-5.6-sol · 37 092 токена

**„Block the commit."** Поправката от кръг 5 покриваше едната посока.

Дословно: *„`agent-result.schema.json` accepts arbitrary or empty
`contradicted_by` references. The validator verifies every `supported_by` value
against `findings[].source_ref`, but never verifies `contradicted_by`, whose
items also lack `minLength: 1`. … the schema explicitly represents contradictions
as evidence references, yet currently validates contradiction 'evidence' that
does not exist."*

Проверявах доказателството **в подкрепа** и не проверявах доказателството
**против**. Хипотеза можеше да бъде отслабена от противоречие, което никой не е
докладвал. Сега двете полета минават през един списък, не през два кода.

### Chunk 0 · кръг 14 · 2026-09-04 · втори субагент, враждебен мандат

Мандатът беше **един клас**: „проверка, която отговаря на по-тесен въпрос от
този, който името ѝ обещава" — класът, който този ден произведе осем пъти.
Пет находки, всичките верни.

| # | Какво минаваше | Поправка |
|---|---|---|
| 1 | **инвариантите се прилагаха само върху вградения `conversation`.** Agent result, невалиден сам, ставаше валиден в `analysis.agents[]` — точно разцеплението „минава тук, пада там", което този файл започва с обещание да предотврати | инвариантите слизат във вградените документи · **потвърдено с пускане, преди поправка** |
| 2 | `refs.test.ts` строеше списъка с регистрирани схеми **от папката**, а validator-ът има ръчен списък с import-и. Нов файл, рефериран и незаписан, минаваше | тестът внася `REGISTERED_IDS` от validator-а; нов тест иска папката и validator-ът да описват едно и също, **в двете посоки** |
| 3 | `node a.mjs && node missing.mjs` отчиташе „всички скриптове сочат съществуващи файлове", след като е погледнал един | съставна команда е **неизследвана**, не наполовина изследвана |
| 4 | тестът за образците доказваше „обявеното се хваща"; нужната посока е **обратната** — разширяване на израза до `id_(rsa\|dsa\|ed25519)` оставаше незабелязано | тестът чете буквалните алтернативи от израза и иска всяко име, което може да изпише, да е обявено · **проверено чрез разширяване: пада** |
| 5 | проверката „мутацията сочи съществуващ тест" търсеше в целия изходен текст, тоест фраза, оцеляла в **коментар**, я удовлетворяваше | търси се буквалният аргумент на `it()` |

Находка 1 е най-тежката: `validate.ts` **отваря** с изречението, че „valid"
трябва да значи едно и също в тест и в production, и точно това не правеше.

### Chunk 0 · кръг 10 · 2026-09-04 · Codex gpt-5.6-sol · 21 360 токена

**„Block."** Тестът, писан срещу дефекта от кръг 9, питаше по-широк въпрос от
името си.

Дословно: *„The 'own pattern' test does not test the entry's `re`; it calls
`findSecretShaped()`, which succeeds if **any other entry** matches the name.
Thus a filename can be declared under the wrong entry—with unrelated
`ignoreLines`—and all three pairing tests still pass."*

Тестът се казваше „този запис хваща имената, които обявява", а питаше „някой
запис хваща ли ги". Име, заведено под грешен запис, наследяваше чужди редове от
`.gitignore` и трите теста оставаха зелени.

Сега твърдението е за собствения образец; твърдението за целия набор остана
отделно, защото и то е част от обещаното.

**Проверено, не предположено:** преместих име в грешен запис и **два** теста
паднаха, като посочиха точно кой запис е сгрешен. Върнато с обратна редакция.

### Chunk 0 · кръг 9 · 2026-09-04 · Codex gpt-5.6-sol · 27 260 токена

**„Block the commit."** Поправката от кръг 8 съдържаше същия дефект.

Дословно: *„`SECRET_SHAPED` combines `id_rsa` and `id_ed25519` in one regex but
declares only `id_ed25519` as its `ignoreLine`. The counterpart test therefore
still passes if the `id_rsa` line is removed from `.gitignore`, recreating the
exact SSH-key exposure this change claims to prevent."*

Един израз хващаше две имена и **отговаряше за едното**. Тестът, писан точно
срещу тази дупка, я оставяше отворена наполовина.

Взета е втората възможност, която самият той предложи: всеки запис изброява
**всички** имена, които хваща, и **всички** редове, които трябва да ги пазят.
Три теста обхождат двата списъка — че всяко име наистина се хваща, че всеки ред
съществува в `.gitignore`, и че всяко име е покрито от ред на своя запис. Седма
мутация трие реда `id_rsa` и иска тестът да падне.

**Още един от същия вид, изваден от писането на теста.** Първото сравнение на
glob-ове гледаше само начало и край и отсече, че `*credentials*.json` не покрива
`n8n-credentials.json` — звезда в средата беше невидима за него. Отговаряше на
по-тесен въпрос от зададения, тихо. Сега преводът на glob е истински.

### Chunk 0 · кръг 8 · 2026-09-04 · Codex gpt-5.6-sol · 30 169 токена

**„Block."** Една находка, за свежестта на артефакта.

Дословно: *„The mutation gate reuses `out/mutation-report.json` without deleting
it before each Vitest run. If Vitest starts but fails before writing a new
report, the gate can read a stale report from an earlier run and falsely declare
the mutation caught. `r.ran` only proves the process produced an exit code; it
does not prove the report is fresh."*

Изречението, което си заслужава да се запомни: **изходният код доказва, че
процесът е свършил, не че файлът е нов.** Мутация щеше да се обяви за хваната по
доказателство от друго пускане.

Поправено **в корена, не на мястото**: изтриването и четенето станаха една
функция `readFreshReport`, през която минават и двете проверки — тестовата и
мутационната. Така изтриването не може да е налице на едното място и да липсва
на другото. Три теста, единият възпроизвежда точно описания провал.

**Намерено паралелно, докато Codex четеше — и то намери истинска дупка.** Списъкът
с „файлове с форма на ключ" в gate-а и `.gitignore` са два носителя на една
идея. Не могат да се слеят — git чете единия, gate-ът другия, и отговарят на
различни въпроси — затова всеки образец сега носи реда от `.gitignore`, който му
съответства, и тест иска съответствието да съществува.

**Тестът падна на първото пускане.** `.gitignore` нямаше ред нито за `id_rsa`,
нито за `id_ed25519`: частен SSH ключ, оставен в дървото, не беше игнориран от
нищо. Добавени.

### Chunk 0 · кръг 7 · 2026-09-04 · Codex gpt-5.6-sol · 25 340 токена

**„Block."** Две находки, и първата е пак същият клас.

| # | Възражението, дословно | Какво стана |
|---|---|---|
| 1 | „`refs.test.ts` does not enforce its stated invariant… It checks only top-level `type` and `properties`. Adding any other assertion—such as `const`, `enum`, `required`, `allOf`, `not`, or even `false` as the schema—would make common validate data while this test still passes." | тестът **забраняваше по име**, тоест пак частична категория. Обърнат на **allowlist**: позволени са само `$schema`, `$id`, `title`, `description`, `$defs`; всичко друго пада, включително ключова дума, за която никой не се е сетил. |
| 2 | „URI-fragment percent-decoding is missing. For example, `#/%24defs/severity` resolves like `#/$defs/severity` for JSON Schema/Ajv, but the hand-written resolver looks for a literal `%24defs` property and rejects it." | огледалният провал: работеща препратка, обявена за счупена. Указателят се percent-decode-ва **преди** собствените си escape-и — този ред е важен, обратният превръща `~01` в `~` вместо в `~1`. |

Точка 1 записва правилото „**изисквай нужното, не забранявай невъзможното**" на
трето място за деня. Забраната изброява познатото; изискването отказва всичко
непознато. Посоката на провала е разликата.

Шеста мутация добавя `const` в `common.schema.json` и иска allowlist тестът да
падне.

### Chunk 0 · кръг 6 · 2026-09-04 · Codex gpt-5.6-sol · 24 848 токена

**„Block the commit."** Поправката от кръг 5 беше създала скрита зависимост.

Дословно: *„The bundled production validator resolves every `$ref` because it
pre-registers all four schemas. However, the new shared-enum references break
standalone compilation… An absolute `$ref` is only an identifier; Ajv does not
automatically load that schema. Thus these formerly independent schemas now have
an undocumented runtime dependency on the incident schema."*

Ключовото изречение е **„an absolute $ref is only an identifier"** — препратката
е име, не зареждане. Нищо не отваря файла, към който сочи. В production работеше,
защото validator-ът регистрира всичко наведнъж; извън него две схеми, които
дотогава стояха сами, вече не компилираха.

Какво стана:

* споделените дефиниции излязоха в нов `schemas/common.schema.json`, който няма
  какво да валидира — само дефиниции;
* договорът се написа **изрично**: схемите са пакет, нищо не компилира само,
  всичко се регистрира заедно;
* `tests/scenarios/refs.test.ts` го пази: обхожда всяка препратка във всеки файл
  и иска целта да е документ, който някой файл обявява за свой `$id`, а всеки
  указател да сочи нещо съществуващо;
* пета мутация връща препратка към несъществуващ документ и иска този тест да
  падне.

**Дефект, който петата мутация извади веднага.** Тестът „всяка мутация сочи
съществуващ тест" четеше **изброени** два тестови файла. Третият беше добавен,
списъкът остана с два, и новата мутация се отчете като сочеща несъществуващ тест,
докато тестът стоеше точно там. Списък на ръка, за трети път в един ден — сега
файловете се **откриват**, не се изброяват.

### Chunk 0 · кръг 5 · 2026-09-04 · Codex gpt-5.6-sol · 29 123 токена

**„Block commit."** Същият клас дефект, едно ниво по-горе — точно за което го питах.

Дословно: *„The six values appear in the general `type` enum and again in
`$defs/stateChangingType`… They are copied a third time into `STATE_CHANGING` in
absence.test.ts. A newly allowed state-changing action can be added to the main
enum but omitted from both `$defs` and the copied test list. It would then
require neither approval nor a target, while all 102 tests remain green—the exact
recurring defect class."*

Кръг 4 махна три копия и **направи четвърто**: собственият ми тест изписа
шестте стойности наново, във файла, който трябваше да поправи точно това.

| Носител | Тогава | Сега |
|---|---|---|
| главният `type` enum | плосък списък от 8 | `anyOf` на двете категории |
| `$defs/stateChangingType` | 6, вписани отделно | единственият носител |
| `STATE_CHANGING` в теста | 6, преписани на ръка | чете се от схемата |

Добавянето на действие вече иска **избор на категория**; няма списък, който да
се забрави. Тест пази, че двете категории не се застъпват, че и двете са
непразни, и че двете правила сочат **един и същ** носител.

**Намерено паралелно, докато Codex четеше.** Скрипт, който търси еднакви множества
стойности из четирите схеми, извади още два дублирани enum-а: източникът на
доказателство (`kubernetes` / `logs` / `metrics` / `datadog`) живееше и в
`incident`, и в `conversation`; тежестта (`info` / `warning` / `critical`) — и в
`incident`, и в `agent-result`. Разминаване между първите два би позволило
съобщение да цитира източник, какъвто доказателство не може да има. И двата
слязоха в `incident.schema.json` `$defs` и се реферират през файловете.

Скенерът отчита **нула** дублирани множества.

### Chunk 0 · кръг 4 · 2026-09-04 · Codex gpt-5.6-sol · 30 710 токена

**„Block commit."** Една находка, и тя е точно този проект в умален вид.

Възражението, дословно: *„the target-required enum omits `fix_image_reference`
and `adjust_readiness_probe`, although both are explicitly classified as
state-changing… The enum also contains `scale_replicas`, which is not an allowed
action type, indicating the lists drifted. The existing empty-target test uses
only `restart_deployment`, so the gate remains green while these two
missing-target cases validate."*

Три неща в един дефект:

1. **Списъкът с действия, които сменят състояние, съществуваше три пъти** — два
   пъти дословно вписан и веднъж с тип `scale_replicas`, който изобщо не е
   позволено действие. Правилото „всяко действие, което сменя състояние, трябва
   да каже какво пипа" покриваше четири от шест.
2. **Тестът беше писан за един член на категорията.** `restart_deployment`
   минаваше проверката; другите пет никой не питаше.
3. **Gate-ът остана зелен**, защото зеленото беше вярно за онова, което се
   проверява.

Поправено не с допълване на списъка — това щеше да се разсинхронизира пак — а с
`$defs/stateChangingType`: **един носител**, към който сочат и двете правила.
Тестът вече обхожда цялата категория: три отказа и едно приемане по шест типа.

Тестовете скочиха от 83 на 102, без да е добавено ново поведение — само
покритие върху поведение, което вече беше там и никой не питаше.

### Chunk 0 · кръг 5 · 2026-09-04 · субагент, враждебен мандат върху стоящия код

Не Codex, а субагент с **един клас дефект** за мандат: „намери всяко място в
схемите, където липса, празнота или неказаност още минава валидация". Върна
единайсет находки. Правилото е находката да е хипотеза — затова всичките бяха
написани първо **като тестове**, пуснати срещу непроменените схеми, и чак после
пипнат код.

**Всичките дванайсет проверки минаха валидация, а не трябваше.** Нула фалшиви.

| # | Какво минаваше | Поправка |
|---|---|---|
| 1 | conversation с `thread_id: null` **и** `incident_id: null` — guard-ът се задействаше само при string, тоест цялата защита срещу смесване на инциденти беше по избор | `incident_id` вече не може да е null |
| 2 | thread на един инцидент, conversation на втори, съобщение на трети — четири схеми доволни, защото всяко поле има вярната **форма** и нито едно няма вярната **стойност** | cross-field инварианти в `validate.ts` |
| 3 | `diagnosed` с **нула агенти** и доказателство от нищото | `agents` иска `minItems: 1` при diagnosed |
| 4 | `diagnosed` върху доказателство, което казва **against** | иска поне едно `supports: "for"`; `supports` стана задължително |
| 5 | `supported_by: [""]` — подкрепа от нищо, с формата на подкрепа | `minLength: 1` + инвариант: всяко сочи реален `source_ref` |
| 6 | `restart_deployment` с `target: {}` — одобрение на нищо | `target` задължителен и пълен при действие, което сменя състояние |
| 7 | диагноза с `confidence: 0` | `exclusiveMinimum: 0`; горен праг **не** се слага, защото не е измерен |
| 9 | `alert: {}` минаваше, и всеки печатен ключ пътуваше непрочетен | alert стана затворен обект с задължителни `id`, `title`, `triggered_at` |
| 10 | отговор на агент **без цитат** минаваше проверката, която съществува да докаже цитиране | `cited_evidence` задължително при `role: "agent"` |
| 11 | `status: "ok"` носещ `error` | забранено |

**Дефект, който излезе при самата поправка.** Едно от новите правила счупи
компилацията на схемите в strict режим. Validator-ът върна **`unchecked`**, не
`valid` — тоест счупената схема не мина за „чисто". Третото състояние си свърши
работата за първи път на живо, върху дефект, който не беше нарочно направен.

**Два тестови файла, не един.** `absence.test.ts` държи дванайсетте случая, които
преди минаваха, **плюс два положителни**: добре оформен incident и пълна диагноза
минават. Без тях стягането можеше да е купено с отказ на всичко.

### Chunk 0 · кръг 3 · 2026-09-04 · Codex gpt-5.6-sol · 32 485 токена

Въпросът беше един: има ли нещо, заради което би блокирал commit-а.
Отговорът: **„Do not commit. Two blocking defects remain."**

| # | Възражението, дословно | Прието? | Какво стана |
|---|---|---|---|
| 1 | „`LIMITATIONS` improperly contains 'that each fix carries a test which fails without the fix.' That is mechanically decidable through mutation/reversion testing… Moving this requirement into a non-gating list makes today's exit 0 dishonest." | да | точно това, за което го питах: дали разцепването не е начин да се купи exit 0. Изискването излезе от `LIMITATIONS` и стана **шеста проверка**: четири записани дефекта се връщат в кода един по един, suite-ът се пуска, и всеки трябва да събори **именувания си тест**. Файлът се възстановява с обратна редакция в `finally`, никога с git. |
| 2 | „README.md still says the gate exits 2 because six claims remain unverified. The actual gate and PROGRESS.md say exit 0, with four limitations." | да | README беше писан преди разцепването и остана да противоречи. Поправен. |

**Дефект в самата поправка, намерен веднага от нея.** Първото пускане на
мутационната проверка обяви, че мутация 2 оцелява — тоест че тестът за нея е
украшение. Не беше: **anchor текстът се среща два пъти** в `acceptance-gate.mjs`
— веднъж като истински код и веднъж цитиран като данни в списъка с мутации.
Замяната хвана цитата, кодът остана непокътнат, suite-ът остана зелен.

Две поправки, защото едната не стига:

* мутациите излязоха в собствен файл `scripts/mutations.mjs`, за да не цитират
  файла, който мутират;
* gate-ът **отказва двусмислен anchor** — при повече от едно съвпадение връща
  „не може да се установи", не резултат.

Плюс тест, който проверява, че всеки anchor се среща точно веднъж, и втори, че
всяко `mustFail` име сочи тест, който наистина съществува — иначе мутация би се
броила за хваната, защото тестът ѝ е бил преименуван.

### Chunk 0 · кръг 2 · 2026-09-04 · Codex gpt-5.6-sol · 29 948 токена

Заглавието: **„Do not commit. Five material objections remain."** Прегледът пак
беше статичен — командите за пускане са забранени в подканата.

| # | Възражението, дословно | Прието? | Какво стана |
|---|---|---|---|
| 1 | „Exit 0 accepts an unrecognized state… A check returning `{state: \"timeout\"}` is neither `fail` nor `unknown`; the arithmetic produces `0`, falsely meaning 'everything passed.'" | да | всяко състояние извън `pass`/`fail`/`unknown` става `unknown`. Тест подава `{state:\"timeout\"}` и `undefined`. |
| 2 | „The permanently nonzero gate destroys its authority… Teams will bypass it, special-case exit 2, or delete list entries without adding checks. That is operationally worse than a conspicuous disclaimer." | да | **списъкът се разцепи на две.** `LIMITATIONS` — програмата не може да ги реши никога (минал ли е преглед, писана ли е памет); печатат се, не влияят. `DEBT` — механично решими, само ненаписани; всяко носи **от кой chunk става blocking**. Проверката: „би ли могла програма да реши това с файловете на диска?" Ако да — дълг, а дългът има падеж. |
| 3 | „The recursion guard is both bypassable and overbroad… A test can `delete process.env.VITEST`… Conversely, running `VITEST=0 npm run gate` silently suppresses the test check." | да | собствен маркер `ACCEPTANCE_GATE_CHILD`, слаган само на децата, които gate-ът сам пуска. |
| 4 | „Porcelain rename records are parsed incorrectly… turning the second pathname `.env` into `v`." | да | `parsePorcelainZ` консумира втория път цял при `R` и `C`. Проверено на живо в отделно repo, не по документация. |
| 5 | „Documentation contradicts the implementation. CLAUDE.md asserts three gate codes; the code and PROGRESS.md define four." | да | §13 поправен. |

**Втори дефект в същата проверка, намерен от мен, не от Codex.** Докато
проверявах точка 4 на живо, излезе по-опасното: `git status --porcelain` без
`--untracked-files=all` свива цяла untracked папка до `keys/` — и файл вътре в
нея е невидим за проверката. Точно днешното състояние на дървото беше `?? src/`,
`?? tests/`, `?? scripts/`. Ако вътре имаше `.env`, gate-ът щеше да каже „чисто".
Поправено с `-uall`; измерено, не предположено.

**Трети — мой, в самата поправка.** `readCurrentChunk` четеше „първата числова
клетка на кой да е ред от таблица" и връщаше **6** за файл, чийто най-голям
chunk е 0: таблицата с номерирани възражения изглежда точно като таблица с
chunk-ове за парсър, на когото не са казали коя таблица да чете. Сега таблицата
се разпознава по заглавието си, а липсата ѝ дава `null`, не `0`.

### Chunk 0 · кръг 1 · 2026-09-04 · Codex gpt-5.6-sol · 29 083 токена

Заглавието на отсъдата: **„Do not commit. Material defects found."**

Codex не можа да пусне тестовете — read-only sandbox-ът му отказа временните
записи на vitest. Тоест всичките шест находки идват от четене на кода, не от
пускане. Това е ограничение на прегледа и се записва като такова.

| # | Възражението, дословно | Прието? | Какво стана |
|---|---|---|---|
| 1 | „Dirty repository can pass… `checkNoTrackedSecrets()` only examines `git ls-files`, so modified and untracked files—including the current chunk—do not affect exit 0." | да | проверката гледа **и** `git status --porcelain`. Gate-ът тича преди commit, а следващият ход е `git add -A`, който помита точно untracked файла, който index-ът още не познава. |
| 2 | „Exit-code precedence hides uncertainty… Exit 1 therefore falsely implies a completed determination rather than 'failure found, assessment incomplete.'" | да | **четвърти изходен код**: `0` чисто, `1` провал при всичко останало установено, `2` неустановено, `3` провал **и** неустановено. Човек чете доклада; CI чете само числото. |
| 3 | „`NOT_VERIFIED` is an unchecked disclaimer… the gate can print PASS while explicitly admitting that essential Definition-of-Done and mutation-test claims remain unverified. That is indeed the same defect one level up." | да | списъкът стана **проверка**. Докато е непразен, gate-ът не може да стигне 0. Пътят към 0 е да се напише истинска проверка и редът да се изтрие — не списъкът да се съкрати. |
| 4 | „Missing `executed` passes… absence silently reads as read-only compliance—the exact principle the schemas claim to prevent." | да | `executed` влезе в `required`. Поправката веднага счупи „accepts a well-formed recommendation" — доказателство, че дотогава мълчанието минаваше. |
| 5 | „A gate test does not test its named behavior… If `format()` stopped printing unknown results, the test would still pass." | да | тестът вече чете изхода на `format()`, не само `gate.unresolved`. |
| 6 | „`interpretScripts()` returns pass when one bare `node` script is valid even if every other script is unexamined." | да | една разчетена проверка не говори за неразчетените. При неразчетени → `unknown`. |

**Собствен дефект, намерен при поправката, не от Codex:** тестът за точка 3
викаше `runGate()` с истинските проверки, една от които пуска `vitest` — и
suite-ът влезе в безкрайна рекурсия. Не се проваля, **виси**, което отвън не се
различава от бавни тестове. Затова `checkTests()` вече отказва да пусне vitest
отвътре в vitest, с тест за самия отказ. Механизъм, не бележка.

### План · кръг 1 · 2026-09-04 · Codex gpt-5.6-sol · 6 094 токена

Заглавието на отсъдата: **„There are material defects. Do not proceed unchanged."**

| # | Възражението, дословно | Прието? | Какво стана |
|---|---|---|---|
| 1 | „Option C is not yet one source of truth… n8n Cloud becomes a mutable competing source as soon as UI edits are allowed." | да | добавя се **drift detection**: export на deployed workflow, нормализация, сравнение с генерирания. Несъответствие = провал, не предупреждение. |
| 2 | „The chunk-2 isolation test proves only the index's behavior… Model-output assertions alone are insufficient because a model may ignore leaked data." | да | unit тестът остава; добавя се **черна кутия в chunk 5**, която проверява *сглобения context*, не само отговора. |
| 3 | „Credentials should validate—not first reveal—the architecture." | да | **n8n spike без credentials** преди chunk 1: node типове, JS runtime в Code node, лимити, формат на import/export. Непроверените допускания се маркират като такива. |
| 4 | „The cycle's closing condition is circular… A reviewer's silence is not proof." | да | цикълът получава **пета станция — acceptance gate**, отделна от прегледа: декларираните проверки се пускат, командите и резултатите се записват, включително „не можах да установя". |
| 5 | „Pure local Python is unreachable from n8n Cloud without hosting, so Option C currently lacks an execution model." | да | **обръща се решението за език: TypeScript, не Python.** ⚠️ **Основанието се оказа невярно и е поправено на 2026-09-04** — вж. „Spike" по-долу: Python **е** достъпен в Code node. Решението стои, но защото ядрото не се внася през пробваните JavaScript механизми, а не защото Python е недостижим. Дали Python може да внася пакети не е пробвано. |
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
е дефектът от точка 4, приложен към самата поправка. Chunk 0 го затваря с
acceptance gate, който чете този файл.
