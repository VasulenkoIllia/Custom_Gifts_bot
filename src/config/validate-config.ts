import type { AppConfig } from "./config.types";
import path from "node:path";
import { APP_ROLES, isAppRole } from "./app-role";

export function validateConfig(config: AppConfig): void {
  if (!isAppRole(config.appRole)) {
    throw new Error(`APP_ROLE is invalid. Expected one of: ${APP_ROLES.join(", ")}.`);
  }

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

  if (
    !Number.isFinite(config.databasePoolConnectionTimeoutMs) ||
    config.databasePoolConnectionTimeoutMs <= 0
  ) {
    throw new Error("DATABASE_POOL_CONNECTION_TIMEOUT_MS is invalid.");
  }

  if (!Number.isFinite(config.databasePoolIdleTimeoutMs) || config.databasePoolIdleTimeoutMs <= 0) {
    throw new Error("DATABASE_POOL_IDLE_TIMEOUT_MS is invalid.");
  }

  if (!Number.isFinite(config.databaseQueryTimeoutMs) || config.databaseQueryTimeoutMs <= 0) {
    throw new Error("DATABASE_QUERY_TIMEOUT_MS is invalid.");
  }

  if (typeof config.databaseAutoMigrateOnBoot !== "boolean") {
    throw new Error("DATABASE_AUTO_MIGRATE_ON_BOOT is invalid.");
  }

  if (!config.databaseMigrationsDir) {
    throw new Error("DATABASE_MIGRATIONS_DIR is invalid.");
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

  if (!["copy", "forward"].includes(config.telegramForwardMode)) {
    throw new Error("TELEGRAM_FORWARD_MODE is invalid.");
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

  if (!Number.isFinite(config.spotifyRequestTimeoutMs) || config.spotifyRequestTimeoutMs <= 0) {
    throw new Error("SPOTIFY_REQUEST_TIMEOUT_MS is invalid.");
  }

  if (!Number.isFinite(config.spotifyRequestRetries) || config.spotifyRequestRetries < 0) {
    throw new Error("SPOTIFY_REQUEST_RETRIES is invalid.");
  }

  if (!Number.isFinite(config.spotifyRequestRetryBaseMs) || config.spotifyRequestRetryBaseMs <= 0) {
    throw new Error("SPOTIFY_REQUEST_RETRY_BASE_MS is invalid.");
  }

  if (!Number.isFinite(config.shortenerRequestTimeoutMs) || config.shortenerRequestTimeoutMs <= 0) {
    throw new Error("SHORTENER_REQUEST_TIMEOUT_MS is invalid.");
  }

  if (!Number.isFinite(config.shortenerRequestRetries) || config.shortenerRequestRetries < 0) {
    throw new Error("SHORTENER_REQUEST_RETRIES is invalid.");
  }

  if (
    !Number.isFinite(config.shortenerRequestRetryBaseMs) ||
    config.shortenerRequestRetryBaseMs <= 0
  ) {
    throw new Error("SHORTENER_REQUEST_RETRY_BASE_MS is invalid.");
  }

  if (!Number.isFinite(config.pdfSourceRequestTimeoutMs) || config.pdfSourceRequestTimeoutMs <= 0) {
    throw new Error("PDF_SOURCE_REQUEST_TIMEOUT_MS is invalid.");
  }

  if (!Number.isFinite(config.pdfSourceRequestRetries) || config.pdfSourceRequestRetries < 0) {
    throw new Error("PDF_SOURCE_REQUEST_RETRIES is invalid.");
  }

  if (
    !Number.isFinite(config.pdfSourceRequestRetryBaseMs) ||
    config.pdfSourceRequestRetryBaseMs <= 0
  ) {
    throw new Error("PDF_SOURCE_REQUEST_RETRY_BASE_MS is invalid.");
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

  if (!Number.isFinite(config.queuePollIntervalMs) || config.queuePollIntervalMs <= 0) {
    throw new Error("QUEUE_POLL_INTERVAL_MS is invalid.");
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

  if (!config.qrRulesPath) {
    throw new Error("QR_RULES_PATH is invalid.");
  }

  if (!config.outputDir) {
    throw new Error("OUTPUT_DIR is invalid.");
  }
  ensureSafeStoragePath("OUTPUT_DIR", config.outputDir);

  if (!config.tempDir) {
    throw new Error("TEMP_DIR is invalid.");
  }
  ensureSafeStoragePath("TEMP_DIR", config.tempDir);

  if (!Number.isFinite(config.outputRetentionHours) || config.outputRetentionHours <= 0) {
    throw new Error("OUTPUT_RETENTION_HOURS is invalid.");
  }

  if (!Number.isFinite(config.tempRetentionHours) || config.tempRetentionHours <= 0) {
    throw new Error("TEMP_RETENTION_HOURS is invalid.");
  }

  if (!Number.isFinite(config.cleanupIntervalMs) || config.cleanupIntervalMs <= 0) {
    throw new Error("CLEANUP_INTERVAL_MS is invalid.");
  }

  if (!Number.isFinite(config.dbCleanupIntervalMs) || config.dbCleanupIntervalMs <= 0) {
    throw new Error("DB_CLEANUP_INTERVAL_MS is invalid.");
  }

  if (!Number.isFinite(config.dbCleanupBatchSize) || config.dbCleanupBatchSize <= 0) {
    throw new Error("DB_CLEANUP_BATCH_SIZE is invalid.");
  }

  if (!Number.isFinite(config.queueJobRetentionHours) || config.queueJobRetentionHours <= 0) {
    throw new Error("QUEUE_JOB_RETENTION_HOURS is invalid.");
  }

  if (
    !Number.isFinite(config.telegramDeliveryRetentionHours) ||
    config.telegramDeliveryRetentionHours <= 0
  ) {
    throw new Error("TELEGRAM_DELIVERY_RETENTION_HOURS is invalid.");
  }

  if (
    !Number.isFinite(config.forwardingBatchRetentionHours) ||
    config.forwardingBatchRetentionHours <= 0
  ) {
    throw new Error("FORWARDING_BATCH_RETENTION_HOURS is invalid.");
  }

  if (!Number.isFinite(config.deadLetterRetentionHours) || config.deadLetterRetentionHours <= 0) {
    throw new Error("DEAD_LETTER_RETENTION_HOURS is invalid.");
  }

  if (!config.fontPath) {
    throw new Error("FONT_PATH is invalid.");
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

  if (!Number.isFinite(config.pdfHighDetailDpi) || config.pdfHighDetailDpi <= 0) {
    throw new Error("RASTERIZE_DPI_HIGH_DETAIL is invalid.");
  }

  if (!Number.isFinite(config.rasterizeConcurrency) || config.rasterizeConcurrency <= 0) {
    throw new Error("RASTERIZE_CONCURRENCY is invalid.");
  }

  if (
    config.pdfFinalPreflightMeasureDpi !== undefined &&
    (!Number.isFinite(config.pdfFinalPreflightMeasureDpi) || config.pdfFinalPreflightMeasureDpi <= 0)
  ) {
    throw new Error("PDF_FINAL_PREFLIGHT_MEASURE_DPI is invalid.");
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

  if (!Number.isFinite(config.readinessProbeTimeoutMs) || config.readinessProbeTimeoutMs <= 0) {
    throw new Error("READINESS_PROBE_TIMEOUT_MS is invalid.");
  }

  if (
    !Number.isFinite(config.readinessMinDiskFreeBytes) ||
    config.readinessMinDiskFreeBytes < 0
  ) {
    throw new Error("READINESS_MIN_DISK_FREE_BYTES is invalid.");
  }
}

function ensureSafeStoragePath(name: string, value: string): void {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    throw new Error(`${name} cannot be filesystem root.`);
  }

  const segments = resolved.split(path.sep).filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`${name} must point to a nested directory (unsafe root-level path).`);
  }
}
