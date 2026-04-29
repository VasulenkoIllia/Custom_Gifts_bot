# Архітектурний аудит (2026-04-29)

## Обсяг перевірки
- security: валідація webhook secrets у `validateConfig`;
- runtime bootstrap, lifecycle та graceful shutdown;
- queue механіка: lease, heartbeat, DLQ, retry, idempotency;
- PostgreSQL connection pool під multi-worker deployment;
- ops alerts і їх стійкість при рестартах;
- Docker deployment (Dockerfile, docker-compose.prod.yml);
- документація (актуальність усіх `docs/`);
- тести (покриття, структура).

## Висновок
Архітектура надійна і продумана. Система готова до production за умови закриття одного критичного Security-issue (порожній webhook secret).

**Оцінки:**
- Архітектура: `A-` (queue-driven, lease-based, idempotency, DLQ, role separation)
- Безпека: `C+` (один відкритий bypass, потребує негайного виправлення)
- Стресостійкість: `B+` (overflow protection, retry, graceful shutdown є; circuit breaker і queue depth alerting відсутні)
- Тести: `B+` (114 tests, хороше покриття business logic; integration tests з реальним PostgreSQL відсутні)
- Документація: `A-` (детальна, структурована, актуальна)

## Критичні проблеми

### 1. Webhook secret bypass при порожньому значенні (Security)
**Файли:** `src/config/validate-config.ts`, `src/modules/webhook/webhook-auth.ts`

`validateConfig` не перевіряє непустоту `KEYCRM_WEBHOOK_SECRET` і `TELEGRAM_REACTION_SECRET_TOKEN`.
При `KEYCRM_WEBHOOK_SECRET=` (порожній рядок):
- `validateWebhookSecret` повертає `true` через `if (!expectedSecret) return true`
- Обидва webhook endpoints стають публічними без авторизації

**Виправлення:** додати в `validateConfig`:
```ts
if (!config.keycrmWebhookSecret) throw new Error("KEYCRM_WEBHOOK_SECRET is required.");
if (!config.telegramReactionSecretToken) throw new Error("TELEGRAM_REACTION_SECRET_TOKEN is required.");
```

**Статус:** відкрито, потребує виправлення перед production.

## Важливі проблеми

### 2. Вичерпання PostgreSQL connection pool при масштабуванні
**Файл:** `.env.production.example` → `DATABASE_POOL_MAX=20`

З 4 order-workers × 20 connections + receiver + reaction-worker = ~120 connections.
PostgreSQL default `max_connections = 100`.

**Рекомендація:** знизити `DATABASE_POOL_MAX` до 8-10 на контейнер,
або явно підняти `max_connections` у docker-compose для postgres.

### 3. In-memory dedupe у OpsAlertService
**Файл:** `src/modules/alerts/ops-alert.service.ts`

`dedupeMap` втрачається при кожному рестарті контейнера.
Після краш-рестарту протягом `dedupeWindowMs` (60s) однакові алерти можуть надходити повторно.

### 4. Shutdown + `Promise.allSettled` поглинає помилки queue.close()
**Файл:** `src/app/runtime.ts`

При timeout під час shutdown помилки `orderQueue.close()` / `reactionQueue.close()` мовчки ігноруються.
Рекомендовано залогувати результат `allSettled`.

## Дизайнові питання

### 5. `projectPhase: "stage_f_pdf_pipeline"` — артефакт розробки
**Файл:** `src/config/config.types.ts`, `src/config/load-config.ts`

Захардкоджено. Відображається у `/health` відповідях та логах. Потрібно прибрати або зробити конфігурованим.

### 6. `order-worker` у docker-compose без container_name і без явного scale
**Файл:** `docker-compose.prod.yml`

Запуск кількох voркерів виконується через `docker compose up --scale order-worker=4` але це не задокументовано у compose-файлі.

### 7. `hashtext()` advisory lock — 32-bit hash
**Файл:** `src/modules/queue/db-queue.service.ts`

Теоретична колізія між різними queue names при розширенні системи.

### 8. `DbIdempotencyStore.trimIfNeeded` — race condition при trim
Видалення найстаріших ключів не є атомарним. Прийнятно для trim-операції, але може зрідка видалити свіжо-вставлений ключ.

## Незакриті місця (known gaps)

- Відсутній алерт при накопиченні черги (queue depth > N протягом M хвилин)
- Відсутній circuit breaker для зовнішніх API (Telegram, CRM, Spotify)
- Відсутні integration tests з реальним PostgreSQL
- Немає механізму автоматичного reprocessing з DLQ
- `CUTTLY_API_KEY` може бути порожнім — при обох порожніх shortener keys QR генерується з довгим URL

## Що НЕ є проблемою
- Lease + heartbeat: надійно захищає від duplicate processing
- DLQ: повна трасабельність всіх failed jobs
- Idempotency: атомарна вставка через PostgreSQL ON CONFLICT
- Graceful shutdown: SIGINT/SIGTERM → drain → close pool
- Config validation: ~60 перевірок на старті
- Migration checksum: SHA-256 захист від змін
- Health endpoints: liveness + readiness (disk, DB, Ghostscript)
