# Custom Gifts Bot

TypeScript-сервіс для повного циклу обробки замовлень із `KeyCRM`:
- прийом webhook подій;
- побудова layout plan;
- рання валідація кейсів `Без файлу`;
- генерація PDF-матеріалів;
- відправка комплекту в Telegram topic `ОБРОБКА`;
- реакційний workflow через `❤️`;
- пересилання комплекту в topic `ЗАМОВЛЕННЯ`;
- зміна статусів у CRM;
- retry / DLQ / retention / idempotency.

## Що робить проєкт

Сервіс приймає подію `order.change_order_status` з KeyCRM, обробляє замовлення на статусі `Матеріали = 20`, формує файли для друку і відправляє їх у Telegram. Далі оператор ставить реакцію під PDF-повідомленням, після чого сервіс змінює CRM-статус і пересилає комплект у наступну робочу гілку.

## Простий порядок обробки замовлення

1. KeyCRM надсилає webhook про зміну статусу.
2. `receiver` кладе job у `order_intake`.
3. `order-worker` забирає job і ще раз перевіряє, що order реально стоїть у `Матеріали = 20`.
4. Будується `layout plan`:
   - які PDF треба зробити;
   - які є прапорці (`QR +`, `LF +`, `A6 +`, `B +`);
   - які є preview;
   - які є warning-и.
5. Далі йдуть ранні перевірки:
   - немає `_tib_design_link_1`:
     - якщо є `preview` -> шлемо alert `Не вдалося сформувати PDF`, але CRM-статус не змінюємо;
     - якщо `preview` немає -> одразу `40 / Без файлу`;
   - є engraving/sticker, але немає тексту -> одразу `40 / Без файлу`;
   - `_tib_design_link_1` є, але CDN/TeeInBlue дає `403/404` -> CRM статус не змінюємо, тільки шлемо alert `Не вдалося сформувати PDF`.
6. Якщо ранніх блокерів немає, запускається PDF pipeline.
7. Готові preview і PDF летять у Telegram topic `ОБРОБКА`.
   - перше preview показує також текст гравіювання і стікера, якщо вони є;
   - у стікері emoji автоматично вирізаються, лишається тільки plain text.
8. Оператор ставить `❤️` під PDF.
9. `reaction-worker` змінює CRM статус на `22 / Друк` і копіює PDF у topic `ЗАМОВЛЕННЯ`.

## Коли PDF не формується: матриця рішень

| Сценарій | Що робить система | CRM статус | Retry / DLQ | Alert |
|---|---|---|---|---|
| `webhook.status_id != materialsStatusId` або `order.status_id != materialsStatusId` | Intake job `skip`, PDF pipeline не стартує | Без змін | Ні | Ні (тільки `info` лог) |
| Немає `_tib_design_link_1` і **немає** preview | Зупинка до PDF pipeline | `missingFileStatusId` (`40`) | Ні | `error` в processing + ops |
| Немає `_tib_design_link_1`, але preview **є** | Зупинка до PDF pipeline | Без змін | Ні | `error` в processing + ops (`Не вдалося сформувати PDF`) |
| Немає тексту engraving/sticker | Зупинка до PDF pipeline | `missingFileStatusId` (`40`) | Ні | `error` в processing + ops |
| `_tib_design_link_1` є, але download дає `403/404` | PDF pipeline зупиняється як deterministic `source unavailable` | Без змін | Ні | `error` в processing + ops (`Не вдалося сформувати PDF`) |
| Інші помилки PDF (`pdf_generation`) | Worker кидає `OrderProcessingError`, queue робить retry | На retry-етапі без змін; при DLQ -> `missingFileStatusId` (`40`) | Так | При DLQ: `critical` в ops (`Job moved to DLQ`) |

## Основні компоненти

- `receiver`
  - HTTP-сервіс із маршрутами `/webhook/keycrm`, `/webhook/telegram`, `/health`
- `order-worker`
  - обробка webhook job, генерація PDF, Telegram delivery
