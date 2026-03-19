# Runbook

## 1. Перед запуском
1. Заповнити `.env` або `.env.production` за шаблоном [/.env.production.example](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/.env.production.example).
2. Перевірити наявність:
   - `KEYCRM_TOKEN`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `TELEGRAM_OPS_CHAT_ID`
   - `KEYCRM_WEBHOOK_SECRET`
   - `TELEGRAM_REACTION_SECRET_TOKEN`
3. Переконатись, що директорії запису доступні:
   - `storage/files/`
   - `storage/temp/`
4. Переконатись, що PostgreSQL доступний за `DATABASE_URL`.
5. Переконатись, що в PostgreSQL є права на створення/оновлення таблиць
   (`idempotency_keys`, `telegram_message_map`, `order_workflow_state`, `dead_letters`).

## 2. Запуск
1. `npm run check`
2. `npm run build`
3. `npm start`

Очікуваний стан:
- `/health` повертає `ok: true`;
- у логах є `server_started`;
- у логах немає помилок ініціалізації PostgreSQL schema;
- `storage_cleanup_completed` з'являється після старту.

## 2.1 Docker Compose: local (тільки БД + optional UI)
1. Підняти PostgreSQL:
   - `docker compose -f docker-compose.local.yml up -d`
2. Опційно підняти pgAdmin:
   - `docker compose -f docker-compose.local.yml --profile tools up -d`
3. Для локального запуску застосунку з хоста встановити:
   - `DATABASE_URL=postgres://custom_gifts:custom_gifts@127.0.0.1:5432/custom_gifts_bot`

## 2.2 Docker Compose: production (app + DB)
1. Підготувати `.env.production` (можна від [/.env.production.example](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/.env.production.example)).
2. Перевірити секрети:
   - `POSTGRES_PASSWORD`
   - `KEYCRM_TOKEN`
   - `TELEGRAM_BOT_TOKEN`
   - `KEYCRM_WEBHOOK_SECRET`
   - `TELEGRAM_REACTION_SECRET_TOKEN`
3. Запуск:
   - `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build`
4. Перезапуск після оновлення коду:
   - `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build app`

## 3. Що перевірити після старту
1. Тестовий webhook KeyCRM створює job у `order_intake`.
2. Тестове замовлення на статусі `Матеріали` відправляється у Telegram.
3. У БД з'являються записи в `telegram_message_map` і `order_workflow_state`.
4. Реакція `1 ❤️` змінює статус на `Друк`, `2 ❤️` на `Пакування`.

## 4. Реакція на інциденти
### 4.1 Queue/DLQ
Ознаки:
- у логах `queue_dead_letter_recorded`;
- у БД з'являються записи в `dead_letters`;
- в ops-чат приходить `[CRITICAL]`.

Дії:
1. Відкрити останній запис у DLQ.
2. Визначити `failureKind` (`pdf_generation` або `telegram_delivery`).
3. Виправити причину.
4. Повторно відправити замовлення (через CRM повторний статус/webhook).

### 4.2 Telegram недоступний / rate limit
Ознаки:
- помилки `Telegram ... failed (429/5xx)`;
- затримки доставки.

Дії:
1. Перевірити доступність Telegram API з сервера.
2. Тимчасово зменшити `ORDER_QUEUE_CONCURRENCY`.
3. За потреби підвищити `TELEGRAM_REQUEST_RETRIES`.

### 4.3 CRM API помилки
Ознаки:
- `CrmApiError`, `crm_retry`.

Дії:
1. Перевірити токен і доступність KeyCRM.
2. Перевірити `KEYCRM_API_BASE`.
3. Дочекатися автоматичних retry; при вичерпанні - переглянути DLQ.

## 5. Recovery
1. Якщо сервіс перезапущено:
   - idempotency, message-map і DLQ зберігаються в PostgreSQL;
   - обробка продовжується з нових webhook подій.
2. Якщо згенеровані файли накопичились:
   - retention-cleanup працює автоматично за `OUTPUT_RETENTION_HOURS` і `TEMP_RETENTION_HOURS`.

## 6. Rollback
1. Зупинити поточний процес.
2. Повернути попередній стабільний build.
3. Відновити попередній `.env`.
4. Переконатись, що `/health` знову `ok`.
