# Legacy JS snapshot

Ця папка зберігає snapshot поточної JavaScript-реалізації як reference для майбутньої TypeScript-міграції.

## Правила
- Не використовувати цю папку як цільову архітектуру нового проєкту.
- Не редагувати ці файли як основне місце розробки нового TS-рішення.
- Використовувати тільки для:
  - звірки поведінки;
  - перенесення перевірених фрагментів логіки;
  - regression comparison.

## Джерело snapshot
- Поточні файли з кореня репозиторію, що містять existing business logic.

## Вміст
- `index.js`
- `material-generator.js`
- `order-queue.js`
- `telegram-client.js`
- `telegram-message-store.js`
- `url-shortener.js`
- `package.json`
- `package-lock.json`
- `.env.example`
- `open-api.yml`
- `Caveat-VariableFont_wght.ttf`
