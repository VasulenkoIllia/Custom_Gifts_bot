# Контроль реалізації проєкту

## 1. Призначення
Це головний робочий документ для реалізації.

Саме тут фіксується:
- що вже вирішено;
- що ще треба зробити;
- у якому порядку рухаємось;
- що тестуємо автоматично;
- що тестуємо вручну;
- що блокує наступний етап.

Для щоденної роботи достатньо цього документа плюс:
- [docs/TZ_COMPLETION_PLAN.md](./TZ_COMPLETION_PLAN.md)
- [docs/TZ_ADDENDUM_PLAN.md](./TZ_ADDENDUM_PLAN.md)
- [docs/CUSTOMER_BRIEF.md](./CUSTOMER_BRIEF.md)

## 1.1 Структура документації

### Основна документація
- [docs/PROJECT_CONTROL.md](./PROJECT_CONTROL.md)
  - головний документ керування роботою.
- [docs/TZ_COMPLETION_PLAN.md](./TZ_COMPLETION_PLAN.md)
  - джерело підтверджених фактів, правил і відкритих питань.
- [docs/TZ_ADDENDUM_PLAN.md](./TZ_ADDENDUM_PLAN.md)
  - план нових вимог, які додані після стартового ТЗ.
- [docs/CUSTOMER_BRIEF.md](./CUSTOMER_BRIEF.md)
  - короткий опис реалізації для замовника.

### Загальна reference документація
- [docs/TS_ARCHITECTURE.md](./TS_ARCHITECTURE.md)
- [docs/IMPLEMENTATION_STAGES.md](./IMPLEMENTATION_STAGES.md)
- [docs/OPERATIONS.md](./OPERATIONS.md)
- [docs/CONFIGURATION_MODEL.md](./CONFIGURATION_MODEL.md)
- [docs/LEGACY_REFERENCE.md](./LEGACY_REFERENCE.md)
- [docs/RUNBOOK.md](./RUNBOOK.md)
- [docs/WEBHOOK_CHECKLIST.md](./WEBHOOK_CHECKLIST.md)
- [docs/STORAGE_RETENTION.md](./STORAGE_RETENTION.md)
- [docs/MANUAL_UAT_CHECKLIST.md](./MANUAL_UAT_CHECKLIST.md)

Правило:
- щоденна робота ведеться тільки через основну документацію;
- reference docs відкриваються лише для деталізації конкретного питання.

## 2. Що зафіксовано як цільові правила
Примітка:
- цей розділ фіксує узгоджені правила процесу;
- факт реалізації перевіряється по статусах етапів у розділі `5`.

- webhook у CRM буде надходити тільки для Shopify-замовлень;
- статуси CRM підтверджені live:
  - `Матеріали = 20`
  - `Друк = 22`
  - `Пакування = 7`
- порядок матеріалів при `poster + engraving + sticker`:
  - `1`: poster
  - `2`: engraving
  - `3`: sticker
- реакції за замовчуванням працюють тільки вперед:
  - `1 ❤️` -> `Друк` + пересилання в гілку `ЗАМОВЛЕННЯ`;
  - `👍` -> `Пакування` (пілотний відкладений етап, disabled за замовчуванням);
  - rollback не робимо;
- у примітках повідомлення підтримуються прапори:
  - `QR +`, `LF +`, `A6 +`, `B +`;
- якщо в замовленні є `A6`/`брелок`, вони входять у загальний `total` нумерації файлів;
- перед QR-генерацією посилання проходить shortener:
  - primary `lnk.ua`;
  - fallback `cutt.ly`.
- структура Telegram робочого простору:
  - `ОБРОБКА` (автоматичний потік бота);
  - `ЗАМОВЛЕННЯ` (відібрані/виправлені макети);
  - `ЧАТ` (комунікація команди);
- `RBG` у SKU підтверджено як реальні артикули;
- поточний JS-код вважається reference, а не цільовою архітектурою.

