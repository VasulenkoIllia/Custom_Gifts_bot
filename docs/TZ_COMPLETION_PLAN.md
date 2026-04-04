# План доробки бота макетів за ТЗ

## 0. Пов'язана документація
- [docs/README.md](./README.md) - карта документації
- [docs/PROJECT_CONTROL.md](./PROJECT_CONTROL.md) - головний документ керування реалізацією, тестуванням і прогресом
- [docs/TS_ARCHITECTURE.md](./TS_ARCHITECTURE.md) - цільова архітектура TypeScript-проєкту
- [docs/IMPLEMENTATION_STAGES.md](./IMPLEMENTATION_STAGES.md) - поетапний план реалізації від legacy до production
- [docs/OPERATIONS.md](./OPERATIONS.md) - production, черги, логування, алерти, вузькі місця
- [docs/CONFIGURATION_MODEL.md](./CONFIGURATION_MODEL.md) - мінімальний конфіг, який можна змінювати без правок коду
- [docs/LEGACY_REFERENCE.md](./LEGACY_REFERENCE.md) - що саме з поточного JS-коду зберігається як reference
- [docs/CUSTOMER_BRIEF.md](./CUSTOMER_BRIEF.md) - короткий brief для замовника
- [docs/TZ_ASSUMPTIONS.md](./TZ_ASSUMPTIONS.md) - decision-log по fallback-логіці, warning-поведінці і переглядних бізнес-рішеннях
- [docs/TZ_ADDENDUM_PLAN.md](./TZ_ADDENDUM_PLAN.md) - додаткові вимоги після стартового ТЗ (Telegram-гілки, пересилання, оновлений reaction-flow)

