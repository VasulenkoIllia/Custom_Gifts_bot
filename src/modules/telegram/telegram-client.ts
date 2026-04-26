import fsp from "node:fs/promises";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const MAX_MEDIA_GROUP_SIZE = 10;
const MAX_CAPTION_LENGTH = 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 900;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RequestOptions = {
  timeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
};

type NormalizedRequestOptions = {
  timeoutMs: number;
  retries: number;
  retryBaseMs: number;
};

type TelegramFile = {
  path: string;
  filename: string;
};

type TelegramMessage = {
  message_id: number;
  [key: string]: unknown;
};

type TelegramRawPayload = {
  ok?: boolean;
  result?: unknown;
  parameters?: { retry_after?: number | string };
  [key: string]: unknown;
};

type BuildCaptionParams = {
  orderId: string;
  fileNames: string[];
  flags: string[];
  warnings: string[];
  qrUrl: string | null;
  pipelineMetrics?: PipelineCaptionMetrics | null;
};

export type PipelineCaptionMetrics = {
  rasterizeDpi: number;
  finalWhiteStrictPixels: number;
  finalWhiteAggressivePixels: number;
  finalWhiteCorrectedPixels?: number | null;
  orderProcessingDurationMs?: number | null;
};

export type PreviewCaptionDetails = {
  engravingTexts: string[];
  stickerTexts: string[];
  quantityLines?: string[];
};

export type SendOrderFilesInput = {
  botToken: string;
  chatId: string;
  messageThreadId?: string;
  orderId: string;
  flags: string[];
  warnings: string[];
  qrUrl: string | null;
  previewImages: string[];
  previewDetails?: PreviewCaptionDetails | null;
  pipelineMetrics?: PipelineCaptionMetrics | null;
  generatedFiles: TelegramFile[];
  requestOptions?: RequestOptions;
};

