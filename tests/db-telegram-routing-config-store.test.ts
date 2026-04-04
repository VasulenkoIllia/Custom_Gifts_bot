import assert from "node:assert/strict";
import test from "node:test";
import type { DbQueryResult, DatabaseClient } from "../src/modules/db/postgres-client";
import { DbTelegramRoutingConfigStore } from "../src/modules/telegram/db-telegram-routing-config-store";

type RoutingSettingsRow = {
  singleton_key: string;
  forward_mode: string;
};

type RoutingDestinationRow = {
  destination: string;
  chat_id: string;
  thread_id: string;
};

class InMemoryTelegramRoutingDb implements DatabaseClient {
  private settings: RoutingSettingsRow | null = null;
  private readonly destinations = new Map<string, RoutingDestinationRow>();

  async query<TRow = Record<string, unknown>>(
    text: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<DbQueryResult<TRow>> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("SELECT singleton_key FROM telegram_routing_settings")) {
      return {
        rows: this.settings ? ([{ singleton_key: this.settings.singleton_key }] as TRow[]) : [],
        rowCount: this.settings ? 1 : 0,
      };
    }

    if (sql.startsWith("INSERT INTO telegram_routing_settings(")) {
      if (!this.settings) {
        this.settings = {
          singleton_key: "default",
          forward_mode: String(params[0] ?? "copy"),
        };
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("SELECT destination FROM telegram_routing_destinations")) {
      return {
        rows: Array.from(this.destinations.values()).map((row) => ({ destination: row.destination })) as TRow[],
        rowCount: this.destinations.size,
      };
    }

    if (sql.startsWith("INSERT INTO telegram_routing_destinations(")) {
      const destination = String(params[0] ?? "").trim();
      if (!this.destinations.has(destination)) {
        this.destinations.set(destination, {
          destination,
          chat_id: String(params[1] ?? "").trim(),
          thread_id: String(params[2] ?? "").trim(),
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("SELECT forward_mode FROM telegram_routing_settings")) {
      return {
        rows: this.settings ? ([{ forward_mode: this.settings.forward_mode }] as TRow[]) : [],
        rowCount: this.settings ? 1 : 0,
      };
    }

    if (sql.startsWith("SELECT destination, chat_id, thread_id FROM telegram_routing_destinations")) {
      const rows = Array.from(this.destinations.values()).sort((left, right) =>
        left.destination.localeCompare(right.destination),
      );
      return {
        rows: rows as TRow[],
        rowCount: rows.length,
      };
    }

    throw new Error(`Unsupported SQL in test double: ${sql}`);
  }

  async close(): Promise<void> {
    // no-op
  }
}

test("DbTelegramRoutingConfigStore seeds routing config once and loads DB-backed values", async () => {
  const db = new InMemoryTelegramRoutingDb();
  const store = new DbTelegramRoutingConfigStore(db);
  await store.init();

  await store.seedIfEmpty({
    forwardMode: "copy",
    destinations: {
      processing: { chatId: "-100-processing", threadId: "10" },
      orders: { chatId: "-100-orders", threadId: "20" },
      ops: { chatId: "-100-ops", threadId: "" },
    },
  });

  const loaded = await store.load();
  assert.equal(loaded.forwardMode, "copy");
  assert.deepEqual(loaded.destinations.processing, {
    chatId: "-100-processing",
    threadId: "10",
  });
  assert.deepEqual(loaded.destinations.orders, {
    chatId: "-100-orders",
    threadId: "20",
  });
  assert.deepEqual(loaded.destinations.ops, {
    chatId: "-100-ops",
    threadId: "",
  });
});

test("DbTelegramRoutingConfigStore does not require env seed after DB is initialized", async () => {
  const db = new InMemoryTelegramRoutingDb();
  const store = new DbTelegramRoutingConfigStore(db);
  await store.init();

  await store.seedIfEmpty({
    forwardMode: "forward",
    destinations: {
      processing: { chatId: "-100-processing", threadId: "" },
      orders: { chatId: "-100-orders", threadId: "" },
      ops: { chatId: "-100-processing", threadId: "" },
    },
  });

  await store.seedIfEmpty({
    forwardMode: "copy",
    destinations: {
      processing: { chatId: "", threadId: "" },
      orders: { chatId: "", threadId: "" },
      ops: { chatId: "", threadId: "" },
    },
  });

  const loaded = await store.load();
  assert.equal(loaded.forwardMode, "forward");
  assert.equal(loaded.destinations.processing.chatId, "-100-processing");
  assert.equal(loaded.destinations.orders.chatId, "-100-orders");
});
