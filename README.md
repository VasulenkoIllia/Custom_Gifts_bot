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
- deterministic missing-file кейси (`немає _tib_design_link_1`, `немає тексту для engraving/sticker`) відсікаються до PDF pipeline
- решта технічних помилок типізуються і відправляються в retry / DLQ

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
