import { createHash, randomUUID } from "node:crypto";
import { extractErrorMessage, resolveRetryableError } from "../errors/worker-errors";
import type { TelegramOrderMessageRef } from "./telegram-message-map.types";

type TelegramRequestOptions = {
  timeoutMs: number;
  retries: number;
  retryBaseMs: number;
};

export type TelegramForwardMode = "copy" | "forward";

export type ForwardingEventStore = {
  listForwardedSourceMessages: (params: {
    orderId: string;
    stageCode: string;
    targetChatId: string;
    targetThreadId: string;
  }) => Promise<TelegramOrderMessageRef[]>;
  recordForwardedMessage: (params: {
    orderId: string;
    stageCode: string;
    sourceChatId: string;
    sourceMessageId: number;
    targetChatId: string;
    targetThreadId: string;
    mode: TelegramForwardMode;
    targetMessageId: number;
  }) => Promise<void>;
};

type CreateTelegramForwardingServiceParams = {
  botToken: string;
  targetChatId: string;
  targetThreadId: string;
  primaryMode: TelegramForwardMode;
  requestOptions: TelegramRequestOptions;
  eventStore: ForwardingEventStore;
  batchStore?: {
    acquire: (params: {
      batchKey: string;
      orderId: string;
      stageCode: string;
      targetChatId: string;
      targetThreadId: string;
      sourceMessages: TelegramOrderMessageRef[];
      leaseOwner: string;
      leaseTtlMs: number;
    }) => Promise<
      | { outcome: "acquired" }
      | { outcome: "busy" }
      | { outcome: "sent"; result: TelegramForwardingResult }
    >;
    complete: (
      leaseOwner: string,
      params: {
        batchKey: string;
        forwardedResult: TelegramForwardingResult;
      },
    ) => Promise<void>;
    release: (batchKey: string, leaseOwner: string) => Promise<void>;
  } | null;
  leaseTtlMs?: number;
};

type TelegramForwardingInput = {
  orderId: string;
  stageCode: string;
  sourceMessages: TelegramOrderMessageRef[];
};

export type TelegramForwardingResult = {
  targetChatId: string;
  targetThreadId: string;
  forwardedMessageIds: number[];
  forwardedCount: number;
  skippedCount: number;
  modeCounts: Record<TelegramForwardMode, number>;
};

type TelegramRequestPayload = {
  ok?: boolean;
  result?: unknown;
  description?: string;
  parameters?: {
    retry_after?: number;
  };
};

class TelegramForwardingError extends Error {
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly code?: string;

  constructor(params: {
    message: string;
    retryable: boolean;
    statusCode?: number;
    code?: string;
  }) {
    super(params.message);
    this.name = "TelegramForwardingError";
    this.retryable = params.retryable;
    this.statusCode = params.statusCode;
    this.code = params.code;
  }
}

const TELEGRAM_API_BASE = "https://api.telegram.org";

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isRetryableStatusCode(value: number): boolean {
  return value === 408 || value === 409 || value === 425 || value === 429 || value >= 500;
}

