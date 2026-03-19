# Storage Retention Policy

## 1. Що зберігається
- `storage/files/materials` - згенеровані PDF.
- `storage/temp` - тимчасові артефакти.
- PostgreSQL таблиці:
  - `telegram_message_map` - мапа `message -> order`.
  - `order_workflow_state` - поточний етап реакцій.
  - `idempotency_keys` - ключі дедуплікації webhook.
  - `dead_letters` - dead-letter події.

## 2. Автоматичний cleanup
Сервіс запускає cleanup циклічно:
- інтервал: `CLEANUP_INTERVAL_MS`
- видалення старих папок/файлів у:
  - `OUTPUT_DIR` старше `OUTPUT_RETENTION_HOURS`
  - `TEMP_DIR` старше `TEMP_RETENTION_HOURS`

## 3. Message map і idempotency
- `TELEGRAM_MESSAGE_MAP_MAX_ENTRIES` обмежує ріст `telegram_message_map`.
- `IDEMPOTENCY_MAX_ENTRIES` обмежує ріст `idempotency_keys`.

## 4. DLQ retention
- записи в `dead_letters` не видаляються автоматично сервісом.
- рекомендовано:
  - щоденний перегляд;
  - SQL purge/архів раз на 7-30 днів.

## 5. Операційні рекомендації
1. Моніторити вільне місце на диску.
2. Моніторити обсяг таблиць у PostgreSQL.
3. Тримати `OUTPUT_RETENTION_HOURS` мінімально достатнім для процесу.
4. Не видаляти таблиці `telegram_message_map`, `idempotency_keys`, `dead_letters` під час роботи сервісу.
