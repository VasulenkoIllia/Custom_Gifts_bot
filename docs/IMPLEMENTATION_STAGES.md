# Етапи реалізації

## Принцип
Міграція має бути поетапною. Спочатку фіксуємо та документуємо legacy, потім будуємо TypeScript-каркас, далі переносимо логіку по модулях, і лише після цього перемикаємо production.

## Етап 0. Freeze legacy і reference
Ціль:
- зберегти поточний JS-код як контрольну точку;
- зафіксувати, що саме вже частково протестовано.

Результат:
- папка `reference/legacy-js/`
- опис legacy-модулів у `docs/LEGACY_REFERENCE.md`

## Етап 1. Документація і рішення по архітектурі
Ціль:
- закрити всі архітектурні рішення до початку TS-реалізації.

Результат:
- актуальний план ТЗ
- TypeScript architecture doc
- operations doc
- customer brief

## Етап 2. Bootstrap TypeScript-проєкту
Ціль:
- підготувати чисту основу нового сервісу.

Що входить:
- `tsconfig`
- структура `src/`
- base logger
- base config loader
- env validation
- health endpoint

Критерій завершення:
- проєкт стартує як порожній TS-сервіс без бізнес-логіки.

## Етап 3. Domain types і config rules
Ціль:
- типізувати домен і винести бізнес-правила з коду в config.

Що входить:
- типи order, product, material, reaction, queue job
- `product-code-rules`
- `qr-rules`
- `reaction-rules`
- `status-rules`

Критерій завершення:
- конфіг проходить валідацію на старті;
- правила не хардкодяться в оркестраторі.

## Етап 4. CRM integration layer
Ціль:
- побудувати чистий adapter до CRM.

Що входить:
- fetch order by id
- update status
- retry policy
- timeout policy
- помилки інтеграції

Критерій завершення:
- всі CRM-виклики покриті одним модулем.

## Етап 5. Webhook receiver і enqueue
Ціль:
- відокремити прийом webhook від обробки.

Що входить:
- KeyCRM webhook controller
- Telegram webhook controller
- auth/secret validation
- idempotency key
- постановка в durable queue

Критерій завершення:
- receiver не виконує heavy processing синхронно.

## Етап 6. Order orchestration
Ціль:
- побудувати один передбачуваний pipeline для order processing.

Що входить:
- fetch order
- normalize order
- select base item
- detect add-ons
- build layout plan
- decide QR / Spotify / notes / preview

Критерій завершення:
- один модуль керує повним lifecycle замовлення.

## Етап 7. SKU classifier і naming
Ціль:
- перенести всі правила артикулів і назв файлів.

Що входить:
- special poster codes
- format resolution
- stand type resolution
- urgent detection
- filename builder

Критерій завершення:
- всі whitelisted SKU проходять mapping predictably.

## Етап 8. PDF pipeline hardening
Ціль:
- перенести і стабілізувати найважчий блок системи.

Що входить:
- source poster download
- recolor white
- CMYK conversion
- QR embed
- Spotify code
- engraving PDF
- sticker PDF
- temp files lifecycle
- per-step logging

Критерій завершення:
- pipeline проходить на контрольному наборі fixtures;
- worker не падає від звичайного навантаження.

## Етап 9. Telegram delivery і ops alerts
Ціль:
- розділити customer-facing delivery і технічні повідомлення.

Що входить:
- preview send
- files send
- message mapping
- ops alert messages
- retry and fallback logic

Критерій завершення:
- будь-яка критична проблема дублюється в ops chat.

## Етап 10. Reaction workflow
Ціль:
- реалізувати односторонній workflow за реакціями.

Що входить:
- reaction counting
- `1 ❤️ -> Друк`
- `2 ❤️ -> Пакування`
- no rollback by default
- duplicate protection

Критерій завершення:
- реакції не викликають фліп-флоп статусів.

## Етап 11. Observability і failure handling
Ціль:
- зробити систему передбачуваною в production.

Що входить:
- structured logging
- metrics
- DLQ
- alert routing
- queue backlog visibility
- disk usage checks

Критерій завершення:
- оператор розуміє, що саме зламалось і де.

## Етап 12. Stress tests і ресурсні обмеження
Ціль:
- підтвердити безпечні межі concurrency.

Що входить:
- тест на чергу з серією замовлень
- тест на великий PDF
- test cleanup temp files
- memory peaks
- timeout behavior

Критерій завершення:
- визначено production concurrency і worker sizing.

## Етап 13. Cutover в production
Ціль:
- безпечно перевести бізнес-процес на новий TS-сервіс.

Що входить:
- dry run
- shadow mode
- limited rollout
- full switch
- rollback plan

Критерій завершення:
- webhook і worker працюють стабільно на реальних замовленнях.
