# White Cleanup Smart Retry Validation (2026-04-18)

## 1. Scope

Документ фіксує впровадження `Smart retry` для white cleanup та результати порівняльного A/B тесту на live-замовленнях:

- `29645`
- `29644`
- `29640`
- `29634`
- `29635`
- `29626`

Мета:
- прибирати залишковий білий (`near-white`) максимально повно;
- зменшити деградацію якості від зайвих повторних проходів;
- не змінювати бізнес-логіку order flow;
- зберегти CMYK conversion.

## 2. What Changed

### 2.1 Smart retry white cleanup

Реалізовано режим:
- перший white pass виконується завжди;
- другий pass виконується тільки якщо preflight після першого проходу показав residual near-white;
- третій pass більше не запускається як безумовний повтор.

Відповідно:
- `whiteReplaceIterations` і `whiteFinalIterations` лишаються в конфіг як `3` для backward compatibility;
- runtime cap встановлено на максимум `2` фактичні спроби на етап.

### 2.2 Residual white preflight metrics

Додано явні метрики для прийняття рішення про retry:
- `residual_strict_white_pixels`
- `residual_aggressive_white_pixels`
- `residual_strict_low_alpha_white_pixels`
- `residual_aggressive_low_alpha_white_pixels`

### 2.3 Conditional final preflight in pipeline service

Final strict preflight (`enforceOffWhiteInPdf`) тепер виконується тільки якщо у фінальному white stage залишився residual near-white.

Побічний ефект:
- повторна CMYK conversion після final preflight запускається тільки коли strict preflight реально виконався.

## 3. Changed Files

- `src/modules/pdf/material-generator.ts`
  - Smart retry logic + residual white metrics.
- `src/modules/pdf/pdf-pipeline.service.ts`
  - conditional final preflight and conditional post-preflight CMYK conversion.
- `src/scripts/diagnose-pdf-white-quality.ts`
  - diagnostic script для масового live-тестування якості/білого.
- `docs/OPERATIONS.md`
  - оновлено операційний опис white cleanup.

## 4. Validation Method

### 4.1 Baseline run (before change)

```bash
set -a; source .env; set +a;
node dist/scripts/diagnose-pdf-white-quality.js \
  --label=baseline \
  --order-ids=29645,29644,29640,29634,29635,29626 \
  --output-json=artifacts/diagnostics/white-quality-baseline.json
```

### 4.2 Smart retry run (after change)

```bash
set -a; source .env; set +a;
node dist/scripts/diagnose-pdf-white-quality.js \
  --label=smart_retry \
  --order-ids=29645,29644,29640,29634,29635,29626 \
  --output-json=artifacts/diagnostics/white-quality-smart-retry.json
```

### 4.3 Metrics used

- `White strict` / `White aggressive`:
  кількість near-white пікселів у фінальному output raster (600 DPI).
- `Edge preservation ratio`:
  `outputMeanGradient / sourceMeanGradient` (ближче до 1 = краще збереження різкості).
- `RMSE RGB`:
  відхилення output від source (менше = ближче до оригіналу).
- `iterations_used`:
  фактична кількість white-pass ітерацій.
- `final_preflight.applied`:
  чи запускався додатковий strict preflight pass.

## 5. Comparison Results (Before vs After)

| Order | White strict | White aggressive | Edge ratio | RMSE | Iter used | Final preflight |
|---|---:|---:|---:|---:|---:|---:|
| 29645 | 0 → 0 | 0 → 0 | 0.758 → 0.836 | 48.349 → 30.573 | 3 → 1 | true → false |
| 29644 | 5327 → 0 | 39250 → 0 | 0.896 → 0.928 | 7.737 → 5.753 | 3 → 1 | true → false |
| 29640 | 573 → 0 | 3134 → 0 | 0.972 → 0.985 | 3.864 → 2.496 | 3 → 1 | true → false |
| 29634 | 0 → 0 | 0 → 0 | 0.759 → 0.836 | 48.371 → 30.585 | 3 → 1 | true → false |
| 29635 | 0 → 0 | 0 → 0 | 0.819 → 0.905 | 39.206 → 32.421 | 3 → 1 | true → false |
| 29626 | 0 → 0 | 0 → 0 | 0.767 → 0.832 | 46.911 → 28.778 | 3 → 1 | true → false |

## 6. Aggregate Outcome

- `total strict white`: `5900 -> 0`
- `total aggressive white`: `42384 -> 0`
- `average edge ratio`: `0.8287 -> 0.8869` (`+7.03%`)
- `average RMSE`: `32.406 -> 21.768` (`-32.83%`)
- `white pass iterations_used`: `3 -> 1` у всіх 6 кейсах
- `final strict preflight`: `applied=true -> false` у всіх 6 кейсах

## 7. Business Impact

- Бізнес-логіка order flow не змінена:
  - webhook intake;
  - layout plan;
  - QR/Spotify logic;
  - Telegram delivery;
  - CRM status transitions.
- CMYK conversion збережена.
- Додано контрольований механізм retry тільки для проблемних файлів, без зайвих повторів на стабільних кейсах.

## 8. Artifacts

- Baseline JSON:
  - `artifacts/diagnostics/white-quality-baseline.json`
- Smart retry JSON:
  - `artifacts/diagnostics/white-quality-smart-retry.json`

## 9. Notes

- На окремих source PDF джерельна якість уже обмежена (наприклад, raster 300 PPI + soft mask у джерелі).  
  Smart retry покращує збереження деталей після обробки, але не може підвищити деталізацію вище source.
