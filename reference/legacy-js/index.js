"use strict";

const http = require("node:http");
const { URL } = require("node:url");
const fs = require("node:fs");
const path = require("node:path");
const { generateMaterialFiles } = require("./material-generator");
const { sendOrderFilesToTelegram } = require("./telegram-client");
const { shortenUrl } = require("./url-shortener");
const { OrderQueue } = require("./order-queue");
const { TelegramMessageOrderStore } = require("./telegram-message-store");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const envContent = fs.readFileSync(filePath, "utf8");
  const lines = envContent.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));

    if (isQuoted && value.length >= 2) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadEnvFile(path.resolve(process.cwd(), ".env"));

function parseOptionalEnvNumber(envName) {
  const raw = process.env[envName];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null;
  }

  const value = Number.parseFloat(String(raw));
  return Number.isFinite(value) ? value : null;
}

function parseEnvBoolean(envName, defaultValue) {
  const raw = process.env[envName];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return defaultValue;
  }

  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseEnvInt(envName, defaultValue, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const raw = process.env[envName];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return defaultValue;
  }

  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  return Math.max(min, Math.min(max, parsed));
}

function parseEnvCsv(envName, fallbackValues = []) {
  const raw = process.env[envName];
  const source = raw === undefined || raw === null || String(raw).trim() === ""
    ? fallbackValues
    : String(raw).split(",");

  return source
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

function normalizeEmojiValue(value) {
  return String(value ?? "").trim().normalize("NFC");
}

function stripEmojiVariationSelector(value) {
  return normalizeEmojiValue(value).replace(/\uFE0F/g, "");
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function buildQrPlacement(prefix) {
  const globalSizeMm = parseOptionalEnvNumber("QR_SIZE_MM");
  const globalRightMm = parseOptionalEnvNumber("QR_RIGHT_MM");
  const globalBottomMm = parseOptionalEnvNumber("QR_BOTTOM_MM");

  return {
    // Legacy absolute coordinates from left/bottom
    xMm: parseOptionalEnvNumber(`${prefix}_X_MM`),
    yMm: parseOptionalEnvNumber(`${prefix}_Y_MM`),
    // Preferred right/bottom positioning
    rightMm: parseOptionalEnvNumber(`${prefix}_RIGHT_MM`) ?? globalRightMm ?? 10,
    bottomMm: parseOptionalEnvNumber(`${prefix}_BOTTOM_MM`) ?? globalBottomMm ?? 10,
    sizeMm: parseOptionalEnvNumber(`${prefix}_SIZE_MM`) ?? globalSizeMm ?? 20,
  };
}

function isQrPlacementComplete(placement) {
  const hasAbsoluteLeftBottom =
    Number.isFinite(placement?.xMm) &&
    Number.isFinite(placement?.yMm) &&
    Number.isFinite(placement?.sizeMm) &&
    placement.sizeMm > 0;

  const hasRightBottom =
    Number.isFinite(placement?.rightMm) &&
    Number.isFinite(placement?.bottomMm) &&
    Number.isFinite(placement?.sizeMm) &&
    placement.sizeMm > 0;

  return (
    placement &&
    (hasAbsoluteLeftBottom || hasRightBottom)
  );
}

const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const KEYCRM_API_BASE = process.env.KEYCRM_API_BASE ?? "https://openapi.keycrm.app/v1";
const KEYCRM_TOKEN = process.env.KEYCRM_TOKEN ?? "";
const TEST_ORDER_ID = process.env.TEST_ORDER_ID ?? "";
const OUTPUT_DIR = path.resolve(process.cwd(), process.env.OUTPUT_DIR ?? "outputs");
const FONT_PATH = path.resolve(process.cwd(), process.env.FONT_PATH ?? "Caveat-VariableFont_wght.ttf");
const EMOJI_FONT_PATH = String(process.env.EMOJI_FONT_PATH ?? "").trim()
  ? path.resolve(process.cwd(), String(process.env.EMOJI_FONT_PATH).trim())
  : "";
const EMOJI_RENDER_MODE =
  String(process.env.EMOJI_RENDER_MODE ?? "apple_image").trim().toLowerCase() === "apple_image"
    ? "apple_image"
    : "font";
const APPLE_EMOJI_BASE_URL = String(
  process.env.APPLE_EMOJI_BASE_URL ?? "",
)
  .trim()
  .replace(/\/+$/, "");
const DEFAULT_APPLE_EMOJI_ASSETS_DIR = path.resolve(
  process.cwd(),
  "node_modules/emoji-datasource-apple/img/apple/64",
);
const APPLE_EMOJI_ASSETS_DIR = (() => {
  const configured = String(process.env.APPLE_EMOJI_ASSETS_DIR ?? "").trim();
  if (configured) {
    return path.resolve(process.cwd(), configured);
  }
  if (fs.existsSync(DEFAULT_APPLE_EMOJI_ASSETS_DIR)) {
    return DEFAULT_APPLE_EMOJI_ASSETS_DIR;
  }
  return "";
})();
const STICKER_SIZE_MM = Number.parseFloat(process.env.STICKER_SIZE_MM ?? "100");
const PDF_COLOR_SPACE =
  String(process.env.PDF_COLOR_SPACE ?? "RGB").trim().toUpperCase() === "CMYK"
    ? "CMYK"
    : "RGB";
const REPLACE_WHITE_WITH_OFFWHITE = true;
const OFFWHITE_HEX = String(process.env.OFFWHITE_HEX ?? "FFFEFA").trim().replace(/^#/, "");
const WHITE_REPLACE_MODE =
  String(process.env.WHITE_REPLACE_MODE ?? "photoshop_like").trim().toLowerCase() === "threshold"
    ? "threshold"
    : "photoshop_like";
const WHITE_THRESHOLD = Number.parseInt(process.env.WHITE_THRESHOLD ?? "252", 10);
const WHITE_MAX_SATURATION = Number.parseFloat(process.env.WHITE_MAX_SATURATION ?? "0.03");
const WHITE_LAB_DELTA_E_MAX = Number.parseFloat(process.env.WHITE_LAB_DELTA_E_MAX ?? "3");
const WHITE_LAB_SOFTNESS = Number.parseFloat(process.env.WHITE_LAB_SOFTNESS ?? "1");
const WHITE_MIN_LIGHTNESS = Number.parseFloat(process.env.WHITE_MIN_LIGHTNESS ?? "99.5");
const WHITE_FEATHER_PX = Number.parseFloat(process.env.WHITE_FEATHER_PX ?? "0.35");
const WHITE_MIN_ALPHA = Number.parseInt(process.env.WHITE_MIN_ALPHA ?? "0", 10);
const WHITE_CLEANUP_PASSES = Number.parseInt(process.env.WHITE_CLEANUP_PASSES ?? "3", 10);
const WHITE_CLEANUP_MIN_CHANNEL = Number.parseInt(process.env.WHITE_CLEANUP_MIN_CHANNEL ?? "248", 10);
const WHITE_CLEANUP_MAX_SATURATION = Number.parseFloat(process.env.WHITE_CLEANUP_MAX_SATURATION ?? "0.35");
const WHITE_HARD_CLEANUP_PASSES = Number.parseInt(process.env.WHITE_HARD_CLEANUP_PASSES ?? "2", 10);
const WHITE_HARD_MIN_CHANNEL = Number.parseInt(process.env.WHITE_HARD_MIN_CHANNEL ?? "246", 10);
const WHITE_HARD_MIN_LIGHTNESS = Number.parseFloat(process.env.WHITE_HARD_MIN_LIGHTNESS ?? "98.5");
const WHITE_HARD_DELTA_E_MAX = Number.parseFloat(process.env.WHITE_HARD_DELTA_E_MAX ?? "14");
const WHITE_HARD_MAX_SATURATION = Number.parseFloat(process.env.WHITE_HARD_MAX_SATURATION ?? "0.6");
const WHITE_ZERO_TRANSPARENT_RGB =
  String(process.env.WHITE_ZERO_TRANSPARENT_RGB ?? "true").trim().toLowerCase() !== "false";
const WHITE_REPLACE_ITERATIONS = Number.parseInt(process.env.WHITE_REPLACE_ITERATIONS ?? "3", 10);
const WHITE_ALLOW_SOFT_MASK_FALLBACK =
  String(process.env.WHITE_ALLOW_SOFT_MASK_FALLBACK ?? "true").trim().toLowerCase() === "true";
const WHITE_FINAL_ENFORCE =
  String(process.env.WHITE_FINAL_ENFORCE ?? "true").trim().toLowerCase() !== "false";
const WHITE_FINAL_ITERATIONS = Number.parseInt(process.env.WHITE_FINAL_ITERATIONS ?? "3", 10);
const WHITE_FINAL_THRESHOLD = Number.parseInt(process.env.WHITE_FINAL_THRESHOLD ?? "254", 10);
const WHITE_FINAL_MAX_SATURATION = Number.parseFloat(process.env.WHITE_FINAL_MAX_SATURATION ?? "0.25");
const WHITE_FINAL_DPI = Number.parseInt(process.env.WHITE_FINAL_DPI ?? "300", 10);
const RASTERIZE_DPI = Number.parseInt(process.env.RASTERIZE_DPI ?? "600", 10);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "";
const TELEGRAM_MESSAGE_THREAD_ID = process.env.TELEGRAM_MESSAGE_THREAD_ID ?? "";
const CUTTLY_API_KEY = process.env.CUTTLY_API_KEY ?? "";
const URL_SHORTENER_PROVIDER = (process.env.URL_SHORTENER_PROVIDER ?? "cuttly").trim().toLowerCase();
const URL_SHORTENER_TIMEOUT_MS = Number.parseInt(process.env.URL_SHORTENER_TIMEOUT_MS ?? "7000", 10);
const URL_SHORTENER_RETRIES = parseEnvInt("URL_SHORTENER_RETRIES", 2, {
  min: 0,
  max: 6,
});
const URL_SHORTENER_RETRY_BASE_MS = parseEnvInt("URL_SHORTENER_RETRY_BASE_MS", 500, {
  min: 100,
  max: 20_000,
});
const URL_SHORTENER_REQUIRED = String(process.env.URL_SHORTENER_REQUIRED ?? "true").trim().toLowerCase() !== "false";
const QR_PLACEMENT_BY_FORMAT = {
  A5: buildQrPlacement("QR_A5"),
  A4: buildQrPlacement("QR_A4"),
};
const QR_PLACEMENT_CONFIGURED = {
  A5: isQrPlacementComplete(QR_PLACEMENT_BY_FORMAT.A5),
  A4: isQrPlacementComplete(QR_PLACEMENT_BY_FORMAT.A4),
};
const EVENT_ORDER_STATUS_CHANGED = "order.change_order_status";
const REQUEST_BODY_LIMIT_BYTES = 1_000_000;

const KEYCRM_ORDER_INCLUDE = (process.env.KEYCRM_ORDER_INCLUDE ??
  "products.offer,tags,custom_fields,status,manager,shipping.deliveryService,shipping.lastHistory")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const KEYCRM_REQUEST_TIMEOUT_MS = parseEnvInt("KEYCRM_REQUEST_TIMEOUT_MS", 15_000, {
  min: 1_000,
  max: 120_000,
});
const KEYCRM_REQUEST_RETRIES = parseEnvInt("KEYCRM_REQUEST_RETRIES", 2, {
  min: 0,
  max: 6,
});
const KEYCRM_REQUEST_RETRY_BASE_MS = parseEnvInt("KEYCRM_REQUEST_RETRY_BASE_MS", 500, {
  min: 100,
  max: 10_000,
});

const TELEGRAM_REQUEST_TIMEOUT_MS = parseEnvInt("TELEGRAM_REQUEST_TIMEOUT_MS", 30_000, {
  min: 1_000,
  max: 180_000,
});
const TELEGRAM_REQUEST_RETRIES = parseEnvInt("TELEGRAM_REQUEST_RETRIES", 2, {
  min: 0,
  max: 6,
});
const TELEGRAM_RETRY_BASE_MS = parseEnvInt("TELEGRAM_RETRY_BASE_MS", 900, {
  min: 100,
  max: 20_000,
});

const ORDER_QUEUE_CONCURRENCY = parseEnvInt("ORDER_QUEUE_CONCURRENCY", 2, {
  min: 1,
  max: 20,
});
const ORDER_QUEUE_MAX_SIZE = parseEnvInt("ORDER_QUEUE_MAX_SIZE", 100, {
  min: 1,
  max: 10_000,
});
const ORDER_JOB_TIMEOUT_MS = parseEnvInt("ORDER_JOB_TIMEOUT_MS", 15 * 60 * 1000, {
  min: 10_000,
  max: 12 * 60 * 60 * 1000,
});
const ORDER_QUEUE_DEDUPE = parseEnvBoolean("ORDER_QUEUE_DEDUPE", true);

const WEBHOOK_PROCESS_ORDERS = parseEnvBoolean("WEBHOOK_PROCESS_ORDERS", false);
const WEBHOOK_GENERATE_FILES = parseEnvBoolean("WEBHOOK_GENERATE_FILES", false);
const WEBHOOK_SEND_TELEGRAM = parseEnvBoolean("WEBHOOK_SEND_TELEGRAM", false);
const WEBHOOK_WAIT_FOR_COMPLETION = parseEnvBoolean("WEBHOOK_WAIT_FOR_COMPLETION", false);

const TELEGRAM_MESSAGE_MAP_PATH = path.resolve(
  process.cwd(),
  process.env.TELEGRAM_MESSAGE_MAP_PATH ?? "outputs/telegram-message-map.json",
);
const TELEGRAM_MESSAGE_MAP_MAX_ENTRIES = parseEnvInt("TELEGRAM_MESSAGE_MAP_MAX_ENTRIES", 25_000, {
  min: 100,
  max: 500_000,
});
const TELEGRAM_REACTION_ENABLED = parseEnvBoolean("TELEGRAM_REACTION_ENABLED", true);
const TELEGRAM_REACTION_SECRET_TOKEN = String(
  process.env.TELEGRAM_REACTION_SECRET_TOKEN ?? "",
).trim();
const TELEGRAM_REACTION_TARGET_STATUS_ID = parseEnvInt(
  "TELEGRAM_REACTION_TARGET_STATUS_ID",
  0,
  {
    min: 0,
    max: 1_000_000,
  },
);
const TELEGRAM_REACTION_HEART_THRESHOLD = parseEnvInt("TELEGRAM_REACTION_HEART_THRESHOLD", 2, {
  min: 1,
  max: 10_000,
});
const TELEGRAM_REACTION_HEART_EMOJIS = parseEnvCsv("TELEGRAM_REACTION_HEART_EMOJIS", [
  "❤️",
  "❤",
]).map(normalizeEmojiValue);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

function log(level, message, meta = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function computeBackoffDelayMs(attempt, baseDelayMs, maxDelayMs = 20_000) {
  const safeAttempt = Math.max(1, attempt);
  const cappedExp = Math.min(8, safeAttempt - 1);
  const exponential = baseDelayMs * (2 ** cappedExp);
  const jitter = Math.floor(Math.random() * Math.min(1_000, baseDelayMs));
  return Math.min(maxDelayMs, exponential + jitter);
}

function isRetryableStatusCode(statusCode) {
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function isRetryableFetchError(error) {
  if (!error) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  const message = String(error.message ?? "");
  return /fetch failed|network|timeout|socket|econnreset|etimedout|enotfound|eai_again/i.test(message);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

const orderQueue = new OrderQueue({
  concurrency: ORDER_QUEUE_CONCURRENCY,
  maxQueueSize: ORDER_QUEUE_MAX_SIZE,
  jobTimeoutMs: ORDER_JOB_TIMEOUT_MS,
  onJobStateChange: (event) => {
    log("info", "order_job_state", event);
  },
});

const TELEGRAM_HEART_EMOJI_SET = (() => {
  const set = new Set();
  for (const emoji of TELEGRAM_REACTION_HEART_EMOJIS) {
    const normalized = normalizeEmojiValue(emoji);
    if (!normalized) {
      continue;
    }
    set.add(normalized);
    set.add(stripEmojiVariationSelector(normalized));
  }
  return set;
})();

const telegramMessageStore = new TelegramMessageOrderStore({
  filePath: TELEGRAM_MESSAGE_MAP_PATH,
  maxEntries: TELEGRAM_MESSAGE_MAP_MAX_ENTRIES,
});

const reactionProcessingLocks = new Map();

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;

    req.on("data", (chunk) => {
      totalSize += chunk.length;
      if (totalSize > REQUEST_BODY_LIMIT_BYTES) {
        reject(new HttpError(413, "Payload is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (error) => {
      reject(new HttpError(400, `Cannot read request body: ${error.message}`));
    });
  });
}

function parseJson(rawBody) {
  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw new HttpError(400, `Invalid JSON body: ${error.message}`);
  }
}

function extractWebhookEvents(payload) {
  const events = [];

  const addCandidate = (candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return;
    }

    const directEvent = candidate.event && candidate.context ? candidate : null;
    if (directEvent) {
      events.push(directEvent);
      return;
    }

    const wrappedEvent =
      candidate.body && candidate.body.event && candidate.body.context
        ? candidate.body
        : null;

    if (wrappedEvent) {
      events.push(wrappedEvent);
    }
  };

  if (Array.isArray(payload)) {
    payload.forEach(addCandidate);
    return events;
  }

  addCandidate(payload);
  return events;
}

function buildOrderUrl(orderId) {
  const base = KEYCRM_API_BASE.endsWith("/")
    ? KEYCRM_API_BASE
    : `${KEYCRM_API_BASE}/`;
  const orderUrl = new URL(`order/${encodeURIComponent(String(orderId))}`, base);

  if (KEYCRM_ORDER_INCLUDE.length) {
    orderUrl.searchParams.set("include", KEYCRM_ORDER_INCLUDE.join(","));
  }

  return orderUrl;
}

function parseRetryAfterMs(value) {
  if (!value) {
    return null;
  }

  const seconds = Number.parseInt(String(value).trim(), 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const asDate = Date.parse(String(value));
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }

  return null;
}

function parseResponsePayloadFromText(responseText) {
  let payload = responseText;
  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch (_error) {
    // Keep plain text payload when remote API returns non-JSON data.
  }
  return payload;
}

function isTrackedHeartEmoji(emoji) {
  const normalized = normalizeEmojiValue(emoji);
  if (!normalized) {
    return false;
  }
  return (
    TELEGRAM_HEART_EMOJI_SET.has(normalized) ||
    TELEGRAM_HEART_EMOJI_SET.has(stripEmojiVariationSelector(normalized))
  );
}

function buildOrderUpdateUrl(orderId) {
  const base = KEYCRM_API_BASE.endsWith("/")
    ? KEYCRM_API_BASE
    : `${KEYCRM_API_BASE}/`;
  return new URL(`order/${encodeURIComponent(String(orderId))}`, base);
}

async function updateOrderStatus(orderId, statusId) {
  if (!KEYCRM_TOKEN) {
    throw new Error("KEYCRM_TOKEN is not configured.");
  }

  if (!Number.isFinite(Number(statusId)) || Number(statusId) <= 0) {
    throw new Error("TELEGRAM_REACTION_TARGET_STATUS_ID is invalid.");
  }

  const orderUrl = buildOrderUpdateUrl(orderId);
  const body = JSON.stringify({
    status_id: Number(statusId),
  });

  const maxAttempts = KEYCRM_REQUEST_RETRIES + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        orderUrl,
        {
          method: "PUT",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${KEYCRM_TOKEN}`,
          },
          body,
        },
        KEYCRM_REQUEST_TIMEOUT_MS,
      );

      const responseText = await response.text();
      const responsePayload = parseResponsePayloadFromText(responseText);

      if (!response.ok) {
        const responseMessage =
          typeof responsePayload === "string"
            ? responsePayload
            : JSON.stringify(responsePayload);
        const error = new Error(
          `KeyCRM update order failed (${response.status}): ${responseMessage.slice(0, 500)}`,
        );

        if (attempt < maxAttempts && isRetryableStatusCode(response.status)) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          const delayMs = retryAfterMs ?? computeBackoffDelayMs(attempt, KEYCRM_REQUEST_RETRY_BASE_MS);
          await sleep(delayMs);
          continue;
        }

        throw error;
      }

      if (responsePayload && typeof responsePayload === "object" && "data" in responsePayload) {
        return responsePayload.data;
      }
      return responsePayload;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableFetchError(error)) {
        throw error;
      }

      const delayMs = computeBackoffDelayMs(attempt, KEYCRM_REQUEST_RETRY_BASE_MS);
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("KeyCRM update order failed.");
}

function extractTelegramUpdates(payload) {
  const updates = [];
  const addCandidate = (candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return;
    }

    if (
      Number.isFinite(Number(candidate?.update_id)) ||
      candidate?.message_reaction_count ||
      candidate?.message_reaction
    ) {
      updates.push(candidate);
      return;
    }

    if (Array.isArray(candidate?.result)) {
      for (const item of candidate.result) {
        addCandidate(item);
      }
    }
  };

  if (Array.isArray(payload)) {
    for (const item of payload) {
      addCandidate(item);
    }
    return updates;
  }

  addCandidate(payload);
  return updates;
}

function extractHeartCount(reactions) {
  const list = Array.isArray(reactions) ? reactions : [];
  let count = 0;

  for (const reaction of list) {
    const reactionType = reaction?.type;
    const emoji =
      reactionType?.type === "emoji"
        ? normalizeEmojiValue(reactionType?.emoji)
        : "";
    if (!emoji || !isTrackedHeartEmoji(emoji)) {
      continue;
    }
    count += Number.parseInt(String(reaction?.total_count ?? "0"), 10) || 0;
  }

  return count;
}

function reactionTypesContainHeart(reactions) {
  const list = Array.isArray(reactions) ? reactions : [];
  for (const reactionType of list) {
    if (reactionType?.type !== "emoji") {
      continue;
    }
    if (isTrackedHeartEmoji(reactionType?.emoji)) {
      return true;
    }
  }
  return false;
}

async function withReactionProcessingLock(lockKey, handler) {
  const existing = reactionProcessingLocks.get(lockKey);
  if (existing) {
    return existing;
  }

  const promise = Promise.resolve()
    .then(handler)
    .finally(() => {
      reactionProcessingLocks.delete(lockKey);
    });

  reactionProcessingLocks.set(lockKey, promise);
  return promise;
}

async function handleReactionCountForMessage({
  chatId,
  messageId,
  heartCount,
  source = "telegram_webhook",
  updateId = null,
}) {
  const normalizedChatId = String(chatId ?? "").trim();
  const normalizedMessageId = Number.parseInt(String(messageId ?? ""), 10);
  const normalizedHeartCount = Math.max(0, Number.parseInt(String(heartCount ?? "0"), 10) || 0);
  const lockKey = `${normalizedChatId}:${normalizedMessageId}`;

  if (!normalizedChatId || !Number.isFinite(normalizedMessageId)) {
    return {
      action: "skipped",
      reason: "invalid_message_identity",
    };
  }

  return withReactionProcessingLock(lockKey, async () => {
    const mapped = await telegramMessageStore.getMessage(normalizedChatId, normalizedMessageId);
    if (!mapped) {
      return {
        action: "skipped",
        reason: "message_not_mapped",
      };
    }

    await telegramMessageStore.markReactionState(normalizedChatId, normalizedMessageId, {
      lastHeartCount: normalizedHeartCount,
      lastHeartEmoji: TELEGRAM_REACTION_HEART_EMOJIS[0] ?? "❤️",
    });

    if (mapped.reaction_applied) {
      return {
        action: "skipped",
        reason: "already_applied",
        order_id: mapped.order_id,
      };
    }

    if (normalizedHeartCount < TELEGRAM_REACTION_HEART_THRESHOLD) {
      return {
        action: "tracked",
        order_id: mapped.order_id,
        heart_count: normalizedHeartCount,
        threshold: TELEGRAM_REACTION_HEART_THRESHOLD,
      };
    }

    if (!Number.isFinite(TELEGRAM_REACTION_TARGET_STATUS_ID) || TELEGRAM_REACTION_TARGET_STATUS_ID <= 0) {
      throw new Error("TELEGRAM_REACTION_TARGET_STATUS_ID is not configured.");
    }

    const crmUpdate = await updateOrderStatus(mapped.order_id, TELEGRAM_REACTION_TARGET_STATUS_ID);
    await telegramMessageStore.markReactionState(normalizedChatId, normalizedMessageId, {
      lastHeartCount: normalizedHeartCount,
      reactionApplied: true,
      reactionAppliedStatusId: TELEGRAM_REACTION_TARGET_STATUS_ID,
    });

    return {
      action: "status_updated",
      source,
      update_id: updateId,
      order_id: mapped.order_id,
      heart_count: normalizedHeartCount,
      threshold: TELEGRAM_REACTION_HEART_THRESHOLD,
      status_id: TELEGRAM_REACTION_TARGET_STATUS_ID,
      crm_order_id: crmUpdate?.id ?? mapped.order_id,
    };
  });
}

async function processTelegramReactionPayload(payload) {
  const updates = extractTelegramUpdates(payload);
  const processed = [];
  const skipped = [];
  const errors = [];

  if (!TELEGRAM_REACTION_ENABLED) {
    return {
      received_updates: updates.length,
      processed,
      skipped: [
        {
          reason: "reactions_processing_disabled",
        },
      ],
      errors,
    };
  }

  for (const update of updates) {
    const messageReactionCount = update?.message_reaction_count;
    const messageReaction = update?.message_reaction;

    if (!messageReactionCount && !messageReaction) {
      skipped.push({
        update_id: update?.update_id ?? null,
        reason: "unsupported_update_type",
      });
      continue;
    }

    const sourcePayload = messageReactionCount ?? messageReaction;
    const chatId = String(sourcePayload?.chat?.id ?? "").trim();
    const messageId = Number.parseInt(String(sourcePayload?.message_id ?? ""), 10);
    let heartCount = 0;

    try {
      if (messageReactionCount) {
        heartCount = extractHeartCount(messageReactionCount?.reactions);
      } else {
        const userId = messageReaction?.user?.id;
        const actorChatId = messageReaction?.actor_chat?.id;
        const userKey =
          Number.isFinite(Number(userId))
            ? `u:${String(userId)}`
            : Number.isFinite(Number(actorChatId))
              ? `c:${String(actorChatId)}`
              : "";

        if (!userKey) {
          skipped.push({
            update_id: update?.update_id ?? null,
            chat_id: chatId,
            message_id: messageId,
            reason: "reaction_user_unknown",
          });
          continue;
        }

        const hasHeartNow = reactionTypesContainHeart(messageReaction?.new_reaction);
        const upserted = await telegramMessageStore.upsertUserHeartReaction(chatId, messageId, {
          userKey,
          hasHeart: hasHeartNow,
          emoji: TELEGRAM_REACTION_HEART_EMOJIS[0] ?? "❤️",
        });

        if (!upserted) {
          skipped.push({
            update_id: update?.update_id ?? null,
            chat_id: chatId,
            message_id: messageId,
            reason: "message_not_mapped",
          });
          continue;
        }

        heartCount = Number.parseInt(String(upserted.last_heart_count ?? 0), 10) || 0;
      }

      const result = await handleReactionCountForMessage({
        chatId,
        messageId,
        heartCount,
        source: "telegram_webhook",
        updateId: update?.update_id ?? null,
      });

      if (result.action === "status_updated" || result.action === "tracked") {
        processed.push({
          update_id: update?.update_id ?? null,
          chat_id: chatId,
          message_id: messageId,
          ...result,
        });
      } else {
        skipped.push({
          update_id: update?.update_id ?? null,
          chat_id: chatId,
          message_id: messageId,
          ...result,
        });
      }
    } catch (error) {
      errors.push({
        update_id: update?.update_id ?? null,
        chat_id: chatId,
        message_id: messageId,
        message: toErrorMessage(error),
      });
    }
  }

  return {
    received_updates: updates.length,
    processed,
    skipped,
    errors,
  };
}

async function fetchOrderById(orderId) {
  if (!KEYCRM_TOKEN) {
    throw new Error("KEYCRM_TOKEN is not configured.");
  }

  if (typeof fetch !== "function") {
    throw new Error("Global fetch is unavailable. Use Node.js 18+.");
  }

  const orderUrl = buildOrderUrl(orderId);
  const maxAttempts = KEYCRM_REQUEST_RETRIES + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        orderUrl,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${KEYCRM_TOKEN}`,
          },
        },
        KEYCRM_REQUEST_TIMEOUT_MS,
      );

      const responseText = await response.text();
      const responsePayload = parseResponsePayloadFromText(responseText);

      if (!response.ok) {
        const responseMessage =
          typeof responsePayload === "string"
            ? responsePayload
            : JSON.stringify(responsePayload);
        const error = new Error(
          `KeyCRM request failed (${response.status}): ${responseMessage.slice(0, 500)}`,
        );

        if (attempt < maxAttempts && isRetryableStatusCode(response.status)) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          const delayMs =
            retryAfterMs ?? computeBackoffDelayMs(attempt, KEYCRM_REQUEST_RETRY_BASE_MS);
          log("warn", "keycrm_retryable_status", {
            order_id: String(orderId),
            attempt,
            status_code: response.status,
            delay_ms: delayMs,
          });
          await sleep(delayMs);
          continue;
        }

        throw error;
      }

      if (responsePayload && typeof responsePayload === "object" && "data" in responsePayload) {
        return responsePayload.data;
      }

      return responsePayload;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableFetchError(error)) {
        throw error;
      }

      const delayMs = computeBackoffDelayMs(attempt, KEYCRM_REQUEST_RETRY_BASE_MS);
      log("warn", "keycrm_retryable_error", {
        order_id: String(orderId),
        attempt,
        delay_ms: delayMs,
        error: toErrorMessage(error),
      });
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("KeyCRM request failed.");
}