## 1. Мета
Доробити поточний сервіс так, щоб він повністю покривав ТЗ по:
- формуванню назв файлів макетів;
- включенню ручних матеріалів `A6` і `брелок` у загальну нумерацію комплекту;
- генерації/вбудовуванню QR або Spotify-коду тільки для потрібних груп товарів;
- скороченню посилань для QR через `lnk.ua` (fallback `cutt.ly`);
- коректному повідомленню в Telegram (файли, примітки, прев'ю);
- зміні статусів у CRM за реакціями в Telegram;
- гарантії заміни білого кольору під друк у CMYK-пайплайні.

## 2. Що вже реалізовано в коді
Оновлення станом на Stage D intake:
- додано `POST /webhook/keycrm` і `POST /webhook/telegram` у TS-сервісі;
- додано `CrmClient` з `GET /order/{id}` і `PUT /order/{id}` + retry/timeout;
- додано idempotency в PostgreSQL (`idempotency_keys`) для order webhook;
- додано queue intake (`order_intake`, `reaction_intake`) замість синхронної обробки в HTTP;
- додано базові автотести для webhook parser/idempotency/controller.

Оновлення станом на Stage E layout/naming:
- додано `layout-plan-builder` у TS;
- додано data-driven `product-code-rules.json` для special SKU;
- реалізовано naming `poster/engraving/sticker` за ТЗ;
- реалізовано fixed ordering `poster -> engraving -> sticker`;
- реалізовано `urgent -> _T`;
- реалізовано пріоритет `SKU -> properties -> fallback` для формату;
- реалізовано `+K/speaker -> K` для stand type;
- додано автотести по ключових naming-кейсах.

Оновлення станом на Stage F PDF pipeline:
- додано TS `PdfPipelineService`, який інтегрує `layoutPlan` з перевіреним legacy PDF generator;
- генерація poster/engraving/sticker викликається з `order_intake` worker;
- підключено white recolor + CMYK у pipeline (через legacy модуль);
- додано SKU-specific QR rules (`config/business-rules/qr-rules.json`) і `QR_RULES_PATH`;
- додано per-poster decision engine:
  - `none` для SKU поза whitelist;
  - `qr` для whitelist SKU;
  - `spotify_code` для Spotify SKU + Spotify URL;
- додано TS QR/Spotify post-processing поверх згенерованого poster PDF;
- після TS QR/Spotify embed для `CMYK` виконується повторна CMYK-конверсія постера;
- додано pipeline-конфіг у `.env`/`AppConfig` (шрифти, output, color-space, QR fallback placement);
- додано тест на mapping `LayoutPlan -> legacy generator payload`.

Оновлення станом на Stage G Telegram delivery:
- `order_intake` worker тепер відправляє generated materials у Telegram після PDF pipeline;
- додано status-gate: відправка лише коли `order.status_id == materialsStatusId` (з rules);
- додано PostgreSQL message-map store для зв'язку `chat/message -> order`;
- message map використовується далі в reaction workflow.
- додано `OpsAlertService` для технічного чату:
  - retry/backoff на `sendMessage`;
  - dedupe-window проти alert spam.
- додано dead-letter persistence:
  - PostgreSQL table `dead_letters`.
- додано failure-status flow:
  - при `pdf_generation` DLQ ставиться статус `missingFileStatusId` (`40`);
  - при `telegram_delivery` DLQ ставиться статус `missingTelegramStatusId` (`59`).

Оновлення станом на Stage H Reaction workflow:
- додано `reaction-status-rules.json` (materials/print workflow з можливістю disabled stage);
- `reaction_intake` worker оновлює CRM статуси за правилами `emoji + countThreshold`:
  - `PRINT`: `❤️` (з alias `❤/♥️/♥`) `>=1` -> `print status`;
  - `PACKING`: `👍 >=1` -> `packing status` (пілотний сценарій, вимкнений у дефолтному релізі);
- додано послідовне застосування stage transitions:
  - при ввімкненому `PACKING`, якщо перша подія одразу `👍`, worker виконує `Друк -> Пакування`;
- rollback свідомо ігнорується (monotonic тільки вперед);
- додано unit tests на stage resolver і reaction worker.
- додано anti-flood для reaction webhook:
  - dedupe key по `chat/message + resolved stage bucket`.

Оновлення станом на Stage I hardening:
- додано queue retry policy:
  - `maxAttempts`, `retryBaseMs`, `shouldRetry`;
- додано queue DLQ callbacks;
- прибрано файлові state-store реалізації з runtime:
  - idempotency/message-map/DLQ працюють тільки через PostgreSQL;
- додано автоматичний storage retention cleanup:
  - `OUTPUT_RETENTION_HOURS`
  - `TEMP_RETENTION_HOURS`
  - `CLEANUP_INTERVAL_MS`
- додано production docs:
  - `RUNBOOK`
  - `WEBHOOK_CHECKLIST`
  - `STORAGE_RETENTION`
  - `MANUAL_UAT_CHECKLIST`
  - `.env.production.example`.

Історично, у попередньому JS-коді вже були/частково були:
- побудова `layoutPlan` із матеріалами `poster/engraving/sticker`;
- базовий неймінг `CGU_<code>_<order>_<index>_<total>[_T]`;
- прапори для повідомлень (`QR +`, `LF +`) і суміжна ручна обробка спец-матеріалів;
- попередження про невалідне QR-посилання;
- завантаження прев'ю із `_customization_image` і відправка у Telegram;
- генерація PDF для гравіювання/стікера;
- вбудовування звичайного QR в постер;
- реакції Telegram -> зміна статусу в CRM (у legacy-версії був лише один поріг по hearts);
- пайплайн зміни білого + опційна CMYK-конверсія.

## 2.1 Що підтверджено по API локально і live через CRM

### Документовано в `open-api.yml`
Підтверджені маршрути:
- `GET /order/{orderId}`
- `PUT /order/{orderId}`
- `GET /order/status`

Підтверджені include для замовлення:
- `products.offer`
- `status`
- `tags`
- `manager`
- `shipping.lastHistory`
- `shipping.deliveryService`
- `custom_fields`
- `buyer`
- `payments`
- `expenses`
- `assigned`

Підтверджені поля замовлення, які нам практично корисні:
- `id`
- `source_id`
- `source_uuid`
- `status_id`
- `status_group_id`
- `status`
- `products[]`
- `custom_fields[]`
- `tags[]`
- `manager_comment`
- `buyer_comment`
- `shipping`

Підтверджені поля товару в замовленні:
- `products[].id`
- `products[].sku`
- `products[].name`
- `products[].picture`
- `products[].comment`
- `products[].properties[]`
- `products[].offer`
- `products[].offer.sku`
- `products[].offer.properties[]`

Практичний висновок:
- якщо webhook дає лише `context.id`, ми можемо дотягнути все потрібне через `GET /order/{id}`;
- формат і тип підставки можна брати не лише з назви товару, а й з `products[].offer.properties[]`;
- статус замовлення можна змінювати штатно через `PUT /order/{id}` з `status_id`.
- Shopify як джерело можна не виявляти програмно, якщо в CRM webhook налаштований лише на Shopify-замовлення.

### Підтверджено live запитами у CRM
Актуальні статуси, які прямо стосуються процесу:
- `Матеріали` = `20`
- `Макет` = `21`
- `Друк` = `22`
- `Пакування` = `7`
- `Скачано макет` = `29`
- `Без файлу` = `40`
- `Немає в тг` = `59`

Поточний стан реалізації:
- реакції керуються через `config/business-rules/reaction-status-rules.json`;
- активний етап за замовчуванням: `1 ❤️ -> Друк (22)`;
- `👍 -> Пакування (7)` зафіксований як пілотний відкладений етап (disabled до окремого рішення).

Що видно з live-структури реального замовлення:
- базовий товар містить `_tib_design_link_1` і `_customization_image`;
- базовий товар містить бізнес-властивості типу `Гравіювання`, `Текст для гравіювання`, `Стікер-записка`, `Термінове виготовлення`, `Live Photo`, `Variant`;
- додаткові опції приходять ще й окремими line items з `_parentKey`;
- `offer.properties[]` реально містить `Розмір` і `Тип підставки`.

Практичний висновок:
- для надійності треба використовувати обидва джерела:
  - `product.properties[]` для даних кастомізації;
  - `offer.properties[]` для нормалізації формату/підставки;
- зв'язок base item <-> add-on item можна визначати через `_itemKey` / `_parentKey`.

## 2.2 Результат live-звірки SKU з CRM
Перевірено всі SKU з розділів `6` і `7` цього документа через `GET /offers`.

Результат:
- у ТЗ зафіксовано `177` цільових SKU;
- у CRM знайдено `176` SKU;
- не знайдено рівно `1` SKU:
  - `FriendAppleA5RGB+K`

Що важливо:
- усі `24` SKU з `RBG` реально існують у CRM;
- отже `RBG` не можна автоматично вважати опечаткою;
- у всіх знайдених `176` SKU є корисні поля для формату і типу підставки;
- в CRM використовуються 2 варіанти назв полів формату:
  - `Розмір`
  - `Оберіть розмір постера`
- в CRM використовуються 2 варіанти назв полів типу підставки:
  - `Тип підставки`
  - `Оберіть тип стійки`

Знайдена 1 реальна неузгодженість даних:
- `FriendAppleA4RGB+K`
  - у SKU зашито `A4`
  - в `offer.properties` значення формату = `А5`

Практичний висновок:
- інформації в CRM достатньо, щоб правильно формувати більшість рішень по товарах;
- але parser має бути не “properties-first”, а “SKU-mapping-first” для whitelisted товарів;
- якщо SKU є в нашому явному mapping, довіряємо mapping;
- `offer.properties` використовуємо як другий пріоритет;
- для невідомих SKU залишаємо fallback на `product.properties`, `Variant`, `name`.

## 3. GAP-аналіз відносно ТЗ

### 3.1 Неймінг макетів
Відсутнє/неповне:
- окрема група артикулів із спеціальними кодами постера (`HT`, `RB`, `RC`, ...), замість стандартного `AA5/AA4`;
- повна підтримка типів підставок `K` (з колонкою) у коді гравіювання;
- надійний форматний парсер для SKU без явного `A5/A4` у назві (потрібен fallback із властивостей CRM);
- включення ручних матеріалів (`A6`, `брелок`) у `total` нумерації (`CGU_B`, `CGU_AA6` як ручні позиції).

### 3.2 Логіка QR/Spotify-коду
Відсутнє/неповне:
- rules-by-SKU: зараз QR застосовується загально, а за ТЗ треба тільки для визначених груп;
- різні розміри/позиції QR за групами товарів;
- shortener шар перед QR:
  - primary `lnk.ua`;
  - fallback `cutt.ly`;
- окрема поведінка для Spotify:
  - якщо посилання Spotify -> Spotify code у центрі знизу у прямокутнику;
  - якщо не Spotify -> звичайний QR у визначеній позиції.

### 3.3 Telegram та статуси
Відсутнє/неповне:
- явна прив'язка "відправляти на статусі МАТЕРІАЛИ";
- явна маршрутизація в Telegram-гілки `ОБРОБКА / ЗАМОВЛЕННЯ / ЧАТ`;
- workflow на реакціях:
  - `1 ❤️` -> статус `Друк` + пересилання в `ЗАМОВЛЕННЯ`;
  - `👍` -> статус `Пакування` (pilot-disabled за замовчуванням);
- узгоджена політика пересилання (`copy`/`forward`) і таргетів.

### 3.4 Колір і підготовка до друку
Відсутнє/неповне:
- ТЗ вимагає гарантувати заміну `C0 M0 Y0 K0` на `C0 M0 Y3 K0` для всіх макетів, що йдуть у бот;
- поточна реалізація робить near-white replacement + CMYK conversion, але без жорсткої перевірки саме `Y=3` у фінальному PDF.

### 3.5 Додаткові вимоги
Потрібно зафіксувати:
- для товарів поза whitelist QR не додається, але `QR +`/`LF +`/`A6 +`/`B +` у примітках залишаються;
- для товарів поза whitelist або без достатніх технічних даних для embed (`SKU`, формат) Telegram має явно показувати `🚨`-попередження, що QR не згенеровано і не вбудовано в макет;
- при невалідному посиланні потрібна примітка про помилку (частково вже є, треба уніфікувати для всіх QR-груп).

### 3.6 Що вже покрито частково, але треба переробити
- webhook -> завантаження замовлення -> генерація файлів -> відправка в Telegram уже зібрані в один пайплайн;
- реакції Telegram уже мапляться назад у CRM, але routing у `ЗАМОВЛЕННЯ` після `1 ❤️` ще треба закрити окремим етапом;
- визначення формату/типу підставки зараз є, але працює евристично по `Variant`/SKU/name і не використовує `offer.properties[]` як основне джерело;
- QR уже вбудовується в PDF, але без SKU-specific правил;
- прев'ю макету вже відправляється в Telegram.

## 4. Цільова архітектура доробки

### 4.1 Конфігурація (data-driven)
Додати окремі конфіг-файли:
- `config/business-rules/product-code-rules.json`
  - mapping SKU/pattern -> код постера (`AA5`, `HT`, `RB`...);
  - mapping stand type (`W`, `WW`, `MWW`, `C`, `K`);
- `config/business-rules/qr-rules.json`
  - whitelist SKU для вбудовування коду;
  - тип коду: `qr` або `spotify_code`;
  - параметри placement (A5/A4);
- `config/business-rules/reaction-status-rules.json`
  - emoji/stage -> status_id (активні й відкладені етапи);
  - політика ескалації/блокування повторного застосування.
- `config/business-rules/telegram-routing-rules.json`
  - топологія `processing/orders/chat`;
  - `chat_id` + optional `message_thread_id` для кожної цілі;
  - політика пересилання (`copy`/`forward`) і fallback.
- `config/business-rules/url-shortener-rules.json`
  - provider order: `lnk.ua`, `cutt.ly`;
  - timeout/retry/fallback policy;
  - маркування помилки shortener у примітках.

### 4.2 Сервіси/модулі
Винести логіку в окремі блоки:
- `src/modules/layout/filename-builder.ts` (нормалізований неймінг);
- `src/modules/layout/sku-classifier.ts` (визначення групи/коду/формату/підставки);
- `src/modules/qr/qr-rules.ts` (звичайний QR vs Spotify code + placement);
- `src/modules/reactions/reaction-status-rules.ts` (1❤️ активний етап + опційний disabled stage);
- `src/modules/telegram/telegram-delivery.service.ts` (доставка й mapping повідомлень);
- `src/modules/url-shortener/shortener-service.ts` (`lnk.ua` primary, `cutt.ly` fallback).

## 5. Покроковий план реалізації

## Етап 0. Узгодження вхідних даних
Завдання:
- зафіксувати використання підтверджених `status_id`:
  - "МАТЕРІАЛИ" = `20`;
  - "ДРУК" = `22`;
  - "ПАКУВАННЯ" = `7`;
- зафіксувати джерело замовлень:
  - сервіс обробляє лише webhook, які CRM вже відфільтрувала як Shopify;
  - додаткова програмна перевірка `source_id/source_uuid` не є обов'язковою;
- зафіксувати порядок матеріалів для комбінації `poster + engraving + sticker`:
  - `1`: poster
  - `2`: engraving
  - `3`: sticker
- зафіксувати розширені прапори приміток:
  - `QR +`, `LF +`, `A6 +`, `B +`;
- зафіксувати правила гравіювання:
  - файл гравіювання формується у форматі `A3`;
  - зона тексту для `A4` підставки: `22x210 мм`;
  - зона тексту для `A5` підставки: `22x148 мм`;
- зафіксувати, що розмір стікера фіксований;
- зафіксувати нумерацію при ручних позиціях:
  - `CGU_B_<order>_<i>_<total>`
  - `CGU_AA6_<order>_<i>_<total>`;
- підтвердити CRM-поле, з якого брати формат для гравіювання, якщо не визначився з SKU.

Результат:
- документ [docs/TZ_ASSUMPTIONS.md](./TZ_ASSUMPTIONS.md) з фінальними ID, fallback-правилами і decision-log по спірних кейсах.

## Етап 1. SKU-класифікація і неймінг
Завдання:
- реалізувати whitelist спеціальних артикулів для кодів (`HT`, `RB`, ... `BM`);
- додати підтримку stand type `K`;
- перевести визначення формату і типу підставки на пріоритет:
  - explicit SKU mapping із ТЗ
  - `products[].offer.properties[]`
  - `products[].properties[]`
  - SKU / `Variant` / product name;
- оновити builder назв:
  - постер: `CGU_<posterCode>_<order>_<i>_<total>[_T]`;
  - гравіювання: `CGU_<format><stand>_G_<order>_<i>_<total>[_T]`;
  - стікер: `CGU_S_<order>_<i>_<total>[_T]`.

Критерії приймання:
- для кожного SKU із таблиці нижче постер має правильний код;
- нумерація `index/total` правильна для комбінацій:
  - лише постер;
  - постер+гравіювання;
  - постер+стікер;
  - постер+гравіювання+стікер;
  - постер + ручні позиції (`A6`/`брелок`);
- для `poster + engraving + sticker` порядок фіксований:
  - `poster` -> `engraving` -> `sticker`;
- термінове замовлення додає `_T`.

## Етап 2. QR/Spotify по whitelist товарів
Завдання:
- додати SKU-based правила вбудовування коду;
- інтегрувати shortener перед QR:
  - primary `lnk.ua`;
  - fallback `cutt.ly`;
  - shortener застосовується тільки для звичайного QR;
  - для Spotify code shortener не використовується;
- реалізувати `isSpotifyLink(url)`:
  - `open.spotify.com`, `spotify.link`, `spoti.fi` -> Spotify code;
  - інакше звичайний QR;
- реалізувати placement згідно таблиці нижче;
- для товарів поза whitelist код не вбудовувати.

Критерії приймання:
- код з'являється лише для дозволених SKU;
- для Spotify SKU:
  - spotify link -> Spotify code по центру знизу;
  - non-spotify link -> звичайний QR у заданій позиції;
- при недоступності `lnk.ua` автоматично використовується `cutt.ly`;
- при невалідному URL є warning у примітці Telegram.

## Етап 3. Відправка у Telegram на статусі "МАТЕРІАЛИ"
Завдання:
- додати перевірку статусу події KeyCRM (обробка/відправка тільки коли status == "МАТЕРІАЛИ");
- якщо у webhook немає достатніх даних, довантажувати order через `GET /order/{id}`;
- зберегти поточну логіку прев'ю + файлів;
- додати topology routing:
  - автоматичний потік у `ОБРОБКА`;
  - службовий `ЧАТ` без автоматичних файлів;
- уніфікувати примітки:
  - `QR +`;
  - `LF +`;
  - `A6 +`;
  - `B +`;
  - текст помилки URL за наявності.

Критерії приймання:
- бот не відправляє матеріали на інших статусах;
- у повідомленні є прев'ю і коректні назви файлів;
- бот коректно працює і в group, і в supergroup (topic/thread).

## Етап 4. Реакції Telegram -> `Друк` + пересилання (+ pilot `Пакування`)
Завдання:
- активувати `1 ❤️` як робочий етап:
  - рівно/не менше 1 ❤️ -> статус `Друк`;
  - після успішного апдейту статусу виконати пересилання комплекту в `ЗАМОВЛЕННЯ`;
- stage `👍 -> Пакування` тримати pilot-disabled у конфігу;
- додати захист від повторного застосування етапу по тому ж `order + stage`.

Критерії приймання:
- 1 реакція ставить `Друк` і тригерить рівно одне пересилання;
- `👍` у дефолтному релізі не змінює статус і не тригерить пересилання;
- повторні webhook-події не створюють дублювань.

Рекомендована бізнес-логіка:
- реакції трактуються як односторонній workflow;
- якщо лайк зняли після переходу в `Друк`, статус назад не відкочується;
- система реагує тільки на підвищення етапу:
  - `0 -> 1` лайк: ставимо `Друк`;
  - повторні апдейти в межах цього етапу: ігноруємо;
- для pilot-режиму `👍`:
  - якщо `❤️` не було, при `👍` застосовується послідовно `Друк -> Пакування`;
  - якщо `Друк` уже стоїть, при `👍` ставимо лише `Пакування`.

## Етап 5. Гарантія білого в CMYK
Завдання:
- додати фінальний контроль (preflight check) після генерації:
  - шукає пікселі/об'єкти з `C0 M0 Y0 K0`;
  - за потреби виконує корекцію до `C0 M0 Y3 K0`;
- додати лог/метрики: скільки виправлень зроблено.

Критерії приймання:
- для кожного PDF, що відправляється в бот, правило білого виконується стабільно.

## Етап 6. Тести та запуск
Завдання:
- юніт-тести для:
  - SKU classifier;
  - filename builder;
  - QR placement resolver;
  - reaction workflow;
- інтеграційні smoke-тести на 10-15 реальних order fixtures;
- додати чекліст релізу і rollback.

Критерії приймання:
- green тести;
- підтверджені приклади по всіх групах SKU;
- відсутність регресії поточного функціоналу.

## 6. Мапа спеціальних кодів постера (окрема група товарів)

`HT`:
- `ShapedNaghtLight6_A5WW`
- `ShapedNaghtLight6_A5RGB`

`RB`:
- `ShapedNaghtLight5_A5WW`
- `ShapedNaghtLight5_A5RGB`

`RC`:
- `ShapedNaghtLight4_A5WW`
- `ShapedNaghtLight4_A5RGB`

`HS`:
- `ShapedNaghtLight3_A5WW`
- `ShapedNaghtLight3_A5RGB`

`CL`:
- `ShapedNaghtLight2_A5WW`
- `ShapedNaghtLight2_A5RGB`

`CS`:
- `ShapedNaghtLight1A5WW`
- `ShapedNaghtLight1A5RGB`

`ZN`:
- `LoveLocksWW`
- `LoveLocksRGB`

`RH`:
- `LoveRingsWW`
- `LoveRingsRGB`

`DN`:
- `HandsHeartWW`
- `HandsHeartRGB`

`MH`:
- `DateHeartWW`
- `DateHeartRGB`

`LL`:
- `NameLocksWW`
- `NameLocksRGB`

`BN`:
- `BridesLoversWW`
- `BridesLoversRGB`

`BH`:
- `BirdsLoveWW`
- `BirdsLoveRGB`

`FH`:
- `NamedFlowerHeartWW`
- `NamedFlowerHeartRGB`

`ZS`:
- `PisceslightWW`
- `PisceslightRGB`
- `AquariusWW`
- `AquariusRGB`
- `CapricornWW`
- `CapricornRGB`
- `SagittariusWW`
- `SagittariusRGB`
- `ScorpioWW`
- `ScorpioRGB`
- `LibraWW`
- `LibraRGB`
- `VirgoWW`
- `VirgoRGB`
- `LeoWW`
- `LeoRGB`
- `CancerWW`
- `CancerRGB`
- `GeminiWW`
- `GeminiRGB`
- `TaurusWW`
- `TaurusRGB`
- `AriesWW`
- `AriesRGB`

`BM`:
- `LightBabyBoyA5WW`
- `LightBabyBoyA5RGB`
- `LightBabyGirlA5WW`
- `LightBabyGirlA5RGB`
- `NamedLBabyA5WW`
- `NamedLBabyA5RGB`
- `BabyLNameA5WW`
- `BabyLNameA5RGB`
- `BabyLNightLightA5WW`
- `BabyLNightLightA5RGB`
- `ColorLNightLightA5WW`
- `ColorLNightLightA5RGB`

## 7. Мапа SKU для вбудовування QR/коду

## 7.1 Spotify група
Правило:
- якщо посилання Spotify -> Spotify code;
- якщо не Spotify -> звичайний QR.

A5 (звичайний QR):
- розмір `20x20 мм`;
- відступ знизу `70 мм`;
- відступ справа `20 мм`.

A5 (Spotify code):
- зона `80x20 мм`, знизу по центру;
- відступ знизу `11 мм`.

SKU:
- `SpotifyA5Wood`
- `SpotifyA5WoodWW`
- `SpotifyA5WoodMultiWW`
- `SpotifyA5WoodRGB`
- `SpotifyA5WoodRBGSpeaker`

A4 (звичайний QR):
- розмір `30x30 мм`;
- відступ знизу `90 мм`;
- відступ справа `28 мм`.

A4 (Spotify code):
- зона `110x25 мм`, знизу по центру;
- відступ знизу `11 мм`.

SKU:
- `SpotifyA4Wood`
- `SpotifyA4WoodWW`
- `SpotifyA4WoodMultiWW`
- `SpotifyA4WoodRGB`
- `SpotifyA4WoodRBGSpeaker`

## 7.2 Telegram група
A5:
- `20x20 мм`, справа;
- знизу `42 мм`, справа `8 мм`.

SKU:
- `TelegramA5Wood`
- `TelegramA5WoodWW`
- `TelegramA5WoodMultiWW`
- `TelegramA5WoodRGB`
- `TelegramA5WoodRBGSpeaker`

A4:
- `30x30 мм`, справа;
- знизу `63 мм`, справа `12 мм`.

SKU:
- `TelegramA4Wood`
- `TelegramA4WoodWW`
- `TelegramA4WoodMultiWW`
- `TelegramA4WoodRGB`
- `TelegramA4WoodRBGSpeaker`

## 7.3 SoundCloud група
A5:
- `15x15 мм`, справа;
- знизу `51 мм`, справа `7 мм`.

SKU:
- `SoundCloudA5Wood`
- `SoundCloudA5WoodWW`
- `SoundCloudA5WoodMultiWW`
- `SoundCloudA5WoodRGB`
- `SoundCloudA5WoodRBGSpeaker`

A4:
- `25x25 мм`, справа;
- знизу `70 мм`, справа `9 мм`.

SKU:
- `SoundCloudA4Wood`
- `SoundCloudA4WoodWW`
- `SoundCloudA4WoodMultiWW`
- `SoundCloudA4WoodRGB`
- `SoundCloudA4WoodRBGSpeaker`

## 7.4 YouTube група
A5:
- `17x17 мм`, знизу по центру;
- знизу `10 мм`.

SKU:
- `YouTubeA5Wood`
- `YouTubeA5WoodWW`
- `YouTubeA5WoodMultiWW`
- `YouTubeA5WoodRGB`
- `YouTubeA5WoodRBGSpeaker`

A4:
- `25x25 мм`, знизу по центру;
- знизу `15 мм`.

SKU:
- `YouTubeA4Wood`
- `YouTubeA4WoodWW`
- `YouTubeA4WoodMultiWW`
- `YouTubeA4WoodRGB`
- `YouTubeA4WoodRBGSpeaker`

## 7.5 PhotoPoster група
A5:
- `15x15 мм`, справа;
- знизу `10 мм`, справа `7 мм`.

SKU:
- `PhotoPosterA5Wood`
- `PhotoPosterA5WoodWW`
- `PhotoPosterA5WoodMultiWW`
- `PhotoPosterA5WoodRGB`

A4:
- `18x18 мм`, справа;
- знизу `11 мм`, справа `9 мм`.

SKU:
- `PhotoPosterA4Wood`
- `PhotoPosterA4WoodWW`
- `PhotoPosterA4WoodMultiWW`
- `PhotoPosterA4WoodRGB`

## 7.6 Apple група
A5:
- `18x18 мм`, справа;
- знизу `65 мм`, справа `15 мм`.

SKU:
- `AppleA5Wood`
- `AppleA5WoodWW`
- `AppleA5WoodMultiWW`
- `AppleA5WoodRGB`
- `AppleA5WoodRBGSpeaker`
- `MomAppleA5Wood`
- `MomAppleA5WoodWW`
- `MomAppleA5WoodMultiWW`
- `MomAppleA5WoodRBG`
- `MomAppleA5WoodRBGSpeaker`
- `AppleGrandpaA5Wood`
- `AppleGrandpaA5WoodWW`
- `AppleGrandpaA5WoodRBG`
- `AppleGrandpaA5WoodRBGSpeaker`
- `AppleGrandpaA5WoodMultiWW`
- `AppleClassmatesA5Wood`
- `AppleClassmatesA5WoodWW`
- `AppleClassmatesA5WoodMultiWW`
- `AppleClassmatesA5WoodRBG`
- `AppleClassmatesA5WoodRBGSpeaker`
- `AppleFriendsA5W`
- `AppleFriendsA5WW`
- `AppleFriendsA5RGB`
- `AppleFriendsA5RGB+K`
- `AppleFriendsA5MultiWW`
- `AppleGrannyA5Wood`
- `AppleGrannyA5WoodWW`
- `AppleGrannyA5WoodRBG`
- `AppleGrannyA5WoodRBGSpeaker`
- `AppleGrannyA5WoodMultiWW`
- `FriendAppleA5W`
- `FriendAppleA5WW`
- `FriendAppleA5RGB`
- `FriendAppleA5RGB+K`
- `FriendAppleA5MultiWW`

A4:
- `25x25 мм`, справа;
- знизу `98 мм`, справа `25 мм`.

SKU:
- `AppleA4Wood`
- `AppleA4WoodWW`
- `AppleA4WoodMultiWW`
- `AppleA4WoodRGB`
- `AppleA4WoodRBGSpeaker`
- `FriendAppleA4W`
- `FriendAppleA4WW`
- `FriendAppleA4RGB`
- `FriendAppleA4RGB+K`
- `FriendAppleA4MultiWW`
- `AppleFriendsA4W`
- `AppleFriendsA4WW`
- `AppleFriendsA4RGB`
- `AppleFriendsA4RGB+K`
- `AppleFriendsA4MultiWW`
- `AppleClassmatesA4Wood`
- `AppleClassmatesA4WoodWW`
- `AppleClassmatesA4WoodMultiWW`
- `AppleClassmatesA4WoodRBG`
- `AppleClassmatesA4WoodRBGSpeaker`
- `MomAppleA4Wood`
- `MomAppleA4WoodWW`
- `MomAppleA4WoodMultiWW`
- `MomAppleA4WoodRBG`
- `MomAppleA4WoodRBGSpeaker`
- `AppleGrandpaA4Wood`
- `AppleGrandpaA4WoodWW`
- `AppleGrandpaA4WoodRBG`
- `AppleGrandpaA4WoodRBGSpeaker`
- `AppleGrandpaA4WoodMultiWW`

## 8. Важливе правило по QR для інших товарів
Для всіх товарів поза списками в розділі 7:
- код у макет НЕ додається;
- у Telegram лишається тільки примітка `QR +`/`LF +`/`A6 +`/`B +` (якщо опції реально є в замовленні).

## 9. Мінімальний набір тест-кейсів
- `TC-01`: звичайний постер, без опцій.
- `TC-02`: постер + гравіювання.
- `TC-03`: постер + стікер.
- `TC-04`: постер + гравіювання + стікер.
- `TC-05`: термінове замовлення (`_T`).
- `TC-06`: спец-група нічників (`HT/RB/...`) з перевіркою коду постера.
- `TC-07`: Spotify SKU + spotify link.
- `TC-08`: Spotify SKU + non-spotify link.
- `TC-09`: Telegram/SoundCloud/YouTube/PhotoPoster/Apple SKU з перевіркою placement.
- `TC-10`: невалідне посилання -> warning у примітках.
- `TC-11`: `1 ❤️` -> статус "друк".
- `TC-12`: `👍` у дефолтному релізі не викликає переходу (pilot disabled).
- `TC-13`: кейс `poster + A6 + брелок`:
  - poster має `..._1_3`;
  - ручні позиції мають `..._2_3` і `..._3_3`.
- `TC-14`: shortener fallback:
  - `lnk.ua` недоступний -> використано `cutt.ly`.
- `TC-15`: перевірка, що у фінальному PDF немає `C0 M0 Y0 K0` для ділянок білого.

## 10. Ризики і що треба узгодити перед реалізацією
- `status_id` уже підтверджені live, але треба затвердити, чи використовуємо ще `Макет = 21`, `Скачано макет = 29`, `Без файлу = 40`, `Немає в тг = 59` для нештатних сценаріїв.
- Потрібно затвердити джерело формату A5/A4 у спірних SKU:
  - рекомендовано explicit SKU mapping як перший пріоритет для whitelisted товарів;
  - далі `offer.properties["Розмір"]` або `offer.properties["Оберіть розмір постера"]`;
  - далі `product.properties["Variant"]`;
  - далі евристика по SKU/name.
- `RBG` у багатьох SKU підтверджено live, тому це слід вважати валідними артикулами.
- shortener-провайдер `lnk.ua` може бути нестабільним, тому потрібен fallback `cutt.ly`.
- Джерело генерації Spotify code зафіксоване:
  - SVG із `scannables.scdn.co` (spotifycodes);
  - видалення фонового шару перед вставкою;
  - після вставки застосовується стандартний off-white/CMYK pipeline.
- У ТЗ є 1 SKU, якого зараз немає в CRM:
  - `FriendAppleA5RGB+K`
- У CRM знайдена щонайменше 1 невідповідність між SKU і `offer.properties`:
  - `FriendAppleA4RGB+K` має `sku=A4`, але `offer.properties` вказує `А5`.

## 10.1 Питання, які API не закриває і потрібне ваше уточнення
- Чи реакції для зміни статусу в CRM обробляємо тільки на PDF-повідомленнях чи також на preview-повідомленнях у Telegram.
- Для `1 ❤️` пересилаємо в `ЗАМОВЛЕННЯ` весь комплект чи лише poster.
- Фінальна політика пересилання: `copy` (рекомендовано) чи `forward`.
- Чи треба дублювати пересилання в приватний чат менеджера.
- Коли вмикаємо pilot-функціонал `👍 -> Пакування` у production.

Вже зафіксовано за вашими відповідями:
- multi-poster дозволений; нумерація йде послідовно по всіх базових постерах у замовленні (`_1_2`, `_2_2`, ...);
- стікер має фіксований розмір;
- при відсутності/збої PDF використовуємо статус `Без файлу`;
- Spotify code: беремо SVG зі `scannables.scdn.co`, прибираємо фон, додаємо у макет, потім виконуємо заміну білого на off-white;
- типи кодів: тільки звичайний QR і Spotify code;
- rollback по лайках не робимо (workflow монотонний вперед, активний етап: `1❤️ -> Друк`).
- файл гравіювання завжди генерується на `A3` з межами тексту:
  - `A4`: `22x210 мм`
  - `A5`: `22x148 мм`
- `A6` і `брелок` входять у `total` нумерації комплекту (`A6 +`, `B +` у примітках).

## 10.2 Вже зафіксовані припущення
- Джерело замовлень:
  - webhook у CRM буде налаштований лише на Shopify-замовлення;
  - у сервісі це вважається вхідною гарантією.
- Порядок файлів для комбінації `poster + engraving + sticker`:
  - `1/3` -> poster
  - `2/3` -> engraving
  - `3/3` -> sticker

## 11. Пропонований порядок робіт у гілці
1. Створити конфіги SKU/QR/reactions.
2. Оновити `layoutPlan` і `filename builder`.
3. Додати QR strategy (звичайний/Spotify), placement resolver і shortener fallback.
4. Доробити webhook gating по статусу "МАТЕРІАЛИ".
5. Додати Telegram routing `ОБРОБКА -> 1❤️ -> ЗАМОВЛЕННЯ`.
6. Зафіксувати `👍 -> Пакування` як pilot-disabled stage.
7. Додати врахування ручних `A6/B` позицій у `total` нумерації.
8. Додати preflight перевірку CMYK-білого.
9. Покрити тести і виконати прогін на fixture-замовленнях.
