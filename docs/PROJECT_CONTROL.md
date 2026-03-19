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
- [docs/CUSTOMER_BRIEF.md](./CUSTOMER_BRIEF.md)

## 1.1 Структура документації

### Основна документація
- [docs/PROJECT_CONTROL.md](./PROJECT_CONTROL.md)
  - головний документ керування роботою.
- [docs/TZ_COMPLETION_PLAN.md](./TZ_COMPLETION_PLAN.md)
  - джерело підтверджених фактів, правил і відкритих питань.
- [docs/CUSTOMER_BRIEF.md](./CUSTOMER_BRIEF.md)
  - короткий опис реалізації для замовника.

### Загальна reference документація
- [docs/TS_ARCHITECTURE.md](./TS_ARCHITECTURE.md)
- [docs/IMPLEMENTATION_STAGES.md](./IMPLEMENTATION_STAGES.md)
- [docs/OPERATIONS.md](./OPERATIONS.md)
- [docs/CONFIGURATION_MODEL.md](./CONFIGURATION_MODEL.md)
- [docs/LEGACY_REFERENCE.md](./LEGACY_REFERENCE.md)

Правило:
- щоденна робота ведеться тільки через основну документацію;
- reference docs відкриваються лише для деталізації конкретного питання.

## 2. Що вже зафіксовано
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
  - `1 ❤️` -> `Друк`
  - `2 ❤️` -> `Пакування`
  - rollback не робимо;
- `RBG` у SKU підтверджено як реальні артикули;
- поточний JS-код вважається reference, а не цільовою архітектурою.

## 3. Основна стратегія реалізації
- Не доробляти current JS-код як фінальний production baseline.
- Зберегти його як reference.
- Нову реалізацію будувати як TypeScript-сервіс.
- Важку PDF-обробку виконувати через queue/worker, а не в HTTP handler.
- Всі бізнес-правила виносити в конфіг.

## 4. Активний мінімальний набір документів
- [docs/PROJECT_CONTROL.md](./PROJECT_CONTROL.md)
  - один керуючий документ.
- [docs/TZ_COMPLETION_PLAN.md](./TZ_COMPLETION_PLAN.md)
  - підтверджені факти, SKU, API, rules.
- [docs/CUSTOMER_BRIEF.md](./CUSTOMER_BRIEF.md)
  - короткий опис для замовника.

## 4.1 Посилання на reference docs
- Архітектура:
  - [docs/TS_ARCHITECTURE.md](./TS_ARCHITECTURE.md)
- Поетапна міграція:
  - [docs/IMPLEMENTATION_STAGES.md](./IMPLEMENTATION_STAGES.md)
- Production, черги, alerting:
  - [docs/OPERATIONS.md](./OPERATIONS.md)
- Конфігурація:
  - [docs/CONFIGURATION_MODEL.md](./CONFIGURATION_MODEL.md)
- Legacy reference:
  - [docs/LEGACY_REFERENCE.md](./LEGACY_REFERENCE.md)

## 5. Етапи реалізації

### Етап A. Freeze і база
Статус: `done`

Що вже зроблено:
- зафіксовано legacy snapshot у `reference/legacy-js/`;
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
  - KeyCRM: `x-keycrm-webhook-secret` / `x-webhook-secret` (якщо `KEYCRM_WEBHOOK_SECRET` заданий);
  - Telegram: `x-telegram-bot-api-secret-token` (якщо `TELEGRAM_REACTION_SECRET_TOKEN` заданий);
- додано file-based idempotency store:
  - `storage/files/idempotency/order-webhooks.json`;
- додано queue intake layer:
  - `order_intake` queue;
  - `reaction_intake` queue;
- receiver тепер відповідає після enqueue (`202`/`207`), без heavy processing в HTTP handler;
- додано `/health` з runtime queue stats.

Програмна перевірка:
- unit tests для CRM client;
- contract tests для payload normalization;
- retries/timeout tests.

Що вже перевірено автоматично:
- `CrmClient` tests (`GET`/`PUT`, envelope unwrap, request body);
- `normalizeKeycrmWebhook` parser tests;
- `FileIdempotencyStore` dedupe/persistence tests;
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
Статус: `planned`

Що треба зробити:
- SKU classifier;
- format resolver;
- stand type resolver;
- urgent detector;
- filename builder;
- poster/engraving/sticker ordering.

Програмна перевірка:
- fixtures по SKU whitelist;
- snapshots layout plan;
- tests на urgent cases.

Ручна перевірка:
- перевірка імен файлів на реальних замовленнях.

### Етап F. PDF pipeline
Статус: `planned`

Що треба зробити:
- перенос poster download;
- white recolor;
- CMYK conversion;
- QR embed;
- Spotify code;
- engraving PDF;
- sticker PDF;
- temp files isolation and cleanup.

Програмна перевірка:
- smoke tests по PDF fixtures;
- timeout tests;
- cleanup tests;
- memory-sensitive batch tests.

Ручна перевірка:
- візуальна перевірка PDF;
- перевірка placement;
- перевірка білого кольору.

### Етап G. Telegram delivery і ops alerts
Статус: `planned`

Що треба зробити:
- preview send;
- files send;
- message mapping;
- alert routing у технічний чат.

Програмна перевірка:
- message payload tests;
- retry tests;
- partial failure tests.

Ручна перевірка:
- прев'ю і файли коректно приходять у Telegram;
- критична помилка приходить у ops chat.

### Етап H. Reaction workflow
Статус: `planned`

Що треба зробити:
- reaction parsing;
- stage tracking;
- `1 ❤️ -> Друк`;
- `2 ❤️ -> Пакування`;
- no rollback.

Програмна перевірка:
- tests на stage transitions;
- tests на duplicate webhook;
- tests на unlike.

Ручна перевірка:
- руками проставити реакції і перевірити оновлення статусів у CRM.

### Етап I. Stress, hardening, production cutover
Статус: `planned`

Що треба зробити:
- batch queue tests;
- retry and DLQ tests;
- disk/temp cleanup checks;
- rollout plan;
- rollback plan.

Програмна перевірка:
- stress tests;
- queue backlog tests;
- worker restart tests.

Ручна перевірка:
- dry run;
- limited rollout;
- full production switch.

## 6. Що ще не закрито
- Чи може бути більше одного базового постера в одному замовленні.
- Чи стікер завжди фіксованого розміру.
- Що робити при збої генерації або коли Telegram send не вдався:
  - `Без файлу = 40`
  - `Немає в тг = 59`
  - або не чіпати статус.
- Яка фінальна специфіка Spotify code.
- Чи є ще типи кодів, крім QR і Spotify code.
- Що робити з `FriendAppleA5RGB+K`, якого зараз нема в CRM.

## 7. Основні production-ризики
- heavy PDF processing;
- inconsistent data в CRM;
- duplicated webhook;
- Telegram rate limit;
- temp file growth;
- memory spikes на `A4` і multi-pass recolor;
- падіння worker у середині pipeline.

## 8. Правило контролю якості
Кожен етап вважається завершеним тільки якщо є:
- реалізація;
- автоматична перевірка;
- ручна перевірка;
- оновлення документації.

## 9. Як рухаємось далі
Поточний наступний крок:
- Етап E: Layout planning і naming.

Після цього:
- Етап E
- Етап F
- Етап G

Тобто спочатку будуємо основу, а вже потім переносимо важку бізнес-логіку.