function summarizeOrder(order) {
  return {
    id: order?.id ?? null,
    source_uuid: order?.source_uuid ?? null,
    global_source_uuid: order?.global_source_uuid ?? null,
    status_id: order?.status_id ?? null,
    products_count: Array.isArray(order?.products) ? order.products.length : 0,
    updated_at: order?.updated_at ?? null,
  };
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function isTruthyValue(value) {
  const normalized = normalizeKey(value);
  return (
    normalized === "так" ||
    normalized === "yes" ||
    normalized === "true" ||
    normalized === "1" ||
    normalized === "додати" ||
    normalized === "add"
  );
}

function createPropertiesMap(product) {
  const properties = Array.isArray(product?.properties) ? product.properties : [];
  const map = new Map();

  for (const property of properties) {
    const key = normalizeKey(property?.name);
    if (!key) {
      continue;
    }
    map.set(key, normalizeText(property?.value));
  }

  return map;
}

function firstDefinedProperty(propertiesMap, names) {
  for (const name of names) {
    const key = normalizeKey(name);
    if (propertiesMap.has(key)) {
      return propertiesMap.get(key);
    }
  }
  return "";
}

function parseFormat(baseProduct, propertiesMap) {
  const variant = firstDefinedProperty(propertiesMap, ["Variant", "Варіант"]);
  const productName = normalizeText(baseProduct?.name);
  const sku = normalizeText(baseProduct?.sku);
  const source = `${variant} ${productName} ${sku}`;
  const match = source.match(/[AaАа]\s*([45])/);
  if (!match) {
    return "";
  }
  return `A${match[1]}`;
}

function parseStandType(baseProduct, propertiesMap) {
  const variant = normalizeKey(firstDefinedProperty(propertiesMap, ["Variant", "Варіант"]));
  const productName = normalizeKey(baseProduct?.name);
  const sku = normalizeKey(baseProduct?.sku);
  const source = `${variant} ${productName} ${sku}`;

  if (
    source.includes("мульти-біла") ||
    source.includes("мульти біла") ||
    source.includes("multi white") ||
    source.includes("mww")
  ) {
    return "MWW";
  }
  if (
    source.includes("тепла біла") ||
    source.includes("тепло-біла") ||
    source.includes("warm white") ||
    source.includes("ww")
  ) {
    return "WW";
  }
  if (source.includes("кольор") || source.includes("color")) {
    return "C";
  }
  if (source.includes("дерев") || source.includes("wood")) {
    return "W";
  }
  return "";
}

function resolvePosterSource(baseProduct, propertiesMap) {
  const designLink = firstDefinedProperty(propertiesMap, ["_tib_design_link_1"]);
  if (designLink) {
    return designLink;
  }
  const customizationImage = firstDefinedProperty(propertiesMap, ["_customization_image"]);
  if (customizationImage) {
    return customizationImage;
  }
  return normalizeText(baseProduct?.picture?.thumbnail);
}

function collectCustomizationPreviewImages(baseProducts) {
  const urls = [];
  const invalid = [];
  const seen = new Set();

  for (const product of baseProducts ?? []) {
    const propertiesMap = createPropertiesMap(product);
    const value = firstDefinedProperty(propertiesMap, ["_customization_image"]);
    if (!value) {
      continue;
    }

    if (!isValidHttpUrl(value)) {
      invalid.push(value);
      continue;
    }

    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    urls.push(value);
  }

  return {
    urls,
    invalid,
  };
}

function hasQrOption(order, basePropertiesMaps) {
  return (
    basePropertiesMaps.some((map) => isTruthyValue(firstDefinedProperty(map, ["QR-код", "QR код"]))) ||
    (order?.products ?? []).some((product) => normalizeKey(product?.sku).includes("qr"))
  );
}

function resolveQrUrl(basePropertiesMaps) {
  for (const propertiesMap of basePropertiesMaps) {
    const value = firstDefinedProperty(propertiesMap, [
      "Посилання до QR-коду",
      "Посилання до QR коду",
      "QR link",
      "Link to QR",
    ]);
    if (value) {
      return value;
    }
  }
  return "";
}

function isValidHttpUrl(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return false;
  }

  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function collectOrderFlags(order, basePropertiesMaps) {
  const hasLivePhoto =
    basePropertiesMaps.some((map) => isTruthyValue(firstDefinedProperty(map, ["Live Photo"]))) ||
    (order?.products ?? []).some((product) => normalizeKey(product?.sku).includes("live photo"));
  const hasQr = hasQrOption(order, basePropertiesMaps);
  const hasKeychain =
    basePropertiesMaps.some((map) => isTruthyValue(firstDefinedProperty(map, ["Брелок", "Keychain"]))) ||
    (order?.products ?? []).some((product) => normalizeKey(product?.sku).includes("брелок"));

  const flags = [];
  if (hasQr) {
    flags.push("QR +");
  }
  if (hasLivePhoto) {
    flags.push("LF +");
  }
  if (hasKeychain) {
    flags.push("B +");
  }

  return flags;
}

function resolveUrgent(order, basePropertiesMaps) {
  if (
    basePropertiesMaps.some((map) =>
      isTruthyValue(firstDefinedProperty(map, ["Термінове виготовлення", "Термінове"])),
    )
  ) {
    return true;
  }

  return (order?.products ?? []).some(
    (product) =>
      normalizeKey(product?.sku).includes("термінове") ||
      normalizeKey(product?.name).includes("термінове"),
  );
}

function buildFilename(code, orderNumber, index, total, urgent) {
  const urgentSuffix = urgent ? "_T" : "";
  return `CGU_${code}_${orderNumber}_${index}_${total}${urgentSuffix}`;
}

function buildLayoutPlan(order) {
  const orderNumber = String(order?.id ?? "");
  const products = Array.isArray(order?.products) ? order.products : [];
  const baseProducts = products.filter((product) =>
    (product?.properties ?? []).some((property) => normalizeKey(property?.name) === "_tib_design_link_1"),
  );
  const effectiveBaseProducts = baseProducts.length > 0 ? baseProducts : products.slice(0, 1);
  const basePropertiesMaps = effectiveBaseProducts.map((product) => createPropertiesMap(product));
  const urgent = resolveUrgent(order, basePropertiesMaps);
  const flags = collectOrderFlags(order, basePropertiesMaps);
  const qrRequested = hasQrOption(order, basePropertiesMaps);
  const qrUrl = resolveQrUrl(basePropertiesMaps);
  const qrUrlValid = qrRequested ? isValidHttpUrl(qrUrl) : false;
  const customizationPreviews = collectCustomizationPreviewImages(effectiveBaseProducts);
  const notes = [];

  if (qrRequested && !qrUrlValid) {
    notes.push("Посилання до QR-коду невалідне, QR файл не згенеровано.");
  }
  if (customizationPreviews.invalid.length > 0) {
    notes.push("Посилання _customization_image невалідне, прев'ю не додано.");
  }

  const materials = [];

  for (let i = 0; i < effectiveBaseProducts.length; i += 1) {
    const baseProduct = effectiveBaseProducts[i];
    const propertiesMap = basePropertiesMaps[i];
    const format = parseFormat(baseProduct, propertiesMap) || "A5";
    const standType = parseStandType(baseProduct, propertiesMap) || "W";
    const posterSourceUrl = resolvePosterSource(baseProduct, propertiesMap);
    const engravingText = firstDefinedProperty(
      propertiesMap,
      ["Текст для гравіювання", "Text for engraving"],
    );
    const stickerText = firstDefinedProperty(propertiesMap, ["Текст на стікер", "Text on sticker"]);
    const hasEngraving =
      isTruthyValue(firstDefinedProperty(propertiesMap, ["Гравіювання"])) || Boolean(engravingText);
    const hasSticker =
      isTruthyValue(firstDefinedProperty(propertiesMap, ["Стікер-записка", "Стікер"])) ||
      Boolean(stickerText);

    materials.push({
      type: "poster",
      code: `A${format}`,
      product_id: baseProduct?.id ?? null,
      source_url: posterSourceUrl || null,
      text: null,
      format,
      stand_type: null,
    });

    if (hasEngraving) {
      materials.push({
        type: "engraving",
        code: `${format}${standType}_G`,
        product_id: baseProduct?.id ?? null,
        source_url: null,
        text: engravingText || null,
        format,
        stand_type: standType,
      });
    }

    if (hasSticker) {
      materials.push({
        type: "sticker",
        code: "S",
        product_id: baseProduct?.id ?? null,
        source_url: null,
        text: stickerText || null,
        format: null,
        stand_type: null,
      });
    }
  }

  const total = materials.length;
  const namedMaterials = materials.map((material, index) => ({
    ...material,
    index: index + 1,
    total,
    filename: buildFilename(material.code, orderNumber, index + 1, total, urgent),
  }));

  return {
    order_number: orderNumber || null,
    urgent,
    flags,
    notes,
    preview_images: customizationPreviews.urls,
    qr: {
      requested: qrRequested,
      original_url: qrUrl || null,
      short_url: null,
      url: qrUrl || null,
      valid: qrUrlValid,
      should_generate: qrRequested && qrUrlValid,
    },
    materials: namedMaterials,
  };
}

async function enrichQrWithShortUrl(layoutPlan) {
  if (!layoutPlan?.qr?.requested) {
    return;
  }

  if (!layoutPlan.qr.valid || !layoutPlan.qr.url) {
    return;
  }

  try {
    const shortUrl = await shortenUrl(layoutPlan.qr.url, {
      provider: URL_SHORTENER_PROVIDER,
      timeoutMs: Number.isFinite(URL_SHORTENER_TIMEOUT_MS) ? URL_SHORTENER_TIMEOUT_MS : 7000,
      retries: URL_SHORTENER_RETRIES,
      retryBaseMs: URL_SHORTENER_RETRY_BASE_MS,
      cuttlyApiKey: CUTTLY_API_KEY,
    });

    layoutPlan.qr.short_url = shortUrl;
    layoutPlan.qr.url = shortUrl;
  } catch (error) {
    const warning = `Не вдалося скоротити посилання для QR: ${error.message}`;
    layoutPlan.notes = [...(layoutPlan.notes ?? []), warning];
    if (URL_SHORTENER_REQUIRED) {
      layoutPlan.qr.should_generate = false;
      layoutPlan.qr.url = null;
    }
  }
}

async function processSingleOrder(
  orderId,
  {
    includeFullOrder = false,
    generateFiles = false,
    sendTelegram = false,
    outputDir = OUTPUT_DIR,
    telegramChatId = TELEGRAM_CHAT_ID,
    telegramMessageThreadId = TELEGRAM_MESSAGE_THREAD_ID,
  } = {},
) {
  if (!orderId) {
    throw new HttpError(400, "orderId is required.");
  }

  const order = await fetchOrderById(orderId);
  const layoutPlan = buildLayoutPlan(order);
  if (layoutPlan?.qr?.requested && (generateFiles || sendTelegram)) {
    await enrichQrWithShortUrl(layoutPlan);
  }
  const warnings = [...(layoutPlan.notes ?? [])];
  const response = {
    orderId,
    summary: summarizeOrder(order),
    layout_plan: layoutPlan,
    warnings,
    order: includeFullOrder ? order : undefined,
  };

  if (generateFiles || sendTelegram) {
    response.generated_files = await generateMaterialFiles({
      layoutPlan,
      outputRoot: outputDir,
      orderId,
      fontPath: FONT_PATH,
      emojiFontPath: EMOJI_FONT_PATH,
      emojiRenderMode: EMOJI_RENDER_MODE,
      appleEmojiBaseUrl: APPLE_EMOJI_BASE_URL,
      appleEmojiAssetsDir: APPLE_EMOJI_ASSETS_DIR,
      stickerSizeMm: STICKER_SIZE_MM,
      colorSpace: PDF_COLOR_SPACE,
      qrPlacementByFormat: QR_PLACEMENT_BY_FORMAT,
      replaceWhiteWithOffWhite: REPLACE_WHITE_WITH_OFFWHITE,
      offWhiteHex: OFFWHITE_HEX,
      whiteReplaceMode: WHITE_REPLACE_MODE,
      whiteThreshold: WHITE_THRESHOLD,
      whiteMaxSaturation: WHITE_MAX_SATURATION,
      whiteLabDeltaEMax: WHITE_LAB_DELTA_E_MAX,
      whiteLabSoftness: WHITE_LAB_SOFTNESS,
      whiteMinLightness: WHITE_MIN_LIGHTNESS,
      whiteFeatherPx: WHITE_FEATHER_PX,
      whiteMinAlpha: WHITE_MIN_ALPHA,
      whiteCleanupPasses: WHITE_CLEANUP_PASSES,
      whiteCleanupMinChannel: WHITE_CLEANUP_MIN_CHANNEL,
      whiteCleanupMaxSaturation: WHITE_CLEANUP_MAX_SATURATION,
      whiteHardCleanupPasses: WHITE_HARD_CLEANUP_PASSES,
      whiteHardCleanupMinChannel: WHITE_HARD_MIN_CHANNEL,
      whiteHardCleanupMinLightness: WHITE_HARD_MIN_LIGHTNESS,
      whiteHardCleanupDeltaEMax: WHITE_HARD_DELTA_E_MAX,
      whiteHardCleanupMaxSaturation: WHITE_HARD_MAX_SATURATION,
      whiteSanitizeTransparentRgb: WHITE_ZERO_TRANSPARENT_RGB,
      whiteAllowSoftMaskFallback: WHITE_ALLOW_SOFT_MASK_FALLBACK,
      whiteReplaceIterations: WHITE_REPLACE_ITERATIONS,
      whiteFinalEnforce: WHITE_FINAL_ENFORCE,
      whiteFinalIterations: WHITE_FINAL_ITERATIONS,
      whiteFinalThreshold: WHITE_FINAL_THRESHOLD,
      whiteFinalMaxSaturation: WHITE_FINAL_MAX_SATURATION,
      whiteFinalDpi: WHITE_FINAL_DPI,
      rasterizeDpi: RASTERIZE_DPI,
    });

    if (Array.isArray(response.generated_files?.warnings) && response.generated_files.warnings.length) {
      warnings.push(...response.generated_files.warnings);
    }
  }

  if (sendTelegram) {
    const failedFiles = response.generated_files?.failed ?? [];
    if (failedFiles.length > 0) {
      throw new Error(
        `Cannot send to Telegram: ${failedFiles.length} file(s) failed to generate.`,
      );
    }

    const generatedFiles = response.generated_files?.generated ?? [];
    if (generatedFiles.length === 0) {
      throw new Error("Cannot send to Telegram: no generated files.");
    }

    response.telegram = await sendOrderFilesToTelegram({
      botToken: TELEGRAM_BOT_TOKEN,
      chatId: telegramChatId,
      messageThreadId: telegramMessageThreadId,
      orderId,
      flags: layoutPlan.flags,
      warnings: response.warnings,
      qrUrl: layoutPlan?.qr?.should_generate ? layoutPlan.qr.url : null,
      previewImages: Array.isArray(layoutPlan?.preview_images) ? layoutPlan.preview_images : [],
      generatedFiles,
      requestOptions: {
        timeoutMs: TELEGRAM_REQUEST_TIMEOUT_MS,
        retries: TELEGRAM_REQUEST_RETRIES,
        retryBaseMs: TELEGRAM_RETRY_BASE_MS,
      },
    });

    const messageIds = Array.isArray(response.telegram?.message_ids)
      ? response.telegram.message_ids
      : [];
    const linkedChatId = response.telegram?.chat_id ?? telegramChatId;
    if (messageIds.length > 0 && linkedChatId) {
      try {
        const linkResult = await telegramMessageStore.linkMessages({
          orderId,
          chatId: linkedChatId,
          messageIds,
        });
        response.telegram.message_mapping = {
          linked: linkResult.linked,
          storage_path: TELEGRAM_MESSAGE_MAP_PATH,
        };
      } catch (error) {
        warnings.push(`Не вдалося зберегти Telegram mapping: ${toErrorMessage(error)}`);
      }
    }
  }

  return response;
}

function buildOrderOptionsFromRequest(requestUrl) {
  return {
    includeFullOrder: shouldIncludeFullOrder(requestUrl),
    generateFiles: shouldGenerateFiles(requestUrl),
    outputDir: resolveOutputDirFromQuery(requestUrl),
    sendTelegram: shouldSendTelegram(requestUrl),
    telegramChatId: resolveTelegramChatIdFromQuery(requestUrl),
    telegramMessageThreadId: resolveTelegramThreadIdFromQuery(requestUrl),
  };
}

async function runOrderThroughQueue(orderId, options, { source = "manual", metadata = {} } = {}) {
  if (!orderId) {
    throw new HttpError(400, "orderId is required.");
  }

  const queuedJob = orderQueue.enqueue(
    {
      orderId,
      source,
      dedupe: ORDER_QUEUE_DEDUPE,
      metadata,
    },
    () => processSingleOrder(orderId, options),
  );

  const startedAt = Date.now();
  const result = await queuedJob.promise;
  const durationMs = Date.now() - startedAt;

  return {
    ...result,
    queue: {
      job_id: queuedJob.jobId,
      deduplicated: queuedJob.deduplicated,
      duration_ms: durationMs,
      ...orderQueue.getStats(),
    },
  };
}

function resolveOutputDirFromQuery(requestUrl) {
  const outputDir = requestUrl.searchParams.get("outputDir");
  if (!outputDir) {
    return OUTPUT_DIR;
  }
  return path.resolve(process.cwd(), outputDir);
}

function shouldGenerateFiles(requestUrl) {
  const value = (requestUrl.searchParams.get("generate") ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function shouldSendTelegram(requestUrl) {
  const value = (requestUrl.searchParams.get("sendTelegram") ?? "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function parseBooleanQueryParam(requestUrl, name, fallback) {
  const raw = requestUrl.searchParams.get(name);
  if (raw === null || raw === undefined || raw === "") {
    return fallback;
  }

  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return fallback;
}

function hasValidTelegramSecret(req) {
  if (!TELEGRAM_REACTION_SECRET_TOKEN) {
    return true;
  }

  const headerValue = req.headers["x-telegram-bot-api-secret-token"];
  const incoming = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return String(incoming ?? "") === TELEGRAM_REACTION_SECRET_TOKEN;
}

function resolveTelegramChatIdFromQuery(requestUrl) {
  return requestUrl.searchParams.get("chatId") ?? TELEGRAM_CHAT_ID;
}

function resolveTelegramThreadIdFromQuery(requestUrl) {
  return requestUrl.searchParams.get("threadId") ?? TELEGRAM_MESSAGE_THREAD_ID;
}

function extractOrderIdFromPath(pathname) {
  const match = pathname.match(/^\/test\/order\/([^/]+)$/);
  if (!match) {
    return null;
  }
  return decodeURIComponent(match[1]);
}

function shouldIncludeFullOrder(requestUrl) {
  return requestUrl.searchParams.get("full") === "1";
}

function parseCliOptions(argv) {
  const options = {
    orderId: "",
    generateFiles: false,
    sendTelegram: false,
    includeFullOrder: true,
    outputDir: OUTPUT_DIR,
    telegramChatId: TELEGRAM_CHAT_ID,
    telegramMessageThreadId: TELEGRAM_MESSAGE_THREAD_ID,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }

    if (arg === "--generate" || arg === "-g") {
      options.generateFiles = true;
      continue;
    }

    if (arg === "--send-telegram" || arg === "--telegram") {
      options.sendTelegram = true;
      continue;
    }

    if (arg === "--chat-id") {
      const nextArg = argv[index + 1];
      if (nextArg && nextArg !== "--") {
        options.telegramChatId = nextArg;
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--chat-id=")) {
      options.telegramChatId = arg.slice("--chat-id=".length);
      continue;
    }

    if (arg === "--thread-id") {
      const nextArg = argv[index + 1];
      if (nextArg && nextArg !== "--") {
        options.telegramMessageThreadId = nextArg;
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--thread-id=")) {
      options.telegramMessageThreadId = arg.slice("--thread-id=".length);
      continue;
    }

    if (arg === "--full") {
      options.includeFullOrder = true;
      continue;
    }

    if (arg === "--no-full") {
      options.includeFullOrder = false;
      continue;
    }

    if (arg === "--output-dir") {
      const nextArg = argv[index + 1];
      if (nextArg && nextArg !== "--") {
        options.outputDir = path.resolve(process.cwd(), nextArg);
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--output-dir=")) {
      options.outputDir = path.resolve(process.cwd(), arg.slice("--output-dir=".length));
      continue;
    }

    if (arg === "--order-id") {
      const nextArg = argv[index + 1];
      if (nextArg && nextArg !== "--") {
        options.orderId = nextArg;
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--order-id=")) {
      options.orderId = arg.slice("--order-id=".length);
      continue;
    }

    if (!arg.startsWith("-") && !options.orderId) {
      options.orderId = arg;
    }
  }

  return options;
}

async function processWebhookPayload(
  payload,
  {
    processOrders = WEBHOOK_PROCESS_ORDERS,
    generateFiles = WEBHOOK_GENERATE_FILES,
    sendTelegram = WEBHOOK_SEND_TELEGRAM,
    waitForCompletion = WEBHOOK_WAIT_FOR_COMPLETION,
    outputDir = OUTPUT_DIR,
    telegramChatId = TELEGRAM_CHAT_ID,
    telegramMessageThreadId = TELEGRAM_MESSAGE_THREAD_ID,
  } = {},
) {
  const events = extractWebhookEvents(payload);
  const processed = [];
  const skipped = [];
  const errors = [];

  for (const eventPayload of events) {
    if (eventPayload.event !== EVENT_ORDER_STATUS_CHANGED) {
      skipped.push({
        reason: `Unsupported event: ${eventPayload.event}`,
      });
      continue;
    }

    const orderId = eventPayload.context?.id;
    if (!orderId) {
      skipped.push({
        reason: "Webhook event has no context.id",
      });
      continue;
    }

    try {
      if (!processOrders) {
        const order = await fetchOrderById(orderId);
        processed.push({
          orderId,
          mode: "summary",
          order: summarizeOrder(order),
        });
        continue;
      }

      const queuedJob = orderQueue.enqueue(
        {
          orderId,
          source: "webhook",
          dedupe: ORDER_QUEUE_DEDUPE,
          metadata: {
            event: eventPayload.event,
            status_id: eventPayload?.context?.status_id ?? null,
            source_uuid: eventPayload?.context?.source_uuid ?? null,
          },
        },
        () =>
          processSingleOrder(orderId, {
            includeFullOrder: false,
            generateFiles,
            sendTelegram,
            outputDir,
            telegramChatId,
            telegramMessageThreadId,
          }),
      );

      if (waitForCompletion) {
        const result = await queuedJob.promise;
        processed.push({
          orderId,
          mode: "processed",
          job_id: queuedJob.jobId,
          deduplicated: queuedJob.deduplicated,
          summary: result.summary,
          warnings: result.warnings ?? [],
        });
      } else {
        queuedJob.promise.catch((error) => {
          log("error", "webhook_job_failed_async", {
            order_id: String(orderId),
            job_id: queuedJob.jobId,
            error: toErrorMessage(error),
          });
        });

        processed.push({
          orderId,
          mode: "queued",
          job_id: queuedJob.jobId,
          deduplicated: queuedJob.deduplicated,
        });
      }
    } catch (error) {
      errors.push({
        orderId,
        message: toErrorMessage(error),
      });
    }
  }

  return {
    received_events: events.length,
    processing_mode: processOrders ? (waitForCompletion ? "sync" : "async") : "summary",
    processed,
    skipped,
    errors,
    queue: orderQueue.getStats(),
  };
}

function createServer() {
  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && requestUrl.pathname === "/test/reaction-map") {
      try {
        const orderId = requestUrl.searchParams.get("orderId");
        const chatId = requestUrl.searchParams.get("chatId");
        const messageId = requestUrl.searchParams.get("messageId");

        if (orderId) {
          const entries = await telegramMessageStore.listByOrder(orderId, { limit: 200 });
          sendJson(res, 200, {
            ok: true,
            mode: "reaction_map_order",
            order_id: orderId,
            count: entries.length,
            entries,
            storage_path: TELEGRAM_MESSAGE_MAP_PATH,
          });
          return;
        }

        if (chatId && messageId) {
          const entry = await telegramMessageStore.getMessage(chatId, messageId);
          sendJson(res, 200, {
            ok: true,
            mode: "reaction_map_message",
            chat_id: chatId,
            message_id: Number.parseInt(String(messageId), 10),
            entry,
            storage_path: TELEGRAM_MESSAGE_MAP_PATH,
          });
          return;
        }

        throw new HttpError(400, "Provide orderId OR chatId+messageId.");
      } catch (error) {
        const statusCode = error instanceof HttpError ? error.statusCode : 500;
        sendJson(res, statusCode, {
          ok: false,
          message: toErrorMessage(error),
        });
        return;
      }
    }

    if (req.method === "GET" && requestUrl.pathname === "/test/reaction/simulate") {
      try {
        const orderId = requestUrl.searchParams.get("orderId");
        const chatId = requestUrl.searchParams.get("chatId");
        const messageId = requestUrl.searchParams.get("messageId");
        const heartCount = Number.parseInt(
          String(requestUrl.searchParams.get("count") ?? TELEGRAM_REACTION_HEART_THRESHOLD),
          10,
        );

        let mappedChatId = chatId;
        let mappedMessageId = messageId;

        if (orderId && (!chatId || !messageId)) {
          const entries = await telegramMessageStore.listByOrder(orderId, { limit: 1 });
          if (entries.length === 0) {
            throw new HttpError(404, `No Telegram message mapping found for order ${orderId}.`);
          }
          mappedChatId = String(entries[0].chat_id);
          mappedMessageId = String(entries[0].message_id);
        }

        if (!mappedChatId || !mappedMessageId) {
          throw new HttpError(400, "Provide orderId OR chatId+messageId.");
        }

        const result = await handleReactionCountForMessage({
          chatId: mappedChatId,
          messageId: mappedMessageId,
          heartCount,
          source: "test_simulation",
          updateId: `simulate-${Date.now()}`,
        });

        sendJson(res, 200, {
          ok: true,
          mode: "reaction_simulation",
          chat_id: mappedChatId,
          message_id: Number.parseInt(String(mappedMessageId), 10),
          heart_count: heartCount,
          threshold: TELEGRAM_REACTION_HEART_THRESHOLD,
          result,
        });
        return;
      } catch (error) {
        const statusCode = error instanceof HttpError ? error.statusCode : 500;
        sendJson(res, statusCode, {
          ok: false,
          message: toErrorMessage(error),
        });
        return;
      }
    }

    if (req.method === "GET" && requestUrl.pathname === "/test/reaction/reset") {
      try {
        const orderId = requestUrl.searchParams.get("orderId");
        const chatId = requestUrl.searchParams.get("chatId");
        const messageId = requestUrl.searchParams.get("messageId");

        if (!orderId && !(chatId && messageId)) {
          throw new HttpError(400, "Provide orderId OR chatId+messageId.");
        }

        const result = await telegramMessageStore.resetReactionState({
          orderId,
          chatId,
          messageId,
        });

        sendJson(res, 200, {
          ok: true,
          mode: "reaction_reset",
          order_id: orderId ?? null,
          chat_id: chatId ?? null,
          message_id: messageId ? Number.parseInt(String(messageId), 10) : null,
          updated: result.updated,
        });
        return;
      } catch (error) {
        const statusCode = error instanceof HttpError ? error.statusCode : 500;
        sendJson(res, statusCode, {
          ok: false,
          message: toErrorMessage(error),
        });
        return;
      }
    }

    if (req.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        mode: "server",
        test_order_id: TEST_ORDER_ID || null,
        output_dir: OUTPUT_DIR,
        font_path: FONT_PATH,
        emoji_font_path: EMOJI_FONT_PATH || null,
        emoji_render_mode: EMOJI_RENDER_MODE,
        apple_emoji_base_url: APPLE_EMOJI_BASE_URL || null,
        apple_emoji_assets_dir: APPLE_EMOJI_ASSETS_DIR || null,
        pdf_color_space: PDF_COLOR_SPACE,
        replace_white_with_offwhite: REPLACE_WHITE_WITH_OFFWHITE,
        offwhite_hex: OFFWHITE_HEX,
        white_replace_mode: WHITE_REPLACE_MODE,
        white_threshold: WHITE_THRESHOLD,
        white_max_saturation: WHITE_MAX_SATURATION,
        white_lab_delta_e_max: WHITE_LAB_DELTA_E_MAX,
        white_lab_softness: WHITE_LAB_SOFTNESS,
        white_min_lightness: WHITE_MIN_LIGHTNESS,
        white_feather_px: WHITE_FEATHER_PX,
        white_min_alpha: WHITE_MIN_ALPHA,
        white_cleanup_passes: WHITE_CLEANUP_PASSES,
        white_cleanup_min_channel: WHITE_CLEANUP_MIN_CHANNEL,
        white_cleanup_max_saturation: WHITE_CLEANUP_MAX_SATURATION,
        white_hard_cleanup_passes: WHITE_HARD_CLEANUP_PASSES,
        white_hard_min_channel: WHITE_HARD_MIN_CHANNEL,
        white_hard_min_lightness: WHITE_HARD_MIN_LIGHTNESS,
        white_hard_delta_e_max: WHITE_HARD_DELTA_E_MAX,
        white_hard_max_saturation: WHITE_HARD_MAX_SATURATION,
        white_zero_transparent_rgb: WHITE_ZERO_TRANSPARENT_RGB,
        white_replace_iterations: WHITE_REPLACE_ITERATIONS,
        white_allow_soft_mask_fallback: WHITE_ALLOW_SOFT_MASK_FALLBACK,
        white_final_enforce: WHITE_FINAL_ENFORCE,
        white_final_iterations: WHITE_FINAL_ITERATIONS,
        white_final_threshold: WHITE_FINAL_THRESHOLD,
        white_final_max_saturation: WHITE_FINAL_MAX_SATURATION,
        white_final_dpi: WHITE_FINAL_DPI,
        rasterize_dpi: RASTERIZE_DPI,
        qr_placement_configured: QR_PLACEMENT_CONFIGURED,
        url_shortener_provider: URL_SHORTENER_PROVIDER,
        url_shortener_timeout_ms: URL_SHORTENER_TIMEOUT_MS,
        url_shortener_retries: URL_SHORTENER_RETRIES,
        url_shortener_retry_base_ms: URL_SHORTENER_RETRY_BASE_MS,
        url_shortener_required: URL_SHORTENER_REQUIRED,
        cuttly_api_key_configured: Boolean(CUTTLY_API_KEY),
        telegram_enabled: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
        keycrm_request_timeout_ms: KEYCRM_REQUEST_TIMEOUT_MS,
        keycrm_request_retries: KEYCRM_REQUEST_RETRIES,
        telegram_request_timeout_ms: TELEGRAM_REQUEST_TIMEOUT_MS,
        telegram_request_retries: TELEGRAM_REQUEST_RETRIES,
        order_queue: orderQueue.getStats(),
        order_queue_dedupe: ORDER_QUEUE_DEDUPE,
        webhook_process_orders: WEBHOOK_PROCESS_ORDERS,
        webhook_generate_files: WEBHOOK_GENERATE_FILES,
        webhook_send_telegram: WEBHOOK_SEND_TELEGRAM,
        webhook_wait_for_completion: WEBHOOK_WAIT_FOR_COMPLETION,
        telegram_message_map_path: TELEGRAM_MESSAGE_MAP_PATH,
        telegram_message_map_max_entries: TELEGRAM_MESSAGE_MAP_MAX_ENTRIES,
        telegram_reaction_enabled: TELEGRAM_REACTION_ENABLED,
        telegram_reaction_secret_set: Boolean(TELEGRAM_REACTION_SECRET_TOKEN),
        telegram_reaction_target_status_id: TELEGRAM_REACTION_TARGET_STATUS_ID || null,
        telegram_reaction_heart_threshold: TELEGRAM_REACTION_HEART_THRESHOLD,
        telegram_reaction_heart_emojis: TELEGRAM_REACTION_HEART_EMOJIS,
      });
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === "/test/order") {
      const orderId = requestUrl.searchParams.get("orderId") ?? TEST_ORDER_ID;
      try {
        const options = buildOrderOptionsFromRequest(requestUrl);
        const result = await runOrderThroughQueue(orderId, options, {
          source: "manual",
          metadata: {
            route: "/test/order",
          },
        });
        sendJson(res, 200, {
          ok: true,
          mode: "manual",
          ...result,
        });
        return;
      } catch (error) {
        const statusCode = error instanceof HttpError ? error.statusCode : error?.statusCode ?? 500;
        sendJson(res, statusCode, {
          ok: false,
          mode: "manual",
          message: toErrorMessage(error),
        });
        return;
      }
    }

    if (req.method === "GET") {
      const orderIdFromPath = extractOrderIdFromPath(requestUrl.pathname);
      if (orderIdFromPath) {
        try {
          const options = buildOrderOptionsFromRequest(requestUrl);
          const result = await runOrderThroughQueue(orderIdFromPath, options, {
            source: "manual",
            metadata: {
              route: "/test/order/:id",
            },
          });
          sendJson(res, 200, {
            ok: true,
            mode: "manual",
            ...result,
          });
          return;
        } catch (error) {
          const statusCode = error instanceof HttpError ? error.statusCode : error?.statusCode ?? 500;
          sendJson(res, statusCode, {
            ok: false,
            mode: "manual",
            message: toErrorMessage(error),
          });
          return;
        }
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/webhook/keycrm") {
      try {
        const rawBody = await readRequestBody(req);
        if (!rawBody.trim()) {
          throw new HttpError(400, "Request body is empty.");
        }

        const payload = parseJson(rawBody);
        const result = await processWebhookPayload(payload, {
          processOrders: parseBooleanQueryParam(requestUrl, "processOrders", WEBHOOK_PROCESS_ORDERS),
          generateFiles: parseBooleanQueryParam(requestUrl, "generate", WEBHOOK_GENERATE_FILES),
          sendTelegram: parseBooleanQueryParam(requestUrl, "sendTelegram", WEBHOOK_SEND_TELEGRAM),
          waitForCompletion: parseBooleanQueryParam(
            requestUrl,
            "wait",
            WEBHOOK_WAIT_FOR_COMPLETION,
          ),
          outputDir: resolveOutputDirFromQuery(requestUrl),
          telegramChatId: resolveTelegramChatIdFromQuery(requestUrl),
          telegramMessageThreadId: resolveTelegramThreadIdFromQuery(requestUrl),
        });
        const hasErrors = result.errors.length > 0;

        const successStatus = result.processing_mode === "async" ? 202 : 200;
        sendJson(res, hasErrors ? 207 : successStatus, {
          ok: !hasErrors,
          ...result,
        });
        return;
      } catch (error) {
        const statusCode = error instanceof HttpError ? error.statusCode : error?.statusCode ?? 500;
        sendJson(res, statusCode, {
          ok: false,
          message: toErrorMessage(error),
        });
        return;
      }
    }

    if (req.method === "POST" && requestUrl.pathname === "/webhook/telegram") {
      try {
        if (!hasValidTelegramSecret(req)) {
          throw new HttpError(401, "Invalid Telegram secret token.");
        }

        const rawBody = await readRequestBody(req);
        if (!rawBody.trim()) {
          throw new HttpError(400, "Request body is empty.");
        }

        const payload = parseJson(rawBody);
        const result = await processTelegramReactionPayload(payload);
        const hasErrors = result.errors.length > 0;

        log("info", "telegram_webhook_processed", {
          received_updates: result.received_updates,
          processed: result.processed.length,
          skipped: result.skipped.length,
          errors: result.errors.length,
        });

        sendJson(res, hasErrors ? 207 : 200, {
          ok: !hasErrors,
          ...result,
        });
        return;
      } catch (error) {
        const statusCode = error instanceof HttpError ? error.statusCode : 500;
        sendJson(res, statusCode, {
          ok: false,
          message: toErrorMessage(error),
        });
        return;
      }
    }

    sendJson(res, 404, {
      ok: false,
      message: "Not found.",
    });
  });
}

async function runCliMode(cliOptions) {
  const result = await runOrderThroughQueue(
    cliOptions.orderId,
    {
      includeFullOrder: cliOptions.includeFullOrder,
      generateFiles: cliOptions.generateFiles,
      sendTelegram: cliOptions.sendTelegram,
      outputDir: cliOptions.outputDir,
      telegramChatId: cliOptions.telegramChatId,
      telegramMessageThreadId: cliOptions.telegramMessageThreadId,
    },
    {
      source: "cli",
    },
  );
  process.stdout.write(`${JSON.stringify({ ok: true, mode: "cli", ...result }, null, 2)}\n`);
}

async function main() {
  await telegramMessageStore.init();

  const cliOptions = parseCliOptions(process.argv.slice(2));
  if (cliOptions.orderId) {
    await runCliMode(cliOptions);
    return;
  }

  const server = createServer();
  server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
    console.log(`Webhook endpoint: POST /webhook/keycrm`);
    console.log(`Webhook endpoint: POST /webhook/telegram`);
    console.log(`Manual test endpoint: GET /test/order?orderId=28658`);
    console.log(`Manual test endpoint (path): GET /test/order/28658`);
    console.log(`Reaction map endpoint: GET /test/reaction-map?orderId=28658`);
    console.log(`Reaction simulation: GET /test/reaction/simulate?orderId=28658&count=2`);
    console.log(`Reaction reset: GET /test/reaction/reset?orderId=28658`);
    console.log(`Generate files: add query 'generate=1' to /test/order`);
    console.log(`Send to Telegram: add query 'sendTelegram=1' to /test/order`);
    if (TEST_ORDER_ID) {
      console.log(`Default TEST_ORDER_ID: ${TEST_ORDER_ID}`);
    }
    console.log(`Output dir: ${OUTPUT_DIR}`);
    console.log(`Font path: ${FONT_PATH}`);
    console.log(`Emoji font path: ${EMOJI_FONT_PATH || "(not set)"}`);
    console.log(`Emoji render mode: ${EMOJI_RENDER_MODE}`);
    console.log(`Apple emoji base URL: ${APPLE_EMOJI_BASE_URL || "(not set)"}`);
    console.log(`Apple emoji assets dir: ${APPLE_EMOJI_ASSETS_DIR || "(not set)"}`);
    console.log(`PDF color space: ${PDF_COLOR_SPACE}`);
    console.log(
      `White replacement: ${REPLACE_WHITE_WITH_OFFWHITE} mode=${WHITE_REPLACE_MODE} (#${OFFWHITE_HEX}, threshold=${WHITE_THRESHOLD}, maxSaturation=${WHITE_MAX_SATURATION}, deltaE=${WHITE_LAB_DELTA_E_MAX}, softness=${WHITE_LAB_SOFTNESS}, minL=${WHITE_MIN_LIGHTNESS}, featherPx=${WHITE_FEATHER_PX}, minAlpha=${WHITE_MIN_ALPHA}, cleanupPasses=${WHITE_CLEANUP_PASSES}, cleanupMinChannel=${WHITE_CLEANUP_MIN_CHANNEL}, cleanupMaxSat=${WHITE_CLEANUP_MAX_SATURATION}, hardPasses=${WHITE_HARD_CLEANUP_PASSES}, hardMinChannel=${WHITE_HARD_MIN_CHANNEL}, hardMinL=${WHITE_HARD_MIN_LIGHTNESS}, hardDeltaE=${WHITE_HARD_DELTA_E_MAX}, hardMaxSat=${WHITE_HARD_MAX_SATURATION}, zeroTransparentRgb=${WHITE_ZERO_TRANSPARENT_RGB}, iterations=${WHITE_REPLACE_ITERATIONS}, allowSoftMaskFallback=${WHITE_ALLOW_SOFT_MASK_FALLBACK}, finalEnforce=${WHITE_FINAL_ENFORCE}, finalIterations=${WHITE_FINAL_ITERATIONS}, finalThreshold=${WHITE_FINAL_THRESHOLD}, finalMaxSat=${WHITE_FINAL_MAX_SATURATION}, finalDpi=${WHITE_FINAL_DPI}, dpi=${RASTERIZE_DPI})`,
    );
    console.log(`QR placement configured (A5/A4): ${QR_PLACEMENT_CONFIGURED.A5}/${QR_PLACEMENT_CONFIGURED.A4}`);
    console.log(
      `URL shortener: ${URL_SHORTENER_PROVIDER} timeout=${URL_SHORTENER_TIMEOUT_MS}ms retries=${URL_SHORTENER_RETRIES} baseDelay=${URL_SHORTENER_RETRY_BASE_MS}ms (required=${URL_SHORTENER_REQUIRED})`,
    );
    console.log(
      `KeyCRM request: timeout=${KEYCRM_REQUEST_TIMEOUT_MS}ms retries=${KEYCRM_REQUEST_RETRIES} baseDelay=${KEYCRM_REQUEST_RETRY_BASE_MS}ms`,
    );
    console.log(
      `Telegram request: timeout=${TELEGRAM_REQUEST_TIMEOUT_MS}ms retries=${TELEGRAM_REQUEST_RETRIES} baseDelay=${TELEGRAM_RETRY_BASE_MS}ms`,
    );
    console.log(
      `Order queue: concurrency=${ORDER_QUEUE_CONCURRENCY} maxSize=${ORDER_QUEUE_MAX_SIZE} jobTimeout=${ORDER_JOB_TIMEOUT_MS}ms dedupe=${ORDER_QUEUE_DEDUPE}`,
    );
    console.log(
      `Webhook mode: processOrders=${WEBHOOK_PROCESS_ORDERS} generate=${WEBHOOK_GENERATE_FILES} sendTelegram=${WEBHOOK_SEND_TELEGRAM} wait=${WEBHOOK_WAIT_FOR_COMPLETION}`,
    );
    console.log(
      `Reaction mode: enabled=${TELEGRAM_REACTION_ENABLED} statusId=${TELEGRAM_REACTION_TARGET_STATUS_ID || "(not set)"} threshold=${TELEGRAM_REACTION_HEART_THRESHOLD} emojis=${TELEGRAM_REACTION_HEART_EMOJIS.join(",")} secret=${Boolean(TELEGRAM_REACTION_SECRET_TOKEN)}`,
    );
    console.log(`Telegram mapping store: ${TELEGRAM_MESSAGE_MAP_PATH}`);
    console.log(`Cuttly key configured: ${Boolean(CUTTLY_API_KEY)}`);
    console.log(`Telegram chat configured: ${Boolean(TELEGRAM_CHAT_ID)}`);
  });
}

main().catch((error) => {
  process.stderr.write(`${toErrorMessage(error)}\n`);
  process.exit(1);
});