## 2.1 Відкладені уточнення
Ці питання відкладені на пізніше і не блокують поточну реалізацію:
- чи реакції для workflow мають оброблятися тільки на повідомленнях із PDF файлами, чи також на preview-повідомленнях;
- для `1 ❤️` пересилаємо в `ЗАМОВЛЕННЯ` увесь комплект чи тільки poster;
- `copy` чи `forward` як основна політика пересилання;
- чи дублюємо пересилання після `1 ❤️` ще й у приватний чат менеджера;
- коли вмикаємо пілотний етап `👍 -> Пакування` і чи лишається він у фінальному workflow;
- чи для `👍` застосовуємо авто-ланцюжок `Друк -> Пакування`, якщо `❤️` не було;
- доля SKU `FriendAppleA5RGB+K`, якого зараз немає в CRM (не блокує запуск, якщо SKU не приходить у webhook-потоці).

## 2.2 Поточний локальний readiness
Поточний стан для локального тестування:
- live access до `KeyCRM`, `Telegram Bot API`, `lnk.ua`, `cutt.ly` і `Spotify scannables` підтверджений;
- цього достатньо для формування `layout plan`, QR/Spotify decision і Telegram caption;
- для повного локального runtime ще потрібен PostgreSQL (`DATABASE_URL`);
- webhook secrets (`KEYCRM_WEBHOOK_SECRET`, `TELEGRAM_REACTION_SECRET_TOKEN`) можна відкласти до етапу підключення webhook;
- локальний no-webhook етап вважається основним наступним кроком.

Мінімальний контур для ручного інтеграційного тесту без webhook:
- PostgreSQL;
- `KEYCRM_TOKEN` + `KEYCRM_API_BASE`;
- `TELEGRAM_BOT_TOKEN`;
- Telegram destination для `ОБРОБКА`;
- Telegram destination для `ЗАМОВЛЕННЯ`;
- shortener доступ (`lnk.ua` / `cutt.ly`);
- локальний запуск worker/runtime або ручного processing runner.

Що ще потрібно для Telegram-перевірки:
- один Telegram bot;
- одна `supergroup`;
- мінімум 2 topic-гілки:
  - `ОБРОБКА`
  - `ЗАМОВЛЕННЯ`
- ops topic бажаний, але для початкового no-webhook тесту не є blocker.

## 3. Основна стратегія реалізації
- Не доробляти current JS-код як фінальний production baseline.
- Зберегти його як reference.
- Нову реалізацію будувати як TypeScript-сервіс.
- Важку PDF-обробку виконувати через queue/worker, а не в HTTP handler.
- Всі бізнес-правила виносити в конфіг.
- Операційний state зберігати тільки в PostgreSQL:
  - `idempotency_keys`
  - `telegram_message_map`
  - `order_workflow_state`
  - `dead_letters`

## 4. Активний мінімальний набір документів
- [docs/PROJECT_CONTROL.md](./PROJECT_CONTROL.md)
  - один керуючий документ.
- [docs/TZ_COMPLETION_PLAN.md](./TZ_COMPLETION_PLAN.md)
  - підтверджені факти, SKU, API, rules.
- [docs/TZ_ADDENDUM_PLAN.md](./TZ_ADDENDUM_PLAN.md)
  - додаткові вимоги по Telegram-гілках і reaction-flow.
- [docs/CUSTOMER_BRIEF.md](./CUSTOMER_BRIEF.md)
  - короткий опис для замовника.

## 4.1 Посилання на reference docs
- Архітектура:
  - [docs/TS_ARCHITECTURE.md](./TS_ARCHITECTURE.md)
- Поетапна міграція:
  - [docs/IMPLEMENTATION_STAGES.md](./IMPLEMENTATION_STAGES.md)
- Production, черги, alerting:
  - [docs/OPERATIONS.md](./OPERATIONS.md)
