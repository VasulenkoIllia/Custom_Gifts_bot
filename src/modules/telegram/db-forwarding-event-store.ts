import type { DatabaseClient } from "../db/postgres-client";
import type { ForwardingEventStore, TelegramForwardMode } from "./telegram-forwarding.service";

type ForwardedSourceMessageRow = {
  source_chat_id: string;
  source_message_id: number;
};

export class DbForwardingEventStore implements ForwardingEventStore {
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  async init(): Promise<void> {
    // Schema is created by ensurePostgresSchema.
  }

  async listForwardedSourceMessages(params: {
    orderId: string;
    stageCode: string;
    targetChatId: string;
    targetThreadId: string;
  }): Promise<Array<{ chatId: string; messageId: number }>> {
    const result = await this.db.query<ForwardedSourceMessageRow>(
      `
        SELECT source_chat_id, source_message_id
        FROM forwarding_events
        WHERE order_id = $1
          AND stage_code = $2
          AND target_chat_id = $3
          AND target_thread_id = $4
        ORDER BY source_message_id ASC
      `,
      [
        String(params.orderId ?? "").trim(),
        String(params.stageCode ?? "").trim().toUpperCase(),
        String(params.targetChatId ?? "").trim(),
        String(params.targetThreadId ?? "").trim(),
      ],
    );

    return result.rows
      .map((row) => ({
        chatId: String(row.source_chat_id ?? "").trim(),
        messageId: Number.parseInt(String(row.source_message_id ?? ""), 10),
      }))
      .filter((value) => value.chatId && Number.isFinite(value.messageId));
  }

  async recordForwardedMessage(params: {
    orderId: string;
    stageCode: string;
    sourceChatId: string;
    sourceMessageId: number;
    targetChatId: string;
    targetThreadId: string;
    mode: TelegramForwardMode;
    targetMessageId: number;
  }): Promise<void> {
    await this.db.query(
      `
        INSERT INTO forwarding_events(
          stage_code,
          order_id,
          source_chat_id,
          source_message_id,
          target_chat_id,
          target_thread_id,
          mode,
          target_message_id,
          created_at
        )
        VALUES($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (
          stage_code,
          source_chat_id,
          source_message_id,
          target_chat_id,
          target_thread_id
        )
        DO NOTHING
      `,
      [
        String(params.stageCode ?? "").trim().toUpperCase(),
        String(params.orderId ?? "").trim(),
        String(params.sourceChatId ?? "").trim(),
        Math.max(1, Math.floor(Number(params.sourceMessageId))),
        String(params.targetChatId ?? "").trim(),
        String(params.targetThreadId ?? "").trim(),
        params.mode,
        Math.max(1, Math.floor(Number(params.targetMessageId))),
      ],
    );
  }
}
