# White Quality-Safe Integration (2026-04-21)

Документ фіксує інтеграцію друк-підходу (H6/H3 quality profile) в основний pipeline без зміни бізнес-правил order/Qr/CRM routing.

## Що інтегровано

- Додано опціональний quality-safe профіль white cleanup:
  - `PDF_WHITE_QUALITY_SAFE_PROFILE=true`
  - strict one-pass (`threshold=254`, `maxSaturation=0.25`, `cleanup=0`, `hard_cleanup=2`, `iterations=1`)
  - `whiteFinalEnforce=false` (без другого final-pass)
- Додано опціональну lossless CMYK конверсію:
  - `PDF_CMYK_LOSSLESS=true`
  - Ghostscript PDF write з `FlateEncode` для color/gray image, без downsample.
- Прибрано зайву повторну CMYK конверсію у final preflight, якщо файл вже позначений як CMYK (`details.color_space === "CMYK"`).

## Update 2026-04-22: CMYK final-order fix

Після релізу виявлено регресію: у частині кейсів фінальний PDF мав `DeviceRGB`.
Root cause: CMYK конверсія виконувалась до `white_recolor_final`, а фінальний white-pass перебудовував PDF через PNG і повертав RGB colorspace.

Виправлення:
- у `material-generator` перенесено CMYK конверсію після `white_recolor_final`;
- порядок став детермінованим: `white_recolor_final -> convertPdfToCmykInPlace`;
- бізнес-логіка (QR/Spotify/layout/CRM/Telegram) не змінювалась.

Практична перевірка після фіксу:
- фінальний файл має `/DeviceCMYK`;
- `DeviceRGB` у фінальному постері не очікується.

## Нові ENV

- `PDF_WHITE_QUALITY_SAFE_PROFILE` (`true|false`, default `false`)
- `PDF_CMYK_LOSSLESS` (`true|false`, default `false`)
- `PDF_PROFILE_AUTO_ROUTER` (`true|false`, default `false`)
- `PDF_PROFILE_AUTO_ROUTER_PREFLIGHT_DPI` (default `300`)
- `PDF_PROFILE_AUTO_ROUTER_RISK_THRESHOLD` (default `2`)
- `PDF_PROFILE_AUTO_ROUTER_AGGRESSIVE_WHITE_PIXELS` (default `150000`)

## Auto-router (STANDARD vs QUALITY_SAFE)

- Якщо `PDF_WHITE_QUALITY_SAFE_PROFILE=true`, завжди використовується `QUALITY_SAFE` (forced).
- Якщо `PDF_PROFILE_AUTO_ROUTER=true`, pipeline робить source preflight і рахує risk-score:
  - базовий сигнал: `residual_aggressive_white_pixels` (плюс strict/low-alpha допоміжно);
  - при досягненні порогу risk-score -> маршрут `QUALITY_SAFE`;
  - інакше -> `STANDARD`.
- У результат PDF pipeline пишеться:
  - `pipeline_profile`
  - `pipeline_profile_reason`
  - `pipeline_profile_risk_score`
  - `pipeline_profile_risk_details`

## Telegram diagnostics in caption

У caption файлів додається:
- `Пайплайн: STANDARD|QUALITY_SAFE (reason)`
- `Білий фінал (px): strict=<N> | aggressive=<N>`
- `Час опрацювання: <Nс | Mхв Sс | Hг Mхв Sс>`

## Рекомендований production-профіль (для макетів типу 29658)

- `PDF_COLOR_SPACE=CMYK`
- `OFFWHITE_HEX=FCFBF7`
- `RASTERIZE_DPI=1200`
- `PDF_WHITE_QUALITY_SAFE_PROFILE=true`
- `PDF_CMYK_LOSSLESS=true`

## Валідація інтеграції

Прогін через вже інтегрований runtime path:

- label: `pipeline_integrated_h6_mode`
- output:
  - `/Users/monstermac/WebstormProjects/Custom_Gifts_bot/storage/files/materials/29658_pipeline_integrated_h6_mode_c4fc92e7/CGU_AA5_29658_1_1_T.pdf`
- report:
  - `/Users/monstermac/WebstormProjects/Custom_Gifts_bot/artifacts/diagnostics/white-quality-29658-pipeline-integrated-h6-mode.json`

Метрики (vs source rasterized @600dpi):

- `white strict/aggressive: 0/0`
- `edge ratio: 0.9941270563622072`
- `RMSE RGB: 20.734109958216685`
- `CMYK image: yes`
- `smask encoding: image (lossless), not jpeg`

## Ризики/компроміси

- `PDF_CMYK_LOSSLESS=true` збільшує розмір файлів.
- `RASTERIZE_DPI=1200` підвищує CPU/RAM/time на обробку.

## Rollback

Для повернення на попередню поведінку:

- `PDF_WHITE_QUALITY_SAFE_PROFILE=false`
- `PDF_CMYK_LOSSLESS=false`
- `OFFWHITE_HEX=FFFEFA`
- `RASTERIZE_DPI=600`

## Прод-оновлення (рекомендований порядок)

1. Оновити код сервісу до commit з цією інтеграцією.
2. Оновити `.env.production`:
   - `PDF_COLOR_SPACE=CMYK`
   - `OFFWHITE_HEX=FFFEFA` (або `FCFBF7` для більш теплого off-white)
   - `RASTERIZE_DPI=600` (або `1200` для максимальної якості на важких макетах)
   - `PDF_WHITE_QUALITY_SAFE_PROFILE=false`
   - `PDF_CMYK_LOSSLESS=false` (вмикати `true` для quality-safe/high-fidelity)
   - `PDF_PROFILE_AUTO_ROUTER=true`
   - `PDF_PROFILE_AUTO_ROUTER_PREFLIGHT_DPI=300`
   - `PDF_PROFILE_AUTO_ROUTER_RISK_THRESHOLD=2`
   - `PDF_PROFILE_AUTO_ROUTER_AGGRESSIVE_WHITE_PIXELS=150000`
3. Виконати деплой контейнерів:
   - `docker compose -f docker-compose.prod.yml --env-file .env.production --profile ops run --rm migrate`
   - `docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build receiver order-worker reaction-worker`
4. Перевірити health:
   - `curl -fsS http://127.0.0.1:3000/health`
5. Прогнати smoke-order і перевірити у Telegram caption:
   - `Пайплайн: STANDARD|QUALITY_SAFE`
   - `Білий фінал (px): strict=... | aggressive=...`
