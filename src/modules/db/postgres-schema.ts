import type { DatabaseClient } from "./postgres-client";

export async function ensurePostgresSchema(db: DatabaseClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS telegram_message_map (
      chat_id TEXT NOT NULL,
      message_id BIGINT NOT NULL,
      order_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_heart_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, message_id)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS order_workflow_state (
      order_id TEXT PRIMARY KEY,
      highest_stage_index INTEGER NOT NULL,
      applied_status_id INTEGER NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_heart_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS dead_letters (
      id BIGSERIAL PRIMARY KEY,
      queue TEXT NOT NULL,
      key TEXT NOT NULL,
      job_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      payload JSONB NOT NULL,
      error_type TEXT NOT NULL,
      retryable BOOLEAN NOT NULL DEFAULT FALSE,
      failure_kind TEXT NULL,
      error TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_dead_letters_queue_recorded_at
      ON dead_letters(queue, recorded_at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_telegram_message_map_order_id
      ON telegram_message_map(order_id, updated_at DESC);
  `);
}
