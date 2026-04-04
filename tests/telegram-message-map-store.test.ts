import assert from "node:assert/strict";
import test from "node:test";
import type { DbQueryResult, DatabaseClient } from "../src/modules/db/postgres-client";
import { DbTelegramMessageMapStore } from "../src/modules/telegram/db-telegram-message-map-store";

type MessageRow = {
  chat_id: string;
  message_id: number;
  order_id: string;
  created_at: string;
  updated_at: string;
  last_heart_count: number;
};

type WorkflowRow = {
  order_id: string;
  highest_stage_index: number;
  applied_status_id: number | null;
  updated_at: string;
  last_heart_count: number;
};

class InMemoryTelegramDb implements DatabaseClient {
  private readonly messages = new Map<string, MessageRow>();
  private readonly orderStates = new Map<string, WorkflowRow>();
  private sequence = 0;

  async query<TRow = Record<string, unknown>>(
    text: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<DbQueryResult<TRow>> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("INSERT INTO telegram_message_map(")) {
      const chatId = String(params[0] ?? "").trim();
      const messageId = Number.parseInt(String(params[1] ?? ""), 10);
      const orderId = String(params[2] ?? "").trim();
      const key = `${chatId}:${messageId}`;
      const now = new Date(Date.now() + this.sequence * 1000).toISOString();
      this.sequence += 1;

      const existing = this.messages.get(key);
      this.messages.set(key, {
        chat_id: chatId,
        message_id: messageId,
        order_id: orderId,
        created_at: existing?.created_at ?? now,
        updated_at: now,
        last_heart_count: existing?.last_heart_count ?? 0,
      });
      return {
        rows: [],
        rowCount: 1,
      };
    }

    if (sql.startsWith("DELETE FROM telegram_message_map WHERE (chat_id, message_id) IN")) {
      const maxEntries = Number.parseInt(String(params[0] ?? 0), 10);
      const ordered = Array.from(this.messages.values()).sort((left, right) =>
        right.updated_at.localeCompare(left.updated_at),
      );
      const keep = new Set(
        ordered.slice(0, Math.max(0, maxEntries)).map((item) => `${item.chat_id}:${item.message_id}`),
      );
      let removed = 0;
      for (const key of Array.from(this.messages.keys())) {
        if (!keep.has(key)) {
          this.messages.delete(key);
          removed += 1;
        }
      }
      return {
        rows: [],
        rowCount: removed,
      };
    }

    if (sql.startsWith("SELECT order_id FROM telegram_message_map WHERE chat_id = $1")) {
      const chatId = String(params[0] ?? "").trim();
      const messageId = Number.parseInt(String(params[1] ?? ""), 10);
      const row = this.messages.get(`${chatId}:${messageId}`);
      return {
        rows: row ? ([{ order_id: row.order_id }] as TRow[]) : [],
        rowCount: row ? 1 : 0,
      };
    }

    if (sql.startsWith("SELECT chat_id, message_id FROM telegram_message_map WHERE order_id = $1")) {
      const orderId = String(params[0] ?? "").trim();
      const rows = Array.from(this.messages.values())
        .filter((row) => row.order_id === orderId)
        .sort(
          (left, right) =>
            left.created_at.localeCompare(right.created_at) || left.message_id - right.message_id,
        )
        .map((row) => ({
          chat_id: row.chat_id,
          message_id: row.message_id,
        }));
      return {
        rows: rows as TRow[],
        rowCount: rows.length,
      };
    }

    if (sql.startsWith("UPDATE telegram_message_map SET last_heart_count = $3")) {
      const chatId = String(params[0] ?? "").trim();
      const messageId = Number.parseInt(String(params[1] ?? ""), 10);
      const heartCount = Number.parseInt(String(params[2] ?? 0), 10);
      const key = `${chatId}:${messageId}`;
      const row = this.messages.get(key);
      if (!row) {
        return {
          rows: [],
          rowCount: 0,
        };
      }
      const updatedAt = new Date(Date.now() + this.sequence * 1000).toISOString();
      this.sequence += 1;
      this.messages.set(key, {
        ...row,
        last_heart_count: heartCount,
        updated_at: updatedAt,
      });
      return {
        rows: [],
        rowCount: 1,
      };
    }

