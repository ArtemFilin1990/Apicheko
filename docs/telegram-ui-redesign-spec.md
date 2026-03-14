## 1. Design system decisions

- Product voice: concise operational assistant for due diligence, not a chatty bot.
- Screen anatomy for every section:
  1) Title
  2) Risk banner (if available)
  3) 3–7 key facts
  4) Optional detail list (top 5–10 records)
  5) Navigation buttons
- Visual density standard:
  - 1 semantic block = 2–6 lines
  - blank line between blocks
  - max ~45–55 lines per message; longer lists trimmed with “Показаны первые N”.
- Labeling standard:
  - short nouns in buttons (Checks, Finances, Arbitration)
  - short field labels in cards (ИНН, ОГРН, Статус, Адрес, Руководитель)
  - no bureaucratic phrase repetition.
- Consistency standard:
  - one icon per meaning (fixed dictionary below)
  - one keyboard rhythm (2 columns, full-width for terminal actions)
  - one risk language model across company, entrepreneur, and checks screens.

## 2. Icon system

### Final icon dictionary (stable)

- 🏢 company / main card
- 👔 entrepreneur
- 👤 person / director
- 👥 founders / employees
- 🏦 bank / capital
- 🆔 identifiers
- 📌 status
- 📅 date
- 📍 address
- 📞 phone
- ✉️ email
- 🏭 OKVED / activity
- 💰 finances / revenue
- 📈 profit / growth
- 💸 debt / tax arrears
- ⚠️ risk / warning
- 🔴 critical risk
- ⚖️ arbitration / courts
- 🛡️ FSSP / enforcement
- 📑 contracts / procurement
- 🕓 history
- 🔗 connections
- 🧾 taxes / documents
- 🏬 branches
- 🏠 menu / home

### Usage map

- Main menu: 🏢 👔 👤 🏦 entry points + 🏠 return.
- Company card: 🏢 header; 🆔, 📌, 📅, 📍, 👤, 📞, ✉️, 🏭, 🏦, 👥, 🏬.
- Risk/checks screen: ⚠️/🔴 header + 💸 ⚖️ 🛡️ markers.
- Finances: 💰 + 📈 + 🏦.
- Arbitration: ⚖️.
- FSSP: 🛡️ + 💸.
- Contracts: 📑 + 💰.
- History: 🕓 + 📅.
- Connections: 🔗 + 👤/👥.
- Founders: 👥 + 🏦.
- Branches: 🏬 + 📍.
- OKVED: 🏭.
- Taxes: 🧾 + 💸.
- Entrepreneur: 👔.
- Person: 👤.
- Bank: 🏦.

### Remove / replace

- Replace all “⬅️ Назад” with concise context labels where possible (`← К карточке`, `← К поиску`).
- Avoid mixed green/yellow circle icon language for risk levels on the same screen; use wording + ⚠️/🔴.
- Remove generic “ℹ️” from critical call-to-action rows (use it only for help/instructions).

## 3. Button layout rules

### Global layout rules

- Default: 2 buttons per row.
- If odd count: last content button may be full-width.
- Always full-width:
  - `🏠 Menu`
  - `🏢 Card`
  - `🧾 Taxes` on company stack
- Button text length target: 8–18 chars.
- Verb-first for actions, noun-first for sections.

### Company card keyboard (target)

1. `⚠️ Checks` | `💰 Finances`
2. `⚖️ Arbitration` | `🛡️ FSSP`
3. `📑 Contracts` | `🕓 History`
4. `🔗 Connections` | `👥 Founders`
5. `🏬 Branches` | `🏭 OKVED`
6. `🧾 Taxes` (full-width)
7. `🏢 Card` (full-width)
8. `🏠 Menu` (full-width)

### Main menu keyboard

1. `🆔 Search by INN/OGRN` | `🏢 Search by name`
2. `🏦 Search by BIC` | `ℹ️ Help`
3. `🏠 Menu` (optional when inside nested flow)

### Search result keyboard

- One full-width button per result (for readability).
- Footer:
  - `← Back to search` (full-width)
  - `🏠 Menu` (full-width)

### 12-digit INN choice keyboard

1. `👔 As entrepreneur` | `👤 As person`
2. `← Back to INN search` (full-width)
3. `🏠 Menu` (full-width)

### Entrepreneur keyboard

