"use strict";

const fsp = require("node:fs/promises");

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_MEDIA_GROUP_SIZE = 10;
const MAX_CAPTION_LENGTH = 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 900;

function ensureValue(value, name) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${name} is not configured.`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeRequestOptions(requestOptions = {}) {
  const timeoutMs = Number.parseInt(String(requestOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS), 10);
  const retries = Number.parseInt(String(requestOptions.retries ?? DEFAULT_RETRIES), 10);
  const retryBaseMs = Number.parseInt(
    String(requestOptions.retryBaseMs ?? DEFAULT_RETRY_BASE_MS),
    10,
  );

  return {
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1_000, timeoutMs) : DEFAULT_TIMEOUT_MS,
    retries: Number.isFinite(retries) ? Math.max(0, Math.min(6, retries)) : DEFAULT_RETRIES,
    retryBaseMs: Number.isFinite(retryBaseMs)
      ? Math.max(100, Math.min(20_000, retryBaseMs))
      : DEFAULT_RETRY_BASE_MS,
  };
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

function parseRetryAfterMs(value) {
  if (value === undefined || value === null || value === "") {
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

function parseTelegramRetryAfterMs(payload, response) {
  const payloadRetryAfter = payload?.parameters?.retry_after;
  const headerRetryAfter = response?.headers?.get?.("retry-after");
  return parseRetryAfterMs(payloadRetryAfter) ?? parseRetryAfterMs(headerRetryAfter);
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

async function readTelegramPayload(response) {
  const responseText = await response.text();
  let responsePayload = responseText;
  try {
    responsePayload = responseText ? JSON.parse(responseText) : null;
  } catch (_error) {
    // Keep raw text as fallback payload.
  }

  return {
    responseText,
    responsePayload,
  };
}

function ensureRuntimeApis() {
  if (typeof fetch !== "function" || typeof FormData !== "function" || typeof Blob !== "function") {
    throw new Error("Global fetch/FormData/Blob are unavailable. Use Node.js 18+.");
  }
}

function buildCaption({ orderId, fileNames, flags, warnings, qrUrl }) {
  const lines = [`Замовлення ${orderId}`, "", "Файли:"];
  for (const fileName of fileNames) {
    lines.push(fileName);
  }

  if (qrUrl) {
    lines.push("", `Посилання QR: ${qrUrl}`);
  }

  if (Array.isArray(flags) && flags.length) {
    lines.push("", ...flags);
  }

  if (Array.isArray(warnings) && warnings.length) {
    lines.push("", "Примітки:", ...warnings);
  }

  const caption = lines.join("\n");
  if (caption.length <= MAX_CAPTION_LENGTH) {
    return caption;
  }

  return `${caption.slice(0, MAX_CAPTION_LENGTH - 3)}...`;
}

function chunkArray(items, chunkSize) {
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

async function sendTelegramRequest({
  botToken,
  methodName,
  buildForm,
  requestOptions,
}) {
  ensureRuntimeApis();
  ensureValue(botToken, "TELEGRAM_BOT_TOKEN");

  const normalizedOptions = normalizeRequestOptions(requestOptions);
  const maxAttempts = normalizedOptions.retries + 1;
  const endpoint = `${TELEGRAM_API_BASE}/bot${botToken}/${methodName}`;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const form = await buildForm();
      const response = await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          body: form,
        },
        normalizedOptions.timeoutMs,
      );

      const { responsePayload } = await readTelegramPayload(response);
      if (response.ok && responsePayload?.ok) {
        return responsePayload.result ?? null;
      }

      const reason =
        typeof responsePayload === "string"
          ? responsePayload
          : JSON.stringify(responsePayload);
      const retryAfterMs = parseTelegramRetryAfterMs(responsePayload, response);
      const retryable = isRetryableStatusCode(response.status) || Number.isFinite(retryAfterMs);
      if (retryable && attempt < maxAttempts) {
        const delayMs =
          retryAfterMs ?? computeBackoffDelayMs(attempt, normalizedOptions.retryBaseMs);
        await sleep(delayMs);
        continue;
      }

      throw new Error(`Telegram ${methodName} failed (${response.status}): ${reason}`);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableFetchError(error)) {
        throw error;
      }
      const delayMs = computeBackoffDelayMs(attempt, normalizedOptions.retryBaseMs);
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error(`Telegram ${methodName} request failed.`);
}

async function downloadPhotoForUpload(photoUrl, requestOptions) {
  const normalizedOptions = normalizeRequestOptions(requestOptions);
  const maxAttempts = normalizedOptions.retries + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(photoUrl, { method: "GET" }, normalizedOptions.timeoutMs);
      if (!response.ok) {
        if (attempt < maxAttempts && isRetryableStatusCode(response.status)) {
          const delayMs = computeBackoffDelayMs(attempt, normalizedOptions.retryBaseMs);
          await sleep(delayMs);
          continue;
        }
        throw new Error(`Preview image download failed (${response.status})`);
      }

      const contentType = response.headers.get("content-type") || "image/jpeg";
      const bytes = Buffer.from(await response.arrayBuffer());
      return {
        bytes,
        contentType,
      };
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableFetchError(error)) {
        throw error;
      }
      const delayMs = computeBackoffDelayMs(attempt, normalizedOptions.retryBaseMs);
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("Preview image download failed.");
}

async function sendMediaGroup({
  botToken,
  chatId,
  messageThreadId,
  files,
  caption,
  requestOptions,
}) {
  ensureValue(chatId, "TELEGRAM_CHAT_ID");

  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("No files to send to Telegram.");
  }

  if (files.length > MAX_MEDIA_GROUP_SIZE) {
    throw new Error(`Telegram media group supports up to ${MAX_MEDIA_GROUP_SIZE} files.`);
  }

  const fileBuffers = await Promise.all(files.map((file) => fsp.readFile(file.path)));

  const result = await sendTelegramRequest({
    botToken,
    methodName: "sendMediaGroup",
    requestOptions,
    buildForm: async () => {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (messageThreadId) {
        form.append("message_thread_id", String(messageThreadId));
      }

      const media = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const attachName = `file${index + 1}`;
        const blob = new Blob([fileBuffers[index]], { type: "application/pdf" });

        form.append(attachName, blob, file.filename);
        media.push({
          type: "document",
          media: `attach://${attachName}`,
          caption: index === 0 ? caption : undefined,
        });
      }

      form.append("media", JSON.stringify(media));
      return form;
    },
  });

  return Array.isArray(result) ? result : [];
}

