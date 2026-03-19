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
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_MESSAGE_THREAD_ID`
- `TELEGRAM_OPS_CHAT_ID`
- `TELEGRAM_OPS_THREAD_ID`
- `PORT`
- `OUTPUT_DIR`
- `TEMP_DIR`
- `ORDER_WORKER_CONCURRENCY`
- `PDF_WORKER_CONCURRENCY`
- `QUEUE_MAX_RETRIES`
- `QUEUE_RETRY_BASE_MS`
- `REQUEST_TIMEOUT_MS`

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
- `config/business-rules/status-rules.json`
- `config/business-rules/reaction-rules.json`
- `config/business-rules/product-code-rules.json`
- `config/business-rules/qr-rules.json`
- `config/business-rules/stand-type-rules.json`
- `config/business-rules/alert-rules.json`
- `config/runtime/pipeline-rules.json`

## 6. `status-rules.json`
Має містити:
- `materials_status_id`
- `print_status_id`
- `packing_status_id`
- optional:
  - `layout_status_id`
  - `downloaded_layout_status_id`
  - `missing_file_status_id`
  - `missing_telegram_status_id`

## 7. `reaction-rules.json`
Має містити:
- allowed emoji list
- mapping `heartCount -> statusId`
- stage order
- rollback policy

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

## 8. `product-code-rules.json`
Має містити:
- exact SKU mapping для special poster codes
- optional overrides для format
- optional overrides для stand type
- optional aliases

## 9. `qr-rules.json`
Має містити:
- whitelisted SKU
- group type
- code type:
  - `qr`
  - `spotify_code`
- placement per format
- invalid URL policy

## 10. `pipeline-rules.json`
Має містити:
- retry policy
- PDF timeout
- max download size
- temp retention
- generated files retention
- alert thresholds

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
