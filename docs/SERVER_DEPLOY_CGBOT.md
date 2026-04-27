# Server Deploy: cgbot.workflo.space

## 1. Files to upload

Все що потрібно — в репозиторії. Окремих файлів завантажувати не треба.

На сервері потрібен лише один приватний файл поза Git:
- `.env.production` — створити з треканого шаблону [/.env.production.example](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/.env.production.example) і заповнити реальними production secrets на сервері.
- Локальні файли `.env.*`, крім прикладів, ігноруються через `.gitignore`; не комітити server-specific env із токенами або webhook secrets.

Примітки:
- `config/business-rules/` (включно з `high-detail-skus.json`) вбудовані в Docker image через `COPY config ./config` — монтувати або завантажувати окремо не потрібно.
- `assets/fonts/Caveat-VariableFont_wght.ttf` також вбудований у Docker image.
- Runtime image містить `tzdata`, `ghostscript`, `dist/` і `dist/scripts/*`.
- `receiver`, `order-worker`, `reaction-worker` запускаються з `init: true` — child-процеси GhostScript коректно збираються після завершення.
- Деталі PDF pipeline: [docs/CURRENT_PDF_PIPELINE.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/docs/CURRENT_PDF_PIPELINE.md).

## 1.1 Актуальні значення PDF pipeline і воркерів

```bash
# DPI routing: SKU з high-detail-skus.json → 1200, решта → 800
RASTERIZE_DPI=800
RASTERIZE_DPI_HIGH_DETAIL=1200
PDF_HIGH_DETAIL_SKUS_PATH=config/business-rules/high-detail-skus.json

# Паралельність: 4 незалежних order-worker контейнери, кожен обробляє 1 замовлення
# ORDER_QUEUE_CONCURRENCY=1: 1 замовлення на воркер (без внутрішньої конкуренції за GhostScript)
# RASTERIZE_CONCURRENCY=1: 1 GhostScript процес на воркер
# Разом: 4 замовлення паралельно, 4 незалежних GhostScript слоти
ORDER_QUEUE_CONCURRENCY=1
RASTERIZE_CONCURRENCY=1

# Колір і якість
PDF_COLOR_SPACE=CMYK
OFFWHITE_HEX=F7F6F2
PDF_FINAL_PREFLIGHT_MEASURE_DPI=200
```

Якщо `PDF_HIGH_DETAIL_SKUS_PATH` відсутній, нечитабельний або порожній — сервіс не стартує (fail-fast).

### Чому 4 воркери замість 1 з high concurrency

Тестування показало що спільний GhostScript семафор у одному процесі при 4+ паралельних замовленнях створює чергу очікування до 6-8 хвилин на preflight фазу. З 4 окремими воркерами (кожен зі своїм семафором) preflight займає 14-18 секунд, а замовлення обробляються ізольовано без взаємного блокування.

Порівняння конфігурацій на однакових 5 замовленнях:

| Конфігурація | A5 (1 файл) | A4+A5×2 (3 файли) |
|---|---|---|
| 1 воркер, concurrency=2 | 3-8 хв | 12 хв |
| 1 воркер, concurrency=4 | 10-13 хв | 13 хв |
| 2 воркери, concurrency=2 | 4-8 хв | 9 хв |
| **4 воркери, concurrency=1** | **1.5-2.5 хв** | **8 хв** |

## 2. Traefik assumptions
- Traefik already runs on the server
- external docker network `proxy` already exists
- DNS `cgbot.workflo.space` already points to the server IP
- certificate resolver name is `cf`

## 3. Production update sequence (verified)
```bash
git fetch --all --prune
git checkout main
git pull --ff-only

docker network inspect proxy >/dev/null 2>&1 || docker network create proxy

# optional: stop app services to avoid restart-loop noise during migration
docker compose -f docker-compose.prod.yml --env-file .env.production stop receiver order-worker reaction-worker

docker compose -f docker-compose.prod.yml --env-file .env.production up -d postgres
docker compose -f docker-compose.prod.yml --env-file .env.production --profile ops run --rm migrate

# запустити receiver і reaction-worker як раніше, order-worker — з 4 репліками
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build receiver reaction-worker
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build --scale order-worker=4
```

### 3.1 Одноразова підготовка хоста (виконати один раз на сервері)

Зменшити агресивність swap — ядро не виштовхуватиме сторінки у swap поки є вільна RAM:
```bash
# застосувати зараз
sysctl vm.swappiness=10

# зробити постійним
echo "vm.swappiness=10" >> /etc/sysctl.conf
```

