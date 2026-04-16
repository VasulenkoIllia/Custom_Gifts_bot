# Production, черги, логування і відмовостійкість

## 0. Поточний стан реалізації
Вже реалізовано в TS:
- queue retry policy (`maxAttempts`, `retryBaseMs`, `shouldRetry`);
- persistent DLQ (PostgreSQL table `dead_letters`);
- ops-alert повідомлення в окремий Telegram чат (`TELEGRAM_OPS_CHAT_ID`);
- failure-status flow:
  - deterministic `missing file` до PDF pipeline:
    - немає `_tib_design_link_1`, але є preview -> тільки alert `Не вдалося сформувати PDF`, без зміни CRM-статусу;
    - немає `_tib_design_link_1` і немає preview -> `missingFileStatusId` без retry / DLQ;
    - немає тексту engraving/sticker -> `missingFileStatusId` без retry / DLQ;
  - deterministic `source unavailable` (`_tib_design_link_1` є, але CDN дає `403/404`) -> без retry / DLQ і без зміни CRM-статусу;
  - `pdf_generation` -> `missingFileStatusId`;
  - `telegram_delivery` -> `missingTelegramStatusId`;
- storage retention cleanup для `OUTPUT_DIR` і `TEMP_DIR`.

## 0.1 Простий order flow
- webhook з KeyCRM приходить у `receiver`
- `receiver` кладе order у `order_intake`
- `order-worker` тягне order з CRM і будує `layout plan`
- далі можливі 3 ранні сценарії:
  - немає `_tib_design_link_1`:
    - якщо є `preview` -> CRM статус не змінюємо, тільки шлемо alert
    - якщо `preview` немає -> одразу `40 / Без файлу`
  - немає тексту engraving/sticker -> одразу `40 / Без файлу`
  - source URL є, але CDN/TeeInBlue дає `403/404` -> CRM статус не змінюємо, тільки шлемо alert
- якщо ранніх блокерів немає, генеруємо PDF
- preview + PDF летять у `ОБРОБКА`
- перше preview показує:
  - блок `Кількість` (`<SKU> × N шт`) для базових товарів;
  - тексти engraving/sticker, якщо вони є;
- аддони з `_parentKey` не дублюються як окремі рядки в блоці `Кількість`
- у sticker emoji автоматично вирізаються; якщо після цього текст порожній, sticker вважається `без тексту`
- після `❤️` order переходить у `Друк`, а PDF копіюються в `ЗАМОВЛЕННЯ`

## 1. Як має працювати webhook у production
- KeyCRM надсилає webhook у receiver.
- Receiver валідовує запит.
- Receiver створює idempotency key.
- Receiver ставить job у queue.
- Receiver швидко відповідає:
  - `200` для KeyCRM webhook;
  - `202` для Telegram webhook.
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
  - обробка workflow-реакцій (`❤️`, `👍`).
  - у поточній реалізації примусово серіалізована (`concurrency = 1`) для уникнення race condition по статусам CRM.
- Forwarding queue
  - пересилання/копіювання матеріалів у гілку `ЗАМОВЛЕННЯ` після `1 ❤️`.
- Dead-letter queue
  - задачі, які не пройшли після всіх retry.

## 4. Retry policy
- CRM fetch/update
  - короткі retry з exponential backoff.
- Spotify short-link / scannable SVG
  - timeout + retry з backoff.
- URL shortener (`lnk.ua` primary, `cutt.ly` fallback)
  - timeout + retry + automatic provider fallback.
- Poster source PDF download
  - timeout + retry з backoff.
- Telegram send
  - retry на rate limit і transient network errors.
- PDF generation
  - обережний retry тільки на transient помилках;
  - на deterministic missing-file кейсах PDF взагалі не стартує.

Простіше:
- retry є тільки для тимчасових помилок;
- якщо система точно розуміє, що order зараз не може бути оброблений, retry не робиться.

## 5. Що вважати deterministic помилкою
- відсутній source PDF
- замовлено engraving/sticker, але текст відсутній
- source URL є, але CDN/TeeInBlue повертає `403/404`
- відсутній потрібний mapping SKU
- конфігурація placement поза межами сторінки
- відсутній обов'язковий файл шрифту

## 5.1 Deterministic missing-file path
Для таких кейсів:
- відсутній `_tib_design_link_1`;
- замовлено engraving, але текст відсутній;
- замовлено sticker, але текст відсутній;

система робить так:
- не запускає PDF pipeline;
- не робить retry;
- не створює запис у `dead_letters`;
- якщо немає `_tib_design_link_1`, але є `preview` -> CRM статус не змінює;
- в інших deterministic missing-file кейсах ставить CRM статус `Без файлу` (`40`);
- відправляє `error` alert у Telegram processing і ops chat.

## 5.2 Deterministic source-unavailable path
Для таких кейсів:
- `_tib_design_link_1` у замовленні є;
- але download друкарського PDF з CDN/TeeInBlue повертає `403` або `404`.

Система робить так:
- стартує PDF pipeline;
- зупиняє order на першому deterministic download failure;
- не робить retry;
- не створює запис у `dead_letters`;
- не змінює CRM статус;
- не відправляє PDF у Telegram;
- відправляє `error` alert у Telegram processing і ops chat з деталями order та source URL.

