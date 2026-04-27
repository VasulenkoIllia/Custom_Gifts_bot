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

## 5.4 White cleanup + CMYK postcheck
Поточний TS pipeline використовує legacy-aggressive preset для детекції near-white, але default path робить тільки один основний white-pass:
- `whiteThreshold = 252`
- `whiteMaxSaturation = 0.03`
- `whiteLabDeltaEMax = 5`
- `whiteLabSoftness = 2.5`
- `whiteMinLightness = 98.0`
- `whiteFeatherPx = 2.0`
- `whiteCleanupPasses = 3`

Практично це означає:
- перший прохід виконується завжди;
- `white_recolor_final` не запускається регулярно;
- повторна заміна білого запускається тільки після фінального post-CMYK контролю, якщо residual near-white перевищує поріг;
- зайві повторні проходи не виконуються, що зменшує деградацію деталізації та кількість Ghostscript/PDF round-trips;
- бізнес-потік (QR/Spotify, Telegram delivery, CRM status flow) не змінюється.

У preflight використовується strict/aggressive residual near-white контроль:
- `residual_strict_white_pixels`
- `residual_aggressive_white_pixels`
- `residual_strict_low_alpha_white_pixels`
- `residual_aggressive_low_alpha_white_pixels`

Якщо фінальний postcheck бачить залишковий near-white вище порога, виконується один auto-retry pass.

Для `PDF_COLOR_SPACE=CMYK` додатково діє пост-CMYK контроль:
- фінальний файл обов'язково конвертується в CMYK;
- default path не запускає регулярний `white_recolor_final`; основний white-pass виконується один раз до CMYK;
- після CMYK конверсії запускається residual near-white postcheck;
- якщо postcheck не пройдено, виконується auto-retry з aggressive профілем (`profile=aggressive`) і повторна CMYK конверсія;
- production default `OFFWHITE_HEX=F7F6F2` підібраний після broad A/B validation на live orders `29846..29820`;
- палітра auto-retry для `OFFWHITE_HEX=F7F6F2`: `EFEEEA`, `EBEAE6` (використовується послідовно).

Швидка технічна перевірка color space фінального PDF:
- очікується наявність `/DeviceCMYK` у фінальному файлі;
- не очікується `/DeviceRGB` у постері після pipeline.

Валідація цієї зміни на live-order set зафіксована тут:
- [docs/CURRENT_PDF_PIPELINE.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/docs/CURRENT_PDF_PIPELINE.md)
- [docs/WHITE_SMART_RETRY_VALIDATION_2026-04-18.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/docs/WHITE_SMART_RETRY_VALIDATION_2026-04-18.md)
- [docs/WHITE_CMYK_POSTCHECK_VALIDATION_2026-04-20.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/docs/WHITE_CMYK_POSTCHECK_VALIDATION_2026-04-20.md)
- [docs/PDF_PIPELINE_OPTIMIZATION_2026-04-26.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/docs/PDF_PIPELINE_OPTIMIZATION_2026-04-26.md)

SKU-based DPI routing (замість auto-router):
- Усі матеріали замовлення обробляються з єдиним DPI, визначеним за SKU.
- Якщо будь-який poster-матеріал має SKU з `PDF_HIGH_DETAIL_SKUS_PATH` → `RASTERIZE_DPI_HIGH_DETAIL` (default 1200).
- Всі інші замовлення → `RASTERIZE_DPI` (default 800).
- Список high-detail SKU: `Star*` (StarTransp, StarFP) та `Map*` (MapSquareT, MapTrHeart) серії у форматах A5/A4.
- `PDF_HIGH_DETAIL_SKUS_PATH` є fail-fast конфігом: якщо файл відсутній, не читається, має malformed JSON або порожній список, сервіс не стартує. Це захищає від тихого fallback high-detail SKU на 800 DPI.

Ghostscript concurrency:
- `RASTERIZE_CONCURRENCY` обмежує не тільки генерацію матеріалів, а й service-level post-embed CMYK conversion, finalPreflight measure, aggressive enforce і повторну CMYK conversion.
- Причина попереднього `maxGhostscriptProcesses=3` при `ORDER_QUEUE_CONCURRENCY=2`: finalPreflight і QR/Spotify post-embed CMYK запускались після `generateMaterialFiles` без semaphore і могли накладатися на генерацію іншого order.
- Після виправлення всі ці операції беруть один shared rasterize semaphore у межах `PdfPipelineService`.

