# Webhook Checklist

Примітка:
- webhook етап виконується тільки після локального ручного інтеграційного тестування без webhook;
- спочатку мають бути перевірені `layout plan`, PDF generation, caption і Telegram delivery на конкретних test order ID.

## 1. KeyCRM -> бот
1. URL: `https://<your-domain>/webhook/keycrm`
2. Метод: `POST`
3. Подія: `order.change_order_status`
4. Якщо використовується секрет, додати його в URL:
   `https://<your-domain>/webhook/keycrm?secret=<KEYCRM_WEBHOOK_SECRET>`
5. У CRM фільтр webhook: тільки Shopify-замовлення

Перевірка:
1. Відправити тестову подію.
2. Переконатись у `200` відповіді.
3. У логах має бути `keycrm_webhook_intake`.

## 2. Telegram -> бот
1. URL: `https://<your-domain>/webhook/telegram`
2. `setWebhook` з `secret_token = TELEGRAM_REACTION_SECRET_TOKEN`
3. Увімкнені `message_reaction` updates для чату/треду.
4. `message_reaction_count` теж бажано приймати як aggregate/fallback.

Перевірка:
1. Поставити ❤️ під повідомленням з файлом замовлення.
2. Переконатись, що у логах є `telegram_webhook_intake`.
3. Перевірити зміну статусу в CRM на `Друк`.
4. Перевірити пересилання комплекту в гілку `ЗАМОВЛЕННЯ`.
5. Перевірити, що `👍` не викликає нового переходу в дефолтному режимі (pilot disabled).

## 3. Безпека
1. Webhook endpoints доступні тільки через HTTPS.
2. Секрети довгі і випадкові (не менше 24 символів).
3. Секрети не зберігаються в репозиторії.

## 4. Що перевірити після зміни webhook
1. `/health` працює.
2. `KeyCRM` webhook повертає `200`, а `Telegram` webhook повертає `202`.
3. Queue не переповнюється.
4. В ops-чат не сипляться `critical` алерти.