async function sendSingleDocument({
  botToken,
  chatId,
  messageThreadId,
  file,
  caption,
  requestOptions,
}) {
  ensureValue(chatId, "TELEGRAM_CHAT_ID");

  const buffer = await fsp.readFile(file.path);
  const result = await sendTelegramRequest({
    botToken,
    methodName: "sendDocument",
    requestOptions,
    buildForm: async () => {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (messageThreadId) {
        form.append("message_thread_id", String(messageThreadId));
      }
      form.append("caption", caption);
      form.append("document", new Blob([buffer], { type: "application/pdf" }), file.filename);
      return form;
    },
  });

  return result ? [result] : [];
}

async function sendPhotoByUrl({
  botToken,
  chatId,
  messageThreadId,
  photoUrl,
  caption,
  requestOptions,
}) {
  ensureValue(chatId, "TELEGRAM_CHAT_ID");
  ensureValue(photoUrl, "preview image URL");

  return sendTelegramRequest({
    botToken,
    methodName: "sendPhoto",
    requestOptions,
    buildForm: async () => {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (messageThreadId) {
        form.append("message_thread_id", String(messageThreadId));
      }
      if (caption) {
        form.append("caption", caption);
      }
      form.append("photo", photoUrl);
      return form;
    },
  });
}

async function sendPhotoByUpload({
  botToken,
  chatId,
  messageThreadId,
  photoUrl,
  caption,
  requestOptions,
}) {
  ensureValue(chatId, "TELEGRAM_CHAT_ID");
  ensureValue(photoUrl, "preview image URL");

  const source = await downloadPhotoForUpload(photoUrl, requestOptions);
  const extension =
    source.contentType.includes("png")
      ? "png"
      : source.contentType.includes("webp")
        ? "webp"
        : "jpg";

  return sendTelegramRequest({
    botToken,
    methodName: "sendPhoto",
    requestOptions,
    buildForm: async () => {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      if (messageThreadId) {
        form.append("message_thread_id", String(messageThreadId));
      }
      if (caption) {
        form.append("caption", caption);
      }
      form.append(
        "photo",
        new Blob([source.bytes], { type: source.contentType }),
        `preview.${extension}`,
      );
      return form;
    },
  });
}