- Runbook:
  - [docs/RUNBOOK.md](./RUNBOOK.md)
- Webhook checklist:
  - [docs/WEBHOOK_CHECKLIST.md](./WEBHOOK_CHECKLIST.md)
- Retention policy:
  - [docs/STORAGE_RETENTION.md](./STORAGE_RETENTION.md)
- Manual UAT:
  - [docs/MANUAL_UAT_CHECKLIST.md](./MANUAL_UAT_CHECKLIST.md)
- Конфігурація:
  - [docs/CONFIGURATION_MODEL.md](./CONFIGURATION_MODEL.md)
- Legacy reference:
  - [docs/LEGACY_REFERENCE.md](./LEGACY_REFERENCE.md)

## 5. Етапи реалізації

### Етап F0. Manual інтеграційне тестування без webhook
Статус: `in_progress`

Ціль:
- перевірити реальний шлях `CRM order -> processing -> PDF/caption/Telegram` без зовнішнього webhook trigger;
- спочатку підтвердити правильність формування матеріалів і повідомлень;
- тільки після цього підключати webhook-и.

Поточний принцип тестування:
- беремо конкретне тестове замовлення;
- опрацьовуємо його вручну локально;
- перевіряємо `layout plan`, PDF-комплект, caption і доставку в Telegram;
- після стабільного проходу кількох order cases переходимо до webhook stage.

Що блокує повний локальний runtime прямо зараз:
- відсутній `DATABASE_URL` у локальному контурі;
- не заведені webhook secrets;
- може бути не заведений routing для `ЗАМОВЛЕННЯ` / ops.

Що не блокує цей етап:
- відсутність webhook secret;
- відсутність production HTTPS endpoint;
- відсутність Telegram reaction webhook.

Додаткові локальні helper scripts для цього етапу:
- snapshot поточних CRM statuses перед тестом;
- manual status set у `Матеріали = 20`;
- manual trigger локального processing без KeyCRM webhook;
- sync реальних Telegram reaction updates без Telegram webhook;
- restore CRM statuses після тесту.

### Етап A. Freeze і база
Статус: `done`

Що вже зроблено:
- зафіксовано legacy snapshot у `reference/legacy-js/` як архівний baseline;
- створено базовий комплект documentation;
- зроблено live-аудит SKU через CRM API.

### Етап B. Архітектурне закриття
Статус: `done`

Що вже зроблено:
- визначена TS-архітектура;
- визначені queue/worker принципи;
- визначено config-first підхід;
- зафіксовано production alerting у Telegram.

### Етап C. Підготовка нового TypeScript-каркасу
Статус: `done`

Що треба зробити:
- створити `tsconfig`;
- створити `src/` структуру;
- додати config loader + schema validation;
- додати structured logger;
- додати health endpoint;
- додати базові types.

Програмна перевірка:
- проєкт компілюється;
- сервіс стартує;
- env validation працює.

Ручна перевірка:
- health endpoint повертає коректний стан;
- невалідний env блокує старт.

Що вже зроблено:
- створено новий `package.json` під TypeScript bootstrap;
- додано `tsconfig.json`;
- створено `src/` каркас;
- додано config loader;
- додано config validation;
- додано structured logger;
- додано `GET /health` handler;
- виконано `npm install`;
- виконано `npm run check`;
- виконано `npm run build`;
- перевірено `health` handler програмно без відкриття порту.

### Етап D. CRM adapter і webhook intake
Статус: `in_progress`

Що треба зробити:
- реалізувати `GET /order/{id}`;
- реалізувати `PUT /order/{id}`;
- реалізувати KeyCRM webhook receiver;
- реалізувати Telegram webhook receiver;
- додати idempotency key;
- додати enqueue замість синхронної обробки.

