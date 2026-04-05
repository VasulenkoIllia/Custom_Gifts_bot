import { createHash, randomUUID } from "node:crypto";
import type { PdfGeneratedFile } from "../pdf/pdf.types";
import type { TelegramDeliveryRecord } from "./db-telegram-delivery-store";
import { sendOrderFilesToTelegram, type SendOrderFilesResult } from "./telegram-client";

type TelegramRequestOptions = {
  timeoutMs: number;
  retries: number;
  retryBaseMs: number;
};

type TelegramDeliveryInput = {
  orderId: string;
  flags: string[];
  warnings: string[];
  qrUrl: string | null;
  previewImages: string[];
  generatedFiles: PdfGeneratedFile[];
};

type TelegramDeliveryResult = {
  chatId: string;
  messageIds: number[];
  previewMessageIds: number[];
  caption: string;
  warnings?: string[];
};

type CreateTelegramDeliveryServiceParams = {
  botToken: string;
  chatId: string;
  messageThreadId: string;
  requestOptions: TelegramRequestOptions;
  deliveryStore?: {
    acquire: (params: {
      deliveryKey: string;
      orderId: string;
      leaseOwner: string;
      leaseTtlMs: number;
    }) => Promise<
      | { outcome: "acquired" }
      | { outcome: "busy" }
      | { outcome: "sent"; record: TelegramDeliveryRecord }
    >;
    complete: (leaseOwner: string, record: TelegramDeliveryRecord) => Promise<void>;
    release: (deliveryKey: string, leaseOwner: string) => Promise<void>;
  } | null;
  leaseTtlMs?: number;
  sender?: typeof sendOrderFilesToTelegram;
};

function normalizeMessageIds(values: Array<number | string> | undefined): number[] {
  const result: number[] = [];
  for (const item of values ?? []) {
    const parsed = Number.parseInt(String(item ?? ""), 10);
    if (Number.isFinite(parsed)) {
      result.push(parsed);
    }
  }
  return result;
}

export class TelegramDeliveryService {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly messageThreadId: string;
  private readonly requestOptions: TelegramRequestOptions;
  private readonly deliveryStore:
    | NonNullable<CreateTelegramDeliveryServiceParams["deliveryStore"]>
    | null;
  private readonly leaseTtlMs: number;
  private readonly leaseOwner: string;
  private readonly sendOrderFilesToTelegram: typeof sendOrderFilesToTelegram;

  constructor(params: CreateTelegramDeliveryServiceParams) {
    this.botToken = String(params.botToken ?? "").trim();
    this.chatId = String(params.chatId ?? "").trim();
    this.messageThreadId = String(params.messageThreadId ?? "").trim();
    this.requestOptions = params.requestOptions;
    this.deliveryStore = params.deliveryStore ?? null;
    this.leaseTtlMs = Number.isFinite(params.leaseTtlMs)
      ? Math.max(1_000, Math.floor(Number(params.leaseTtlMs)))
      : 10 * 60 * 1000;
    this.leaseOwner = `telegram_delivery:${randomUUID()}`;
    this.sendOrderFilesToTelegram = params.sender ?? sendOrderFilesToTelegram;
  }

