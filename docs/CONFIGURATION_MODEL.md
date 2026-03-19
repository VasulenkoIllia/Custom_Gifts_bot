# Модель конфігурації

## 1. Ціль
Конфіг має дозволяти швидко змінювати бізнес-правила без правок коду і без ризику поламати production.

## 2. Шари конфігурації
- `.env`
  - секрети, токени, URL, системні ліміти.
- `config/runtime/*.json`
  - операційні правила середовища.
- `config/business-rules/*.json`
  - статуси, реакції, SKU mapping, QR/Spotify placement.

## 3. Що має жити в `.env`
- `KEYCRM_API_BASE`
- `KEYCRM_TOKEN`
- `DATABASE_URL`
- `DATABASE_POOL_MAX`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_MESSAGE_THREAD_ID`
- `TELEGRAM_OPS_CHAT_ID`
- `TELEGRAM_OPS_THREAD_ID`
- `OPS_ALERT_TIMEOUT_MS`
- `OPS_ALERT_RETRIES`
- `OPS_ALERT_RETRY_BASE_MS`
- `OPS_ALERT_DEDUPE_WINDOW_MS`
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

## 4. Що має жити в business config
- `status_id` для переходів CRM
- список emoji для workflow
- кількість реакцій для кожного переходу
- mapping SKU -> poster code
- mapping значень підставки -> `W`, `WW`, `MWW`, `C`, `K`
- QR/Spotify SKU rules
- placement по SKU і формату
- alert routing rules

## 5. Мінімальний набір конфіг-файлів
- `config/business-rules/reaction-status-rules.json`
- `config/business-rules/product-code-rules.json`
- `config/business-rules/qr-rules.json`

## 6. `reaction-status-rules.json`
Має містити:
- `materialsStatusId`
- mapping `heartCount -> statusId`
- stage order
- rollback policy
- optional:
  - `missingFileStatusId`
  - `missingTelegramStatusId`

Приклад:

```json
{
  "allowedEmojis": ["❤️", "❤"],
  "stages": [
    { "heartCount": 1, "statusId": 22, "code": "PRINT" },
    { "heartCount": 2, "statusId": 7, "code": "PACKING" }
  ],
  "rollback": "ignore"
}
```

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

## 9. Database Tables
Стан зберігається в PostgreSQL таблицях:
- `idempotency_keys`
- `telegram_message_map`
- `order_workflow_state`
- `dead_letters`

## 10. Що не зберігаємо у файлах
- message-map/idempotency/DLQ/workflow-state не зберігаються в JSON/JSONL.
- локальні директорії (`OUTPUT_DIR`, `TEMP_DIR`) використовуються тільки для PDF/preview артефактів.

## 11. Правила зміни конфігу
- Конфіг валідований на старті.
- Невалідний конфіг блокує старт сервісу.
- Всі business rules мають схему валідації.
- Конфіг не повинен вимагати перекомпіляції коду.

## 12. Що не можна тримати в коді
- `status_id`
- allowed reaction emoji
- required heart count
- SKU placement rules
- poster code mapping
- ops chat ids

## 13. Що можна тримати в коді
- type guards
- validation schemas
- safe defaults
- внутрішні технічні константи алгоритмів