Що вже зроблено:
- додано TypeScript `CrmClient` з:
  - `GET /order/{id}` (`getOrder`);
  - `PUT /order/{id}` (`updateOrderStatus`);
  - timeout + retry + backoff логіку;
- додано webhook receiver маршрути:
  - `POST /webhook/keycrm`;
  - `POST /webhook/telegram`;
- додано валідацію webhook secret:
  - KeyCRM: query param `?secret=<KEYCRM_WEBHOOK_SECRET>` або legacy header `x-keycrm-webhook-secret` / `x-webhook-secret`;
  - Telegram: `x-telegram-bot-api-secret-token` (якщо `TELEGRAM_REACTION_SECRET_TOKEN` заданий);
- додано idempotency store в PostgreSQL (`idempotency_keys`);
- додано queue intake layer:
  - `order_intake` queue;
  - `reaction_intake` queue;
- receiver відповідає після enqueue, без heavy processing в HTTP handler:
  - KeyCRM: `200` при успішному enqueue;
  - Telegram: `202` при успішному enqueue;
- додано `/health` з runtime queue stats.

Програмна перевірка:
- unit tests для CRM client;
- contract tests для payload normalization;
- retries/timeout tests.

Що вже перевірено автоматично:
- `CrmClient` tests (`GET`/`PUT`, envelope unwrap, request body);
- `normalizeKeycrmWebhook` parser tests;
- `DbIdempotencyStore` dedupe/persistence tests;
- `KeycrmWebhookController` duplicate webhook dedupe test;
- `npm run check` пройдено;
- `npm run build` пройдено;
- `npm test` пройдено.

Ручна перевірка:
- тестовий webhook ставить job у queue;
- дубльований webhook не дублює роботу.

Що лишається по етапу D:
- ручний live smoke-test на CRM webhook у тестовому середовищі;
- ручний live smoke-test на Telegram webhook із секретом.

### Етап E. Layout planning і naming
Статус: `in_progress`

Що треба зробити:
- SKU classifier;
- format resolver;
- stand type resolver;
- urgent detector;
- filename builder;
- poster/engraving/sticker ordering.

Що вже зроблено:
- додано `product-code-rules.json` у `config/business-rules/` для special poster codes;
- додано TS `layout` модулі:
  - `sku-classifier`;
  - `format-resolver`;
  - `stand-type-resolver`;
  - `filename-builder`;
  - `layout-plan-builder`;
- реалізовано naming:
  - poster: `CGU_<posterCode>_<order>_<i>_<total>[_T]`;
  - engraving: `CGU_<format><stand>_G_<order>_<i>_<total>[_T]`;
  - sticker: `CGU_S_<order>_<i>_<total>[_T]`;
- реалізовано зафіксований порядок:
  - `poster -> engraving -> sticker`;
- реалізовано пріоритет визначення формату:
  - SKU -> properties -> fallback;
- реалізовано `+K/speaker -> K` для типу підставки;
- інтегровано layout planning у `order_intake` worker.

Програмна перевірка:
- fixtures по SKU whitelist;
- snapshots layout plan;
- tests на urgent cases.

Що вже перевірено автоматично:
- tests на `poster + engraving + sticker` naming;
- tests на special SKU code (`HT`) і urgent suffix `_T`;
- tests на пріоритет SKU формату над `offer.properties`;
- tests на `+K` для engraving code;
- tests на note при невалідному QR URL.

Ручна перевірка:
- перевірка імен файлів на реальних замовленнях.

Що лишається по етапу E:
- live-перевірка naming на реальних замовленнях з CRM;
- валідувати multi-poster нумерацію на реальних кейсах (`_1_N`, `_2_N`, ...).

### Етап F. PDF pipeline
Статус: `in_progress`

Що треба зробити:
- перенос poster download;
- white recolor;
- CMYK conversion;
- QR embed;
- Spotify code;
- engraving PDF;
- sticker PDF;
- temp files isolation and cleanup.