  async sendOrderMaterials(input: TelegramDeliveryInput): Promise<TelegramDeliveryResult> {
    if (!this.botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is required.");
    }
    if (!this.chatId) {
      throw new Error("TELEGRAM_CHAT_ID is required.");
    }
    if (!Array.isArray(input.generatedFiles) || input.generatedFiles.length === 0) {
      throw new Error("No generated files to send.");
    }
    if (!String(input.orderId ?? "").trim()) {
      throw new Error("orderId is required.");
    }

    const normalizedOrderId = String(input.orderId ?? "").trim();
    const deliveryKey = buildDeliveryKey({
      orderId: normalizedOrderId,
      flags: input.flags,
      warnings: input.warnings,
      qrUrl: input.qrUrl,
      previewImages: input.previewImages,
      generatedFiles: input.generatedFiles,
    });
    if (this.deliveryStore) {
      const acquireResult = await this.deliveryStore.acquire({
        deliveryKey,
        orderId: normalizedOrderId,
        leaseOwner: this.leaseOwner,
        leaseTtlMs: this.leaseTtlMs,
      });
      if (acquireResult.outcome === "sent") {
        return {
          chatId: acquireResult.record.chatId,
          messageIds: acquireResult.record.messageIds,
          previewMessageIds: acquireResult.record.previewMessageIds,
          caption: acquireResult.record.caption,
          warnings: acquireResult.record.warnings,
        };
      }
      if (acquireResult.outcome === "busy") {
        const error = new Error("Telegram delivery is already in progress.") as Error & {
          retryable?: boolean;
          failureKind?: string;
        };
        error.name = "TelegramDeliveryBusyError";
        error.retryable = true;
        error.failureKind = "telegram_delivery";
        throw error;
      }
    }

    try {
      const telegramResult = await this.sendOrderFilesToTelegram({
        botToken: this.botToken,
        chatId: this.chatId,
        messageThreadId: this.messageThreadId || undefined,
        orderId: normalizedOrderId,
        flags: Array.isArray(input.flags) ? input.flags : [],
        warnings: Array.isArray(input.warnings) ? input.warnings : [],
        qrUrl: input.qrUrl,
        previewImages: Array.isArray(input.previewImages) ? input.previewImages : [],
        generatedFiles: input.generatedFiles.map((item) => ({
          path: item.path,
          filename: item.filename,
        })),
        requestOptions: this.requestOptions,
      });

      const messageIds = normalizeMessageIds(telegramResult?.message_ids);
      if (messageIds.length === 0) {
        const error = new Error("Telegram delivery returned no file message IDs.") as Error & {
          retryable?: boolean;
          failureKind?: string;
        };
        error.name = "TelegramDeliveryError";
        error.retryable = true;
        error.failureKind = "telegram_delivery";
        throw error;
      }

      const previewErrors = Array.isArray(telegramResult?.preview_errors)
        ? telegramResult.preview_errors
            .map((item) => String(item ?? "").trim())
            .filter(Boolean)
        : [];

      const record: TelegramDeliveryRecord = {
        deliveryKey,
        orderId: normalizedOrderId,
        chatId: String(telegramResult?.chat_id ?? this.chatId).trim() || this.chatId,
        messageIds,
        previewMessageIds: normalizeMessageIds(telegramResult?.preview_message_ids),
        caption: String(telegramResult?.caption ?? "").trim(),
        warnings: previewErrors.map((message) => `⚠️ Preview warning: ${message}`),
      };

      if (this.deliveryStore) {
        await this.deliveryStore.complete(this.leaseOwner, record);
      }

      return {
        chatId: record.chatId,
        messageIds: record.messageIds,
        previewMessageIds: record.previewMessageIds,
        caption: record.caption,
        warnings: record.warnings,
      };
    } catch (error) {
      if (this.deliveryStore) {
        await this.deliveryStore.release(deliveryKey, this.leaseOwner).catch(() => undefined);
      }
      throw error;
    }
  }
}

function buildDeliveryKey(input: {
  orderId: string;
  flags: string[];
  warnings: string[];
  qrUrl: string | null;
  previewImages: string[];
  generatedFiles: PdfGeneratedFile[];
}): string {
  const signature = JSON.stringify({
    orderId: input.orderId,
    flags: [...(input.flags ?? [])].map((item) => String(item ?? "").trim()).filter(Boolean).sort(),
    warnings: [...(input.warnings ?? [])]
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .sort(),
    qrUrl: String(input.qrUrl ?? "").trim() || null,
    previewImages: [...(input.previewImages ?? [])]
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .sort(),
    generatedFiles: (input.generatedFiles ?? [])
      .map((item) => ({
        type: item.type,
        filename: item.filename,
      }))
      .sort((left, right) => left.filename.localeCompare(right.filename)),
  });

  return `delivery:${createHash("sha1").update(signature).digest("hex")}`;
}
