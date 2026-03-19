# Production, черги, логування і відмовостійкість

## 1. Як має працювати webhook у production
- KeyCRM надсилає webhook у receiver.
- Receiver валідовує запит.
- Receiver створює idempotency key.
- Receiver ставить job у queue.
- Receiver швидко відповідає `200` або `202`.
- Важка обробка виконується worker-процесом, а не в HTTP request.

## 2. Чому так
Основна важка частина системи:
- fetch order
- завантаження PDF
- rasterization
- recolor
- CMYK conversion
- QR embed
- Telegram send

Це не можна надійно тримати всередині HTTP webhook handler, бо:
- будуть довгі відповіді;
- можуть бути timeout;
- падіння Ghostscript або PDF-pass може обірвати весь request;
- складно робити retry predictably.

## 3. Рекомендована queue-модель
- Intake queue
  - приймає order webhook.
- Order processing queue
  - повна обробка бізнес-логіки замовлення.
- PDF queue
  - окрема важка стадія з low concurrency.
- Telegram queue
  - доставка матеріалів і прев'ю.
- Reaction queue
  - обробка сердець.
- Dead-letter queue
  - задачі, які не пройшли після всіх retry.

## 4. Retry policy
- CRM fetch/update
  - короткі retry з exponential backoff.
- Telegram send
  - retry на rate limit і transient network errors.
- PDF generation
  - обережний retry тільки на transient помилках;
  - на deterministic помилках одразу alert і DLQ.

## 5. Що вважати deterministic помилкою
- відсутній source PDF
- битий source URL
- відсутній потрібний mapping SKU
- конфігурація placement поза межами сторінки
- відсутній обов'язковий файл шрифту

## 6. Що вважати transient помилкою
- timeout CRM
- `429` або `5xx` від Telegram
- тимчасова мережева помилка
- короткочасний збій зовнішнього URL preview/source

## 7. Ідемпотентність
Потрібні окремі idempotency ключі:
- `order webhook`
  - `order_id + status_id + status_changed_at`
- `telegram delivery`
  - `order_id + layout_plan_hash`
- `reaction update`
  - `chat_id + message_id + heart_stage`

## 8. Логування
Рівні:
- `info`
- `warn`
- `error`
- `fatal`

Обов'язкові події:
- webhook received
- webhook enqueued
- order fetched
- layout plan built
- pdf generation started/completed/failed
- telegram send started/completed/failed
- reaction processed
- crm status updated
- queue retry
- dlq entered
- alert sent

## 9. Alerts від бота
Бот має писати в технічний чат:
- `warning`
  - частковий збій, але процес іде далі
- `error`
  - замовлення не оброблено
- `critical`
  - черга зупинилась, PDF worker падає, CRM/Telegram недоступні, диск заповнений

Мінімальний формат alert:
- рівень
- модуль
- order id
- короткий опис
- retry count
- що робити оператору

## 10. Робота з PDF як головне вузьке місце
Стабільність PDF pipeline вища за швидкість.

Потрібно:
- concurrency limit для PDF jobs
- таймаути child process
- окремі temp directories на job
- cleanup у `finally`
- контроль розміру тимчасових файлів
- checksum або repeatability checks для результату
- логування кожного кроку pipeline

## 11. CPU / RAM практика
Для невеликого production:
- receiver можна тримати легким
- PDF worker має бути ізольований
- concurrency PDF = `1` на старті
- order worker concurrency = `1-2` після stress-test

Якщо RAM `4 GB`:
- починати з `1` активного важкого PDF job

Якщо RAM `8 GB+`:
- можна тестувати `2` важких PDF job, але тільки після вимірювань

## 12. Storage
Потрібно мати:
- temp directory
- generated files directory
- message mapping storage
- idempotency storage
- DLQ storage

Не можна:
- тримати чергу тільки в пам'яті
- покладатися лише на локальний процес без recovery state

## 13. Теоретичні проблеми і вузькі місця
- дубльовані webhook з CRM
- неузгоджені дані в CRM properties
- rate limit Telegram
- великі або биті PDF
- витоки temp files
- переповнення диска
- одночасна обробка кількох “важких” order
- повторні reaction webhook

## 14. Як це має працювати в проді
Базовий надійний варіант:
- один receiver process
- один order worker
- один pdf worker
- один reaction worker
- persistent queue/storage
- окремий Telegram ops chat

## 15. Runbook мінімум
- Якщо впав CRM:
  - job retry
  - alert у технічний чат
- Якщо впав Telegram:
  - retry
  - при вичерпанні retry -> DLQ + alert
- Якщо не згенерувався PDF:
  - alert
  - не відправляти неповний комплект
- Якщо queue backlog росте:
  - alert
  - тимчасово зменшити intake rate або підняти worker
- Якщо заповнився диск:
  - alert
  - cleanup temp/generated retention

## 16. Документація і підтримка
Проєкт має жити довго, тому для кожного production-інциденту треба:
- оновлювати runbook
- оновлювати правила alerting
- оновлювати docs по конфігу
- документувати нетипові SKU і special-cases
