import assert from "node:assert/strict";
import test from "node:test";
import type { DbQueryResult, DatabaseClient } from "../src/modules/db/postgres-client";
import { DbIdempotencyStore } from "../src/modules/orders/order-idempotency";

type IdempotencyRow = {
  key: string;
  created_at: string;
};

class InMemoryIdempotencyDb implements DatabaseClient {
  private readonly entries = new Map<string, IdempotencyRow>();
  private sequence = 0;

  async query<TRow = Record<string, unknown>>(
    text: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<DbQueryResult<TRow>> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("INSERT INTO idempotency_keys(key)")) {
      const key = String(params[0] ?? "").trim();
      if (!key || this.entries.has(key)) {
        return {
          rows: [],
          rowCount: 0,
        };
      }

      const createdAt = new Date(Date.now() + this.sequence * 1000).toISOString();
      this.sequence += 1;
      const row: IdempotencyRow = {
        key,
        created_at: createdAt,
      };
      this.entries.set(key, row);
      return {
        rows: [row as TRow],
        rowCount: 1,
      };
    }

    if (sql.startsWith("SELECT key, created_at FROM idempotency_keys WHERE key = $1")) {
      const key = String(params[0] ?? "").trim();
      const row = this.entries.get(key);
      return {
        rows: row ? [row as TRow] : [],
        rowCount: row ? 1 : 0,
      };
    }

    if (sql.startsWith("DELETE FROM idempotency_keys WHERE key = $1")) {
      const key = String(params[0] ?? "").trim();
      const existed = this.entries.delete(key);
      return {
        rows: [],
        rowCount: existed ? 1 : 0,
      };
    }

    if (sql.startsWith("DELETE FROM idempotency_keys WHERE key IN ( SELECT key FROM idempotency_keys")) {
      const maxEntries = Number.parseInt(String(params[0] ?? 0), 10);
      if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
        this.entries.clear();
        return {
          rows: [],
          rowCount: 0,
        };
      }

      const ordered = Array.from(this.entries.values()).sort((left, right) =>
        right.created_at.localeCompare(left.created_at),
      );
      const keep = new Set(ordered.slice(0, maxEntries).map((item) => item.key));
      let removed = 0;
      for (const key of Array.from(this.entries.keys())) {
        if (!keep.has(key)) {
          this.entries.delete(key);
          removed += 1;
        }
      }

      return {
        rows: [],
        rowCount: removed,
      };
    }

    throw new Error(`Unsupported SQL in test double: ${sql}`);
  }

  async close(): Promise<void> {
    // no-op for in-memory test DB
  }
}

test("DbIdempotencyStore reserve deduplicates and remove frees key", async () => {
  const db = new InMemoryIdempotencyDb();
  const store = new DbIdempotencyStore(db, 1000);
  await store.init();

  const first = await store.reserve("keycrm:order:1");
  const second = await store.reserve("keycrm:order:1");
  assert.equal(first.created, true);
  assert.equal(second.created, false);

  const removed = await store.remove("keycrm:order:1");
  const removedAgain = await store.remove("keycrm:order:1");
  assert.equal(removed, true);
  assert.equal(removedAgain, false);

  const reinsert = await store.reserve("keycrm:order:1");
  assert.equal(reinsert.created, true);
});
