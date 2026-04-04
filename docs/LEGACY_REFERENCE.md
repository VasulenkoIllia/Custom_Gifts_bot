# Legacy reference

## Статус
Поточний JS-код не викидається. Він вважається:
- частково протестованим;
- придатним як функціональний reference;
- непридатним як фінальна цільова архітектура для довгої підтримки без реорганізації.

Важливо:
- поточний TypeScript runtime більше не залежить від файлів у `reference/legacy-js/`;
- папка зберігається тільки як архівний snapshot для історичного звіряння.

## Де зберігається snapshot
- `reference/legacy-js/`

## Для чого потрібен legacy snapshot
- швидко звіряти поточну бізнес-логіку;
- переносити перевірені фрагменти в новий TypeScript-код;
- мати baseline для regression checks;
- не втрачати робочі рішення по PDF/Telegram/CRM.

## Що зараз є в legacy
- `index.js`
  - HTTP server, webhook flow, order orchestration, reactions.
- `material-generator.js`
  - PDF generation, white replacement, CMYK conversion, QR embedding, engraving, sticker.
- `telegram-client.js`
  - preview/files delivery into Telegram.
- `telegram-message-store.js`
  - mapping `order <-> message`.
- `order-queue.js`
  - in-process queue.
- `url-shortener.js`
  - short URL helper.
- `open-api.yml`
  - локальна схема API.

## Як використовувати legacy під час міграції
- Не переносити код “як є” великими шматками.
- Переносити логіку модульно.
- Спочатку виносити domain rules.
- Потім виносити integration adapters.
- Потім переносити heavy PDF logic з окремими тестами.

## Що не можна робити
- Не змішувати новий TS-код і старий JS в одному модулі.
- Не покладатися на legacy як на production architecture.
- Не копіювати старі евристики без перевірки live-даними CRM.

## Роль legacy на старті
Legacy потрібен як референс, а не як майбутня структура проєкту.