function parseRetryAfterMs(payload: TelegramRequestPayload | null): number | null {
  const rawValue = payload?.parameters?.retry_after;
  const parsed = Number.parseInt(String(rawValue ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return parsed * 1000;
}

function computeBackoffDelayMs(attempt: number, baseDelayMs: number): number {
  const safeAttempt = Math.max(1, attempt);
  const exponential = baseDelayMs * Math.pow(2, Math.max(0, safeAttempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(1000, baseDelayMs));
  return Math.min(20_000, exponential + jitter);
}

function ensureValue(value: string, envName: string): void {
  if (!String(value ?? "").trim()) {
    throw new TelegramForwardingError({
      message: `${envName} is required.`,
      retryable: false,
    });
  }
}

function normalizeMessages(sourceMessages: TelegramOrderMessageRef[]): TelegramOrderMessageRef[] {
  const seen = new Set<string>();
  const result: TelegramOrderMessageRef[] = [];

  for (const item of sourceMessages) {
    const chatId = String(item.chatId ?? "").trim();
    const messageId = Number.parseInt(String(item.messageId ?? ""), 10);
    if (!chatId || !Number.isFinite(messageId)) {
      continue;
    }

    const key = `${chatId}:${messageId}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({ chatId, messageId });
  }

  return result;
}

function groupMessagesByChat(sourceMessages: TelegramOrderMessageRef[]): TelegramOrderMessageRef[][] {
  const groups: TelegramOrderMessageRef[][] = [];
  const buckets = new Map<string, TelegramOrderMessageRef[]>();

  for (const item of sourceMessages) {
    const current = buckets.get(item.chatId) ?? [];
    current.push(item);
    buckets.set(item.chatId, current);
  }

  for (const items of buckets.values()) {
    groups.push([...items].sort((left, right) => left.messageId - right.messageId));
  }

  return groups;
}

function chunkMessages(sourceMessages: TelegramOrderMessageRef[], chunkSize: number): TelegramOrderMessageRef[][] {
  const chunks: TelegramOrderMessageRef[][] = [];
  for (let index = 0; index < sourceMessages.length; index += chunkSize) {
    chunks.push(sourceMessages.slice(index, index + chunkSize));
  }
  return chunks;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function parseResponsePayload(response: Response): Promise<TelegramRequestPayload | string | null> {
  const responseText = await response.text();
  if (!responseText) {
    return null;
  }

  try {
    return JSON.parse(responseText) as TelegramRequestPayload;
  } catch (_error) {
    return responseText;
  }
}

export class TelegramForwardingService {
  private readonly botToken: string;
  private readonly targetChatId: string;
  private readonly targetThreadId: string;
  private readonly primaryMode: TelegramForwardMode;
  private readonly requestOptions: TelegramRequestOptions;
  private readonly eventStore: ForwardingEventStore;
  private readonly batchStore:
    | NonNullable<CreateTelegramForwardingServiceParams["batchStore"]>
    | null;
  private readonly leaseTtlMs: number;
  private readonly leaseOwner: string;

  constructor(params: CreateTelegramForwardingServiceParams) {
    this.botToken = String(params.botToken ?? "").trim();
    this.targetChatId = String(params.targetChatId ?? "").trim();
    this.targetThreadId = String(params.targetThreadId ?? "").trim();
    this.primaryMode = params.primaryMode;
    this.requestOptions = params.requestOptions;
    this.eventStore = params.eventStore;
    this.batchStore = params.batchStore ?? null;
    this.leaseTtlMs = Number.isFinite(params.leaseTtlMs)
      ? Math.max(1_000, Math.floor(Number(params.leaseTtlMs)))
      : 10 * 60 * 1000;
    this.leaseOwner = `telegram_forwarding:${randomUUID()}`;
  }

  async forwardOrderMaterials(input: TelegramForwardingInput): Promise<TelegramForwardingResult> {
    ensureValue(this.botToken, "TELEGRAM_BOT_TOKEN");
    ensureValue(this.targetChatId, "TELEGRAM_ORDERS_CHAT_ID");

    const orderId = String(input.orderId ?? "").trim();
    const stageCode = String(input.stageCode ?? "").trim().toUpperCase();
    const sourceMessages = normalizeMessages(input.sourceMessages);

    if (!orderId) {
      throw new TelegramForwardingError({
        message: "orderId is required for Telegram forwarding.",
        retryable: false,
      });
    }

    if (!stageCode) {
      throw new TelegramForwardingError({
        message: "stageCode is required for Telegram forwarding.",
        retryable: false,
      });
    }

    if (sourceMessages.length === 0) {
      throw new TelegramForwardingError({
        message: `No Telegram PDF messages found for order ${orderId}.`,
        retryable: false,
      });
    }

    const batchKey = buildForwardingBatchKey({
      orderId,
      stageCode,
      targetChatId: this.targetChatId,
      targetThreadId: this.targetThreadId,
      sourceMessages,
    });
    if (this.batchStore) {
      const acquireResult = await this.batchStore.acquire({
        batchKey,
        orderId,
        stageCode,
        targetChatId: this.targetChatId,
        targetThreadId: this.targetThreadId,
        sourceMessages,
        leaseOwner: this.leaseOwner,
        leaseTtlMs: this.leaseTtlMs,
      });
      if (acquireResult.outcome === "sent") {
        return acquireResult.result;
      }
      if (acquireResult.outcome === "busy") {
        throw new TelegramForwardingError({
          message: "Telegram forwarding batch is already in progress.",
          retryable: true,
        });
      }
    }

    const alreadyForwarded = new Set(
      (
        await this.eventStore.listForwardedSourceMessages({
          orderId,
          stageCode,
          targetChatId: this.targetChatId,
          targetThreadId: this.targetThreadId,
        })
      ).map((item) => `${item.chatId}:${item.messageId}`),
    );

    const result: TelegramForwardingResult = {
      targetChatId: this.targetChatId,
      targetThreadId: this.targetThreadId,
      forwardedMessageIds: [],
      forwardedCount: 0,
      skippedCount: 0,
      modeCounts: {
        copy: 0,
        forward: 0,
      },
    };

    const pendingMessages = sourceMessages.filter(
      (item) => !alreadyForwarded.has(`${item.chatId}:${item.messageId}`),
    );
    result.skippedCount = sourceMessages.length - pendingMessages.length;
    const forwardedRecords: Array<{
      sourceMessage: TelegramOrderMessageRef;
      targetMessageId: number;
      mode: TelegramForwardMode;
    }> = [];

    try {
      for (const group of groupMessagesByChat(pendingMessages)) {
        for (const batch of chunkMessages(group, 100)) {
          const forwarded = await this.forwardMessageBatch(batch);
          for (let index = 0; index < batch.length; index += 1) {
            const sourceMessage = batch[index];
            const targetMessageIdRaw = forwarded.targetMessageIds[index];
            if (!sourceMessage || !Number.isFinite(targetMessageIdRaw)) {
              continue;
            }
            const targetMessageId = Number(targetMessageIdRaw);

            alreadyForwarded.add(`${sourceMessage.chatId}:${sourceMessage.messageId}`);
            result.forwardedMessageIds.push(targetMessageId);
            result.forwardedCount += 1;
            result.modeCounts[forwarded.mode] += 1;
            forwardedRecords.push({
              sourceMessage,
              targetMessageId,
              mode: forwarded.mode,
            });
          }
        }
      }

      if (this.batchStore) {
        await this.batchStore.complete(this.leaseOwner, {
          batchKey,
          forwardedResult: result,
        });
      }

      const recordTasks: Promise<void>[] = [];
      for (const forwardedRecord of forwardedRecords) {
        recordTasks.push(
          this.eventStore.recordForwardedMessage({
            orderId,
            stageCode,
            sourceChatId: forwardedRecord.sourceMessage.chatId,
            sourceMessageId: forwardedRecord.sourceMessage.messageId,
            targetChatId: this.targetChatId,
            targetThreadId: this.targetThreadId,
            mode: forwardedRecord.mode,
            targetMessageId: forwardedRecord.targetMessageId,
          }),
        );
      }
      await Promise.allSettled(recordTasks);
      return result;
    } catch (error) {
      if (this.batchStore) {
        await this.batchStore.release(batchKey, this.leaseOwner).catch(() => undefined);
      }
      throw error;
    }
  }

  private async forwardMessageBatch(
    sourceMessages: TelegramOrderMessageRef[],
  ): Promise<{ mode: TelegramForwardMode; targetMessageIds: number[] }> {
    const modes =
      this.primaryMode === "copy"
        ? (["copy", "forward"] as const)
        : (["forward"] as const);

    if (sourceMessages.length === 0) {
      throw new TelegramForwardingError({
        message: "No Telegram messages provided for forwarding.",
        retryable: false,
      });
    }

    let lastError: unknown = null;
    for (const mode of modes) {
      try {
        const targetMessageIds = await this.sendForwardRequest(mode, sourceMessages);
        return {
          mode,
          targetMessageIds,
        };
      } catch (error) {
        lastError = error;
        if (mode === "copy" && resolveRetryableError(error)) {
          break;
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new TelegramForwardingError({
          message: `Telegram forwarding failed: ${extractErrorMessage(lastError)}`,
          retryable: resolveRetryableError(lastError),
        });
  }

  private async sendForwardRequest(
    mode: TelegramForwardMode,
    sourceMessages: TelegramOrderMessageRef[],
  ): Promise<number[]> {
    const methodName = mode === "copy" ? "copyMessages" : "forwardMessages";
    const endpoint = `${TELEGRAM_API_BASE}/bot${this.botToken}/${methodName}`;
    const maxAttempts = Math.max(1, this.requestOptions.retries + 1);
    let lastError: unknown = null;
    const sourceChatId = sourceMessages[0]?.chatId ?? "";
    const messageIds = sourceMessages.map((item) => item.messageId);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const form = new FormData();
        form.append("chat_id", this.targetChatId);
        form.append("from_chat_id", sourceChatId);
        form.append("message_ids", JSON.stringify(messageIds));
        if (this.targetThreadId) {
          form.append("message_thread_id", this.targetThreadId);
        }
        if (mode === "copy") {
          form.append("remove_caption", "true");
        }

        const response = await fetchWithTimeout(
          endpoint,
          {
            method: "POST",
            body: form,
          },
          this.requestOptions.timeoutMs,
        );
        const payload = await parseResponsePayload(response);
        const typedPayload =
          payload && typeof payload === "object" ? (payload as TelegramRequestPayload) : null;

        if (response.ok && typedPayload?.ok) {
          const resultItems = Array.isArray(typedPayload.result)
            ? typedPayload.result
            : [];
          const targetMessageIds = resultItems
            .map((item) =>
              Number.parseInt(
                String((item as { message_id?: unknown } | null)?.message_id ?? ""),
                10,
              ),
            )
            .filter((value) => Number.isFinite(value));

          if (targetMessageIds.length !== messageIds.length) {
            throw new TelegramForwardingError({
              message: `Telegram ${methodName} returned ${targetMessageIds.length} target message ids for ${messageIds.length} source messages.`,
              retryable: true,
            });
          }
          return targetMessageIds;
        }

        const reason =
          typeof payload === "string"
            ? payload
            : JSON.stringify(payload ?? { ok: false, description: "Unknown Telegram error" });
        const retryAfterMs = parseRetryAfterMs(typedPayload);
        const retryable = isRetryableStatusCode(response.status) || Number.isFinite(retryAfterMs);
        if (retryable && attempt < maxAttempts) {
          await sleep(retryAfterMs ?? computeBackoffDelayMs(attempt, this.requestOptions.retryBaseMs));
          continue;
        }

        throw new TelegramForwardingError({
          message: `Telegram ${methodName} failed (${response.status}): ${reason}`,
          retryable,
          statusCode: response.status,
        });
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts || !resolveRetryableError(error)) {
          break;
        }

        await sleep(computeBackoffDelayMs(attempt, this.requestOptions.retryBaseMs));
      }
    }

    if (lastError instanceof TelegramForwardingError) {
      throw lastError;
    }

    throw new TelegramForwardingError({
      message: `Telegram ${methodName} failed: ${extractErrorMessage(lastError)}`,
      retryable: resolveRetryableError(lastError),
      code:
        lastError && typeof lastError === "object"
          ? String((lastError as { code?: unknown }).code ?? "")
          : undefined,
    });
  }
}

function buildForwardingBatchKey(params: {
  orderId: string;
  stageCode: string;
  targetChatId: string;
  targetThreadId: string;
  sourceMessages: TelegramOrderMessageRef[];
}): string {
  const signature = JSON.stringify({
    orderId: params.orderId,
    stageCode: params.stageCode,
    targetChatId: params.targetChatId,
    targetThreadId: params.targetThreadId,
    sourceMessages: [...params.sourceMessages]
      .map((item) => ({
        chatId: String(item.chatId ?? "").trim(),
        messageId: Number(item.messageId),
      }))
      .sort(
        (left, right) =>
          left.chatId.localeCompare(right.chatId) || left.messageId - right.messageId,
      ),
  });

  return `forward:${createHash("sha1").update(signature).digest("hex")}`;
}
