import type { AppConfig } from "./config.types";
import fs from "node:fs";
import path from "node:path";
import { parseAppRole } from "./app-role";

function loadHighDetailSkus(filePath: string): string[] {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("expected a JSON array");
    }

    const skus = [...new Set(parsed.map((item) => String(item ?? "").trim()).filter(Boolean))];
    if (skus.length === 0) {
      throw new Error("SKU list is empty");
    }
    return skus;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`PDF_HIGH_DETAIL_SKUS_PATH is invalid (${filePath}): ${reason}`);
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
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

function parseTelegramForwardMode(value: string | undefined): "copy" | "forward" {
  return String(value ?? "copy").trim().toLowerCase() === "forward" ? "forward" : "copy";
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const configuredAppleEmojiAssetsDir = String(env.APPLE_EMOJI_ASSETS_DIR ?? "").trim();
  const defaultAppleEmojiAssetsDir = path.resolve(
    process.cwd(),
    "node_modules/emoji-datasource-apple/img/apple/64",
  );
  const resolvedAppleEmojiAssetsDir = configuredAppleEmojiAssetsDir
    ? path.resolve(process.cwd(), configuredAppleEmojiAssetsDir)
    : fs.existsSync(defaultAppleEmojiAssetsDir)
      ? defaultAppleEmojiAssetsDir
      : "";
  const baseRasterizeDpi = parsePositiveInteger(env.RASTERIZE_DPI, 800);
  const highDetailDpi = parsePositiveInteger(env.RASTERIZE_DPI_HIGH_DETAIL, 1200);

  const highDetailSkusPath = path.resolve(
    process.cwd(),
    String(env.PDF_HIGH_DETAIL_SKUS_PATH ?? "config/business-rules/high-detail-skus.json"),
  );
  const pdfHighDetailSkus = loadHighDetailSkus(highDetailSkusPath);

  return {
    appRole: parseAppRole(env.APP_ROLE),
    host: String(env.HOST ?? "127.0.0.1").trim() || "127.0.0.1",
    port: Number.parseInt(env.PORT ?? "3000", 10),
    projectPhase: "stage_f_pdf_pipeline",
    databaseUrl: String(env.DATABASE_URL ?? "").trim(),
    databasePoolMax: parsePositiveInteger(env.DATABASE_POOL_MAX, 10),
    databasePoolConnectionTimeoutMs: parsePositiveInteger(
      env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      5_000,
    ),
    databasePoolIdleTimeoutMs: parsePositiveInteger(env.DATABASE_POOL_IDLE_TIMEOUT_MS, 30_000),
    databaseQueryTimeoutMs: parsePositiveInteger(env.DATABASE_QUERY_TIMEOUT_MS, 30_000),
    databaseAutoMigrateOnBoot: parseBoolean(env.DATABASE_AUTO_MIGRATE_ON_BOOT, false),
    databaseMigrationsDir: path.resolve(
      process.cwd(),
      String(env.DATABASE_MIGRATIONS_DIR ?? "migrations"),
    ),
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
    spotifyRequestTimeoutMs: parsePositiveInteger(env.SPOTIFY_REQUEST_TIMEOUT_MS, 12_000),
    spotifyRequestRetries: parsePositiveInteger(env.SPOTIFY_REQUEST_RETRIES, 2),
    spotifyRequestRetryBaseMs: parsePositiveInteger(env.SPOTIFY_REQUEST_RETRY_BASE_MS, 700),
    shortenerRequestTimeoutMs: parsePositiveInteger(env.SHORTENER_REQUEST_TIMEOUT_MS, 7_000),
    shortenerRequestRetries: parsePositiveInteger(env.SHORTENER_REQUEST_RETRIES, 2),
    shortenerRequestRetryBaseMs: parsePositiveInteger(env.SHORTENER_REQUEST_RETRY_BASE_MS, 500),
    lnkUaBearerToken: String(env.LNK_UA_BEARER_TOKEN ?? "").trim(),
    cuttlyApiKey: String(env.CUTTLY_API_KEY ?? "").trim(),
    pdfSourceRequestTimeoutMs: parsePositiveInteger(env.PDF_SOURCE_REQUEST_TIMEOUT_MS, 20_000),
    pdfSourceRequestRetries: parsePositiveInteger(env.PDF_SOURCE_REQUEST_RETRIES, 2),
    pdfSourceRequestRetryBaseMs: parsePositiveInteger(env.PDF_SOURCE_REQUEST_RETRY_BASE_MS, 800),
    keycrmWebhookSecret: String(env.KEYCRM_WEBHOOK_SECRET ?? "").trim(),
    telegramBotToken: String(env.TELEGRAM_BOT_TOKEN ?? "").trim(),
    telegramChatId: String(env.TELEGRAM_CHAT_ID ?? "").trim(),
    telegramMessageThreadId: String(env.TELEGRAM_MESSAGE_THREAD_ID ?? "").trim(),
    telegramOrdersChatId: String(env.TELEGRAM_ORDERS_CHAT_ID ?? "").trim(),
    telegramOrdersThreadId: String(env.TELEGRAM_ORDERS_THREAD_ID ?? "").trim(),
    telegramForwardMode: parseTelegramForwardMode(env.TELEGRAM_FORWARD_MODE),
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
    queuePollIntervalMs: parsePositiveInteger(env.QUEUE_POLL_INTERVAL_MS, 1_000),
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
    dbCleanupIntervalMs: parsePositiveInteger(env.DB_CLEANUP_INTERVAL_MS, 60 * 60 * 1000),
    dbCleanupBatchSize: parsePositiveInteger(env.DB_CLEANUP_BATCH_SIZE, 1_000),
    queueJobRetentionHours: parsePositiveInteger(env.QUEUE_JOB_RETENTION_HOURS, 72),
    telegramDeliveryRetentionHours: parsePositiveInteger(
      env.TELEGRAM_DELIVERY_RETENTION_HOURS,
      24 * 30,
    ),
    forwardingBatchRetentionHours: parsePositiveInteger(
      env.FORWARDING_BATCH_RETENTION_HOURS,
      24 * 30,
    ),
    deadLetterRetentionHours: parsePositiveInteger(env.DEAD_LETTER_RETENTION_HOURS, 24 * 14),
    fontPath: path.resolve(
      process.cwd(),
      String(env.FONT_PATH ?? "assets/fonts/Caveat-VariableFont_wght.ttf"),
    ),
    emojiFontPath: String(env.EMOJI_FONT_PATH ?? "").trim()
      ? path.resolve(process.cwd(), String(env.EMOJI_FONT_PATH ?? "").trim())
      : "",
    emojiRenderMode: parseEmojiRenderMode(env.EMOJI_RENDER_MODE),
    appleEmojiBaseUrl: String(env.APPLE_EMOJI_BASE_URL ?? "").trim(),
    appleEmojiAssetsDir: resolvedAppleEmojiAssetsDir,
    pdfColorSpace: parseColorSpace(env.PDF_COLOR_SPACE),
    pdfStickerSizeMm: parsePositiveFloat(env.STICKER_SIZE_MM, 100),
    pdfOffWhiteHex: String(env.OFFWHITE_HEX ?? "F7F6F2")
      .trim()
      .replace(/^#/, "")
      .toUpperCase(),
    pdfRasterizeDpi: baseRasterizeDpi,
    pdfHighDetailDpi: highDetailDpi,
    pdfHighDetailSkus: pdfHighDetailSkus,
    pdfCmykLossless: parseBoolean(env.PDF_CMYK_LOSSLESS, false),
    pdfFinalPreflightMeasureDpi: parsePositiveInteger(env.PDF_FINAL_PREFLIGHT_MEASURE_DPI, 200),
    rasterizeConcurrency: parsePositiveInteger(env.RASTERIZE_CONCURRENCY, 3),
    qrA5RightMm: parsePositiveFloat(env.QR_A5_RIGHT_MM, 10),
    qrA5BottomMm: parsePositiveFloat(env.QR_A5_BOTTOM_MM, 10),
    qrA5SizeMm: parsePositiveFloat(env.QR_A5_SIZE_MM, 20),
    qrA4RightMm: parsePositiveFloat(env.QR_A4_RIGHT_MM, 10),
    qrA4BottomMm: parsePositiveFloat(env.QR_A4_BOTTOM_MM, 10),
    qrA4SizeMm: parsePositiveFloat(env.QR_A4_SIZE_MM, 30),
    readinessProbeTimeoutMs: parsePositiveInteger(env.READINESS_PROBE_TIMEOUT_MS, 5_000),
    readinessMinDiskFreeBytes: parseNonNegativeInteger(
      env.READINESS_MIN_DISK_FREE_BYTES,
      512 * 1024 * 1024,
    ),
  };
}
