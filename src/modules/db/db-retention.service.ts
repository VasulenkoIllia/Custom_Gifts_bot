import type { Logger } from "../../observability/logger";
import type { DatabaseClient } from "./postgres-client";

type CreateDbRetentionServiceParams = {
  db: DatabaseClient;
  logger: Logger;
  cleanupIntervalMs: number;
  queueJobRetentionHours: number;
  telegramDeliveryRetentionHours: number;
  forwardingBatchRetentionHours: number;
  deadLetterRetentionHours: number;
};

type CleanupStats = {
  queueJobsDeleted: number;
  telegramDeliveryDeleted: number;
  forwardingBatchDeleted: number;
  deadLettersDeleted: number;
};

export class DbRetentionService {
  private readonly db: DatabaseClient;
  private readonly logger: Logger;
  private readonly cleanupIntervalMs: number;
  private readonly queueJobRetentionHours: number;
  private readonly telegramDeliveryRetentionHours: number;
  private readonly forwardingBatchRetentionHours: number;
  private readonly deadLetterRetentionHours: number;
  private timer: NodeJS.Timeout | null = null;
  private runPromise: Promise<void> | null = null;

  constructor(params: CreateDbRetentionServiceParams) {
    this.db = params.db;
    this.logger = params.logger;
    this.cleanupIntervalMs = Math.max(60_000, Math.floor(params.cleanupIntervalMs));
    this.queueJobRetentionHours = Math.max(1, Math.floor(params.queueJobRetentionHours));
    this.telegramDeliveryRetentionHours = Math.max(
      1,
      Math.floor(params.telegramDeliveryRetentionHours),
    );
    this.forwardingBatchRetentionHours = Math.max(
      1,
      Math.floor(params.forwardingBatchRetentionHours),
    );
    this.deadLetterRetentionHours = Math.max(1, Math.floor(params.deadLetterRetentionHours));
  }

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    await this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.cleanupIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<void> {
    if (this.runPromise) {
      return this.runPromise;
    }

    this.runPromise = this.runCleanup().finally(() => {
      this.runPromise = null;
    });
    return this.runPromise;
  }

  private async runCleanup(): Promise<void> {
    try {
      const stats = await this.cleanupTables();
      this.logger.info("db_retention_cleanup_completed", {
        queueJobsDeleted: stats.queueJobsDeleted,
        telegramDeliveryDeleted: stats.telegramDeliveryDeleted,
        forwardingBatchDeleted: stats.forwardingBatchDeleted,
        deadLettersDeleted: stats.deadLettersDeleted,
        queueJobRetentionHours: this.queueJobRetentionHours,
        telegramDeliveryRetentionHours: this.telegramDeliveryRetentionHours,
        forwardingBatchRetentionHours: this.forwardingBatchRetentionHours,
        deadLetterRetentionHours: this.deadLetterRetentionHours,
      });
    } catch (error) {
      this.logger.warn("db_retention_cleanup_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async cleanupTables(): Promise<CleanupStats> {
    const queueJobsDeleted = await this.deleteRows(
      `
        DELETE FROM queue_jobs
        WHERE status IN ('completed', 'dead_letter')
          AND COALESCE(finished_at, updated_at) < NOW() - ($1 * INTERVAL '1 hour')
      `,
      this.queueJobRetentionHours,
    );
    const telegramDeliveryDeleted = await this.deleteRows(
      `
        DELETE FROM telegram_delivery_records
        WHERE status = 'sent'
          AND COALESCE(finished_at, updated_at) < NOW() - ($1 * INTERVAL '1 hour')
      `,
      this.telegramDeliveryRetentionHours,
    );
    const forwardingBatchDeleted = await this.deleteRows(
      `
        DELETE FROM forwarding_batches
        WHERE status = 'sent'
          AND COALESCE(finished_at, updated_at) < NOW() - ($1 * INTERVAL '1 hour')
      `,
      this.forwardingBatchRetentionHours,
    );
    const deadLettersDeleted = await this.deleteRows(
      `
        DELETE FROM dead_letters
        WHERE recorded_at < NOW() - ($1 * INTERVAL '1 hour')
      `,
      this.deadLetterRetentionHours,
    );

    return {
      queueJobsDeleted,
      telegramDeliveryDeleted,
      forwardingBatchDeleted,
      deadLettersDeleted,
    };
  }

  private async deleteRows(sql: string, retentionHours: number): Promise<number> {
    const result = await this.db.query(sql, [retentionHours]);
    return result.rowCount;
  }
}
