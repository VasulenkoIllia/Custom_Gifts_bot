# Local Order Business Testing

## Призначення
Цей сценарій перевіряє тільки бізнес-логіку обробки замовлення:
- читання real payload з KeyCRM;
- побудову `layout plan`;
- naming `CGU_*`;
- прапори `QR +`, `LF +`, `A6 +`, `B +`;
- QR whitelist/decision;
- ризики по даних замовлення.

Сценарій **не** відправляє повідомлення в Telegram і **не** змінює статуси в CRM.

## Regression order set
Зафіксований набір лежить у [config/test-orders/business-logic-order-set.json](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/config/test-orders/business-logic-order-set.json).

Поточні відкриті питання по цьому regression-набору зібрані окремо в [docs/REGRESSION_ORDER_OPEN_QUESTIONS.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/docs/REGRESSION_ORDER_OPEN_QUESTIONS.md).

Звірка `очікується vs фактично` лежить у [docs/REGRESSION_ORDER_EXPECTED_VS_ACTUAL.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/docs/REGRESSION_ORDER_EXPECTED_VS_ACTUAL.md).

Базовий набір:
- `29061`
- `29062`
- `29063`
- `29064`
- `29065`
- `29066`
- `29067`
- `29068`
- `29069`
- `29070`
- `29071`
- `29072`
- `29073`
- `29074`
- `29075`

## Передумови
1. У `.env` мають бути валідні:
   - `KEYCRM_API_BASE`
   - `KEYCRM_TOKEN`
   - `KEYCRM_ORDER_INCLUDE`
2. Доступний internet access до KeyCRM API.
3. Встановлені залежності `npm install`.

Примітка по shell:
- для запуску `npm run ...` з `.env` використовуй:
  `set -a; source .env; set +a;`
- простого `source .env` недостатньо.

## Запуск
Весь regression set:

```bash
set -a; source .env; set +a;
npm run test:orders:business
```

Окремі замовлення:

```bash
set -a; source .env; set +a;
npm run test:orders:business -- --order-ids=29061,29068,29071
```

JSON output:

```bash
set -a; source .env; set +a;
npm run test:orders:business -- --json
```

## Як читати звіт
На кожне замовлення виводиться:
- `status`, `source`, `products`, `auto`, `total`;
- `flags` і `notes`;
- очікувані імена файлів;
- QR outcome по poster SKU;
- `risks` з рівнями `INFO`, `WARNING`, `CRITICAL`.

Типові ризики:
- `status_not_materials`
  замовлення не на статусі `Матеріали`, тому webhook path його не обробить;
- `top_level_addons`
  add-on лежить окремим top-level product і може бути чутливим до linkage-логіки;
- `alternative_parent_keys`
  у payload є нестандартні parent-key поля;
- `preview_fallback`
  poster бере source з preview, а не з design PDF;
- `missing_design_source`
  у замовленні не знайдено design/preview source;
- `missing_addon_text`
  engraving/sticker замовлено без тексту;
- `qr_not_embedded`
  опція QR є, але SKU поза whitelist для embed; у Telegram caption має з'явитися червоне попередження `🚨`, що QR не згенеровано і не вбудовано.

Актуальна цільова поведінка:
- preview не може використовуватись як друкарський source;
- engraving/sticker без тексту не повинні створювати blank PDF;
- warning-и мають стояти на початку Telegram caption;
- якщо warning-ів немає, caption починається з `✅`.
