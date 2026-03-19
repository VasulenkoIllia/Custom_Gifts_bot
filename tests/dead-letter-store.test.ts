import assert from "node:assert/strict";
import test from "node:test";
import type { DbQueryResult, DatabaseClient } from "../src/modules/db/postgres-client";
import { DbDeadLetterStore } from "../src/modules/queue/db-dead-letter-store";

class RecordingDatabaseClient implements DatabaseClient {
  readonly calls: Array<{ text: string; params: ReadonlyArray<unknown> }> = [];

  async query<TRow = Record<string, unknown>>(
    text: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<DbQueryResult<TRow>> {
    this.calls.push({
      text,
      params,
    });
    return {
      rows: [],
      rowCount: 1,
    };
  }

  async close(): Promise<void> {
    // no-op for tests
  }
}

test("DbDeadLetterStore persists DLQ records to database", async () => {
  const db = new RecordingDatabaseClient();
  const store = new DbDeadLetterStore(db);
  await store.init();
  await store.append({
    queue: "order_intake",
    key: "order:1",
    jobId: "j1",
    attempt: 3,
    maxAttempts: 3,
    payload: { orderId: "1" },
    errorType: "OrderProcessingError",
    retryable: false,
    failureKind: "pdf_generation",
    error: "failed",
    createdAt: Date.now() - 1000,
    finishedAt: Date.now(),
  });

  assert.equal(db.calls.length, 1);
  const call = db.calls[0];
  assert.ok(call);
  assert.match(call.text, /INSERT INTO dead_letters/i);
  assert.equal(call.params[0], "order_intake");
  assert.equal(call.params[1], "order:1");
  assert.equal(call.params[2], "j1");
  assert.equal(call.params[3], 3);
  assert.equal(call.params[4], 3);

  const payloadParam = String(call.params[5] ?? "");
  const payload = JSON.parse(payloadParam) as { orderId: string };
  assert.equal(payload.orderId, "1");
});