## 5.3 Матриця сценаріїв "PDF не сформовано"
| Сценарій | Що робить система | CRM статус | Retry / DLQ | Alert |
|---|---|---|---|---|
| `webhook.status_id != materialsStatusId` або `order.status_id != materialsStatusId` | Intake job `skip`, PDF pipeline не стартує | Без змін | Ні | Ні (тільки `info` лог) |
| Немає `_tib_design_link_1` і **немає** preview | Зупинка до PDF pipeline | `missingFileStatusId` (`40`) | Ні | `error` в processing + ops |
| Немає `_tib_design_link_1`, але preview **є** | Зупинка до PDF pipeline | Без змін | Ні | `error` в processing + ops (`Не вдалося сформувати PDF`) |
| Немає тексту engraving/sticker | Зупинка до PDF pipeline | `missingFileStatusId` (`40`) | Ні | `error` в processing + ops |
| `_tib_design_link_1` є, але CDN/TeeInBlue повертає `403/404` | PDF pipeline зупиняється як deterministic `source unavailable` | Без змін | Ні | `error` в processing + ops (`Не вдалося сформувати PDF`) |
| Інші помилки PDF (`pdf_generation`) | Worker кидає `OrderProcessingError`, queue робить retry | На retry-етапі без змін; при DLQ -> `missingFileStatusId` (`40`) | Так | При DLQ: `critical` в ops (`Job moved to DLQ`) |

## 5.4 White cleanup
Поточний TS pipeline повернутий до legacy-aggressive preset, бо м'якші значення іноді лишали залишковий білий:
- `whiteThreshold = 252`
- `whiteMaxSaturation = 0.03`
- `whiteLabDeltaEMax = 3`
- `whiteLabSoftness = 1`
- `whiteMinLightness = 99.5`
- `whiteFeatherPx = 0.35`
- `whiteCleanupPasses = 3`
- `whiteReplaceIterations = 3`
- `whiteFinalIterations = 3`

Практично це означає:
- звичайний poster проходить агресивніше очищення білого;
- Spotify overlay poster має ще один додатковий post-overlay off-white pass;
- обробка стала повільнішою, але стабільнішою проти залишкового білого.

## 6. Що вважати transient помилкою
- timeout CRM
- timeout Spotify/scannables
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
  - `chat_id + message_id + stage_bucket`
- `forwarding`
  - `order_id + stage + target_chat_id + target_thread_id`

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
- PostgreSQL storage для:
  - `telegram_message_map`
  - `order_workflow_state`
  - `idempotency_keys`
  - `dead_letters`

Поточний стан:
- queue зберігається в PostgreSQL (`queue_jobs`) з lease-based processing і recovery;
- recovery забезпечується повторними webhook з CRM + idempotency в PostgreSQL;
- після restart сервісу не втрачається операційний state, а прострочені `running` job повертаються через lease recovery.

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
- in-memory queue + persistent state у PostgreSQL
- окремий Telegram ops chat

## 15. Runbook мінімум
- Якщо впав CRM:
  - job retry
  - alert у технічний чат
- Якщо впав Telegram:
  - retry
  - при вичерпанні retry -> DLQ + alert
  - помилка preview не має зупиняти відправку PDF (фіксується warning у логах)
- Якщо не згенерувався PDF:
  - alert
  - не відправляти неповний комплект
- Якщо queue backlog росте:
  - alert
  - тимчасово зменшити intake rate або підняти worker
- Якщо заповнився диск:
  - alert
  - cleanup temp/generated retention

## 15.1 Часткові бізнес-попередження, які не зупиняють замовлення
- QR запитано, але SKU поза whitelist або не вистачає `SKU/format`:
  - poster генерується без QR;
  - у Telegram caption додається `🚨`-попередження, що QR не згенеровано і не вбудовано.
- QR URL невалідний:
  - `QR +` зберігається;
  - poster генерується без QR;
  - у Telegram caption додається `🚨`-попередження;
  - сире `Посилання QR` не показується.
- engraving/sticker без тексту:
  - order не йде далі в PDF pipeline;
  - CRM статус переходить у `Без файлу` (`40`);
  - у processing/ops chat приходить error alert;
  - запису в `dead_letters` немає.
- Shortener недоступний:
  - QR вбудовується з оригінальним посиланням;
  - у примітках має бути warning про fallback.
- Невалідний preview URL:
  - preview не додається;
  - PDF-файли все одно надсилаються;
  - у примітках зберігається `⚠️`-warning.
- Неприв'язаний add-on:
  - комплект не валиться автоматично;
  - у примітках зберігається `⚠️`-warning на ручну перевірку.
- Preview не доставлено:
  - PDF-файли все одно надсилаються;
  - у примітках зберігається `⚠️ Preview warning: ...`.

## 15.2 Hard-fail правила
- Якщо відсутній реальний design/source file для postera:
  - preview не використовується як друкарський source;
  - order не йде в PDF pipeline;
  - CRM статус переходить у `Без файлу`.
- Якщо design/source URL є, але CDN/TeeInBlue віддає `403/404`:
  - order не йде в retry / DLQ;
  - CRM статус не змінюється;
  - у Telegram йде alert `Не вдалося сформувати PDF`.

## 16. Документація і підтримка
Проєкт має жити довго, тому для кожного production-інциденту треба:
- оновлювати runbook
- оновлювати правила alerting
- оновлювати docs по конфігу
- документувати нетипові SKU і special-cases
