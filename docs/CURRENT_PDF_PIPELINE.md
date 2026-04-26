# Current PDF Pipeline

Last updated: 2026-04-26.

This is the current source of truth for how photo/poster PDFs are processed.

## Production Env

Recommended production values:

- `PDF_COLOR_SPACE=CMYK`
- `OFFWHITE_HEX=F7F6F2`
- `RASTERIZE_DPI=800`
- `RASTERIZE_DPI_HIGH_DETAIL=1200`
- `PDF_HIGH_DETAIL_SKUS_PATH=config/business-rules/high-detail-skus.json`
- `ORDER_QUEUE_CONCURRENCY=2`
- `RASTERIZE_CONCURRENCY=2`
- `PDF_FINAL_PREFLIGHT_MEASURE_DPI=200`
- `PDF_CMYK_LOSSLESS=false`

`ORDER_QUEUE_CONCURRENCY=3` is not the default. Local live tests showed worse latency and more Ghostscript contention.

## DPI Routing

Routing is deterministic and SKU-based:

- If any poster material SKU is listed in `PDF_HIGH_DETAIL_SKUS_PATH`, the whole order uses `RASTERIZE_DPI_HIGH_DETAIL` (`1200`).
- All other orders use `RASTERIZE_DPI` (`800`).
- One order uses one effective DPI for all generated materials.
- The high-detail SKU file is fail-fast. Missing, unreadable, malformed, or empty JSON stops startup instead of silently routing high-detail SKUs to `800 DPI`.

Current high-detail families:

- `StarTransp*`
- `StarFP*`
- `MapSquareT*`
- `MapTrHeart*`

## White Replacement Flow

Default path:

1. Validate that poster print source exists. Preview is never used as print source.
2. Rasterize at effective order DPI (`800` or `1200`).
3. Run one main white replacement pass with `OFFWHITE_HEX=F7F6F2`.
4. Do not run regular `white_recolor_final` in the default path.
5. Convert poster to CMYK after poster generation/QR/Spotify embedding.
6. Run final residual near-white postcheck at `min(effectiveDpi, PDF_FINAL_PREFLIGHT_MEASURE_DPI)`.
7. If residual exceeds thresholds, run one aggressive retry palette sequence and reconvert to CMYK.

Final retry thresholds:

- strict residual: `>64 px`
- aggressive residual: `>256 px`

Retry palette for current default:

- `EFEEEA`
- `EBEAE6`

## Telegram Metrics

The production caption includes:

- `DPI: <N>`
- `Білий (px): strict=<N> | agg=<N> | corrected=<N>`
- `Час опрацювання: <...>`

Meaning:

- `strict` and `agg` are the final residual near-white pixel counts after finalPreflight.
- `corrected` is the number of pixels corrected by finalPreflight retry. For the validated `F7F6F2` broad run this was `0` on all matched successful orders.
- Time is end-to-end order processing time inside the order worker.

## Ghostscript Concurrency

`RASTERIZE_CONCURRENCY` is the cap for rasterize/Ghostscript-heavy operations inside one `PdfPipelineService` instance:

- material generation rasterize/rebuild/CMYK work;
- post-embed QR/Spotify CMYK conversion;
- finalPreflight residual measurement;
- finalPreflight aggressive enforce;
- finalPreflight retry CMYK conversion.

Previous broad validation saw `maxGhostscriptProcesses=3` with order/rasterize concurrency set to `2` because finalPreflight and post-embed CMYK were outside the semaphore. That is now fixed in code.

Semaphore smoke after the fix:

- artifact: `artifacts/diagnostics/live-white-smoke-f7f6f2-semaphore-800-p2-r2-20260426.json`
- orders: `29846`, `29845`
- max active orders: `2`
- max Ghostscript processes: `2`
- finalPreflight corrected pixels: `0` for both orders

## Validated Live Result

Broad A/B validation on live orders `29846..29820`, matched successful orders: `23`.

| Metric | `FFFEFA` baseline | `F7F6F2` current default |
| --- | ---: | ---: |
| Pipeline phase | 2633.4s | 1354.0s |
| Projected successful orders/day | ~755 | ~1468 |
| FinalPreflight corrected pixels | 39,950,659 | 0 |
| Orders with zero corrected pixels | 2 / 23 | 23 / 23 |
| Aggressive white out share | 0.000274% | 0.000687% |
| Avg edge delta | baseline | +0.027 |
| Avg RMSE delta | baseline | -2.776 |

Artifacts:

- `artifacts/diagnostics/live-white-broad-fffe-800-p2-r2-20260426.json`
- `artifacts/diagnostics/live-white-broad-f7f6f2-800-p2-r2-20260426.json`

## Server Validation After Deploy

After deploying to the server, test with the same production env and verify:

- `pdf_pipeline_started.rasterizeDpi` is `800` for standard SKUs and `1200` for high-detail SKUs.
- Telegram caption shows expected `DPI`, `strict`, `agg`, `corrected`, and processing time.
- `finalPreflightCorrectedPixels` stays `0` or near `0` for most normal orders.
- Ghostscript process count does not exceed the configured cap under `ORDER_QUEUE_CONCURRENCY=2`.
- Missing design source orders fail deterministically before PDF generation and do not use preview as print source.
