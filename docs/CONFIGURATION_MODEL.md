# Модель конфігурації

## 1. Ціль
Конфіг має дозволяти швидко змінювати бізнес-правила без правок коду і без ризику поламати production.

## 2. Шари конфігурації
- `.env`
  - секрети, токени, URL, системні ліміти, bootstrap seed для першого запуску.
- `PostgreSQL`
  - змінні бізнес-правила, які треба міняти без деплою.
- `config/business-rules/*.json`
  - статичні SKU mapping, QR/Spotify placement, seed для reaction rules.

## 3. Що має жити в `.env`
- `KEYCRM_API_BASE`
- `KEYCRM_TOKEN`
- `DATABASE_URL`
- `DATABASE_POOL_MAX`
- `DATABASE_POOL_CONNECTION_TIMEOUT_MS`
- `DATABASE_POOL_IDLE_TIMEOUT_MS`
- `DATABASE_QUERY_TIMEOUT_MS`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` (bootstrap seed для `processing`)
- `TELEGRAM_MESSAGE_THREAD_ID` (bootstrap seed для `processing`)
- `TELEGRAM_ORDERS_CHAT_ID` (bootstrap seed для `orders`)
- `TELEGRAM_ORDERS_THREAD_ID` (bootstrap seed для `orders`)
- `TELEGRAM_FORWARD_MODE` (bootstrap seed для routing settings)
- `TELEGRAM_OPS_CHAT_ID` (bootstrap seed для `ops`)
- `TELEGRAM_OPS_THREAD_ID` (bootstrap seed для `ops`)
- `OPS_ALERT_TIMEOUT_MS`
- `OPS_ALERT_RETRIES`
- `OPS_ALERT_RETRY_BASE_MS`
- `OPS_ALERT_DEDUPE_WINDOW_MS`
- `SPOTIFY_REQUEST_TIMEOUT_MS`
- `SPOTIFY_REQUEST_RETRIES`
- `SPOTIFY_REQUEST_RETRY_BASE_MS`
- `SHORTENER_REQUEST_TIMEOUT_MS`
- `SHORTENER_REQUEST_RETRIES`
- `SHORTENER_REQUEST_RETRY_BASE_MS`
- `LNK_UA_BEARER_TOKEN`
- `CUTTLY_API_KEY`
- `PDF_SOURCE_REQUEST_TIMEOUT_MS`
- `PDF_SOURCE_REQUEST_RETRIES`
- `PDF_SOURCE_REQUEST_RETRY_BASE_MS`
- `PORT`
- `OUTPUT_DIR`
- `TEMP_DIR`
- `ORDER_QUEUE_CONCURRENCY`
- `ORDER_QUEUE_MAX_ATTEMPTS`
- `ORDER_QUEUE_RETRY_BASE_MS`
- `REACTION_QUEUE_CONCURRENCY`
- `REACTION_QUEUE_MAX_ATTEMPTS`
- `REACTION_QUEUE_RETRY_BASE_MS`
- `IDEMPOTENCY_MAX_ENTRIES`
- `TELEGRAM_MESSAGE_MAP_MAX_ENTRIES`
- `OUTPUT_RETENTION_HOURS`
- `TEMP_RETENTION_HOURS`
- `CLEANUP_INTERVAL_MS`
- `DB_CLEANUP_INTERVAL_MS`
- `DB_CLEANUP_BATCH_SIZE`

## 4. Що має жити в business config
У БД:
- `status_id` для переходів CRM
- список emoji для workflow
- trigger policy для кожного переходу (`emoji` + `countThreshold`)
- enabled/disabled прапор для кожного reaction stage
- Telegram routing topology (`processing`, `orders`, `ops`)
- forwarding mode (`copy` / `forward`)

У `config/business-rules/*.json`:
- mapping SKU -> poster code
- mapping значень підставки -> `W`, `WW`, `MWW`, `C`, `K`
- QR/Spotify SKU rules
- placement по SKU і формату
- reaction seed для першого bootstrap у БД

## 5. Мінімальний набір конфіг-файлів
- `config/business-rules/reaction-status-rules.json`
- `config/business-rules/product-code-rules.json`
- `config/business-rules/qr-rules.json`

## 6. `reaction-status-rules.json`
Має містити:
- `materialsStatusId`
- `allowedEmojis` (whitelist для Telegram parser)
- mapping `emoji + countThreshold -> statusId`
- optional `emojiAliases` для stage
- stage order
- stage `enabled/disabled`
- rollback policy
- optional:
  - `missingFileStatusId`
  - `missingTelegramStatusId`

Приклад:

```json
{
  "materialsStatusId": 20,
  "missingFileStatusId": 40,
  "missingTelegramStatusId": 59,
  "allowedEmojis": ["❤️", "❤", "👍"],
  "stages": [
    {
      "code": "PRINT",
      "emoji": "❤️",
      "emojiAliases": ["❤", "♥️", "♥"],
      "countThreshold": 1,
      "statusId": 22,
      "enabled": true
    },
    {
      "code": "PACKING",
      "emoji": "👍",
      "countThreshold": 1,
      "statusId": 7,
      "enabled": false
    }
  ],
  "rollback": "ignore"
}
```

Примітка:
- `allowedEmojis` описує whitelist символів, які приймаються webhook-парсером.
- Для уникнення неявної логіки кожен stage має мати явний `emoji`.
- Stage приймає тільки `countThreshold`; legacy-поле `heartCount` більше не підтримується.
- Файл використовується як bootstrap seed. Після першого успішного запуску runtime читає rules із PostgreSQL таблиць `reaction_rule_config` та `reaction_stage_rules`.

## 7. `product-code-rules.json`
Має містити:
- exact SKU mapping для special poster codes
- optional overrides для format
- optional overrides для stand type
- optional aliases

## 8. `qr-rules.json`
Має містити:
- whitelisted SKU
- group type
- code type:
  - `qr`
  - `spotify_code`
- placement per format
- invalid URL policy
- startup fail-fast:
  - мінімум 1 валідний profile;
  - без дубльованих `id`;
  - без дубльованих SKU між profile.

## 8.1 DB-backed Telegram routing
У runtime використовується PostgreSQL:
- `telegram_routing_settings`
  - `forward_mode`
- `telegram_routing_destinations`
  - `processing`
  - `orders`
  - `ops`

Bootstrap policy:
- якщо таблиці порожні, вони сідуються з `TELEGRAM_CHAT_ID`, `TELEGRAM_ORDERS_CHAT_ID`, `TELEGRAM_OPS_CHAT_ID`, thread-id і `TELEGRAM_FORWARD_MODE`;
- після seed ці env-поля вже не є джерелом правди для routing.

## 8.2 URL shortener
Shortener не має окремого JSON-конфігу в runtime.
Поточна політика:
- `lnk.ua` primary;
- `cutt.ly` fallback;
- якщо обидва недоступні, використовується original URL з warning в логах/Telegram caption.

## 9. Database Tables
Стан зберігається в PostgreSQL таблицях:
- `idempotency_keys`
- `telegram_message_map`
- `order_workflow_state`
- `dead_letters`
- `forwarding_events` (рекомендовано для антидублювання пересилань)
- `reaction_rule_config`
- `reaction_stage_rules`
- `telegram_routing_settings`
- `telegram_routing_destinations`

## 10. Що не зберігаємо у файлах
- message-map/idempotency/DLQ/workflow-state не зберігаються в JSON/JSONL.
- reaction workflow і Telegram routing після bootstrap не зберігаються у JSON як runtime source of truth.
- локальні директорії (`OUTPUT_DIR`, `TEMP_DIR`) використовуються тільки для PDF/preview артефактів.

## 11. Правила зміни конфігу
- Конфіг валідований на старті.
- Невалідний конфіг блокує старт сервісу.
- Всі business rules мають схему валідації.
- Конфіг не повинен вимагати перекомпіляції коду.

## 12. Що не можна тримати в коді
- `status_id`
- allowed reaction emoji
- reaction trigger policy (`emoji` + threshold)
- enabled/disabled stage flags
- SKU placement rules
- poster code mapping
- ops chat ids
- Telegram routing topology

## 13. Що можна тримати в коді
- type guards
- validation schemas
- safe defaults
- внутрішні технічні константи алгоритмів
