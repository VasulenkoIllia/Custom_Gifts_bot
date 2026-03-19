# Webhook Checklist

## 1. KeyCRM -> бот
1. URL: `https://<your-domain>/webhook/keycrm`
2. Метод: `POST`
3. Подія: `order.change_order_status`
4. Секрет у KeyCRM = `KEYCRM_WEBHOOK_SECRET`
5. У CRM фільтр webhook: тільки Shopify-замовлення

Перевірка:
1. Відправити тестову подію.
2. Переконатись у `202` відповіді.
3. У логах має бути `keycrm_webhook_intake`.

## 2. Telegram -> бот
1. URL: `https://<your-domain>/webhook/telegram`
2. `setWebhook` з `secret_token = TELEGRAM_REACTION_SECRET_TOKEN`
3. Увімкнені `message_reaction_count` updates для чату/треду.

Перевірка:
1. Поставити ❤️ під повідомленням з файлом замовлення.
2. Переконатись, що у логах є `telegram_webhook_intake`.
3. Перевірити зміну статусу в CRM.

## 3. Безпека
1. Webhook endpoints доступні тільки через HTTPS.
2. Секрети довгі і випадкові (не менше 24 символів).
3. Секрети не зберігаються в репозиторії.

## 4. Що перевірити після зміни webhook
1. `/health` працює.
2. Обидва webhook повертають `202`.
3. Queue не переповнюється.
4. В ops-чат не сипляться `critical` алерти.
