# Runbook

## 1. Перед запуском
1. Заповнити `.env` або `.env.production` за шаблоном [/.env.production.example](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/.env.production.example).
2. Перевірити наявність:
   - `KEYCRM_TOKEN`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `TELEGRAM_ORDERS_CHAT_ID`
   - `TELEGRAM_OPS_CHAT_ID`
   - `KEYCRM_WEBHOOK_SECRET`
   - `TELEGRAM_REACTION_SECRET_TOKEN`
   - `POSTGRES_PASSWORD` (для docker-compose.prod)
3. Переконатись, що директорії запису доступні:
   - `storage/files/`
   - `storage/temp/`
4. Переконатись, що PostgreSQL доступний за `DATABASE_URL`.
5. Переконатись, що в PostgreSQL є права на створення/оновлення таблиць
   (`idempotency_keys`, `telegram_message_map`, `order_workflow_state`, `dead_letters`).

## 1.1 Поточний порядок локального запуску
Поточний рекомендований порядок:
1. Підняти локальну PostgreSQL.
2. Пройти ручне інтеграційне тестування без webhook:
   - взяти test order;
   - опрацювати його вручну локально;
   - перевірити PDF, caption і Telegram delivery.
3. Тільки після цього налаштовувати webhook-и.

Примітка по shell:
- для локальних `npm run ...` сценаріїв, які читають `.env`, використовувати:
  `set -a; source .env; set +a;`
- простого `source .env` недостатньо для export змінних у дочірні процеси.

Що вже підтверджено live:
- `KeyCRM API` доступний;
- `Telegram Bot API` доступний;
- `lnk.ua` і `cutt.ly` доступні;
- `Spotify scannables` доступний.

Що ще не потрібно для цього етапу:
- `KEYCRM_WEBHOOK_SECRET`
- `TELEGRAM_REACTION_SECRET_TOKEN`
- production webhook endpoint

Мінімальний набір для no-webhook локального інтеграційного тесту:
- `DATABASE_URL`
- `KEYCRM_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- destination для `ОБРОБКА`
- destination для `ЗАМОВЛЕННЯ`

Покроковий реальний сценарій без старту з webhook окремо описаний у
[LOCAL_REAL_MODE_TESTING.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/docs/LOCAL_REAL_MODE_TESTING.md).

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
   - якщо `5432` уже зайнятий іншим локальним контейнером:
     `LOCAL_POSTGRES_PORT=5433 docker compose -f docker-compose.local.yml up -d`
2. Опційно підняти pgAdmin:
   - `docker compose -f docker-compose.local.yml --profile tools up -d`
3. Для локального запуску застосунку з хоста встановити:
   - `DATABASE_URL=postgres://custom_gifts:custom_gifts@127.0.0.1:5432/custom_gifts_bot`
   - або, якщо використовується alternate host-port:
     `DATABASE_URL=postgres://custom_gifts:custom_gifts@127.0.0.1:5433/custom_gifts_bot`

## 2.1.1 Telegram prerequisites для локального інтеграційного тесту
Для ручного no-webhook тестування потрібні:
- один Telegram bot;
- одна `supergroup`;
- мінімум 2 topic-гілки:
  - `ОБРОБКА`
  - `ЗАМОВЛЕННЯ`

Опційно:
- окремий `ops` topic або окремий ops chat.

Примітка:
- для першого локального етапу не обов'язково підключати reaction webhook;
- але destination для `ОБРОБКА` і `ЗАМОВЛЕННЯ` повинні бути відомі боту.

## 2.1.2 Тест одного замовлення без зовнішнього webhook
Цей сценарій дозволяє прогнати один order через повний local processing path:
- ручний trigger `POST /webhook/keycrm`;
- генерація PDF;
- відправка в Telegram topic `ОБРОБКА`;
- перевірка caption/preview/files;
- ручна симуляція reaction update;
- copy у topic `ЗАМОВЛЕННЯ`.

Важливо:
- замовлення в CRM повинно бути на статусі `Матеріали = 20`;
- якщо order у CRM має інший статус, worker його пропустить;
- для повторного trigger того самого order потрібно міняти `source_uuid` або `updated_at`, інакше спрацює webhook idempotency;
- для повного чистого rerun того самого order потрібно також скинути operational state через `npm run test:orders:reset-state`.

Кроки:
1. Підняти локальну БД:
   - `LOCAL_POSTGRES_PORT=5433 docker compose -f docker-compose.local.yml up -d postgres`
2. Завантажити `.env`:
   - `source .env`
3. Запустити сервіс:
   - `npm run dev`
4. В іншому терміналі вручну викликати локальний KeyCRM webhook:

```bash
curl -sS -X POST http://127.0.0.1:3000/webhook/keycrm \
  -H 'Content-Type: application/json' \
  -d '{
    "event": "order.change_order_status",
    "context": {
      "id": 29068,
      "status_id": 20,
      "updated_at": "2026-04-02T12:00:00Z",
      "source_uuid": "manual-test-29068-run-1"
    }
  }'
```