export type SendOrderFilesResult = {
  chat_id: string;
  message_thread_id: string | null;
  preview_count: number;
  preview_message_ids: number[];
  preview_errors: string[];
  message_count: number;
  message_ids: number[];
  caption: string;
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function ensureValue(value: unknown, name: string): void {
  if (value === undefined || value === null || value === "") {
    throw new Error(`${name} is not configured.`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeRequestOptions(requestOptions: RequestOptions = {}): NormalizedRequestOptions {
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

function computeBackoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs = 20_000): number {
  const safeAttempt = Math.max(1, attempt);
  const cappedExp = Math.min(8, safeAttempt - 1);
  const exponential = baseDelayMs * 2 ** cappedExp;
  const jitter = Math.floor(Math.random() * Math.min(1_000, baseDelayMs));
  return Math.min(maxDelayMs, exponential + jitter);
}

function isRetryableStatusCode(statusCode: number): boolean {
  return (
    statusCode === 408 ||
    statusCode === 409 ||
    statusCode === 425 ||
    statusCode === 429 ||
    statusCode >= 500
  );
}

function isRetryableFetchError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  if ((error as { name?: unknown }).name === "AbortError") {
    return true;
  }

  const message = String((error as { message?: unknown }).message ?? "");
  return /fetch failed|network|timeout|socket|econnreset|etimedout|enotfound|eai_again/i.test(
    message,
  );
}

function parseRetryAfterMs(value: unknown): number | null {
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

function parseTelegramRetryAfterMs(
  payload: TelegramRawPayload | string | null,
  response: Response,
): number | null {
  const payloadRetryAfter =
    typeof payload === "object" && payload !== null
      ? payload.parameters?.retry_after
      : undefined;
  const headerRetryAfter = response.headers.get("retry-after");
  return parseRetryAfterMs(payloadRetryAfter) ?? parseRetryAfterMs(headerRetryAfter);
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
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

async function readTelegramPayload(response: Response): Promise<{
  responseText: string;
  responsePayload: TelegramRawPayload | string | null;
}> {
  const responseText = await response.text();
  let responsePayload: TelegramRawPayload | string | null = responseText;
  try {
    responsePayload = responseText ? (JSON.parse(responseText) as TelegramRawPayload) : null;
  } catch {
    // Keep raw text as fallback payload.
  }

  return { responseText, responsePayload };
}

function ensureRuntimeApis(): void {
  if (
    typeof fetch !== "function" ||
    typeof FormData !== "function" ||
    typeof Blob !== "function"
  ) {
    throw new Error("Global fetch/FormData/Blob are unavailable. Use Node.js 18+.");
  }
}

function formatDisplayFlag(flag: unknown): string {
  const normalized = String(flag ?? "").trim();
  if (normalized) {
    return `📌 ${normalized}`;
  }
  return "";
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function formatDurationCompact(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}г ${minutes}хв ${seconds}с`;
  }
  if (minutes > 0) {
    return `${minutes}хв ${seconds}с`;
  }
  return `${seconds}с`;
}

// ---------------------------------------------------------------------------
// Core caption builder
// ---------------------------------------------------------------------------

export function buildCaption({
  orderId,
  fileNames,
  flags,
  warnings,
  qrUrl,
  pipelineMetrics,
}: BuildCaptionParams): string {
  const normalizedWarnings = Array.isArray(warnings)
    ? warnings.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  const normalizedFlags = Array.isArray(flags)
    ? flags.map((item) => formatDisplayFlag(item)).filter(Boolean)
    : [];
  const lines: string[] = [];

  if (normalizedWarnings.length > 0) {
    lines.push("Попередження:", ...normalizedWarnings, "", `Замовлення ${orderId}`);
  } else {
    lines.push(`✅ Замовлення ${orderId}`);
  }

  lines.push("", "Файли:");
  for (const fileName of fileNames) {
    lines.push(fileName);
  }

  if (pipelineMetrics) {
    const dpi = Math.max(0, Math.floor(Number(pipelineMetrics.rasterizeDpi ?? 0) || 0));
    const strictPixels = Math.max(
      0,
      Math.floor(Number(pipelineMetrics.finalWhiteStrictPixels ?? 0) || 0),
    );
    const aggressivePixels = Math.max(
      0,
      Math.floor(Number(pipelineMetrics.finalWhiteAggressivePixels ?? 0) || 0),
    );
    const correctedPixels = Math.max(
      0,
      Math.floor(Number(pipelineMetrics.finalWhiteCorrectedPixels ?? 0) || 0),
    );

    lines.push(
      "",
      `DPI: ${dpi} | Білий (px): strict=${strictPixels} | agg=${aggressivePixels} | corrected=${correctedPixels}`,
    );

    const processingDurationMs = Number(pipelineMetrics.orderProcessingDurationMs);
    if (Number.isFinite(processingDurationMs) && processingDurationMs >= 0) {
      lines.push(`Час опрацювання: ${formatDurationCompact(processingDurationMs)}`);
    }
  }

  if (qrUrl) {
    lines.push("", `Посилання QR: ${qrUrl}`);
  }

  if (normalizedFlags.length) {
    lines.push("", ...normalizedFlags);
  }

  const caption = lines.join("\n");
  if (caption.length <= MAX_CAPTION_LENGTH) {
    return caption;
  }

  return `${caption.slice(0, MAX_CAPTION_LENGTH - 3)}...`;
}

export function buildPreviewCaption(params: {
  orderId: string;
  previewDetails?: PreviewCaptionDetails | null;
}): string {
  const quantityLines = Array.isArray(params.previewDetails?.quantityLines)
    ? params.previewDetails.quantityLines.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  const engravingTexts = Array.isArray(params.previewDetails?.engravingTexts)
    ? params.previewDetails.engravingTexts.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];
  const stickerTexts = Array.isArray(params.previewDetails?.stickerTexts)
    ? params.previewDetails.stickerTexts.map((item) => String(item ?? "").trim()).filter(Boolean)
    : [];

  const lines: string[] = [`Замовлення ${params.orderId}`, "Прев'ю макету"];

  if (quantityLines.length > 0) {
    lines.push("", "Кількість:");
    for (const line of quantityLines) {
      lines.push(`- ${line}`);
    }
  }

  if (engravingTexts.length > 0) {
    lines.push("", "Гравіювання:");
    for (const text of engravingTexts) {
      lines.push(`- ${text}`);
    }
  }

  if (stickerTexts.length > 0) {
    lines.push("", "Стікер:");
    for (const text of stickerTexts) {
      lines.push(`- ${text}`);
    }
  }

  const caption = lines.join("\n");
  if (caption.length <= MAX_CAPTION_LENGTH) {
    return caption;
  }

  return `${caption.slice(0, MAX_CAPTION_LENGTH - 3)}...`;
}

// ---------------------------------------------------------------------------
// HTTP request layer
// ---------------------------------------------------------------------------

async function sendTelegramRequest({
  botToken,
  methodName,
  buildForm,
  requestOptions,
}: {
  botToken: string;
  methodName: string;
  buildForm: () => Promise<FormData>;
  requestOptions?: RequestOptions;
}): Promise<unknown> {
  ensureRuntimeApis();
  ensureValue(botToken, "TELEGRAM_BOT_TOKEN");

  const normalizedOptions = normalizeRequestOptions(requestOptions);
  const maxAttempts = normalizedOptions.retries + 1;
  const endpoint = `${TELEGRAM_API_BASE}/bot${botToken}/${methodName}`;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const form = await buildForm();
      const response = await fetchWithTimeout(
        endpoint,
        { method: "POST", body: form },
        normalizedOptions.timeoutMs,
      );

      const { responsePayload } = await readTelegramPayload(response);
      if (
        response.ok &&
        typeof responsePayload === "object" &&
        responsePayload !== null &&
        (responsePayload as TelegramRawPayload).ok
      ) {
        return (responsePayload as TelegramRawPayload).result ?? null;
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

async function downloadPhotoForUpload(
  photoUrl: string,
  requestOptions?: RequestOptions,
): Promise<{ bytes: Buffer; contentType: string }> {
  const normalizedOptions = normalizeRequestOptions(requestOptions);
  const maxAttempts = normalizedOptions.retries + 1;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(
        photoUrl,
        { method: "GET" },
        normalizedOptions.timeoutMs,
      );
      if (!response.ok) {
        if (attempt < maxAttempts && isRetryableStatusCode(response.status)) {
          const delayMs = computeBackoffDelayMs(attempt, normalizedOptions.retryBaseMs);
          await sleep(delayMs);
          continue;
        }
        throw new Error(`Preview image download failed (${response.status})`);
      }

      const contentType = response.headers.get("content-type") ?? "image/jpeg";
      const bytes = Buffer.from(await response.arrayBuffer());
      return { bytes, contentType };
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

// ---------------------------------------------------------------------------
// Media sending functions
// ---------------------------------------------------------------------------

async function sendMediaGroup({
  botToken,
  chatId,
  messageThreadId,
  files,
  caption,
  requestOptions,
}: {
  botToken: string;
  chatId: string;
  messageThreadId?: string;
  files: TelegramFile[];
  caption: string;
  requestOptions?: RequestOptions;
}): Promise<TelegramMessage[]> {
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

      const media: Array<{ type: string; media: string; caption?: string }> = [];
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]!;
        const fileBuffer = fileBuffers[index]!;
        const attachName = `file${index + 1}`;
        const blob = new Blob([fileBuffer], { type: "application/pdf" });

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

  return Array.isArray(result) ? (result as TelegramMessage[]) : [];
}

async function sendSingleDocument({
  botToken,
  chatId,
  messageThreadId,
  file,
  caption,
  requestOptions,
}: {
  botToken: string;
  chatId: string;
  messageThreadId?: string;
  file: TelegramFile;
  caption: string;
  requestOptions?: RequestOptions;
}): Promise<TelegramMessage[]> {
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

  return result ? [result as TelegramMessage] : [];
}

async function sendPhotoByUrl({
  botToken,
  chatId,
  messageThreadId,
  photoUrl,
  caption,
  requestOptions,
}: {
  botToken: string;
  chatId: string;
  messageThreadId?: string;
  photoUrl: string;
  caption?: string;
  requestOptions?: RequestOptions;
}): Promise<TelegramMessage> {
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
  }) as Promise<TelegramMessage>;
}

async function sendPhotoByUpload({
  botToken,
  chatId,
  messageThreadId,
  photoUrl,
  caption,
  requestOptions,
}: {
  botToken: string;
  chatId: string;
  messageThreadId?: string;
  photoUrl: string;
  caption?: string;
  requestOptions?: RequestOptions;
}): Promise<TelegramMessage> {
  ensureValue(chatId, "TELEGRAM_CHAT_ID");
  ensureValue(photoUrl, "preview image URL");

  const source = await downloadPhotoForUpload(photoUrl, requestOptions);
  const extension = source.contentType.includes("png")
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
        new Blob([new Uint8Array(source.bytes)], { type: source.contentType }),
        `preview.${extension}`,
      );
      return form;
    },
  }) as Promise<TelegramMessage>;
}

async function sendSinglePreviewPhoto({
  botToken,
  chatId,
  messageThreadId,
  photoUrl,
  caption,
  requestOptions,
}: {
  botToken: string;
  chatId: string;
  messageThreadId?: string;
  photoUrl: string;
  caption?: string;
  requestOptions?: RequestOptions;
}): Promise<TelegramMessage> {
  try {
    return await sendPhotoByUrl({
      botToken,
      chatId,
      messageThreadId,
      photoUrl,
      caption,
      requestOptions,
    });
  } catch {
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
  previewDetails,
  requestOptions,
}: {
  botToken: string;
  chatId: string;
  messageThreadId?: string;
  orderId: string;
  previewImages: string[];
  previewDetails?: PreviewCaptionDetails | null;
  requestOptions?: RequestOptions;
}): Promise<{ messages: TelegramMessage[]; errors: string[] }> {
  const urls = Array.isArray(previewImages) ? previewImages.filter(Boolean) : [];
  if (urls.length === 0) {
    return { messages: [], errors: [] };
  }

  const messages: TelegramMessage[] = [];
  const errors: string[] = [];
  for (let index = 0; index < urls.length; index += 1) {
    const caption =
      index === 0
        ? buildPreviewCaption({
            orderId,
            previewDetails,
          })
        : undefined;
    try {
      const message = await sendSinglePreviewPhoto({
        botToken,
        chatId,
        messageThreadId,
        photoUrl: urls[index]!,
        caption,
        requestOptions,
      });
      if (message) {
        messages.push(message);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { messages, errors };
}

async function sendGeneratedFiles({
  botToken,
  chatId,
  messageThreadId,
  orderId,
  generatedFiles,
  caption,
  requestOptions,
}: {
  botToken: string;
  chatId: string;
  messageThreadId?: string;
  orderId: string;
  generatedFiles: TelegramFile[];
  caption: string;
  requestOptions?: RequestOptions;
}): Promise<TelegramMessage[]> {
  if (!Array.isArray(generatedFiles) || generatedFiles.length === 0) {
    return [];
  }

  if (generatedFiles.length === 1) {
    return sendSingleDocument({
      botToken,
      chatId,
      messageThreadId,
      file: generatedFiles[0]!,
      caption,
      requestOptions,
    });
  }

  const chunks = chunkArray(generatedFiles, MAX_MEDIA_GROUP_SIZE);
  const messages: TelegramMessage[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    if (chunk.length === 1) {
      const singleMessages = await sendSingleDocument({
        botToken,
        chatId,
        messageThreadId,
        file: chunk[0]!,
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function sendOrderFilesToTelegram({
  botToken,
  chatId,
  messageThreadId,
  orderId,
  flags,
  warnings,
  qrUrl,
  previewImages,
  previewDetails,
  pipelineMetrics,
  generatedFiles,
  requestOptions = {},
}: SendOrderFilesInput): Promise<SendOrderFilesResult> {
  ensureValue(botToken, "TELEGRAM_BOT_TOKEN");
  ensureValue(chatId, "TELEGRAM_CHAT_ID");

  const fileNames = generatedFiles.map((file) => file.filename);
  const previewResult = await sendPreviewPhotos({
    botToken,
    chatId,
    messageThreadId,
    orderId,
    previewImages,
    previewDetails,
    requestOptions,
  });
  const previewMessages = previewResult.messages;
  const previewWarnings = previewResult.errors.map(
    (message) => `⚠️ Preview warning: ${message}`,
  );
  const caption = buildCaption({
    orderId,
    fileNames,
    flags,
    warnings: [...(Array.isArray(warnings) ? warnings : []), ...previewWarnings],
    qrUrl,
    pipelineMetrics: pipelineMetrics ?? null,
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

  return {
    chat_id: chatId,
    message_thread_id: messageThreadId ?? null,
    preview_count: previewMessages.length,
    preview_message_ids: previewMessages.map((message) => message.message_id),
    preview_errors: previewResult.errors,
    message_count: sentMessages.length,
    message_ids: sentMessages.map((message) => message.message_id),
    caption,
  };
}