У Telegram caption додаються технічні метрики:
- `DPI: <N> | Білий (px): strict=<N> | agg=<N> | corrected=<N>`
- `Час опрацювання: <Nс | Mхв Sс | Hг Mхв Sс>`

Для CMYK артефактів на тонких краях доступний lossless режим:
- `PDF_CMYK_LOSSLESS=true`
- CMYK конверсія робиться з `FlateEncode` (color/gray) без downsample.

## 5.5 PDF Quality: DPI optimization (white cleanup & QR/Spotify rendering)
Pipeline забезпечує максимальну якість на всіх етапах за допомогою правильної DPI-конверсії:

**White cleanup DPI:**
- Основний white-pass працює на ефективному DPI замовлення (визначеному через SKU-routing).
- Повторний aggressive-pass не виконується регулярно; він запускається тільки після фінального postcheck, якщо residual near-white перевищує поріг.
- Тепер DPI фінального cleanup завжди відповідає DPI растеризації.

**QR код (звичайний QR):**
- Рендеруються на 600 DPI-еквіваленті цільового фізичного розміру замість дефолтного ~100px
- Формула: `qrSizePx = Math.ceil((widthMm / 25.4) * 600)`
- Приклади:
  - A5 QR (20mm): 100px → 472px
  - A4 QR (30mm): 100px → 709px
- Результат: усунення upscaling артефактів при вбудовуванні в PDF

**Spotify scannable SVG:**
- Рендеруються через `sharp.resize()` на тій же 600 DPI-еквіваленті цільового розміру
- Раніше Spotify код був downsampled з API 640px до потрібного розміру (наприклад, ~709px для A4), що створювало артефакти
- Тепер A4 Spotify коди більше не втрачають якість при resize

Практична імпліка:
- QR і Spotify коди виглядають чіткіше з урахуванням фізичного розміру в макеті
- Жодних видимих артефактів upscaling
- Фінальна білизна чиститься із однаковою якістю як весь решта pipeline
- RAM/CPU залежать від ефективного DPI замовлення: high-detail SKU на `1200` потребує більше, ніж стандартне `800`.
- final preflight для `CMYK` включає:
  - умовний strict-pass (лише коли є residual на першому контролі),
  - обов'язковий CMYK postcheck,
  - умовний aggressive retry тільки для файлів, де postcheck показав залишковий near-white.

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
- поточний validated baseline: `ORDER_QUEUE_CONCURRENCY=2`, `RASTERIZE_CONCURRENCY=2`
- `ORDER_QUEUE_CONCURRENCY=3` не використовувати як default: локальний тест показав гірший latency і вищий Ghostscript contention
- після серверного переносу повторити stress/live validation саме на серверному CPU/RAM

Якщо RAM `4 GB`:
- починати з `1` активного важкого PDF job

Якщо RAM `8 GB+`:
- можна тестувати `2` важких PDF job; піднімати вище тільки після вимірювань `timingFinalPreflightMs`, `finalPreflightCorrectedPixels`, RSS і кількості `gs` процесів

### 11.1 Memory limits і захист від swap

Кожен `order-worker` отримує жорсткий ліміт:
- `mem_limit: 1400m` — Docker не дозволяє контейнеру зайняти більше
- `memswap_limit: 1400m` — swap для воркера = 0 (memswap_limit = mem_limit)
- `--max-old-space-size=768` (в `CMD`) — V8 heap cap; GC стає агресивнішим до досягнення ліміту

Чому ці числа:
- V8 heap під час обробки замовлення (завантаження source PDF + растеризація): до ~700 МБ
- Ghostscript під час CMYK-конверсії: пік ~300–400 МБ поза V8
- 1400 МБ = запас для піків при 800 DPI і CMYK pipeline

Що відбувається при OOM:
- Docker вбиває контейнер; `restart: unless-stopped` піднімає його за кілька секунд
- Queue lease expiry автоматично повертає задачу у `queued`; інший воркер підхопить її
- Жодних втрат замовлень: retry вбудований у чергу

Рекомендації по хосту:
- `vm.swappiness=10` в `/etc/sysctl.conf` — ядро не лізе в swap поки є вільна RAM
- Swap залишати увімкненим як страховий буфер для інших контейнерів і OOM-спайків

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