async function sendSinglePreviewPhoto({
  botToken,
  chatId,
  messageThreadId,
  photoUrl,
  caption,
  requestOptions,
}) {
  try {
    return await sendPhotoByUrl({
      botToken,
      chatId,
      messageThreadId,
      photoUrl,
      caption,
      requestOptions,
    });
  } catch (_urlError) {
    return sendPhotoByUpload({
      botToken,
      chatId,
      messageThreadId,
      photoUrl,
      caption,
      requestOptions,
    });
  }
}

async function sendPreviewPhotos({
  botToken,
  chatId,
  messageThreadId,
  orderId,
  previewImages,
  requestOptions,
}) {
  const urls = Array.isArray(previewImages) ? previewImages.filter(Boolean) : [];
  if (urls.length === 0) {
    return [];
  }

  const messages = [];
  for (let index = 0; index < urls.length; index += 1) {
    const caption = index === 0 ? `Замовлення ${orderId}\nПрев'ю макету` : undefined;
    const message = await sendSinglePreviewPhoto({
      botToken,
      chatId,
      messageThreadId,
      photoUrl: urls[index],
      caption,
      requestOptions,
    });
    if (message) {
      messages.push(message);
    }
  }

  return messages;
}

async function sendGeneratedFiles({
  botToken,
  chatId,
  messageThreadId,
  orderId,
  generatedFiles,
  caption,
  requestOptions,
}) {
  if (!Array.isArray(generatedFiles) || generatedFiles.length === 0) {
    return [];
  }

  if (generatedFiles.length === 1) {
    return sendSingleDocument({
      botToken,
      chatId,
      messageThreadId,
      file: generatedFiles[0],
      caption,
      requestOptions,
    });
  }

  const chunks = chunkArray(generatedFiles, MAX_MEDIA_GROUP_SIZE);
  const messages = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk.length === 1) {
      const singleMessages = await sendSingleDocument({
        botToken,
        chatId,
        messageThreadId,
        file: chunk[0],
        caption: index === 0 ? caption : `Замовлення ${orderId} (продовження)`,
        requestOptions,
      });
      messages.push(...singleMessages);
      continue;
    }

    const groupMessages = await sendMediaGroup({
      botToken,
      chatId,
      messageThreadId,
      files: chunk,
      caption: index === 0 ? caption : `Замовлення ${orderId} (продовження)`,
      requestOptions,
    });
    messages.push(...groupMessages);
  }

  return messages;
}

async function sendOrderFilesToTelegram({
  botToken,
  chatId,
  messageThreadId,
  orderId,
  flags,
  warnings,
  qrUrl,
  previewImages,
  generatedFiles,
  requestOptions = {},
}) {
  ensureValue(botToken, "TELEGRAM_BOT_TOKEN");
  ensureValue(chatId, "TELEGRAM_CHAT_ID");

  const fileNames = generatedFiles.map((file) => file.filename);
  const caption = buildCaption({
    orderId,
    fileNames,
    flags,
    warnings,
    qrUrl,
  });

  const previewMessages = await sendPreviewPhotos({
    botToken,
    chatId,
    messageThreadId,
    orderId,
    previewImages,
    requestOptions,
  });

  const sentMessages = await sendGeneratedFiles({
    botToken,
    chatId,
    messageThreadId,
    orderId,
    generatedFiles,
    caption,
    requestOptions,
  });

  const allMessages = [...previewMessages, ...sentMessages];

  return {
    chat_id: chatId,
    message_thread_id: messageThreadId || null,
    preview_count: previewMessages.length,
    preview_message_ids: previewMessages.map((message) => message.message_id),
    message_count: allMessages.length,
    message_ids: allMessages.map((message) => message.message_id),
    caption,
  };
}

module.exports = {
  sendOrderFilesToTelegram,
};
