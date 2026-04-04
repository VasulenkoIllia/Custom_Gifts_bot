# Server Deploy: cgbot.workflo.space

## 1. Files to upload
- repo code
- `docker-compose.prod.yml`
- `.env.production` built from [/.env.server.cgbot](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/.env.server.cgbot)

## 2. Traefik assumptions
- Traefik already runs on the server
- external docker network `proxy` already exists
- DNS `cgbot.workflo.space` already points to the server IP
- certificate resolver name is `cf`

## 3. Start sequence
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d postgres
docker compose -f docker-compose.prod.yml --env-file .env.production --profile ops run --rm migrate
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build receiver order-worker reaction-worker
curl -fsS https://cgbot.workflo.space/health
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
