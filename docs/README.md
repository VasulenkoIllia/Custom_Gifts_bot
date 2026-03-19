# Документація проєкту

## Призначення
Цей набір документів фіксує:
- що вже підтверджено по API, CRM і бізнес-логіці;
- як має виглядати новий TypeScript-проєкт;
- як мігрувати з поточного JS-коду без втрати знань;
- як система має працювати в production стабільно і передбачувано.

## Основні документи
- [docs/PROJECT_CONTROL.md](./PROJECT_CONTROL.md)
  - єдиний master-plan для реалізації, контролю, тестування і поточного статусу.
- [docs/TZ_COMPLETION_PLAN.md](./TZ_COMPLETION_PLAN.md)
  - джерело фактів: ТЗ, API-підтвердження, SKU-аудит, відкриті питання.
- [docs/CUSTOMER_BRIEF.md](./CUSTOMER_BRIEF.md)
  - короткий brief для замовника.

## Reference документи
- [docs/TS_ARCHITECTURE.md](./TS_ARCHITECTURE.md)
  - цільова модульна архітектура нового TypeScript-проєкту.
- [docs/IMPLEMENTATION_STAGES.md](./IMPLEMENTATION_STAGES.md)
  - етапи реалізації від freeze legacy до запуску в production.
- [docs/OPERATIONS.md](./OPERATIONS.md)
  - робота webhook, черг, логування, алертів, retry, DLQ, ресурсів CPU/RAM.
- [docs/CONFIGURATION_MODEL.md](./CONFIGURATION_MODEL.md)
  - які бізнес-правила і технічні параметри треба виносити в конфіг.
- [docs/LEGACY_REFERENCE.md](./LEGACY_REFERENCE.md)
  - опис поточної JS-реалізації і правил її використання як референсу.

## Поточний статус
- Поточний JS-код вважається частково протестованим і придатним як reference.
- Новий production-проєкт планується як TypeScript-сервіс із модульною архітектурою.
- Основний акцент: надійність, прогнозованість, простота підтримки, контроль помилок, черги, логування, робота з PDF.

## Як працювати з документацією
- Для щоденної роботи використовувати лише:
  - [docs/PROJECT_CONTROL.md](./PROJECT_CONTROL.md)
  - [docs/TZ_COMPLETION_PLAN.md](./TZ_COMPLETION_PLAN.md)
  - [docs/CUSTOMER_BRIEF.md](./CUSTOMER_BRIEF.md)
- Решту документів відкривати тільки коли потрібна деталізація по архітектурі, operations, конфігу або legacy reference.

## Робочі принципи
- Секрети і середовище зберігаються в `.env`.
- Бізнес-правила мають бути винесені в окремі config-файли.
- Потік обробки має бути idempotent, queue-driven і відмовостійким.
- Всі критичні проблеми мають логуватись і дублюватись у Telegram ops-чат.
