# PDF Pipeline Optimization Validation (2026-04-26)

## Scope

Цей документ фіксує оптимізацію white cleanup pipeline без зміни DPI:

- `RASTERIZE_DPI=800`
- `RASTERIZE_DPI_HIGH_DETAIL=1200`
- `PDF_COLOR_SPACE=CMYK`
- baseline `OFFWHITE_HEX=FFFEFA`
- validated production default `OFFWHITE_HEX=F7F6F2`
- `ORDER_QUEUE_CONCURRENCY=2`
- `RASTERIZE_CONCURRENCY=2`
- `PDF_FINAL_PREFLIGHT_MEASURE_DPI=200`

Тестовий набір live orders: `29846, 29845, 29843, 29842, 29841, 29840`.

## Change

До оптимізації default path робив регулярний другий `white_recolor_final` pass ще до фінальної CMYK-перевірки. Це дублювало роботу, бо після CMYK все одно виконувався residual near-white postcheck і умовний retry.

Після оптимізації:

1. Основний white-pass виконується один раз.
2. Регулярний `white_recolor_final` не запускається у default path.
3. PDF конвертується в CMYK.
4. Після CMYK виконується residual near-white postcheck.
5. Aggressive retry запускається тільки якщо фінальний postcheck показав residual вище порога.
6. Stale/pre-CMYK residual з `white_recolor_final` більше не може самостійно тригерити retry.

## Live Result

Diagnostic artifact:

- `artifacts/diagnostics/live-white-optimized-800-p2-r2-20260426.json`

| Metric | Before optimization P2/R2 | After optimization P2/R2 |
| --- | ---: | ---: |
| Pipeline phase | 1196.1s | 797.8s |
| Projected throughput | ~433 orders/day | ~650 orders/day |
| Max active orders | 2 | 2 |
| Max Ghostscript processes | 2 | 2 |
| Max sampled Ghostscript RSS | 176128 KB | 176096 KB |

## Per-order Metrics

| Order | Time after | Time before | Gain | Generation | Final preflight | Strict out | Agg out | Edge ratio | RMSE | W/F |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 29846 | 141.8s | 262.3s | -45.9% | 92.3s | 49.3s | 1 | 31 | 0.998551 | 6.977806 | 0/0 |
| 29845 | 332.5s | 527.0s | -36.9% | 99.1s | 233.2s | 5 | 57 | 0.975068 | 4.747588 | 0/0 |
| 29843 | 363.3s | 514.3s | -29.4% | 172.2s | 190.7s | 5 | 84 | 0.922111 | 10.634799 | 0/0 |
| 29842 | 319.3s | 434.7s | -26.5% | 158.4s | 160.7s | 2 | 21 | 0.901544 | 6.577224 | 0/0 |
| 29841 | 277.3s | 404.3s | -31.4% | 129.2s | 144.8s | 5 | 80 | 0.893538 | 13.424476 | 0/0 |
| 29840 | 145.9s | 234.4s | -37.7% | 122.9s | 22.9s | 0 | 0 | 0.968514 | 4.894276 | 0/0 |

## Interpretation

Оптимізація дала достатній throughput для цілі `600+ orders/day` на поточному live-наборі без зниження DPI і без погіршення output white metrics.

Поточний bottleneck після оптимізації: `finalPreflight`.

На важких A4 orders final preflight все ще займає `144.8s-233.2s`, тобто наступна оптимізація має бути спрямована на post-CMYK residual/retry path.

## Broad Offwhite Validation

Після оптимізації був виконаний ширший A/B прогін live orders `29846..29820` на `800 DPI`, `ORDER_QUEUE_CONCURRENCY=2`, `RASTERIZE_CONCURRENCY=2`.

Artifacts:

- baseline `OFFWHITE_HEX=FFFEFA`: `artifacts/diagnostics/live-white-broad-fffe-800-p2-r2-20260426.json`
- candidate `OFFWHITE_HEX=F7F6F2`: `artifacts/diagnostics/live-white-broad-f7f6f2-800-p2-r2-20260426.json`

