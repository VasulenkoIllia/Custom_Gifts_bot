import assert from "node:assert/strict";
import test from "node:test";
import { DbRetentionService } from "../src/modules/db/db-retention.service";
import type { DbQueryResult, DatabaseClient } from "../src/modules/db/postgres-client";

class RecordingDatabaseClient implements DatabaseClient {
  readonly calls: Array<{ text: string; params: ReadonlyArray<unknown> }> = [];

  async query<TRow = Record<string, unknown>>(
    text: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<DbQueryResult<TRow>> {
    this.calls.push({ text, params });

    if (/DELETE FROM queue_jobs/i.test(text)) {
      return { rows: [], rowCount: 4 };
    }
    if (/DELETE FROM telegram_delivery_records/i.test(text)) {
      return { rows: [], rowCount: 3 };
    }
    if (/DELETE FROM forwarding_batches/i.test(text)) {
      return { rows: [], rowCount: 2 };
    }
    if (/DELETE FROM dead_letters/i.test(text)) {
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }

  async close(): Promise<void> {
    return undefined;
  }
}

function noopLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

test("DbRetentionService deletes stale operational records", async () => {
  const db = new RecordingDatabaseClient();
  const service = new DbRetentionService({
    db,
    logger: noopLogger(),
    cleanupIntervalMs: 60_000,
    queueJobRetentionHours: 72,
    telegramDeliveryRetentionHours: 720,
    forwardingBatchRetentionHours: 720,
    deadLetterRetentionHours: 336,
  });

  await service.runOnce();

  assert.equal(db.calls.length, 4);
  assert.match(db.calls[0]?.text ?? "", /DELETE FROM queue_jobs/i);
  assert.deepEqual(db.calls[0]?.params, [72]);
  assert.match(db.calls[1]?.text ?? "", /DELETE FROM telegram_delivery_records/i);
  assert.deepEqual(db.calls[1]?.params, [720]);
  assert.match(db.calls[2]?.text ?? "", /DELETE FROM forwarding_batches/i);
  assert.deepEqual(db.calls[2]?.params, [720]);
  assert.match(db.calls[3]?.text ?? "", /DELETE FROM dead_letters/i);
  assert.deepEqual(db.calls[3]?.params, [336]);
});
