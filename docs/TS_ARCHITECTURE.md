# Цільова архітектура TypeScript-проєкту

## 1. Цілі
- Переписати поточний JS-сервіс у TypeScript без втрати бізнес-логіки.
- Розділити систему на невеликі модулі з чіткими контрактами.
- Забезпечити стабільну роботу webhook, черг, PDF-процесингу і Telegram-відправки.
- Закласти основу для довготривалої підтримки і поступового масштабування.

## 2. Основні принципи
- `TypeScript strict mode` з максимально явними типами домену.
- Всі зовнішні інтеграції ізольовані адаптерами.
- Бізнес-правила винесені в конфіг і не захардкоджені в оркестрації.
- Webhook receiver не виконує важку роботу синхронно.
- PDF-обробка відокремлена від HTTP-приймача.
- Всі критичні дії логуються структуровано.
- Всі нештатні ситуації ведуть до retry, DLQ або алерта.

## 3. Цільовий production flow

```mermaid
flowchart TD
    A["KeyCRM webhook"] --> B["Webhook Receiver"]
    B --> C["Idempotency Check"]
    C --> D["Order Intake Queue"]
    D --> E["Order Worker"]
    E --> F["CRM Fetch / Enrichment"]
    F --> G["Layout Planner"]
    G --> H["PDF Pipeline"]
    H --> I["Telegram Delivery"]
    I --> J["Telegram Message Mapping"]
    K["Telegram reaction webhook"] --> L["Reaction Queue"]
    L --> M["Reaction Worker"]
    M --> N["CRM Status Update"]
    E --> O["Ops Alerts"]
    H --> O
    I --> O
    M --> O
```

## 4. Рекомендована структура проєкту

```text
src/
  app/
    server.ts
    bootstrap.ts
  config/
    load-config.ts
    validate-config.ts
    business-rules/
      product-code-rules.json
      qr-rules.json
      reaction-rules.json
      status-rules.json
      alert-rules.json
  domain/
    orders/
      order.types.ts
      order-normalizer.ts
    materials/
      material.types.ts
      layout-plan.types.ts
    reactions/
      reaction.types.ts
    pdf/
      pdf.types.ts
  modules/
    crm/
      crm-client.ts
      crm-order-service.ts
      crm-status-service.ts
    webhook/
      keycrm-webhook.controller.ts
      telegram-webhook.controller.ts
      webhook-auth.ts
    queue/
      queue.types.ts
      queue-service.ts
      queue-jobs.ts
      dead-letter.ts
    orders/
      order-orchestrator.ts
      order-idempotency.ts
    layout/
      sku-classifier.ts
      format-resolver.ts
      stand-type-resolver.ts
      filename-builder.ts
      layout-plan-builder.ts
    pdf/
      poster-fetcher.ts
      white-recolor.ts
      cmyk-converter.ts
      qr-embedder.ts
      spotify-code.ts
      engraving-generator.ts
      sticker-generator.ts
      pdf-pipeline.ts
    telegram/
      telegram-client.ts
      telegram-delivery.ts
      telegram-alerting.ts
      telegram-message-store.ts
    reactions/
      reaction-counter.ts
      reaction-workflow.ts
    observability/
      logger.ts
      metrics.ts
      alerting.ts
  workers/
    order-worker.ts
    reaction-worker.ts
    pdf-worker.ts
  storage/
    files/
    temp/
  scripts/
  tests/
```

## 5. Ролі модулів
- `webhook`
  - приймає webhook, валідовує, нормалізує payload, ставить задачу в чергу.
- `crm`
  - відповідає тільки за читання і запис у CRM.
- `orders`
  - керує всім життєвим циклом одного замовлення.
- `layout`
  - визначає, які матеріали потрібні, як вони називаються і в якому порядку йдуть.
- `pdf`
  - вся важка логіка PDF, CMYK, QR, Spotify code, engraving, sticker.
- `telegram`
  - відправка файлів, прев'ю, alert-повідомлень, mapping message id -> order id.
- `reactions`
  - обробка сердець у Telegram і оновлення статусів у CRM.
- `queue`
  - постановка задач, retry, DLQ, обмеження concurrency.
- `observability`
  - логи, метрики, warning/error notifications.

