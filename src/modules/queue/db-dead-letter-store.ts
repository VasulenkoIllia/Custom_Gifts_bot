import type { DatabaseClient } from "../db/postgres-client";
import type { QueueDeadLetterEvent } from "./queue.types";

export class DbDeadLetterStore {
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  async init(): Promise<void> {
    // No-op: schema is created in global DB bootstrap.
  }

  async append<TPayload>(event: QueueDeadLetterEvent<TPayload>): Promise<void> {
    await this.db.query(
      `
        INSERT INTO dead_letters(
          queue,
          key,
          job_id,
          attempt,
          max_attempts,
          payload,
          error_type,
          retryable,
          failure_kind,
          error,
          created_at,
          finished_at,
          recorded_at
        )
        VALUES(
          $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10,
          to_timestamp($11 / 1000.0),
          to_timestamp($12 / 1000.0),
          NOW()
        )
      `,
      [
        event.queue,
        event.key,
        event.jobId,
        event.attempt,
        event.maxAttempts,
        JSON.stringify(event.payload),
        event.errorType,
        event.retryable,
        event.failureKind,
        event.error,
        event.createdAt,
        event.finishedAt,
      ],
    );
  }
}