Очікування:
- HTTP-відповідь `200`;
- у логах є `order_intake_processed`, `order_pdf_pipeline_completed`, `order_telegram_delivery_completed`;
- у topic `ОБРОБКА` з'являються preview і PDF-файли;
- у БД з'являються записи в `telegram_message_map`.

Корисна перевірка message map:

```bash
PGPASSWORD=custom_gifts psql -h 127.0.0.1 -p 5433 -U custom_gifts -d custom_gifts_bot \
  -c "SELECT order_id, chat_id, message_id, created_at FROM telegram_message_map WHERE order_id='29068' ORDER BY created_at ASC, message_id ASC;"
```

Примітка:
- workflow reaction прив'язаний до PDF-повідомлень, не до preview.

## 2.1.3 Реакційний тест без зовнішнього Telegram webhook
У no-webhook режимі справжня реакція в Telegram не дійде до локального сервісу автоматично.
Тому для локального етапу reaction-flow тестується через ручний `POST /webhook/telegram`.

Примітка:
- сервіс приймає і `message_reaction`, і `message_reaction_count`;
- для живих реакцій від користувачів основний update type це `message_reaction`;
- `message_reaction_count` не можна використовувати як єдиний trigger, бо для частини сценаріїв він приходить із затримкою.

Кроки:
1. Визначити `message_id` PDF-повідомлення для потрібного order через `telegram_message_map`.
2. Вручну відправити локальний Telegram update:

```bash
curl -sS -X POST http://127.0.0.1:3000/webhook/telegram \
  -H 'Content-Type: application/json' \
  -d '{
    "update_id": 900001,
    "message_reaction_count": {
      "chat": { "id": -1003710886298 },
      "message_id": 123,
      "reactions": [
        {
          "type": { "type": "emoji", "emoji": "❤️" },
          "total_count": 1
        }
      ]
    }
  }'
```

Очікування:
- HTTP-відповідь `202`;
- статус order у CRM змінюється на `22` (`Друк`);
- PDF-комплект копіюється з `ОБРОБКА` в `ЗАМОВЛЕННЯ`;
- у БД з'являються записи в `forwarding_events` і `order_workflow_state`.

Корисні перевірки:

```bash
PGPASSWORD=custom_gifts psql -h 127.0.0.1 -p 5433 -U custom_gifts -d custom_gifts_bot \
  -c "SELECT order_id, highest_stage_index, applied_status_id, updated_at FROM order_workflow_state WHERE order_id='29068';" \
  -c "SELECT order_id, stage_code, source_message_id, target_message_id, created_at FROM forwarding_events WHERE order_id='29068' ORDER BY created_at ASC;"
```

Якщо потрібно протестувати саме живу реакцію натисканням у Telegram, а не ручну симуляцію:
- треба або підняти реальний Telegram webhook;
- або додати polling-mode, якого зараз у сервісі немає.

## 2.2 Docker Compose: production (app + DB)
1. Підготувати `.env.production` (можна від [/.env.production.example](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/.env.production.example)).
2. Перевірити секрети:
   - `POSTGRES_PASSWORD`
   - `KEYCRM_TOKEN`
   - `TELEGRAM_BOT_TOKEN`
   - `KEYCRM_WEBHOOK_SECRET`
   - `TELEGRAM_REACTION_SECRET_TOKEN`
3. Переконатись, що DNS для `APP_DOMAIN` вже вказує на сервер, а Traefik має доступ до external network `TRAEFIK_NETWORK`.
4. Підняти PostgreSQL:
   - `docker compose -f docker-compose.prod.yml --env-file .env.production up -d postgres`
5. Прогнати міграції:
   - `docker compose -f docker-compose.prod.yml --env-file .env.production --profile ops run --rm migrate`
6. Підняти прод-сервіси:
   - `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build receiver order-worker reaction-worker`
7. Перевірити health:
   - `curl -fsS https://<APP_DOMAIN>/health`
8. Перезапуск після оновлення коду:
   - `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build receiver order-worker reaction-worker`

Примітки:
- production image already includes `tzdata`, `ghostscript` і compiled `dist/scripts/*`;
- app services run with `init: true`, що важливо для дочірніх процесів PDF pipeline;
- operational scripts on the server should be executed from the container through `npm run ...`, not through `tsx src/...`.

### 2.2.1 Production ops/test commands from the container
Snapshot statuses:
- `docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver npm run test:orders:snapshot -- --order-ids=29068,29069`

Set test status:
- `docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver npm run test:orders:set-status -- --order-ids=29068 --status-id=20`

Manual order trigger:
- `docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver npm run test:order:trigger -- --order-id=29068`

Reset one order:
- `docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver npm run test:orders:reset-state -- --order-ids=29068 --include-history`

Reset whole regression set:
- `docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver npm run test:orders:reset-state -- --include-history`

Restore statuses:
- `docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver npm run test:orders:restore -- --snapshot=artifacts/order-status-snapshots/<snapshot-file>.json`

### 2.3 Production webhook values
- KeyCRM webhook URL:
  `https://<APP_DOMAIN>/webhook/keycrm?secret=<KEYCRM_WEBHOOK_SECRET>`
