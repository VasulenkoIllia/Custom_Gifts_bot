# White Cleanup CMYK Postcheck Validation (2026-04-20)

## 1. Scope

Документ фіксує оновлення white cleanup для режиму `PDF_COLOR_SPACE=CMYK` і результати перевірки на live-order set:

- `29660`
- `29659`
- `29658`
- `29657`
- `29656`
- `29655`
- `29654`

Ціль:
- гарантувати, що фінальний файл лишається у `CMYK`;
- мінімізувати residual near-white після CMYK conversion;
- не ламати основну бізнес-логіку order flow;
- тримати контроль якості через `edge ratio` і `RMSE`.

## 2. What Changed

### 2.1 Final CMYK guarantee

У `PdfPipelineService` CMYK conversion тепер виконується у final preflight stage навіть коли strict retry не тригериться (за умови, що файл ще не був конвертований після overlay stage).

### 2.2 Post-CMYK residual near-white postcheck

Додано окремий residual checker (`measureResidualNearWhiteInPdf`) на фінальному CMYK PDF:
- rasterization на `RASTERIZE_DPI`;
- ті самі strict/aggressive критерії, що в preflight;
- метрики:
  - `residual_strict_white_pixels`
  - `residual_aggressive_white_pixels`
  - `residual_strict_low_alpha_white_pixels`
  - `residual_aggressive_low_alpha_white_pixels`

### 2.3 Smart retry after CMYK conversion

Якщо postcheck показує residual near-white:
- запускається додатковий `enforceOffWhiteInPdf(profile="aggressive")`;
- виконується повторна CMYK conversion;
- postcheck повторюється.

Retry-палітра (для `OFFWHITE_HEX=FFFEFA`):
- `F7F6F2`
- `F3F2EE`

## 3. Changed Files

- `src/modules/pdf/material-generator.ts`
  - `enforceOffWhiteInPdf(profile: "strict" | "aggressive")`
  - новий `measureResidualNearWhiteInPdf(...)`
- `src/modules/pdf/pdf-pipeline.service.ts`
  - guaranteed CMYK in final stage
  - post-CMYK residual check + smart retry
  - додані поля в `final_preflight` details (`cmyk_postcheck_applied`, `cmyk_retry_*`, `cmyk_applied`)

## 4. Validation Method

Виконано поодинокі прогони для кожного order id:

```bash
set -a; source .env; set +a;
node dist/scripts/diagnose-pdf-white-quality.js \
  --label=single_<ORDER_ID>_cmyk_quality_check \
  --order-ids=<ORDER_ID> \
  --output-json=artifacts/diagnostics/white-quality-<ORDER_ID>-single-cmyk-quality-check.json
```

Додатково перевірено маркери color space у фінальних PDF:
- очікування: `/DeviceCMYK`
- не очікується: `/DeviceRGB`

## 5. Results (Single Runs)

| Order | White strict (source → output) | White aggressive (source → output) | Edge ratio | RMSE | Final preflight |
|---|---:|---:|---:|---:|---|
| 29660 | `10086 → 0` | `18409 → 0` | `1.0596` | `4.6331` | `applied=true` |
| 29659 | `17423 → 0` | `20796 → 0` | `0.8144` | `8.2272` | `applied=true` |
| 29658 | `1772190 → 0` | `1788651 → 0` | `0.7934` | `29.2873` | `applied=false` |
| 29657 | `90798 → 0` | `179354 → 0` | `0.9135` | `9.4939` | `applied=true` |
| 29656 | `1103096 → 0` | `1183870 → 2` | `0.9022` | `9.4871` | `applied=true` |
| 29655 | `31270 → 0` | `53908 → 1` | `0.9239` | `7.4208` | `applied=true` |
| 29654 | `48440 → 0` | `60932 → 1` | `0.9129` | `8.9653` | `applied=true` |

Агреговано по 7 кейсах:
- `source strict`: `3,073,303`
- `source aggressive`: `3,305,920`
- `output strict`: `0`
- `output aggressive`: `4`

## 6. CMYK Verification

Для всіх 7 фінальних PDF у single-run артефактах знайдено маркер `/DeviceCMYK`.

## 7. Business Impact

- Основна бізнес-логіка не змінена:
  - webhook intake;
  - layout plan;
  - QR/Spotify бізнес-правила;
  - Telegram delivery;
  - CRM status transitions.
- Зміни ізольовані в PDF quality pipeline.

## 8. Artifacts

JSON reports:
- `artifacts/diagnostics/white-quality-29660-single-cmyk-quality-check.json`
- `artifacts/diagnostics/white-quality-29659-single-cmyk-quality-check.json`
- `artifacts/diagnostics/white-quality-29658-single-cmyk-quality-check.json`
- `artifacts/diagnostics/white-quality-29657-single-cmyk-quality-check.json`
- `artifacts/diagnostics/white-quality-29656-single-cmyk-quality-check.json`
- `artifacts/diagnostics/white-quality-29655-single-cmyk-quality-check.json`
- `artifacts/diagnostics/white-quality-29654-single-cmyk-quality-check.json`

Final single-run PDFs:
- `storage/files/materials/29660_single_29660_cmyk_quality_check_58d8316e/CGU_AA4_29660_1_1.pdf`
- `storage/files/materials/29659_single_29659_cmyk_quality_check_f9fe1d4b/CGU_AA5_29659_1_1.pdf`
- `storage/files/materials/29658_single_29658_cmyk_quality_check_6b2a6834/CGU_AA5_29658_1_1_T.pdf`
- `storage/files/materials/29657_single_29657_cmyk_quality_check_d7adbacd/CGU_AA5_29657_1_1.pdf`
- `storage/files/materials/29656_single_29656_cmyk_quality_check_cf30db6f/CGU_AA4_29656_1_1.pdf`
- `storage/files/materials/29655_single_29655_cmyk_quality_check_4da41681/CGU_AA4_29655_1_3_T.pdf`
- `storage/files/materials/29654_single_29654_cmyk_quality_check_3e5b3743/CGU_AA5_29654_1_2.pdf`
