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
    telegramReactionSecretToken: String(env.TELEGRAM_REACTION_SECRET_TOKEN ?? "").trim(),
    telegramRequestTimeoutMs: parsePositiveInteger(env.TELEGRAM_REQUEST_TIMEOUT_MS, 30_000),
    telegramRequestRetries: parsePositiveInteger(env.TELEGRAM_REQUEST_RETRIES, 2),
    telegramRequestRetryBaseMs: parsePositiveInteger(env.TELEGRAM_REQUEST_RETRY_BASE_MS, 900),
    orderQueueConcurrency: parsePositiveInteger(env.ORDER_QUEUE_CONCURRENCY, 1),
    orderQueueMaxSize: parsePositiveInteger(env.ORDER_QUEUE_MAX_SIZE, 200),
    reactionQueueConcurrency: parsePositiveInteger(env.REACTION_QUEUE_CONCURRENCY, 1),
    reactionQueueMaxSize: parsePositiveInteger(env.REACTION_QUEUE_MAX_SIZE, 300),
    queueJobTimeoutMs: parsePositiveInteger(env.QUEUE_JOB_TIMEOUT_MS, 10 * 60 * 1000),
    idempotencyStorePath: path.resolve(
      process.cwd(),
      String(env.IDEMPOTENCY_STORE_PATH ?? "storage/files/idempotency/order-webhooks.json"),
    ),
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
    telegramMessageMapPath: path.resolve(
      process.cwd(),
      String(env.TELEGRAM_MESSAGE_MAP_PATH ?? "storage/files/telegram/message-map.json"),
    ),
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
