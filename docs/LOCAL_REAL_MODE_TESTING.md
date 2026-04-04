# Local Real-Mode Testing Without Webhook Start

## Призначення
Цей сценарій дає повний ручний цикл:
- беремо конкретне test order;
- переводимо його в `Матеріали = 20`;
- локально тригеримо processing без зовнішнього KeyCRM webhook;
- бот реально шле повідомлення в Telegram topic `ОБРОБКА`;
- ти реально ставиш реакцію в Telegram;
- локальний sync script підтягує reaction update без зовнішнього Telegram webhook;
- CRM-статус реально змінюється;
- комплект реально копіюється в topic `ЗАМОВЛЕННЯ`;
- після тесту order statuses можна повернути назад snapshot-скриптом.

## Передумови
1. Піднята локальна PostgreSQL (`5433`).
2. Заповнений [/.env](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/.env).
3. Telegram bot доданий у supergroup.
4. В `.env` уже задані:
   - `TELEGRAM_CHAT_ID`
   - `TELEGRAM_MESSAGE_THREAD_ID`
   - `TELEGRAM_ORDERS_THREAD_ID`
   - `TELEGRAM_OPS_THREAD_ID` (опційно)
5. Order для повного processing має бути на статусі `Матеріали = 20`.

Примітка по shell:
- для `npm run ...` з `.env` використовуй саме:
  `set -a; source .env; set +a;`
- простого `source .env` недостатньо, бо змінні не будуть exported у дочірній процес.

## Скрипти
- snapshot поточних статусів:
  - `npm run test:orders:snapshot -- --order-ids=29068`
- переведення в потрібний статус:
  - `npm run test:orders:set-status -- --order-ids=29068 --status-id=20`
- ручний trigger processing:
  - `npm run test:order:trigger -- --order-id=29068`
- sync реальних Telegram reaction updates:
  - `npm run test:telegram:sync -- --watch`
- reset operational state для повторного прогону:
  - `npm run test:orders:reset-state -- --order-ids=29068`
- restore статусів:
  - `npm run test:orders:restore -- --snapshot=artifacts/order-status-snapshots/<snapshot-file>.json`

## Рекомендований сценарій на один лот
### 1. Зберегти поточний стан order
```bash
set -a; source .env; set +a;
npm run test:orders:snapshot -- --order-ids=29068
```

Очікування:
- у `artifacts/order-status-snapshots/` з'явився snapshot-файл;
- у stdout видно поточний `status`.

### 2. Перевести order у `Матеріали = 20`
```bash
set -a; source .env; set +a;
npm run test:orders:set-status -- --order-ids=29068 --status-id=20
```

Очікування:
- у stdout видно `before=... after=20`.

### 3. Запустити локальний сервіс
```bash
set -a; source .env; set +a;
npm run dev
```

Очікування:
- сервіс стартував без помилок;
- у логах є `server_started`.

### 4. У другому терміналі запустити sync реакцій
```bash
set -a; source .env; set +a;
npm run test:telegram:sync -- --watch --reset-offset
```

Очікування:
- скрипт перейшов у watch-mode;
- помилок `getUpdates` немає.

Примітка:
- цей скрипт потрібен тільки тому, що ми свідомо не стартуємо з Telegram webhook;
- самі реакції ти ставиш реально в Telegram;
- скрипт лише підтягує ці reaction updates у локальний сервіс.
- сервіс приймає і `message_reaction`, і `message_reaction_count`;
- для живої реакції натискання основний update type це `message_reaction`;
- `message_reaction_count` лишається корисним як aggregate/fallback, але не є єдиним trigger.

### 5. У третьому терміналі вручну тригернути processing
```bash
set -a; source .env; set +a;
npm run test:order:trigger -- --order-id=29068
```

Очікування:
- `status=200`;
- у topic `ОБРОБКА` з'явилися preview і PDF;
- у логах є:
  - `order_intake_processed`
  - `order_pdf_pipeline_completed`
  - `order_telegram_delivery_completed`

### 6. Перевірити Telegram повідомлення
Що перевіряємо:
- caption відповідає погодженому формату;
- warning-и, якщо є, стоять зверху;
- flags відображаються як `📌 ...`;
- filenames, `total`, `_T`, special codes правильні.

### 7. Поставити `❤️` під PDF-повідомленням
Важливо:
- реакцію ставимо під PDF-повідомленням, не під preview;
- для `PRINT` достатньо `1 ❤️`.

### 8. Дочекатися sync реакції
Очікування:
- watch-script бачить новий Telegram update;
- локальний `/webhook/telegram` отримує `202`;
- у логах з'являється `reaction_intake_received` і `reaction_intake_forwarded_to_orders`.

### 9. Перевірити результат
Що очікуємо:
- CRM status змінився на `22` (`Друк`);
- PDF-комплект скопійовано в topic `ЗАМОВЛЕННЯ`;
- дублю не виникло;
- у `forwarding_events` є записи;
- у `order_workflow_state` зафіксований applied stage.

Корисні SQL-перевірки:
```bash
PGPASSWORD=custom_gifts psql -h 127.0.0.1 -p 5433 -U custom_gifts -d custom_gifts_bot \
  -c "SELECT order_id, chat_id, message_id, created_at FROM telegram_message_map WHERE order_id='29068' ORDER BY created_at ASC, message_id ASC;" \
  -c "SELECT order_id, highest_stage_index, applied_status_id, updated_at FROM order_workflow_state WHERE order_id='29068';" \
  -c "SELECT order_id, stage_code, source_message_id, target_message_id, created_at FROM forwarding_events WHERE order_id='29068' ORDER BY created_at ASC;"
```

### 10. Повернути тестові statuses назад
```bash
set -a; source .env; set +a;
npm run test:orders:restore -- --snapshot=artifacts/order-status-snapshots/<snapshot-file>.json
```

Очікування:
- order повернувся у свій початковий status.

### 11. Якщо треба прогнати той самий order ще раз
Повернення CRM status саме по собі недостатньо для чистого rerun.
Потрібно скинути operational state:

```bash
set -a; source .env; set +a;
npm run test:orders:reset-state -- --order-ids=29068 --include-history
```

Після цього:
- повторний trigger роби з новим `source_uuid` або `updated_at`;
- базу дропати не потрібно.

## Що вважати успішним проходом
- processing order дійшов до Telegram;
- повідомлення в `ОБРОБКА` коректне;
- реальна Telegram reaction спрацювала;
- CRM status реально оновився;
- copy у `ЗАМОВЛЕННЯ` реально відбувся;
- test order після сценарію можна безпечно повернути назад.

## Рекомендований стартовий набір order
Для першого реального циклу найкраще брати:
- `29068`
- `29069`
- `29071`

Причина:
- `29068` перевіряє multi-poster / urgent / manual keychain;
- `29069` перевіряє звичайний QR path;
- `29071` перевіряє warning path для non-whitelisted QR.