1. `⚠️ Checks` | `🕓 History`
2. `🔗 Connections` (full-width)
3. `👔 Card` (full-width)
4. `🏠 Menu` (full-width)

### Person keyboard

1. `👤 Card` (full-width)
2. `🏠 Menu` (full-width)

### Bank keyboard

1. `🏦 Card` (full-width)
2. `🏠 Menu` (full-width)

### Interaction hierarchy

- L1: Search and selection
- L2: Primary card
- L3: Section deep-dives
- Persistent escape: `🏠 Menu`
- Persistent context recovery from L3: `🏢 Card` / `👔 Card`.

## 4. Screen formatting rules

### Rulebook

- Title line: `<icon> <b>Section Title</b>`.
- Risk block appears immediately after title if risk data exists.
- Field order priority: risk → identity → legal/financial exposure → supporting metadata.
- Spacing:
  - blank line after title
  - blank line between semantic blocks
  - list items prefixed with `•`
- Max text density:
  - headline block <= 8 lines
  - each detail list <= 10 entries
- Empty states are explicit and section-specific.
- Compact mode: default for mobile, shows top facts + totals.
- Extended mode: only for sections with records (courts/FSSP/contracts/history), capped list.

## 5. Risk presentation rules

### Risk hierarchy

1. **Critical** — legal status overrides score
2. **Strong warning**
3. **Medium risk**
4. **Low risk**
5. **No significant red flags**

### Override triggers (always Critical)

- liquidated company
- liquidation in progress
- bankruptcy markers / EFRSB records
- inactive company with shutdown/legal markers

### UI rules

- Main card top banner format:
  - `🔴 <b>CRITICAL RISK</b>`
  - one-line reason
  - one-line caution (`Рекомендуем ручную проверку документов и статуса.`)
- Checks screen risk block:
  - Level line + reasons list
  - include both adverse and positive factors
- Do not hide uncertainty:
  - if data missing, write `Часть источников недоступна, оценка может быть неполной.`

### Risk copy rules

- Critical: `🔴 Критический риск: <reason>. Требуется ручная проверка перед сделкой.`
- Strong warning: `⚠️ Высокий риск: есть существенные негативные маркеры.`
- Medium: `⚠️ Средний риск: выявлены отдельные факторы, проверьте детали.`
- Low: `⚠️ Низкий риск: заметных негативных факторов немного.`
- No flags: `✅ Существенных красных флагов не найдено.`

## 6. Conversation / copy style guide

### Tone guide

- Clear, calm, competent, compact.
- No jokes, no slang, no legal overloading.
- One intent per sentence.

### Copy rules by context

- Welcome:
  - `Проверка компаний, ИП, физлиц и банков. Выберите тип поиска или отправьте реквизит.`
- Search prompt:
  - `Введите ИНН, ОГРН/ОГРНИП, БИК или название.`
- Successful card delivery:
  - `Карточка готова. Откройте нужный раздел ниже.`
- Empty state:
  - neutral, factual, with next action.
- Service error:
  - short safe text + retry guidance.
- Invalid input:
  - concrete format hint.
- Ambiguous input:
  - explain interpretation options (12-digit INN split).
- Section navigation:
  - `Открыт раздел: <name>.`
- Critical alert:
  - risk sentence first, then recommendation.

### Do / Don’t

- Do: short labels, action-first prompts, explicit next step.
- Don’t: raw API wording, dump-style data, mixed emotional tone, repeated filler.

## 7. Empty state and error copy library

- No company found: `🏢 Компания не найдена. Проверьте ИНН/ОГРН или уточните название.`
- No entrepreneur found: `👔 ИП не найден. Проверьте ИНН/ОГРНИП.`
- No person found: `👤 Физлицо не найдено по указанному ИНН.`
- No finances found: `💰 Финансовые данные не найдены за доступные периоды.`
- No contracts found: `📑 Данные о госконтрактах не найдены.`
- No FSSP found: `🛡️ Исполнительные производства не найдены.`
- No arbitration found: `⚖️ Арбитражные дела не найдены.`
- No founders found: `👥 Данные об учредителях не найдены.`
- No branches found: `🏬 Филиалы и обособленные подразделения не найдены.`
- No tax data found: `🧾 Налоговый профиль недоступен в источнике.`
- Service temporarily unavailable: `⚠️ Сервис Checko временно недоступен. Повторите запрос через 1–2 минуты.`
- Malformed identifier: `🆔 Неверный формат. Отправьте ИНН (10/12), ОГРН (13), ОГРНИП (15), БИК (9) или название.`