Очистити swap після деплою нових воркерів з mem_limit (виконати у тихий час):
```bash
# переміщує сторінки зі swap назад в RAM, потім очищає swap
# безпечно якщо вільної RAM > обсягу зайнятого swap
swapoff -a && swapon -a
```

Recommended checks right after update:
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production ps
docker compose -f docker-compose.prod.yml --env-file .env.production logs --tail=100 receiver
docker compose -f docker-compose.prod.yml --env-file .env.production logs --tail=100 order-worker
docker compose -f docker-compose.prod.yml --env-file .env.production logs --tail=100 reaction-worker

# internal app check (inside receiver container)
docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver \
  node -e "fetch('http://127.0.0.1:3000/health').then(async r=>{console.log(r.status);console.log(await r.text())}).catch(e=>{console.error(e);process.exit(1)})"

# local Traefik check from the server host
curl -sk https://127.0.0.1/health -H 'Host: cgbot.workflo.space'

# external domain check
curl -fsS https://cgbot.workflo.space/health
```

Important:
- use `GET` checks for `/health` (`curl .../health`);
- `curl -I`/HEAD can return `404`, because runtime handler exposes `/health` for `GET`.

### 3.1 Quick failure diagnosis
If app services keep restarting with:
`Missing migration 0002_retention_performance_indexes.sql...`

run migration explicitly:
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production --profile ops run --rm migrate
```

and verify:
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres \
  psql -U "${POSTGRES_USER:-custom_gifts}" -d "${POSTGRES_DB:-custom_gifts_bot}" \
  -c "SELECT filename, applied_at FROM schema_migrations ORDER BY filename;"
```

## 4. Webhooks
- KeyCRM:
  `https://cgbot.workflo.space/webhook/keycrm?secret=<KEYCRM_WEBHOOK_SECRET>`
- Telegram:
  `https://cgbot.workflo.space/webhook/telegram`

Telegram setup:
```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://cgbot.workflo.space/webhook/telegram",
    "secret_token": "<TELEGRAM_REACTION_SECRET_TOKEN>",
    "allowed_updates": ["message_reaction", "message_reaction_count"],
    "drop_pending_updates": true
  }'
```

## 5. Ops scripts available inside the container
All test/ops scripts are shipped in the production image and can be executed via `npm run ...` inside `receiver`.

One order reset:
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver \
  npm run test:orders:reset-state -- --order-ids=29068 --include-history
```

Whole regression test-set reset:
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver \
  npm run test:orders:reset-state -- --include-history
```

Manual trigger of one order:
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver \
  npm run test:order:trigger -- --order-id=29068
```

PDF pipeline validation examples:
```bash
# standard SKU order should log rasterizeDpi=800 and Telegram caption DPI: 800
docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver \
  npm run test:order:trigger -- --order-id=<STANDARD_ORDER_ID>

# high-detail SKU order should log rasterizeDpi=1200 and Telegram caption DPI: 1200
docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver \
  npm run test:order:trigger -- --order-id=<HIGH_DETAIL_ORDER_ID>
```

Snapshot statuses before tests:
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver \
  npm run test:orders:snapshot -- --order-ids=29068,29069
```

Restore statuses from snapshot:
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production exec receiver \
  npm run test:orders:restore -- --snapshot=artifacts/order-status-snapshots/<snapshot-file>.json
```

## 6. Storage behavior
- final generated PDF files are stored temporarily in `OUTPUT_DIR` and are not deleted immediately after Telegram delivery;
- technical temp artifacts are mostly cleaned during the PDF pipeline itself;
- periodic retention cleanup removes old `OUTPUT_DIR` and `TEMP_DIR` contents by age.

Default retention values from `.env.production`:
- `OUTPUT_RETENTION_HOURS=168`
- `TEMP_RETENTION_HOURS=24`
- `CLEANUP_INTERVAL_MS=3600000`

## 7. Post-deploy PDF checks

After the first server test orders, verify:

- `order-worker` logs contain `pdf_pipeline_started` with `rasterizeDpi=800` for standard SKU orders.
- `order-worker` logs contain `pdf_pipeline_started` with `rasterizeDpi=1200` for high-detail SKU orders.
- Telegram caption contains `DPI`, `strict`, `agg`, `corrected`, and `Час опрацювання`.
- Normal orders should usually have `corrected=0` with `OFFWHITE_HEX=F7F6F2`.
- `pdf_pipeline_finished.finalPreflightCorrectedPixels` should stay `0` or close to `0` on most orders.
- З 4 воркерами `gs` процеси не повинні перевищувати 4 одночасно (1 per worker).
- Перевірити що запущено саме 4 order-worker контейнери: `docker compose ... ps | grep order-worker` має показати `order-worker-1..4`.
