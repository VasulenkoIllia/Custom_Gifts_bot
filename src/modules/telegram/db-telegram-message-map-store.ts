import type { DatabaseClient } from "../db/postgres-client";
import type {
  TelegramMessageMapStore,
  TelegramOrderWorkflowState,
} from "./telegram-message-map.types";

type DbMessageRow = {
  order_id: string;
};

type DbOrderStateRow = {
  order_id: string;
  highest_stage_index: number;
  applied_status_id: number | null;
  updated_at: string | Date;
  last_heart_count: number;
};

export class DbTelegramMessageMapStore implements TelegramMessageMapStore {
  private readonly db: DatabaseClient;
  private readonly maxEntries: number;

  constructor(db: DatabaseClient, maxEntries = 50_000) {
    this.db = db;
    this.maxEntries = Number.isFinite(maxEntries) ? Math.max(1_000, Math.floor(maxEntries)) : 50_000;
  }

  async init(): Promise<void> {
    await this.trimMessagesIfNeeded();
  }

  async linkMessages(params: {
    orderId: string;
    chatId: string;
    messageIds: number[];
  }): Promise<{ linked: number }> {
    const orderId = String(params.orderId ?? "").trim();
    const chatId = String(params.chatId ?? "").trim();
    const messageIds = Array.isArray(params.messageIds)
      ? params.messageIds
          .map((value) => Number.parseInt(String(value), 10))
          .filter((value) => Number.isFinite(value))
      : [];

    if (!orderId || !chatId || messageIds.length === 0) {
      return { linked: 0 };
    }

    for (const messageId of messageIds) {
      await this.db.query(
        `
          INSERT INTO telegram_message_map(
            chat_id, message_id, order_id, created_at, updated_at, last_heart_count
          )
          VALUES($1, $2, $3, NOW(), NOW(), 0)
          ON CONFLICT (chat_id, message_id)
          DO UPDATE SET
            order_id = EXCLUDED.order_id,
            updated_at = NOW()
        `,
        [chatId, messageId, orderId],
      );
    }

    await this.trimMessagesIfNeeded();
    return {
      linked: messageIds.length,
    };
  }

  async getOrderIdByMessage(chatId: string, messageId: number): Promise<string | null> {
    const normalizedChatId = String(chatId ?? "").trim();
    const normalizedMessageId = Number.parseInt(String(messageId ?? ""), 10);
    if (!normalizedChatId || !Number.isFinite(normalizedMessageId)) {
      return null;
    }

    const result = await this.db.query<DbMessageRow>(
      `
        SELECT order_id
        FROM telegram_message_map
        WHERE chat_id = $1
          AND message_id = $2
        LIMIT 1
      `,
      [normalizedChatId, normalizedMessageId],
    );

    return result.rows[0]?.order_id ?? null;
  }

  async markMessageHeartCount(chatId: string, messageId: number, heartCount: number): Promise<void> {
    const normalizedChatId = String(chatId ?? "").trim();
    const normalizedMessageId = Number.parseInt(String(messageId ?? ""), 10);
    const normalizedHeartCount = Number.isFinite(heartCount)
      ? Math.max(0, Math.floor(heartCount))
      : 0;
    if (!normalizedChatId || !Number.isFinite(normalizedMessageId)) {
      return;
    }

    await this.db.query(
      `
        UPDATE telegram_message_map
        SET last_heart_count = $3,
            updated_at = NOW()
        WHERE chat_id = $1
          AND message_id = $2
      `,
      [normalizedChatId, normalizedMessageId, normalizedHeartCount],
    );
  }

  async getOrderState(orderId: string): Promise<TelegramOrderWorkflowState | null> {
    const normalizedOrderId = String(orderId ?? "").trim();
    if (!normalizedOrderId) {
      return null;
    }

    const result = await this.db.query<DbOrderStateRow>(
      `
        SELECT
          order_id,
          highest_stage_index,
          applied_status_id,
          updated_at,
          last_heart_count
        FROM order_workflow_state
        WHERE order_id = $1
        LIMIT 1
      `,
      [normalizedOrderId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      orderId: row.order_id,
      highestStageIndex: row.highest_stage_index,
      appliedStatusId: row.applied_status_id,
      updatedAt: new Date(String(row.updated_at)).toISOString(),
      lastHeartCount: row.last_heart_count,
    };
  }

  async upsertOrderState(params: {
    orderId: string;
    highestStageIndex: number;
    appliedStatusId: number;
    lastHeartCount: number;
  }): Promise<TelegramOrderWorkflowState> {
    const orderId = String(params.orderId ?? "").trim();
    if (!orderId) {
      throw new Error("orderId is required.");
    }

    const highestStageIndex = Number.isFinite(params.highestStageIndex)
      ? Math.max(-1, Math.floor(params.highestStageIndex))
      : -1;
    const appliedStatusId = Number.isFinite(params.appliedStatusId)
      ? Math.max(1, Math.floor(params.appliedStatusId))
      : null;
    const lastHeartCount = Number.isFinite(params.lastHeartCount)
      ? Math.max(0, Math.floor(params.lastHeartCount))
      : 0;

    const result = await this.db.query<DbOrderStateRow>(
      `
        INSERT INTO order_workflow_state(
          order_id,
          highest_stage_index,
          applied_status_id,
          updated_at,
          last_heart_count
        )
        VALUES($1, $2, $3, NOW(), $4)
        ON CONFLICT (order_id)
        DO UPDATE SET
          highest_stage_index = EXCLUDED.highest_stage_index,
          applied_status_id = EXCLUDED.applied_status_id,
          updated_at = NOW(),
          last_heart_count = EXCLUDED.last_heart_count
        RETURNING
          order_id,
          highest_stage_index,
          applied_status_id,
          updated_at,
          last_heart_count
      `,
      [orderId, highestStageIndex, appliedStatusId, lastHeartCount],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to upsert order workflow state.");
    }

    return {
      orderId: row.order_id,
      highestStageIndex: row.highest_stage_index,
      appliedStatusId: row.applied_status_id,
      updatedAt: new Date(String(row.updated_at)).toISOString(),
      lastHeartCount: row.last_heart_count,
    };
  }

  private async trimMessagesIfNeeded(): Promise<void> {
    await this.db.query(
      `
        DELETE FROM telegram_message_map
        WHERE (chat_id, message_id) IN (
          SELECT chat_id, message_id
          FROM telegram_message_map
          ORDER BY updated_at DESC
          OFFSET $1
        )
      `,
      [this.maxEntries],
    );
  }
}