Порівнювались 23 successful matched orders. Orders `29844`, `29838`, `29834`, `29827` відпали однаково в обох прогонах через missing design source.

| Metric | FFFEFA baseline | F7F6F2 candidate |
| --- | ---: | ---: |
| Pipeline phase | 2633.4s | 1354.0s |
| Projected successful orders/day | ~755 | ~1468 |
| Max active orders | 2 | 2 |
| Max Ghostscript processes | 3 | 3 |
| Final preflight total | 2876.6s | 738.7s |
| Final preflight median | 132.7s | 27.1s |
| FinalPreflight corrected pixels | 39,950,659 | 0 |
| Orders with zero corrected pixels | 2 / 23 | 23 / 23 |
| Strict white out | 110 px | 353 px |
| Aggressive white out | 1,523 px | 3,821 px |
| Aggressive white out share | 0.000274% | 0.000687% |
| Avg edge delta | baseline | +0.027 |
| Avg RMSE delta | baseline | -2.776 |
| Warnings / failed on matched orders | 0 / 0 | 0 / 0 |

Interpretation:

- `F7F6F2` removes the expensive final retry path on all matched successful orders.
- Diagnostic strict/aggressive white counts are higher than `FFFEFA`, but remain below `0.0019%` even on the worst order and do not trigger finalPreflight correction.
- Edge preservation did not regress on any matched order, and RMSE improved on all matched orders.
- `F7F6F2` is now the production default for PDF white replacement. Standalone QR/Spotify fallback defaults remain unchanged unless the pipeline passes `OFFWHITE_HEX`.

## Follow-up Hardening

Після broad run були закриті operational gaps:

- `PDF_HIGH_DETAIL_SKUS_PATH` тепер fail-fast: missing/unreadable/malformed/empty file зупиняє старт замість тихого fallback на standard DPI.
- `RASTERIZE_CONCURRENCY` тепер покриває service-level Ghostscript/rasterize-heavy роботу після генерації: QR/Spotify post-embed CMYK, finalPreflight measure, aggressive enforce і повторну CMYK conversion.
- Причина `maxGhostscriptProcesses=3` у broad run: generation semaphore вже був `2`, але finalPreflight і post-embed CMYK запускались поза semaphore й могли накладатися на Ghostscript з іншого order.
- Telegram caption тепер відправляє `DPI`, `strict`, `agg`, `corrected` і загальний час опрацювання order, щоб оператор бачив і швидкість, і якість прямо в доставці.

Smoke після semaphore fix:

- artifact: `artifacts/diagnostics/live-white-smoke-f7f6f2-semaphore-800-p2-r2-20260426.json`
- orders: `29846`, `29845`
- pipeline phase: `113.6s`
- max active orders: `2`
- max Ghostscript processes: `2`
- max sampled Ghostscript RSS: `85.8 MB`
- finalPreflight corrected pixels: `0` on both orders

## Next FinalPreflight Candidates

1. **Cheaper postcheck gate**
   - Мета: залишити фінальний quality gate, але зробити його дешевшим, не змінюючи фінальний output.
   - Варіанти: lower measure DPI для gate після A/B перевірки або early-stop у residual scanner після перевищення порога.
   - Ризик: lower DPI може пропустити дрібний white residual, тому це тільки після validation.

2. **Adaptive retry profile**
   - Мета: якщо residual невеликий, застосовувати мінімально достатній retry target/profile, а не завжди один aggressive path.
   - Очікуваний ефект: менше corrected pixels і менша деградація edge/detail.

3. **Server-side validation**
   - Мета: повторити broad/live validation на серверному CPU/RAM після переносу.
   - Перевірити: `pipelinePhaseMs`, `timingFinalPreflightMs`, `finalPreflightCorrectedPixels`, caption metrics у Telegram, max `gs` processes/RSS.
   - Якість не змінюється; це production sizing validation.
