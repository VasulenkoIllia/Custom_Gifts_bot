# Документація проєкту

## Що читати в першу чергу
- [README.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/README.md)
  - короткий опис системи, запуск, базові команди.
- [docs/TS_ARCHITECTURE.md](./TS_ARCHITECTURE.md)
  - актуальна архітектурна модель і модульні межі.
- [docs/OPERATIONS.md](./OPERATIONS.md)
  - runtime-поведінка, retry/DLQ, алерти, експлуатаційні правила.
- [docs/RUNBOOK.md](./RUNBOOK.md)
  - практичні кроки для запуску/відновлення.
- [docs/CONFIGURATION_MODEL.md](./CONFIGURATION_MODEL.md)
  - повна модель env/config і бізнес-правил.
- [docs/ARCHITECTURE_AUDIT_2026-04-11.md](./ARCHITECTURE_AUDIT_2026-04-11.md)
  - результат технічного аудиту архітектури і якості коду.
- [docs/ARCHITECTURE_AUDIT_2026-04-29.md](./ARCHITECTURE_AUDIT_2026-04-29.md)
  - аудит production-readiness: security, стресостійкість, DB pool, відкриті ризики.

## Операційні та валідаційні документи
- [docs/WEBHOOK_CHECKLIST.md](./WEBHOOK_CHECKLIST.md)
- [docs/STORAGE_RETENTION.md](./STORAGE_RETENTION.md)
- [docs/MANUAL_UAT_CHECKLIST.md](./MANUAL_UAT_CHECKLIST.md)
- [docs/LOCAL_REAL_MODE_TESTING.md](./LOCAL_REAL_MODE_TESTING.md)
- [docs/WHITE_SMART_RETRY_VALIDATION_2026-04-18.md](./WHITE_SMART_RETRY_VALIDATION_2026-04-18.md)
  - впровадження `Smart retry` для white cleanup + A/B результати на live-order set.
- [docs/WHITE_CMYK_POSTCHECK_VALIDATION_2026-04-20.md](./WHITE_CMYK_POSTCHECK_VALIDATION_2026-04-20.md)
  - CMYK postcheck + одиночні прогони `29660..29654` з контролем near-white і метрик якості.

## Історичні та планові документи
Ці файли збережені як історія рішень і міграції; вони не є джерелом актуального runtime-контракту:
- [docs/PROJECT_CONTROL.md](./PROJECT_CONTROL.md)
- [docs/TZ_COMPLETION_PLAN.md](./TZ_COMPLETION_PLAN.md)
- [docs/TZ_ADDENDUM_PLAN.md](./TZ_ADDENDUM_PLAN.md)
- [docs/TZ_ASSUMPTIONS.md](./TZ_ASSUMPTIONS.md)
- [docs/IMPLEMENTATION_STAGES.md](./IMPLEMENTATION_STAGES.md)
- [docs/LEGACY_REFERENCE.md](./LEGACY_REFERENCE.md)
- [docs/REGRESSION_ORDER_OPEN_QUESTIONS.md](./REGRESSION_ORDER_OPEN_QUESTIONS.md)
- [docs/REGRESSION_ORDER_EXPECTED_VS_ACTUAL.md](./REGRESSION_ORDER_EXPECTED_VS_ACTUAL.md)
- [docs/CUSTOMER_BRIEF.md](./CUSTOMER_BRIEF.md)

## Принцип актуальності
- Якщо є конфлікт між плановими/історичними документами і кодом, джерелом правди є код.
- Зміни поведінки системи мають супроводжуватися оновленням:
  - [README.md](/Users/monstermac/WebstormProjects/Custom_Gifts_bot/README.md)
  - [docs/TS_ARCHITECTURE.md](./TS_ARCHITECTURE.md)
  - [docs/OPERATIONS.md](./OPERATIONS.md)
