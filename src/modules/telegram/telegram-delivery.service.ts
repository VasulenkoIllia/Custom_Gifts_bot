import path from "node:path";
import type { PdfGeneratedFile } from "../pdf/pdf.types";

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
};

type LegacySendOrderFilesResult = {
  chat_id?: string | number;
  preview_message_ids?: Array<number | string>;
  message_ids?: Array<number | string>;
  caption?: string;
};

type LegacySendOrderFilesToTelegram = (input: {
  botToken: string;
  chatId: string;
  messageThreadId?: string;
  orderId: string;
  flags: string[];
  warnings: string[];
  qrUrl: string | null;
  previewImages: string[];
  generatedFiles: Array<{ path: string; filename: string }>;
  requestOptions?: TelegramRequestOptions;
}) => Promise<LegacySendOrderFilesResult>;

type LegacyTelegramClientModule = {
  sendOrderFilesToTelegram: LegacySendOrderFilesToTelegram;
};

type CreateTelegramDeliveryServiceParams = {
  botToken: string;
  chatId: string;
  messageThreadId: string;
  requestOptions: TelegramRequestOptions;
  legacyModulePath: string;
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
  private readonly legacyModulePath: string;
  private sendOrderFilesToTelegram: LegacySendOrderFilesToTelegram | null = null;

  constructor(params: CreateTelegramDeliveryServiceParams) {
    this.botToken = String(params.botToken ?? "").trim();
    this.chatId = String(params.chatId ?? "").trim();
    this.messageThreadId = String(params.messageThreadId ?? "").trim();
    this.requestOptions = params.requestOptions;
    this.legacyModulePath = path.resolve(params.legacyModulePath);
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

    const legacySend = this.getLegacySendOrderFilesToTelegram();
    const legacyResult = await legacySend({
      botToken: this.botToken,
      chatId: this.chatId,
      messageThreadId: this.messageThreadId || undefined,
      orderId: String(input.orderId ?? "").trim(),
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

    return {
      chatId: String(legacyResult?.chat_id ?? this.chatId).trim() || this.chatId,
      messageIds: normalizeMessageIds(legacyResult?.message_ids),
      previewMessageIds: normalizeMessageIds(legacyResult?.preview_message_ids),
      caption: String(legacyResult?.caption ?? "").trim(),
    };
  }

  private getLegacySendOrderFilesToTelegram(): LegacySendOrderFilesToTelegram {
    if (this.sendOrderFilesToTelegram) {
      return this.sendOrderFilesToTelegram;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const legacyModule = require(this.legacyModulePath) as LegacyTelegramClientModule;
    if (!legacyModule || typeof legacyModule.sendOrderFilesToTelegram !== "function") {
      throw new Error(`Legacy telegram client is invalid: ${this.legacyModulePath}`);
    }

    this.sendOrderFilesToTelegram = legacyModule.sendOrderFilesToTelegram;
    return this.sendOrderFilesToTelegram;
  }
}