    if (sql.startsWith("SELECT order_id, highest_stage_index, applied_status_id, updated_at, last_heart_count FROM order_workflow_state")) {
      const orderId = String(params[0] ?? "").trim();
      const row = this.orderStates.get(orderId);
      return {
        rows: row ? ([row] as TRow[]) : [],
        rowCount: row ? 1 : 0,
      };
    }

    if (sql.startsWith("INSERT INTO order_workflow_state(")) {
      const orderId = String(params[0] ?? "").trim();
      const highestStageIndex = Number.parseInt(String(params[1] ?? -1), 10);
      const appliedStatusIdRaw = params[2];
      const appliedStatusId =
        Number.isFinite(appliedStatusIdRaw) && Number(appliedStatusIdRaw) > 0
          ? Number(appliedStatusIdRaw)
          : null;
      const lastHeartCount = Number.parseInt(String(params[3] ?? 0), 10);
      const updatedAt = new Date(Date.now() + this.sequence * 1000).toISOString();
      this.sequence += 1;

      const row: WorkflowRow = {
        order_id: orderId,
        highest_stage_index: highestStageIndex,
        applied_status_id: appliedStatusId,
        updated_at: updatedAt,
        last_heart_count: lastHeartCount,
      };
      this.orderStates.set(orderId, row);
      return {
        rows: [row as TRow],
        rowCount: 1,
      };
    }

    throw new Error(`Unsupported SQL in test double: ${sql}`);
  }

  async close(): Promise<void> {
    // no-op for in-memory test DB
  }
}

test("DbTelegramMessageMapStore links messages and resolves order id", async () => {
  const db = new InMemoryTelegramDb();
  const store = new DbTelegramMessageMapStore(db, 1000);
  await store.init();
  await store.linkMessages({
    orderId: "1001",
    chatId: "-100100",
    messageIds: [501, 502],
  });

  const by501 = await store.getOrderIdByMessage("-100100", 501);
  const by502 = await store.getOrderIdByMessage("-100100", 502);
  assert.equal(by501, "1001");
  assert.equal(by502, "1001");
});

test("DbTelegramMessageMapStore stores workflow state and heart count", async () => {
  const db = new InMemoryTelegramDb();
  const store = new DbTelegramMessageMapStore(db, 1000);
  await store.init();

  await store.linkMessages({
    orderId: "2002",
    chatId: "-100200",
    messageIds: [601],
  });
  await store.markMessageHeartCount("-100200", 601, 2);

  await store.upsertOrderState({
    orderId: "2002",
    highestStageIndex: 0,
    appliedStatusId: 22,
    lastHeartCount: 1,
  });

  const first = await store.getOrderState("2002");
  assert.equal(first?.highestStageIndex, 0);
  assert.equal(first?.appliedStatusId, 22);
  assert.equal(first?.lastHeartCount, 1);

  await store.upsertOrderState({
    orderId: "2002",
    highestStageIndex: 1,
    appliedStatusId: 7,
    lastHeartCount: 2,
  });

  const second = await store.getOrderState("2002");
  assert.equal(second?.highestStageIndex, 1);
  assert.equal(second?.appliedStatusId, 7);
  assert.equal(second?.lastHeartCount, 2);
});

test("DbTelegramMessageMapStore lists ordered file messages by order", async () => {
  const db = new InMemoryTelegramDb();
  const store = new DbTelegramMessageMapStore(db, 1000);
  await store.init();

  await store.linkMessages({
    orderId: "3003",
    chatId: "-100300",
    messageIds: [701, 703, 702],
  });

  const messages = await store.listMessagesByOrder("3003");
  assert.deepEqual(messages, [
    { chatId: "-100300", messageId: 701 },
    { chatId: "-100300", messageId: 703 },
    { chatId: "-100300", messageId: 702 },
  ]);
});
