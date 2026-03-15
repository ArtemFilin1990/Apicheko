# Executive summary

Production API-контур реализован в Cloudflare Worker (`worker/worker.js`), а Python-ветка (`bot/` + `services/`) выглядит как legacy/fallback и содержит рассинхрон маппинга эндпойнтов с Worker. В production runtime все вызовы Checko идут через единый `checkoRequest()` с обязательной проверкой `HTTP 200`, JSON-парсинга и `meta.status == ok`; ошибки не проглатываются и конвертируются в сервисные сообщения Telegram. DaData вынесен в отдельный POST-wrapper `dadataPost()` с отдельной авторизацией и graceful fallback. Реальный runtime в репозитории подтверждается smoke-тестами Worker (перехват `fetch` и проверка URL/params), но browser/devtools-сессия пользовательских Telegram-сценариев в этом репозитории напрямую не воспроизводима, т.к. UI — Telegram-клиент, а не web-app.

Главные расхождения:
- Worker использует `GET /finances`, `GET /timeline`, `GET /fedresurs`, а Python-клиент маппит `financial -> finance`, `history -> history`, `fedresurs -> fedresurs-messages`.
- Worker и README согласованы по основным разделам карточки, но Python-контур добавляет/ожидает другие endpoint-aliases и response-shapes.
- В Worker есть неиспользуемые section-builders (`buildFoundersView`, `buildBranchesView`, `buildOkvedView`) и helper `detectCriticalRisk`.

# Confirmed endpoints
| Method | Path | Purpose | Used in code | Runtime confirmed | Status |
|---|---|---|---|---|---|
| GET | `/` (Worker route) | Healthcheck Worker | `worker.fetch()` роутинг | Yes (unit/smoke) | OK |
| POST | `/webhook` (и `WEBHOOK_PATH`) | Telegram webhook ingress | `worker.fetch()` -> `handleTelegramUpdate` | Yes (unit/smoke) | OK |
| GET | `/company` | Главная карточка, налоги, связи | `buildCompanyMainView`, `buildRiskView`, `buildDebtsView`, `buildConnectionsView`, `buildTaxesView` | Yes | OK |
| GET | `/finances` | Финансы и сигналы риска | `buildFinancesView`, `buildRiskView`, `safeSectionData` | Yes | OK |
| GET | `/legal-cases` | Арбитраж, риск-оценка | `buildArbitrationView`, `buildRiskView` | Yes | OK |
| GET | `/enforcements` | Исп. производства, долги, риск | `buildDebtsView`, `buildRiskView` | Yes | OK |
| GET | `/contracts` | Контракты, риск-профиль | `buildContractsView`, `buildRiskView` | Yes | OK |
| GET | `/timeline` | История изменений | `buildHistoryView`, `buildEntrepreneurSectionView` | Частично (через сценарии callback, endpoint в коде) | suspicious |
| GET | `/search` | Поиск по названию (`by=name,obj=org`) | `buildSearchResultsView` | Yes | OK |
| GET | `/bank` | Поиск по БИК | `buildBankView` | Yes | OK |
| GET | `/entrepreneur` | Карточка ИП/section для ИП | `buildEntrepreneurView`, `buildEntrepreneurSectionView` | Частично (код+контракт, без отдельного assert URL) | suspicious |
| GET | `/person` | Карточка физлица | `buildPersonView` | No (в smoke нет прямого endpoint assert) | suspicious |
| GET | `/bankruptcy-messages` | Риск-факторы (банкротство) | `buildRiskView`, `detectCriticalRisk` | Yes | OK |
| GET | `/fedresurs` | Риск-факторы (ЕФРСБ) | `buildRiskView`, `detectCriticalRisk` | Yes | OK |
| POST | `/findByEmail/company` (DaData) | Поиск компании по email | `findCompanyByEmail` | Yes | OK |
| POST | `/findById/party` (DaData) | Enrichment карточки/рисков/связей | `findPartyByInnOrOgrn` | Yes | OK |
| POST | `/findAffiliated/party` (DaData) | Аффилированные компании | `findAffiliatedByInn` | Yes | OK |
| POST | `https://api.telegram.org/bot{token}/sendMessage` | Отправка сообщений | `sendMessage` | Yes | OK |
| POST | `https://api.telegram.org/bot{token}/editMessageText` | Обновление экранов | `editMessage` | Yes | OK |
| POST | `https://api.telegram.org/bot{token}/answerCallbackQuery` | ACK callback | `handleCallbackQuery` | Yes | OK |

# Unconfirmed / suspicious endpoints
| Method | Path | Why suspicious | Where found |
|---|---|---|---|
| GET | `/finance` | Python client ожидает `finance`, Worker использует `finances`; потенциально битый endpoint в legacy-ветке | `services/checko_api.py` |
| GET | `/history` | Python client ожидает `history`, Worker использует `timeline` | `services/checko_api.py`, `worker/worker.js` |
| GET | `/fedresurs-messages` | Python client ожидает `fedresurs-messages`, Worker использует `fedresurs` | `services/checko_api.py`, `worker/worker.js` |
| GET | `/company/short` | Задекларирован в Python METHOD_ENDPOINTS, не используется в runtime | `services/checko_api.py` |
| GET | `/inspections` | Есть в Python и formatter flow, но отсутствует в Worker flow | `services/checko_api.py`, `bot/cards.py` |
| GET | `/timeline` | В Worker используется, но в smoke-тестах нет явного URL-assert по этому endpoint | `worker/worker.js` |
| GET | `/entrepreneur` | Используется в Worker, но в smoke-тестах нет отдельного endpoint assert | `worker/worker.js` |
| GET | `/person` | Используется в Worker при resolve12/person, но runtime-confirm в тестах отсутствует | `worker/worker.js` |