## 8. Screen-by-screen examples

- Main menu:
  - `🏠 <b>Проверка контрагента</b>`
  - `Выберите способ поиска или отправьте реквизит.`
- Company card:
  - `🏢 <b>ООО «Альфа»</b>`
  - `🔴 <b>CRITICAL RISK</b>` (if override)
  - `🆔 ИНН: ... | ОГРН: ...`
  - `📌 Статус: ...`
  - `📍 Адрес: ...`
  - `👤 Руководитель: ...`
- Checks:
  - `⚠️ <b>Risk & trust review</b>`
  - level + 3–6 factors
- Finances:
  - `💰 <b>Financial profile</b>`
  - year blocks with revenue/profit/assets/capital
- Arbitration:
  - `⚖️ <b>Court exposure</b>` + top cases
- FSSP:
  - `🛡️ <b>Enforcement debt</b>` + totals + top proceedings
- Contracts:
  - `📑 <b>Procurement activity</b>` + count + latest contracts
- History:
  - `🕓 <b>Key changes</b>` + timeline list
- Connections:
  - `🔗 <b>Related entities</b>` + leadership/founder/address links
- Founders:
  - `👥 <b>Ownership</b>` + founders and shares
- Branches:
  - `🏬 <b>Structure</b>` + branch count + top addresses
- OKVED:
  - `🏭 <b>Business activity</b>` + main/additional codes
- Taxes:
  - `🧾 <b>Tax profile</b>` + paid/debt/penalties
- Entrepreneur:
  - `👔 <b>Entrepreneur card</b>` + identifiers + status + activity
- Person:
  - `👤 <b>Person profile</b>` + role counts
- Bank:
  - `🏦 <b>Bank card</b>` + BIC/name/address/corr account
- Search results:
  - `🏢 <b>Search results</b>` + query + top matches
- 12-digit INN choice:
  - `🆔 <b>12-digit INN detected</b>` + mode choice

### Bad vs Good (example)

- Bad: `data.status=ok; found=0; try again`
- Good: `🏢 Компания не найдена. Проверьте ИНН/ОГРН или уточните название.`

## 9. Interaction flow

### Flow map

1. `/start` → Main menu
2. User selects search type or sends free-form identifier
3. Bot validates format
4. If 12-digit INN → branching choice (entrepreneur/person)
5. Fetch card → show primary card
6. User opens sections from inline keyboard
7. User returns via `🏢 Card` / `👔 Card`
8. User exits via `🏠 Menu`

### Entry points

- `/start`
- text query from any screen
- callback button from any section

### Back-navigation rules

- From section: always have `Card` + `Menu`
- From search results: `Back to search` + `Menu`
- From 12-digit choice: `Back to INN search` + `Menu`

### Recovery rules

- Repeated user messages: always treated as new search intent.
- Invalid input: show exact required formats.
- Service error: preserve user context and expose retry path.

## 10. Final recommended UI spec ready for implementation

### Section model (task framing)

- Checks → **Risk & trust review** (terse mode)
- Finances → **Financial profile** (terse by default, extended yearly list)
- Arbitration → **Court exposure** (extended list)
- FSSP → **Enforcement debt** (extended list)
- Contracts → **Procurement activity** (extended list)
- History → **Key changes** (extended list)
- Connections → **Related entities** (terse mode)
- Founders → **Ownership** (terse mode)
- Branches → **Structure** (terse mode)
- OKVED → **Business activity** (terse mode)
- Taxes → **Tax profile** (terse mode)

### Implementation checklist

1. Normalize icons using dictionary in section 2.
2. Normalize button labels/layout per section 3.
3. Apply title/risk/fact block formatting from section 4.
4. Apply risk override logic and copy from section 5.
5. Replace all generic failures with library entries from section 7.
6. Keep navigation invariants (`Card`, `Menu`) on every non-root screen.
7. Enforce list truncation and explicit “shown first N” text for long datasets.

### QA acceptance checklist

- Risk override banner appears for liquidation/bankruptcy/inactive critical states.
- Every section has distinct, non-dump formatting.
- Empty states are section-specific, not generic service errors.
- All keyboards follow 2-column rhythm and full-width terminal actions.
- User can always recover to Card and Menu in one tap.