Що вже зроблено:
- додано `PdfPipelineService` у TS як адаптер до legacy `generateMaterialFiles`;
- інтегровано PDF pipeline у `order_intake` worker після побудови `layoutPlan`;
- pipeline тепер генерує:
  - poster PDF;
  - engraving PDF;
  - sticker PDF;
  - white recolor + CMYK conversion (через legacy пайплайн);
  - QR embed за `qrPlacementByFormat` (generic fallback);
- додано data/config параметри для pipeline:
  - `OUTPUT_DIR`, `FONT_PATH`, `PDF_COLOR_SPACE`, `STICKER_SIZE_MM`, `OFFWHITE_HEX`, `RASTERIZE_DPI`;
  - `QR_A5_*` / `QR_A4_*`;
- додано `qr-rules.json` + loader і `QR_RULES_PATH` у runtime config;
- реалізовано SKU-specific QR policy по whitelist:
  - для SKU поза whitelist код не вбудовується;
  - для whitelist SKU вбудовується звичайний QR;
  - для Spotify SKU + Spotify URL вбудовується Spotify code;
- QR/Spotify застосовується per-poster (а не глобально на весь order) у TS post-processing;
- після вбудовування QR/Spotify для `CMYK` виконується повторна CMYK-конверсія постера;
- додано unit test на mapping `LayoutPlan -> material generator payload`.

Програмна перевірка:
- smoke tests по PDF fixtures;
- timeout tests;
- cleanup tests;
- memory-sensitive batch tests.

Що вже перевірено автоматично:
- `npm run check` пройдено;
- `npm run build` пройдено;
- `npm test` пройдено (включно з PDF mapping test).
- локальний smoke-run legacy PDF generator пройдено (`engraving-only`, `generated=1`, `failed=0`).

Ручна перевірка:
- візуальна перевірка PDF;
- перевірка placement;
- перевірка білого кольору.

Що лишається по етапу F:
- виконати live smoke на 3 кейсах:
  - лише poster;
  - poster + engraving;
  - poster + engraving + sticker;
- зафіксувати performance limits (RAM/CPU) на реальних PDF.

### Етап G. Telegram delivery і ops alerts
Статус: `in_progress`

Що треба зробити:
- preview send;
- files send;
- message mapping;
- alert routing у технічний чат.

Що вже зроблено:
- додано `TelegramDeliveryService` з внутрішнім runtime-клієнтом у `src/modules/telegram/telegram-client.runtime.js`;
- `order_intake` worker тепер:
  - обробляє замовлення тільки коли `status_id == materialsStatusId`;
  - після генерації PDF відправляє прев'ю + файли в Telegram;
  - пише `message_ids` у PostgreSQL message-map store для подальшого reaction workflow;
- додано мапінг повідомлень у PostgreSQL:
  - `telegram_message_map` (`message -> order`);
  - `order_workflow_state` (workflow state для реакцій).
- додано `OpsAlertService`:
  - алерти в окремий `TELEGRAM_OPS_CHAT_ID`/thread;
  - dedupe-window для уникнення alert spam;
  - retry/backoff для `sendMessage`.
- додано DLQ persistence:
  - PostgreSQL table `dead_letters`;
  - автоматичний запис dead-letter подій для `order_intake` і `reaction_intake`.
- додано failure-status flow через rules:
  - `missingFileStatusId` (`40`);
  - `missingTelegramStatusId` (`59`);
  - статуси ставляться при переході order-job в DLQ.

Програмна перевірка:
- message payload tests;
- retry tests;
- partial failure tests.

Що вже перевірено автоматично:
- `DbTelegramMessageMapStore` tests;
- tests на queue retry + DLQ;
- `npm run check` / `build` / `test` пройдено після інтеграції доставки.

Ручна перевірка:
- прев'ю і файли коректно приходять у Telegram;
- критична помилка приходить у ops chat.

Що лишається по етапу G:
- live smoke на тестовому Telegram чаті/треді.