## 6. Черги і типи job
Рекомендовані типи задач:
- `order.intake`
  - основна постановка order у роботу після webhook.
- `order.process`
  - повна обробка замовлення.
- `pdf.generate`
  - важка PDF-фаза, яку краще відокремити.
- `telegram.send`
  - доставка прев'ю і файлів.
- `reaction.process`
  - обробка реакцій Telegram.
- `alerts.send`
  - аварійні повідомлення в ops-чат.

## 7. Рекомендована модель надійності
- Receiver відповідає `200/202` після успішного enqueue, а не після повної обробки.
- Кожен job має `idempotency key`.
- Повторний webhook по тому самому замовленню не має дублювати результати.
- Всі critical jobs мають retry з backoff.
- Після вичерпання retry задача переходить у `DLQ`.
- При переході в `DLQ` бот шле alert у технічний чат.

## 8. Пріоритети довіри до даних
Для whitelisted SKU:
- explicit mapping із ТЗ і конфігів.
- `offer.properties`.
- `product.properties`.
- евристика по `Variant`, `name`, `sku`.

Для невідомих SKU:
- `offer.properties`.
- `product.properties`.
- `Variant`, `name`, `sku`.

## 9. Мінімальний конфіг, який має змінюватися без коду
- `status_id` для всіх переходів.
- список emoji і кількість реакцій для кожного статусного переходу.
- whitelist SKU для QR і Spotify code.
- special mapping SKU -> poster code.
- mapping значень підставки -> `W`, `WW`, `MWW`, `C`, `K`.
- параметри placement для QR/Spotify.
- Telegram chat ids для production і ops alerts.
- policy для retry і alert severity.

## 10. Логування
Логи мають бути структуровані.

Рекомендовані поля:
- `timestamp`
- `level`
- `service`
- `module`
- `event`
- `order_id`
- `job_id`
- `chat_id`
- `message_id`
- `status_id`
- `sku`
- `duration_ms`
- `error_code`
- `error_message`

## 11. Alerts у Telegram
Окремий технічний чат або topic потрібен для:
- падіння CRM API;
- падіння Telegram API;
- провалу PDF generation;
- переходу задачі в DLQ;
- помилок конфігурації при старті;
- переповнення черги;
- нестачі місця на диску;
- зависання worker.

## 12. CPU / RAM оцінка
Оцінка консервативна, для одного worker-процесу.

Легка стадія:
- webhook / CRM / Telegram metadata
- CPU: низьке
- RAM: `80-200 MB`

PDF-стадія:
- A5 при `600 DPI` може давати пік RAM приблизно `250-500 MB` на один активний PDF-pass
- A4 при `600 DPI` може давати пік RAM приблизно `450-900 MB` на один активний PDF-pass
- кілька проходів recolor + CMYK + Ghostscript можуть піднімати піки ще вище

Практичне правило:
- на одному worker не варто паралелити більше `1` важкого PDF job без окремого stress-тесту;
- для невеликого production краще мати:
  - `1` receiver process
  - `1` order worker
  - `1` PDF worker з concurrency `1`
  - `1` reaction worker

## 13. Вузькі місця
- Ghostscript і rasterization PDF.
- тимчасові PNG/PDF файли на диску.
- великі прев'ю або биті source PDF.
- rate limit Telegram API.
- дубльовані webhook.
- неузгоджені SKU та `offer.properties`.

## 14. Що робити в production
- Розділити HTTP receiver і heavy worker хоча б логічно, краще процесно.
- Тримати durable queue поза memory-only режимом.
- Зберігати технічні mapping-и і idempotency state у persistent storage.
- Зберігати generated files і temp files з чіткою політикою cleanup.
- Мати healthcheck, readiness check і queue backlog monitoring.

## 15. Рекомендована production-модель
Базова надійна схема для цього бізнес-процесу:
- `1` Node.js/TypeScript receiver service
- `1` durable queue backend
- `1-2` worker services
- persistent storage для message mapping, idempotency, DLQ, audit trail
- локальний диск або object storage для артефактів PDF

Це не overengineering для “не мільйона користувачів”, бо головний ризик тут не трафік, а стабільність важкого PDF-процесу і відновлення після помилок.
