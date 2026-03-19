import type { AppConfig } from "./config.types";
import path from "node:path";

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return fallback;
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseColorSpace(value: string | undefined): "RGB" | "CMYK" {
  return String(value ?? "RGB").trim().toUpperCase() === "CMYK" ? "CMYK" : "RGB";
}

function parseEmojiRenderMode(value: string | undefined): "font" | "apple_image" {
  return String(value ?? "apple_image").trim().toLowerCase() === "font" ? "font" : "apple_image";
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    host: String(env.HOST ?? "127.0.0.1").trim() || "127.0.0.1",
    port: Number.parseInt(env.PORT ?? "3000", 10),
    projectPhase: "stage_f_pdf_pipeline",
    databaseUrl: String(env.DATABASE_URL ?? "").trim(),
    databasePoolMax: parsePositiveInteger(env.DATABASE_POOL_MAX, 10),
    requestBodyLimitBytes: parsePositiveInteger(env.REQUEST_BODY_LIMIT_BYTES, 1_000_000),
    keycrmApiBase: String(env.KEYCRM_API_BASE ?? "").trim(),
    keycrmToken: String(env.KEYCRM_TOKEN ?? "").trim(),
    keycrmOrderInclude: parseCsv(env.KEYCRM_ORDER_INCLUDE, [
      "products.offer",
      "tags",
      "custom_fields",
      "status",
      "manager",
      "shipping.deliveryService",
      "shipping.lastHistory",
    ]),
    keycrmRequestTimeoutMs: parsePositiveInteger(env.KEYCRM_REQUEST_TIMEOUT_MS, 15_000),
    keycrmRequestRetries: parsePositiveInteger(env.KEYCRM_REQUEST_RETRIES, 2),
    keycrmRequestRetryBaseMs: parsePositiveInteger(env.KEYCRM_REQUEST_RETRY_BASE_MS, 500),
    keycrmWebhookSecret: String(env.KEYCRM_WEBHOOK_SECRET ?? "").trim(),
    telegramBotToken: String(env.TELEGRAM_BOT_TOKEN ?? "").trim(),
    telegramChatId: String(env.TELEGRAM_CHAT_ID ?? "").trim(),
    telegramMessageThreadId: String(env.TELEGRAM_MESSAGE_THREAD_ID ?? "").trim(),
    telegramOpsChatId: String(env.TELEGRAM_OPS_CHAT_ID ?? "").trim(),
    telegramOpsThreadId: String(env.TELEGRAM_OPS_THREAD_ID ?? "").trim(),
    telegramReactionSecretToken: String(env.TELEGRAM_REACTION_SECRET_TOKEN ?? "").trim(),
    telegramRequestTimeoutMs: parsePositiveInteger(env.TELEGRAM_REQUEST_TIMEOUT_MS, 30_000),
    telegramRequestRetries: parsePositiveInteger(env.TELEGRAM_REQUEST_RETRIES, 2),
    telegramRequestRetryBaseMs: parsePositiveInteger(env.TELEGRAM_REQUEST_RETRY_BASE_MS, 900),
    opsAlertTimeoutMs: parsePositiveInteger(env.OPS_ALERT_TIMEOUT_MS, 15_000),
    opsAlertRetries: parsePositiveInteger(env.OPS_ALERT_RETRIES, 2),
    opsAlertRetryBaseMs: parsePositiveInteger(env.OPS_ALERT_RETRY_BASE_MS, 700),
    opsAlertDedupeWindowMs: parsePositiveInteger(env.OPS_ALERT_DEDUPE_WINDOW_MS, 60_000),
    orderQueueConcurrency: parsePositiveInteger(env.ORDER_QUEUE_CONCURRENCY, 1),
    orderQueueMaxSize: parsePositiveInteger(env.ORDER_QUEUE_MAX_SIZE, 200),
    orderQueueMaxAttempts: parsePositiveInteger(env.ORDER_QUEUE_MAX_ATTEMPTS, 3),
    orderQueueRetryBaseMs: parsePositiveInteger(env.ORDER_QUEUE_RETRY_BASE_MS, 1_000),
    reactionQueueConcurrency: parsePositiveInteger(env.REACTION_QUEUE_CONCURRENCY, 1),
    reactionQueueMaxSize: parsePositiveInteger(env.REACTION_QUEUE_MAX_SIZE, 300),
    reactionQueueMaxAttempts: parsePositiveInteger(env.REACTION_QUEUE_MAX_ATTEMPTS, 2),
    reactionQueueRetryBaseMs: parsePositiveInteger(env.REACTION_QUEUE_RETRY_BASE_MS, 500),
    queueJobTimeoutMs: parsePositiveInteger(env.QUEUE_JOB_TIMEOUT_MS, 10 * 60 * 1000),
    idempotencyMaxEntries: parsePositiveInteger(env.IDEMPOTENCY_MAX_ENTRIES, 50_000),
    productCodeRulesPath: path.resolve(
      process.cwd(),
      String(env.PRODUCT_CODE_RULES_PATH ?? "config/business-rules/product-code-rules.json"),
    ),
    reactionStatusRulesPath: path.resolve(
      process.cwd(),
      String(
        env.REACTION_STATUS_RULES_PATH ??
          "config/business-rules/reaction-status-rules.json",
      ),
    ),
    telegramMessageMapMaxEntries: parsePositiveInteger(env.TELEGRAM_MESSAGE_MAP_MAX_ENTRIES, 50_000),
    telegramLegacyClientPath: path.resolve(
      process.cwd(),
      String(env.TELEGRAM_LEGACY_CLIENT_PATH ?? "reference/legacy-js/telegram-client.js"),
    ),
    qrRulesPath: path.resolve(
      process.cwd(),
      String(env.QR_RULES_PATH ?? "config/business-rules/qr-rules.json"),
    ),
    outputDir: path.resolve(
      process.cwd(),
      String(env.OUTPUT_DIR ?? "storage/files/materials"),
    ),
    tempDir: path.resolve(
      process.cwd(),
      String(env.TEMP_DIR ?? "storage/temp"),
    ),
    outputRetentionHours: parsePositiveInteger(env.OUTPUT_RETENTION_HOURS, 168),
    tempRetentionHours: parsePositiveInteger(env.TEMP_RETENTION_HOURS, 24),
    cleanupIntervalMs: parsePositiveInteger(env.CLEANUP_INTERVAL_MS, 60 * 60 * 1000),
    fontPath: path.resolve(
      process.cwd(),
      String(env.FONT_PATH ?? "reference/legacy-js/Caveat-VariableFont_wght.ttf"),
    ),
    emojiFontPath: String(env.EMOJI_FONT_PATH ?? "").trim()
      ? path.resolve(process.cwd(), String(env.EMOJI_FONT_PATH ?? "").trim())
      : "",
    emojiRenderMode: parseEmojiRenderMode(env.EMOJI_RENDER_MODE),
    appleEmojiBaseUrl: String(env.APPLE_EMOJI_BASE_URL ?? "").trim(),
    appleEmojiAssetsDir: String(env.APPLE_EMOJI_ASSETS_DIR ?? "").trim()
      ? path.resolve(process.cwd(), String(env.APPLE_EMOJI_ASSETS_DIR ?? "").trim())
      : "",
    pdfLegacyModulePath: path.resolve(
      process.cwd(),
      String(env.PDF_LEGACY_MODULE_PATH ?? "reference/legacy-js/material-generator.js"),
    ),
    pdfColorSpace: parseColorSpace(env.PDF_COLOR_SPACE),
    pdfStickerSizeMm: parsePositiveFloat(env.STICKER_SIZE_MM, 100),
    pdfOffWhiteHex: String(env.OFFWHITE_HEX ?? "FFFEFA")
      .trim()
      .replace(/^#/, "")
      .toUpperCase(),
    pdfRasterizeDpi: parsePositiveInteger(env.RASTERIZE_DPI, 600),
    qrA5RightMm: parsePositiveFloat(env.QR_A5_RIGHT_MM, 10),
    qrA5BottomMm: parsePositiveFloat(env.QR_A5_BOTTOM_MM, 10),
    qrA5SizeMm: parsePositiveFloat(env.QR_A5_SIZE_MM, 20),
    qrA4RightMm: parsePositiveFloat(env.QR_A4_RIGHT_MM, 10),
    qrA4BottomMm: parsePositiveFloat(env.QR_A4_BOTTOM_MM, 10),
    qrA4SizeMm: parsePositiveFloat(env.QR_A4_SIZE_MM, 30),
  };
}
