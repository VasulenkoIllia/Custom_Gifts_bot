# Server Deploy: cgbot.workflo.space

## 1. Files to upload
- repo code
- `docker-compose.prod.yml`
- `.env.production` built from [/.env.server.cgbot](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/.env.server.cgbot)

Примітка:
- runtime image already contains `tzdata`, `ghostscript`, app `dist/` and operational `dist/scripts/*`;
- `receiver`, `order-worker`, `reaction-worker` run with `init: true`, so child processes from PDF pipeline are reaped correctly.

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
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build receiver order-worker reaction-worker
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
  `https://cgbot.workflo.space/webhook/keycrm?secret=vp5qJ_on7988BYzoKKNl3dKiaqmL9RDg`
- Telegram:
  `https://cgbot.workflo.space/webhook/telegram`

Telegram setup:
```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://cgbot.workflo.space/webhook/telegram",
    "secret_token": "c_q8ysmx7XbUfrCP2FfQsSPU1Z7K9ILO",
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