# Flow map
- `/start` или `/help` -> `handleTelegramUpdate` -> `buildMainMenuView`/`buildHelpView` -> Telegram `sendMessage` -> menu renderer.
- Поиск по ИНН/ОГРН (10/13) -> `buildViewForUserText` -> `buildCompanyMainView` -> `checkoRequest("company")` (+ optional `finances`, DaData `findById/party`) -> company card renderer.
- Поиск по названию -> `buildViewForUserText` -> `buildSearchResultsView` -> `checkoRequest("search", {by:name,obj:org,query})` -> results keyboard renderer.
- Поиск по БИК -> `buildViewForUserText` -> `buildBankView` -> `checkoRequest("bank", {bic})` -> bank renderer.
- Поиск по email -> `buildViewForUserText` -> `buildCompanyByEmailView` -> DaData `findByEmail/company` -> `buildCompanyMainView` -> Checko `/company`.
- Карточка: Риски -> callback `co:risk:*` -> `buildRiskView` -> `/company` + `/finances` + `/legal-cases` + `/enforcements` + `/contracts` + `/bankruptcy-messages` + `/fedresurs` + DaData `findById/party` -> `formatRiskResultForTelegram`.
- Карточка: Финансы -> callback `co:fin:*` -> `buildFinancesView` -> `/finances` -> financial renderer.
- Карточка: Арбитраж -> callback `co:arb:*` -> `buildArbitrationView` -> `/legal-cases` -> arbitration renderer.
- Карточка: Долги -> callback `co:debt:*` -> `buildDebtsView` -> `/company` + `/enforcements` -> debts renderer.
- Карточка: Контракты -> callback `co:ctr:*` -> `buildContractsView` -> `/contracts` -> contracts renderer.
- Карточка: История -> callback `co:his:*` -> `buildHistoryView` -> `/timeline` -> history renderer.
- Карточка: Связи -> callback `co:lnk:*` -> `buildConnectionsView` -> `/company` + DaData `findById/party` + `findAffiliated/party` -> connections renderer.
- Карточка: Налоги -> callback `co:tax:*` -> `buildTaxesView` -> `/company` -> tax renderer.
- INN 12-digit resolve -> callback `resolve12:*` -> `/entrepreneur` или `/person` -> соответствующий renderer.

# Issues
## P0
- Расхождение endpoint-мэппинга между production Worker и Python client: `finances vs finance`, `timeline vs history`, `fedresurs vs fedresurs-messages`. Это может ломать Python fallback/runtime и вводит в заблуждение при сопровождении.
- Отсутствует единый контракт endpoint inventory в коде/доках: для одинаковых бизнес-разделов используются разные пути в разных рантаймах.

## P1
- Несколько endpoints подтверждены только кодом, но не покрыты явными runtime-assert в smoke (`/timeline`, `/entrepreneur`, `/person`), из-за чего regressions по пути/параметрам поймаются поздно.
- Legacy Python flow содержит дополнительные endpoints (`/inspections`, `/company/short`) без явной связи с текущим production Worker.

## P2
- Dead code в Worker: `buildFoundersView`, `buildBranchesView`, `buildOkvedView`, `detectCriticalRisk` не включены в callback routing.
- В `services/checko_api.py` `search()` прокидывает только `query`, без явных `by/obj`, тогда как Worker и README фиксируют конкретный режим поиска по названию.

# Fix plan
- `services/checko_api.py` -> endpoint map рассинхронизирован с Worker -> выровнять METHOD_ENDPOINTS (`financial -> finances`, `history -> timeline`, `fedresurs -> fedresurs`) + добавить тесты на URL-пути -> риск: средний (может задеть legacy consumers).
- `services/checko_api.py::search` -> неполный query contract -> добавить параметры `by=name`, `obj=org` (или сигнатуру с явной конфигурацией) -> риск: низкий.
- `tests/worker_smoke.test.mjs` -> неполное runtime-подтверждение некоторых endpoint-сценариев -> добавить отдельные тесты/assert URL для `co:his`, `resolve12:entrepreneur`, `resolve12:person` -> риск: низкий.
- `README.md` + отдельный `docs/endpoint-inventory.md` -> нет единого source-of-truth для dual-runtime -> документировать различия и пометить Python как legacy/secondary -> риск: низкий.
- `worker/worker.js` -> неиспользуемые section builders/helpers -> либо удалить, либо подключить в callbacks/меню при наличии бизнес-требования -> риск: низкий.

# Unknowns
- UNCONFIRMED: browser/devtools capture реального пользовательского Telegram UI (в репозитории нет web frontend, только webhook Worker и backend-код).
- UNCONFIRMED: фактический продовый трафик Checko/DaData с реальными ключами (в локальной среде секреты не предоставлены).
- UNCONFIRMED: какой рантайм (Python vs Worker) реально используется в каждом окружении кроме продового описания в README/wrangler.
