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

## 1. Мета
Доробити поточний сервіс так, щоб він повністю покривав ТЗ по:
- формуванню назв файлів макетів;
- генерації/вбудовуванню QR або Spotify-коду тільки для потрібних груп товарів;
- коректному повідомленню в Telegram (файли, примітки, прев'ю);
- зміні статусів у CRM за реакціями в Telegram;
- гарантії заміни білого кольору під друк у CMYK-пайплайні.

## 2. Що вже реалізовано в коді
Оновлення станом на Stage D intake:
- додано `POST /webhook/keycrm` і `POST /webhook/telegram` у TS-сервісі;
- додано `CrmClient` з `GET /order/{id}` і `PUT /order/{id}` + retry/timeout;
- додано file-based idempotency для order webhook;
- додано queue intake (`order_intake`, `reaction_intake`) замість синхронної обробки в HTTP;
- додано базові автотести для webhook parser/idempotency/controller.

Історично, у попередньому JS-коді вже були/частково були:
- побудова `layoutPlan` із матеріалами `poster/engraving/sticker`;
- базовий неймінг `CGU_<code>_<order>_<index>_<total>[_T]`;
- прапори для повідомлень (`QR +`, `LF +`);
- попередження про невалідне QR-посилання;
- завантаження прев'ю із `_customization_image` і відправка у Telegram;
- генерація PDF для гравіювання/стікера;
- вбудовування звичайного QR в постер;
- реакції Telegram -> зміна статусу в CRM (зараз лише один цільовий статус по порогу hearts);
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
- в `.env` уже задано `TELEGRAM_REACTION_TARGET_STATUS_ID=22`;
- це означає, що зараз реакції Telegram уже переводять замовлення в `Друк`.

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
- надійний форматний парсер для SKU без явного `A5/A4` у назві (потрібен fallback із властивостей CRM).

### 3.2 Логіка QR/Spotify-коду
Відсутнє/неповне:
- rules-by-SKU: зараз QR застосовується загально, а за ТЗ треба тільки для визначених груп;
- різні розміри/позиції QR за групами товарів;
- окрема поведінка для Spotify:
  - якщо посилання Spotify -> Spotify code у центрі знизу у прямокутнику;
  - якщо не Spotify -> звичайний QR у визначеній позиції.

### 3.3 Telegram та статуси
Відсутнє/неповне:
- явна прив'язка "відправляти на статусі МАТЕРІАЛИ";
- двоступенева зміна статусів:
  - `1 ❤️` -> статус "друк";
  - `2 ❤️` -> статус "пакування";
- узгоджений порядок застосування реакцій (ідемпотентність для переходів 1->2).

### 3.4 Колір і підготовка до друку
Відсутнє/неповне:
- ТЗ вимагає гарантувати заміну `C0 M0 Y0 K0` на `C0 M0 Y3 K0` для всіх макетів, що йдуть у бот;
- поточна реалізація робить near-white replacement + CMYK conversion, але без жорсткої перевірки саме `Y=3` у фінальному PDF.

### 3.5 Додаткові вимоги
Потрібно зафіксувати:
- для товарів поза whitelist QR не додається, але `QR +`/`LF +` у примітках залишаються;
- при невалідному посиланні потрібна примітка про помилку (частково вже є, треба уніфікувати для всіх QR-груп).

### 3.6 Що вже покрито частково, але треба переробити
- webhook -> завантаження замовлення -> генерація файлів -> відправка в Telegram уже зібрані в один пайплайн;
- реакції Telegram уже мапляться назад у CRM, але лише в один статус і без покрокового workflow;
- визначення формату/типу підставки зараз є, але працює евристично по `Variant`/SKU/name і не використовує `offer.properties[]` як основне джерело;
- QR уже вбудовується в PDF, але без SKU-specific правил;
- прев'ю макету вже відправляється в Telegram.

## 4. Цільова архітектура доробки

### 4.1 Конфігурація (data-driven)
Додати окремі конфіг-файли:
- `config/product-code-rules.json`
  - mapping SKU/pattern -> код постера (`AA5`, `HT`, `RB`...);
  - mapping stand type (`W`, `WW`, `MWW`, `C`, `K`);
- `config/qr-rules.json`
  - whitelist SKU для вбудовування коду;
  - тип коду: `qr` або `spotify_code`;
  - параметри placement (A5/A4);
- `config/reaction-status-rules.json`
  - hearts -> status_id (1 і 2);
  - політика ескалації/блокування повторного застосування.

### 4.2 Сервіси/модулі
Винести логіку в окремі блоки:
- `src/layout/filename-builder.js` (нормалізований неймінг);
- `src/layout/product-classifier.js` (визначення групи/коду/формату/підставки);
- `src/qr/code-strategy.js` (звичайний QR vs Spotify code);
- `src/qr/placement-resolver.js` (позиції/розміри по SKU + формату);
- `src/reactions/status-workflow.js` (1❤️/2❤️ переходи статусів).

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
- підтвердити CRM-поле, з якого брати формат для гравіювання, якщо не визначився з SKU.

Результат:
- документ `docs/TZ_ASSUMPTIONS.md` з фінальними ID і правилами fallback.

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
- для `poster + engraving + sticker` порядок фіксований:
  - `poster` -> `engraving` -> `sticker`;
- термінове замовлення додає `_T`.

## Етап 2. QR/Spotify по whitelist товарів
Завдання:
- додати SKU-based правила вбудовування коду;
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
- при невалідному URL є warning у примітці Telegram.

## Етап 3. Відправка у Telegram на статусі "МАТЕРІАЛИ"
Завдання:
- додати перевірку статусу події KeyCRM (обробка/відправка тільки коли status == "МАТЕРІАЛИ");
- якщо у webhook немає достатніх даних, довантажувати order через `GET /order/{id}`;
- зберегти поточну логіку прев'ю + файлів;
- уніфікувати примітки:
  - `QR +`;
  - `LF +`;
  - текст помилки URL за наявності.

Критерії приймання:
- бот не відправляє матеріали на інших статусах;
- у повідомленні є прев'ю і коректні назви файлів.

## Етап 4. Реакції Telegram -> 2 статуси CRM
Завдання:
- замінити один поріг на 2 пороги:
  - рівно/не менше 1 ❤️ -> статус "друк";
  - рівно/не менше 2 ❤️ -> статус "пакування";
- додати захист від даунгрейду статусу при зміні кількості реакцій.
- зберігати найвищий застосований етап по повідомленню/замовленню.

Критерії приймання:
- 1 реакція ставить "друк";
- 2 реакції ставить "пакування";
- повторні webhook-події не створюють фліп-флопів статусів.

Рекомендована бізнес-логіка:
- реакції трактуються як односторонній workflow;
- якщо лайк зняли після переходу в `Друк` або `Пакування`, статус назад не відкочується;
- система реагує тільки на підвищення етапу:
  - `0 -> 1` лайк: ставимо `Друк`;
  - `1 -> 2+` лайки: ставимо `Пакування`;
  - `2 -> 1 -> 0`: ігноруємо;
- якщо потрібен rollback, це має бути окреме явне правило з окремими статусами повернення.

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
- у Telegram лишається тільки примітка `QR +`/`LF +` (якщо опції реально є в замовленні).

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
- `TC-12`: `2 ❤️` -> статус "пакування".
- `TC-13`: перевірка, що у фінальному PDF немає `C0 M0 Y0 K0` для ділянок білого.

## 10. Ризики і що треба узгодити перед реалізацією
- `status_id` уже підтверджені live, але треба затвердити, чи використовуємо ще `Макет = 21`, `Скачано макет = 29`, `Без файлу = 40`, `Немає в тг = 59` для нештатних сценаріїв.
- Потрібно затвердити джерело формату A5/A4 у спірних SKU:
  - рекомендовано explicit SKU mapping як перший пріоритет для whitelisted товарів;
  - далі `offer.properties["Розмір"]` або `offer.properties["Оберіть розмір постера"]`;
  - далі `product.properties["Variant"]`;
  - далі евристика по SKU/name.
- `RBG` у багатьох SKU підтверджено live, тому це слід вважати валідними артикулами.
- Потрібно затвердити джерело генерації Spotify code (API/бібліотека/рендер-специфіка).
- У ТЗ є 1 SKU, якого зараз немає в CRM:
  - `FriendAppleA5RGB+K`
- У CRM знайдена щонайменше 1 невідповідність між SKU і `offer.properties`:
  - `FriendAppleA4RGB+K` має `sku=A4`, але `offer.properties` вказує `А5`.

## 10.1 Питання, які API не закриває і потрібне ваше уточнення
- Чи може в одному замовленні бути більше одного базового постера, і як тоді нумерувати всі файли?
- Чи стікер завжди має стандартний розмір, чи розмір стікера теж залежить від SKU/формату?
- Чи потрібно при помилці генерації/відсутності PDF автоматично переводити замовлення в один із статусів:
  - `Без файлу = 40`
  - `Немає в тг = 59`
  - інший статус?
- Що робити з лайками після досягнення `Пакування`:
  - повністю ігнорувати;
  - логувати;
  - сповіщати менеджера;
  - робити rollback?
- Чи є ще якісь типи кодів, крім звичайного QR і Spotify code?
- Який саме вигляд має мати Spotify code:
  - чорний/світлий;
  - з логотипом чи без;
  - із фіксованими полями safe zone чи достатньо просто вписати у прямокутник?

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
3. Додати QR strategy (звичайний/Spotify) і placement resolver.
4. Доробити webhook gating по статусу "МАТЕРІАЛИ".
5. Розширити reaction workflow до 2 статусів.
6. Додати preflight перевірку CMYK-білого.
7. Покрити тести і виконати прогін на fixture-замовленнях.