### Етап H. Reaction workflow
Статус: `in_progress`

Що треба зробити:
- reaction parsing;
- stage tracking;
- `1 ❤️ -> Друк`;
- `👍 -> Пакування` тримати вимкненим (pilot-disabled) до окремого рішення;
- no rollback.

Що вже зроблено:
- додано `config/business-rules/reaction-status-rules.json`;
- додано `ReactionStatusRules` loader + resolver;
- `reaction_intake` worker тепер:
  - знаходить `orderId` по `chatId/messageId` через PostgreSQL message-map store;
  - застосовує monotonic stage transitions за `emoji + threshold`:
    - `PRINT`: `❤️` (з alias `❤/♥️/♥`) `>=1`;
    - `PACKING`: `👍 >=1` (stage вимкнений у дефолтному конфігу);
  - підтримує послідовне застосування етапів при стрибку:
    - якщо `PACKING` увімкнено і прилетів тільки `👍`, виконується ланцюжок `Друк -> Пакування`;
  - ігнорує rollback (меншу кількість релевантних реакцій після підвищення етапу);
  - викликає `PUT /order/{id}` для зміни `status_id`;
- додано unit test для reaction worker monotonic transitions.
- додано anti-flood policy для burst updates:
  - webhook dedupe key по `chat/message + stage bucket`;
  - повторні реакції в межах того ж stage не ставляться в роботу повторно.

Програмна перевірка:
- tests на stage transitions;
- tests на duplicate webhook;
- tests на unlike.

Що вже перевірено автоматично:
- tests на `resolveStageForReactionCounts`;
- tests на monotonic `reaction_intake` transitions;
- tests на stage-bucket dedupe в `TelegramWebhookController`;
- `npm run check` / `build` / `test` пройдено.

Що лишається по етапу H:
- live webhook smoke з реальними Telegram reaction update payloads.

Ручна перевірка:
- руками проставити `1 ❤️` і перевірити оновлення статусу на `Друк`;
- перевірити, що `👍` не дає нового переходу, поки stage вимкнений.

### Етап J. Engraving A4 bounds для Collage/Textcollage SKUs

**Причина:** Товари `TextcollageA5Wood*` і `Collage2HeartA5Wood*` мають підставку A4-ширини,
тому гравіювання повинно розраховуватися на межі A4 (22×210 мм), а не A5 (22×148 мм).

**Реалізовано:**
- `config/business-rules/product-code-rules.json` — новий масив `engravingA4BoundSkus` з 8 SKU;
- `src/modules/layout/product-code-rules.ts` — тип `engravingA4BoundSkus: ReadonlySet<string>`, helper `hasEngravingA4Bounds()`;
- `src/modules/layout/layout-plan-builder.ts` — при будуванні engraving payload перевіряє базовий SKU і виставляє `format: "A4"` якщо SKU в списку;
  - **Ім'я файлу** (`A5W_G`) не змінюється — відображає фізичний формат товару;
  - **Engraving zone** (`format` у payload) стає `"A4"` → `resolveEngravingZone` повертає 210×22 мм.
- `tests/layout-plan-builder.test.ts` — 3 нові тести (всі 8 SKU, regular fallback, filename invariant).

**SKU список:**
```
TextcollageA5Wood, TextcollageA5WoodWW, TextcollageA5WoodMultiWW, TextcollageA5WoodRBG
Collage2HeartA5Wood, Collage2HeartA5WoodWW, Collage2HeartA5WoodMultiWW, Collage2HeartA5WoodRGB
```

**Статус:** реалізовано, тести зелені (114/114). Потребує ручного UAT: замовлення з одним із цих SKU + гравіювання.

---

### Етап I. Stress, hardening, production cutover
Статус: `in_progress`

Що треба зробити:
- batch queue tests;
- retry and DLQ tests;
- disk/temp cleanup checks;
- rollout plan;
- rollback plan.