- `reaction-worker`
  - обробка Telegram reaction job, зміна статусу, forwarding
- `postgres`
  - durable queue, idempotency, workflow state, delivery state, forwarding state, DLQ

## Архітектурні принципи

- runtime більше не залежить від `reference/legacy-js`
- операційний state зберігається в PostgreSQL
- routing і reaction rules bootstrap-яться з env/json, але працюють через БД
- PDF/temp файли зберігаються локально тимчасово і чистяться retention-політикою
- deterministic кейси відсікаються до або під час старту PDF pipeline:
  - `немає _tib_design_link_1`:
    - якщо `preview` є -> тільки alert `Не вдалося сформувати PDF`, CRM статус не змінюється
    - якщо `preview` немає -> CRM `40 / Без файлу`
  - `немає тексту для engraving/sticker` -> CRM `40 / Без файлу`
  - `_tib_design_link_1` є, але CDN дає `403/404` -> CRM статус не змінюється, у Telegram іде alert `Не вдалося сформувати PDF`
- white cleanup повернутий до legacy-aggressive preset:
  - `WHITE_REPLACE_ITERATIONS = 3`
  - `WHITE_FINAL_ITERATIONS = 3`
  - жорсткіший near-white selection для прибирання залишкового білого
- решта технічних помилок типізуються і відправляються в retry / DLQ

## Як зараз працюють retry

- retry є тільки там, де worker кидає `retryable` помилку
- `order_intake` має `maxAttempts = 3`
- `reaction_intake` має `maxAttempts = 2`
- retry потрібен для тимчасових проблем:
  - timeout CRM;
  - network/fetch помилка;
  - `429/5xx` від Telegram;
  - тимчасовий збій PDF pipeline
- retry немає для deterministic кейсів:
  - немає `_tib_design_link_1`
  - немає тексту engraving/sticker
  - source URL дає `403/404`

## Стек

- `Node.js 20`
- `TypeScript`
- `PostgreSQL`
- `Docker / Docker Compose`
- `Traefik`
- `pdf-lib`, `sharp`, `ghostscript`

## Ключові команди

Локальна перевірка:

```bash
npm run check
npm run build
npm test
```

Локальний запуск:

```bash
docker compose -f docker-compose.local.yml up -d
npm run dev
```

Продовий запуск:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d postgres
docker compose -f docker-compose.prod.yml --env-file .env.production --profile ops run --rm migrate
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build receiver order-worker reaction-worker
```

## Серверні test/ops сценарії

Скрипти вже входять у production image і запускаються з контейнера:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver \
  npm run test:orders:reset-state -- --order-ids=29068 --include-history
```

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver \
  npm run test:order:trigger -- --order-id=29068
```

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver \
  npm run test:orders:snapshot -- --order-ids=29068,29069
```

## Важливо про storage

- фінальні PDF не видаляються одразу після Telegram delivery
- вони чистяться retention-процесом за `OUTPUT_RETENTION_HOURS`
- temp-артефакти додатково чистяться всередині самого PDF pipeline

## Документація

Головні документи:

- [docs/README.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/docs/README.md)
- [docs/PROJECT_CONTROL.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/docs/PROJECT_CONTROL.md)
- [docs/RUNBOOK.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/docs/RUNBOOK.md)
- [docs/SERVER_DEPLOY_CGBOT.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/docs/SERVER_DEPLOY_CGBOT.md)
- [docs/LOCAL_REAL_MODE_TESTING.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/docs/LOCAL_REAL_MODE_TESTING.md)

## Поточний production-контур

- домен: `cgbot.workflo.space`
- reverse proxy: `Traefik`
- timezone: `Europe/Kyiv`
- container names: `cgbot-prod-*`
- health endpoint: `/health`

## Статус

Поточний стан проєкту підготовлений до серверного UAT:
- live `message_reaction` підтриманий;
- production image збирається без `reference`;
- міграції, DB queue, retention і forwarding покриті тестами;
- продовий compose і серверний runbook вирівняні під реальний запуск.