- Telegram webhook URL:
  `https://<APP_DOMAIN>/webhook/telegram`
- Telegram `setWebhook`:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<APP_DOMAIN>/webhook/telegram",
    "secret_token": "<TELEGRAM_REACTION_SECRET_TOKEN>",
    "allowed_updates": ["message_reaction", "message_reaction_count"],
    "drop_pending_updates": true
  }'
```

## 3. Що перевірити після старту
1. Тестовий webhook KeyCRM створює job у `order_intake`.
2. Тестове замовлення на статусі `Матеріали` відправляється у гілку `ОБРОБКА`.
3. У БД з'являються записи в `telegram_message_map` і `order_workflow_state`.
4. Реакція `1 ❤️` змінює статус на `Друк` і запускає пересилання в `ЗАМОВЛЕННЯ`.
5. Реакція `👍` у поточному релізі не виконує переходу (pilot-disabled).
6. Для QR shortener працює в порядку:
   - primary `lnk.ua`;
   - fallback `cutt.ly`.
7. Для read-only перевірки бізнес-логіки по фіксованих order ID використовувати [LOCAL_ORDER_BUSINESS_TESTING.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/docs/LOCAL_ORDER_BUSINESS_TESTING.md).
8. Для order без `_tib_design_link_1` або без тексту engraving/sticker:
   - PDF pipeline не стартує;
   - order одразу переходить у `Без файлу` (`40`);
   - в ops-чат приходить `error` alert;
   - запису в `dead_letters` бути не повинно.

## 4. Реакція на інциденти
### 4.1 Deterministic missing-file
Ознаки:
- у логах `order_intake_missing_file_detected`;
- у CRM order одразу переходить у `40`;
- в ops-чат приходить `Замовлення переведено в "Без файлу"`;
- запису в `dead_letters` немає.

Дії:
1. Відкрити order у CRM.
2. Перевірити, чого саме бракує:
   - `_tib_design_link_1`;
   - тексту engraving;
   - тексту sticker.
3. Виправити дані в order/source.
4. Повернути order у `20` і повторити intake.

### 4.2 Queue/DLQ
Ознаки:
- у логах `queue_dead_letter_recorded`;
- у БД з'являються записи в `dead_letters`;
- в ops-чат приходить `[CRITICAL]`.

Дії:
1. Відкрити останній запис у DLQ.
2. Визначити `failureKind` (`pdf_generation` або `telegram_delivery`).
3. Виправити причину.
4. Повторно відправити замовлення (через CRM повторний статус/webhook).

### 4.3 Telegram недоступний / rate limit
Ознаки:
- помилки `Telegram ... failed (429/5xx)`;
- затримки доставки.
- `Preview warning: ...` у логах (коли preview не доставилось, але PDF-файли пішли).

Дії:
1. Перевірити доступність Telegram API з сервера.
2. Тимчасово зменшити `ORDER_QUEUE_CONCURRENCY`.
3. За потреби підвищити `TELEGRAM_REQUEST_RETRIES`.

### 4.4 CRM API помилки
Ознаки:
- `CrmApiError`, `crm_retry`.

Дії:
1. Перевірити токен і доступність KeyCRM.
2. Перевірити `KEYCRM_API_BASE`.
3. Дочекатися автоматичних retry; при вичерпанні - переглянути DLQ.

### 4.5 Spotify / PDF source URL помилки
Ознаки:
- `Spotify ... failed ...`;
- `Failed to download poster PDF (...)`.

Дії:
1. Перевірити валідність посилання в замовленні.
2. Перевірити доступність `scannables.scdn.co` і джерела PDF з production сервера.
3. За потреби тимчасово підвищити:
   - `SPOTIFY_REQUEST_RETRIES`;
   - `PDF_SOURCE_REQUEST_RETRIES`.

### 4.6 URL shortener помилки (`lnk.ua` / `cutt.ly`)
Ознаки:
- `shortener primary failed` у логах;
- попередження про fallback або відсутність short URL.

Дії:
1. Перевірити доступність `lnk.ua`.
2. Переконатися, що fallback на `cutt.ly` працює.
3. Якщо обидва сервіси недоступні, зафіксувати інцидент в ops-чат і тимчасово працювати без скорочення за аварійним правилом.

## 5. Recovery
1. Якщо сервіс перезапущено:
   - idempotency, message-map і DLQ зберігаються в PostgreSQL;
   - обробка продовжується з нових webhook подій.
2. Якщо згенеровані файли накопичились:
   - retention-cleanup працює автоматично за `OUTPUT_RETENTION_HOURS` і `TEMP_RETENTION_HOURS`;
   - фінальні PDF не видаляються одразу після відправки в Telegram, а очищуються по retention-політиці;
   - технічні temp-артефакти додатково чистяться всередині PDF pipeline.

## 6. Rollback
1. Зупинити поточний процес.
2. Повернути попередній стабільний build.
3. Відновити попередній `.env`.
4. Переконатись, що `/health` знову `ok`.