Що вже зроблено:
- queue-level retry policy (`maxAttempts`, `retryBaseMs`, `shouldRetry`);
- dead-letter callbacks + persistent DLQ store;
- storage retention service:
  - cleanup `OUTPUT_DIR` за `OUTPUT_RETENTION_HOURS`;
  - cleanup `TEMP_DIR` за `TEMP_RETENTION_HOURS`;
  - periodic run за `CLEANUP_INTERVAL_MS`;
- додано production docs:
  - [docs/RUNBOOK.md](./RUNBOOK.md)
  - [docs/WEBHOOK_CHECKLIST.md](./WEBHOOK_CHECKLIST.md)
  - [docs/STORAGE_RETENTION.md](./STORAGE_RETENTION.md)
  - `/.env.production.example`

Програмна перевірка:
- stress tests;
- queue backlog tests;
- worker restart tests.

Ручна перевірка:
- dry run;
- limited rollout;
- full production switch.

## 6. Що ще не закрито

### Security (потребує виправлення перед production)
- **`KEYCRM_WEBHOOK_SECRET` і `TELEGRAM_REACTION_SECRET_TOKEN` не перевіряються як непусті у `validateConfig`.**
  При порожньому значенні webhook endpoints стають публічними.
  Виправлення: додати дві перевірки в `validate-config.ts`.
  Деталі: [docs/ARCHITECTURE_AUDIT_2026-04-29.md](./ARCHITECTURE_AUDIT_2026-04-29.md)

### Операційне
- Знизити `DATABASE_POOL_MAX` до 8-10 при деплої 4+ order-workers
  (поточний дефолт 20 → 120 з'єднань при 4 workers + receiver + reaction-worker, PostgreSQL default max=100).
- Зафіксувати `--scale order-worker=4` у deploy-документації або `docker-compose.prod.yml`.

### Бізнес-логіка (відкладені рішення)
- Фінально зафіксувати політику `copy` чи `forward` для пересилання у `ЗАМОВЛЕННЯ`.
- Визначити, чи реакції приймаємо тільки з PDF-повідомлень, чи також із preview.
- Визначити, чи пересилання після `1 ❤️` дублюється в приватний чат менеджера.
- Вирішити долю етапу `👍 -> Пакування` (залишаємо відключеним або вмикаємо в майбутньому релізі).
- Зафіксувати порядок включення ручних `A6/B` у нумерацію, якщо в одному замовленні кілька poster.
- Узгодити fallback-поведінку shortener (`lnk.ua -> cutt.ly`) при часткових збоях.
- Що робити з `FriendAppleA5RGB+K`, якого зараз нема в CRM.

## 7. Основні production-ризики
- heavy PDF processing;
- inconsistent data в CRM;
- duplicated webhook;
- Telegram rate limit;
- temp file growth;
- memory spikes на `A4` і multi-pass recolor;
- падіння worker у середині pipeline;
- **webhook security bypass при порожньому secret (незакрито, critical)**.

## 8. Правило контролю якості
Кожен етап вважається завершеним тільки якщо є:
- реалізація;
- автоматична перевірка;
- ручна перевірка;
- оновлення документації.

## 9. Як рухаємось далі
Поточний наступний крок:
- live UAT по Stage F/G/H:
  - PDF smoke (3 сценарії);
  - Telegram send і message mapping;
  - reaction workflow `1❤️` в CRM + перевірка, що `👍` неактивний у дефолтному режимі;
  - перевірка пересилання у гілку `ЗАМОВЛЕННЯ` після `1 ❤️`.
  - перевірка нумерації з ручними позиціями `A6/B` у `total`.
  - виконати checklist:
    - [docs/MANUAL_UAT_CHECKLIST.md](./MANUAL_UAT_CHECKLIST.md)

Після UAT:
- закриття Stage I (stress + production cutover).
