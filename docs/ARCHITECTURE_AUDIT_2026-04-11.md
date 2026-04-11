# Архітектурний аудит (2026-04-11)

## Обсяг перевірки
- runtime bootstrap і життєвий цикл (`src/app/*`);
- модулі черг, retention, webhooks, workers;
- перевірка компіляції і тестового контуру;
- актуальність технічної документації.

## Висновок
Поточна архітектура стабільна і прогнозована:
- `check`, `build`, `test` проходять;
- runtime побудований як queue-driven pipeline з retry/DLQ;
- критичні deterministic-кейси обробляються без зайвих retry;
- стан workflow і routing збережено в PostgreSQL.

## Ключові ризики, знайдені під час аудиту
1. Дублювання правил ролей застосунку в кількох місцях (`load-config`, `validate-config`, `runtime`, `health`) створювало ризик розсинхрону.
2. У production-дереві коду була in-memory черга, яка фактично використовувалася тільки тестами.
3. Документація містила застарілі посилання на файли, яких більше немає (`postgres-schema.ts`, `queue-service.ts`).

## Що змінено
1. Додано єдине джерело правди для ролей:
   - `src/config/app-role.ts` (`AppRole`, parse/validate helpers, role-capability helpers).
2. Прибрано неактуальний runtime-код:
   - `src/modules/queue/queue-service.ts` видалено з production-коду;
   - тестова реалізація перенесена в `tests/helpers/in-memory-queue.ts`.
3. Оновлено тести:
   - `tests/queue-retry-dlq.test.ts`;
   - `tests/keycrm-webhook-controller.test.ts`.
4. Виправлено дрібний dead code:
   - видалено невикористаний type-import у `telegram-delivery.service.ts`.
5. Оновлено документацію:
   - `docs/README.md` очищено і переорганізовано;
   - `docs/TS_ARCHITECTURE.md` синхронізовано з фактичною структурою.

## Поточна оцінка якості
- Архітектура: `B+` (добра модульність, чіткий runtime flow, надійні черги).
- Чистота коду: `B` (помірна складність у великих сервісах, але хороше тестове покриття).
- Відповідність патернам: `B+` (адаптери інтеграцій, worker-підхід, idempotency, DLQ).
- Експлуатаційна стабільність: `A-` (health/readiness, retention, structured logging, alerting).

## Рекомендовані наступні кроки
1. Поступово декомпозувати найбільші файли (`material-generator.ts`, `order-intake-worker.ts`) на менші підмодулі.
2. Додати окремий легкий lint-контур (`eslint`) для раннього виявлення dead code і style-regressions.
3. Зафіксувати правило: тестові утиліти не розміщувати в `src/`.
