import type { AppConfig } from "./config.types";

export function validateConfig(config: AppConfig): void {
  if (!config.host) {
    throw new Error("HOST is invalid.");
  }

  if (!Number.isFinite(config.port) || config.port <= 0) {
    throw new Error("PORT is invalid.");
  }

  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  if (!Number.isFinite(config.databasePoolMax) || config.databasePoolMax <= 0) {
    throw new Error("DATABASE_POOL_MAX is invalid.");
  }

  if (!config.keycrmApiBase) {
    throw new Error("KEYCRM_API_BASE is required.");
  }

  if (!config.keycrmToken) {
    throw new Error("KEYCRM_TOKEN is required.");
  }

  if (!config.telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required.");
  }

  if (!config.telegramChatId) {
    throw new Error("TELEGRAM_CHAT_ID is required.");
  }

  if (!Array.isArray(config.keycrmOrderInclude) || config.keycrmOrderInclude.length === 0) {
    throw new Error("KEYCRM_ORDER_INCLUDE is invalid.");
  }

  if (!Number.isFinite(config.requestBodyLimitBytes) || config.requestBodyLimitBytes <= 0) {
    throw new Error("REQUEST_BODY_LIMIT_BYTES is invalid.");
  }

  if (!Number.isFinite(config.keycrmRequestTimeoutMs) || config.keycrmRequestTimeoutMs <= 0) {
    throw new Error("KEYCRM_REQUEST_TIMEOUT_MS is invalid.");
  }

  if (!Number.isFinite(config.keycrmRequestRetries) || config.keycrmRequestRetries < 0) {
    throw new Error("KEYCRM_REQUEST_RETRIES is invalid.");
  }

  if (!Number.isFinite(config.keycrmRequestRetryBaseMs) || config.keycrmRequestRetryBaseMs <= 0) {
    throw new Error("KEYCRM_REQUEST_RETRY_BASE_MS is invalid.");
  }

  if (!Number.isFinite(config.telegramRequestTimeoutMs) || config.telegramRequestTimeoutMs <= 0) {
    throw new Error("TELEGRAM_REQUEST_TIMEOUT_MS is invalid.");
  }

  if (!Number.isFinite(config.telegramRequestRetries) || config.telegramRequestRetries < 0) {
    throw new Error("TELEGRAM_REQUEST_RETRIES is invalid.");
  }

  if (
    !Number.isFinite(config.telegramRequestRetryBaseMs) ||
    config.telegramRequestRetryBaseMs <= 0
  ) {
    throw new Error("TELEGRAM_REQUEST_RETRY_BASE_MS is invalid.");
  }

  if (!Number.isFinite(config.opsAlertTimeoutMs) || config.opsAlertTimeoutMs <= 0) {
    throw new Error("OPS_ALERT_TIMEOUT_MS is invalid.");
  }

  if (!Number.isFinite(config.opsAlertRetries) || config.opsAlertRetries < 0) {
    throw new Error("OPS_ALERT_RETRIES is invalid.");
  }

  if (!Number.isFinite(config.opsAlertRetryBaseMs) || config.opsAlertRetryBaseMs <= 0) {
    throw new Error("OPS_ALERT_RETRY_BASE_MS is invalid.");
  }

  if (!Number.isFinite(config.opsAlertDedupeWindowMs) || config.opsAlertDedupeWindowMs < 0) {
    throw new Error("OPS_ALERT_DEDUPE_WINDOW_MS is invalid.");
  }

  if (!Number.isFinite(config.orderQueueConcurrency) || config.orderQueueConcurrency <= 0) {
    throw new Error("ORDER_QUEUE_CONCURRENCY is invalid.");
  }

  if (!Number.isFinite(config.orderQueueMaxSize) || config.orderQueueMaxSize <= 0) {
    throw new Error("ORDER_QUEUE_MAX_SIZE is invalid.");
  }

  if (!Number.isFinite(config.orderQueueMaxAttempts) || config.orderQueueMaxAttempts <= 0) {
    throw new Error("ORDER_QUEUE_MAX_ATTEMPTS is invalid.");
  }

  if (!Number.isFinite(config.orderQueueRetryBaseMs) || config.orderQueueRetryBaseMs <= 0) {
    throw new Error("ORDER_QUEUE_RETRY_BASE_MS is invalid.");
  }

  if (!Number.isFinite(config.reactionQueueConcurrency) || config.reactionQueueConcurrency <= 0) {
    throw new Error("REACTION_QUEUE_CONCURRENCY is invalid.");
  }

  if (!Number.isFinite(config.reactionQueueMaxSize) || config.reactionQueueMaxSize <= 0) {
    throw new Error("REACTION_QUEUE_MAX_SIZE is invalid.");
  }

  if (!Number.isFinite(config.reactionQueueMaxAttempts) || config.reactionQueueMaxAttempts <= 0) {
    throw new Error("REACTION_QUEUE_MAX_ATTEMPTS is invalid.");
  }

  if (!Number.isFinite(config.reactionQueueRetryBaseMs) || config.reactionQueueRetryBaseMs <= 0) {
    throw new Error("REACTION_QUEUE_RETRY_BASE_MS is invalid.");
  }

  if (!Number.isFinite(config.queueJobTimeoutMs) || config.queueJobTimeoutMs <= 0) {
    throw new Error("QUEUE_JOB_TIMEOUT_MS is invalid.");
  }

  if (!Number.isFinite(config.idempotencyMaxEntries) || config.idempotencyMaxEntries <= 0) {
    throw new Error("IDEMPOTENCY_MAX_ENTRIES is invalid.");
  }

  if (!config.productCodeRulesPath) {
    throw new Error("PRODUCT_CODE_RULES_PATH is invalid.");
  }

  if (!config.reactionStatusRulesPath) {
    throw new Error("REACTION_STATUS_RULES_PATH is invalid.");
  }

  if (
    !Number.isFinite(config.telegramMessageMapMaxEntries) ||
    config.telegramMessageMapMaxEntries <= 0
  ) {
    throw new Error("TELEGRAM_MESSAGE_MAP_MAX_ENTRIES is invalid.");
  }

  if (!config.telegramLegacyClientPath) {
    throw new Error("TELEGRAM_LEGACY_CLIENT_PATH is invalid.");
  }

  if (!config.qrRulesPath) {
    throw new Error("QR_RULES_PATH is invalid.");
  }

  if (!config.outputDir) {
    throw new Error("OUTPUT_DIR is invalid.");
  }

  if (!config.tempDir) {
    throw new Error("TEMP_DIR is invalid.");
  }

  if (!Number.isFinite(config.outputRetentionHours) || config.outputRetentionHours <= 0) {
    throw new Error("OUTPUT_RETENTION_HOURS is invalid.");
  }

  if (!Number.isFinite(config.tempRetentionHours) || config.tempRetentionHours <= 0) {
    throw new Error("TEMP_RETENTION_HOURS is invalid.");
  }

  if (!Number.isFinite(config.cleanupIntervalMs) || config.cleanupIntervalMs <= 0) {
    throw new Error("CLEANUP_INTERVAL_MS is invalid.");
  }

  if (!config.fontPath) {
    throw new Error("FONT_PATH is invalid.");
  }

  if (!config.pdfLegacyModulePath) {
    throw new Error("PDF_LEGACY_MODULE_PATH is invalid.");
  }

  if (!["RGB", "CMYK"].includes(config.pdfColorSpace)) {
    throw new Error("PDF_COLOR_SPACE is invalid.");
  }

  if (!Number.isFinite(config.pdfStickerSizeMm) || config.pdfStickerSizeMm <= 0) {
    throw new Error("STICKER_SIZE_MM is invalid.");
  }

  if (!/^[0-9A-Fa-f]{6}$/.test(config.pdfOffWhiteHex)) {
    throw new Error("OFFWHITE_HEX is invalid.");
  }

  if (!Number.isFinite(config.pdfRasterizeDpi) || config.pdfRasterizeDpi <= 0) {
    throw new Error("RASTERIZE_DPI is invalid.");
  }

  if (!Number.isFinite(config.qrA5RightMm) || config.qrA5RightMm <= 0) {
    throw new Error("QR_A5_RIGHT_MM is invalid.");
  }

  if (!Number.isFinite(config.qrA5BottomMm) || config.qrA5BottomMm <= 0) {
    throw new Error("QR_A5_BOTTOM_MM is invalid.");
  }

  if (!Number.isFinite(config.qrA5SizeMm) || config.qrA5SizeMm <= 0) {
    throw new Error("QR_A5_SIZE_MM is invalid.");
  }

  if (!Number.isFinite(config.qrA4RightMm) || config.qrA4RightMm <= 0) {
    throw new Error("QR_A4_RIGHT_MM is invalid.");
  }

  if (!Number.isFinite(config.qrA4BottomMm) || config.qrA4BottomMm <= 0) {
    throw new Error("QR_A4_BOTTOM_MM is invalid.");
  }

  if (!Number.isFinite(config.qrA4SizeMm) || config.qrA4SizeMm <= 0) {
    throw new Error("QR_A4_SIZE_MM is invalid.");
  }
}
