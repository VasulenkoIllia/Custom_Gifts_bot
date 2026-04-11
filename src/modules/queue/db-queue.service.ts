import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../db/postgres-client";
import { QueueOverflowError } from "./queue-errors";
import type {
  QueueDeadLetterEvent,
  QueueEnqueueInput,
  QueueEnqueueResult,
  QueueEnqueueWithIdempotencyInput,
  QueueEnqueueWithIdempotencyResult,
  QueueHandler,
  QueueJob,
  QueueOptions,
  QueueStateEvent,
  QueueStats,
} from "./queue.types";
export { QueueOverflowError } from "./queue-errors";

type DbQueueJobRow = {
  id: string;
  queue_name: string;
  job_key: string;
  payload: unknown;
  status: string;
  attempt: number;
  max_attempts: number;
  available_at: string | Date;
  created_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  error_type: string | null;
  retryable: boolean;
  failure_kind: string | null;
  error: string | null;
};

type EnqueueOutcomeRow = {
  outcome: "inserted" | "deduplicated" | "overflow" | "idempotent_duplicate";
  job_id: string | null;
};

type QueueStatsRow = {
  pending: number;
  running: number;
  inflight_keys: number;
};

type DbQueueServiceOptions<TPayload> = QueueOptions<TPayload> & {
  db: DatabaseClient;
  pollIntervalMs: number;
};

export class DbQueueService<TPayload> {
  private readonly db: DatabaseClient;
  private readonly name: string;
  private readonly concurrency: number;
  private readonly maxQueueSize: number;
  private readonly jobTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly shouldRetry: NonNullable<QueueOptions<TPayload>["shouldRetry"]>;
  private readonly onDeadLetter: NonNullable<QueueOptions<TPayload>["onDeadLetter"]> | null;
  private readonly handler: QueueHandler<TPayload>;
  private readonly onStateChange: QueueOptions<TPayload>["onStateChange"];
  private readonly workerInstanceId: string;

  private started = false;
  private closing = false;
  private readonly runners = new Set<Promise<void>>();
  private readonly activeExecutions = new Set<Promise<void>>();
  private statsSnapshot: { value: QueueStats; at: number } | null = null;
  private readonly statsSnapshotTtlMs = 500;

  constructor(options: DbQueueServiceOptions<TPayload>) {
    this.db = options.db;
    this.name = options.name;
    this.concurrency = Math.max(1, Math.floor(options.concurrency));
    this.maxQueueSize = Math.max(1, Math.floor(options.maxQueueSize));
    this.jobTimeoutMs = Math.max(1_000, Math.floor(options.jobTimeoutMs));
    this.pollIntervalMs = Math.max(100, Math.floor(options.pollIntervalMs));
    this.maxAttempts = Number.isFinite(options.maxAttempts)
      ? Math.max(1, Math.floor(Number(options.maxAttempts)))
      : 1;
    this.retryBaseMs = Number.isFinite(options.retryBaseMs)
      ? Math.max(100, Math.floor(Number(options.retryBaseMs)))
      : 500;
    this.shouldRetry =
      options.shouldRetry ??
      ((params) => {
        const candidate = params.error as { retryable?: unknown };
        return candidate?.retryable === true;
      });
    this.onDeadLetter = options.onDeadLetter ?? null;
    this.handler = options.handler;
    this.onStateChange = options.onStateChange;
    this.workerInstanceId = `${this.name}:${randomUUID()}`;
  }

  async enqueue(input: QueueEnqueueInput<TPayload>): Promise<QueueEnqueueResult> {
    const key = String(input.key ?? "").trim();
    if (!key) {
      throw new Error("Queue key is required.");
    }

    const jobId = `${this.name}_${randomUUID()}`;
    const outcomeResult = await this.db.query<EnqueueOutcomeRow>(
      `
        WITH queue_lock AS (
          SELECT pg_advisory_xact_lock(hashtext($1))
        ),
        queue_load AS (
          SELECT COUNT(*)::int AS active_count
          FROM queue_jobs
          WHERE queue_name = $1
            AND status IN ('queued', 'running')
        ),
        inserted AS (
          INSERT INTO queue_jobs(
            id,
            queue_name,
            job_key,
            payload,
            status,
            attempt,
            max_attempts,
            available_at,
            created_at,
            updated_at
          )
          SELECT
            $2,
            $1,
            $3,
            $4::jsonb,
            'queued',
            1,
            $5,
            NOW(),
            NOW(),
            NOW()
          FROM queue_load
          WHERE active_count < $6
          ON CONFLICT (queue_name, job_key)
            WHERE status IN ('queued', 'running')
          DO NOTHING
          RETURNING id
        ),
        existing AS (
          SELECT id
          FROM queue_jobs
          WHERE queue_name = $1
            AND job_key = $3
            AND status IN ('queued', 'running')
          LIMIT 1
        )
        SELECT
          CASE
            WHEN EXISTS(SELECT 1 FROM inserted) THEN 'inserted'
            WHEN EXISTS(SELECT 1 FROM existing) THEN 'deduplicated'
            ELSE 'overflow'
          END AS outcome,
          COALESCE(
            (SELECT id FROM inserted LIMIT 1),
            (SELECT id FROM existing LIMIT 1)
          ) AS job_id
      `,
      [this.name, jobId, key, JSON.stringify(input.payload), this.maxAttempts, this.maxQueueSize],
    );

    const outcome = outcomeResult.rows[0]?.outcome ?? "overflow";
    if (outcome === "overflow") {
      throw new QueueOverflowError(`Queue ${this.name} is full (${this.maxQueueSize}).`);
    }

    const stats = await this.getStats();
    return {
      jobId: outcomeResult.rows[0]?.job_id ?? jobId,
      deduplicated: outcome === "deduplicated",
      queue: stats,
    };
  }

  async enqueueWithIdempotency(
    input: QueueEnqueueWithIdempotencyInput<TPayload>,
  ): Promise<QueueEnqueueWithIdempotencyResult> {
    const key = String(input.key ?? "").trim();
    if (!key) {
      throw new Error("Queue key is required.");
    }

    const idempotencyKey = String(input.idempotencyKey ?? "").trim();
    if (!idempotencyKey) {
      throw new Error("Idempotency key is required.");
    }

    const jobId = `${this.name}_${randomUUID()}`;
    const outcomeResult = await this.db.query<EnqueueOutcomeRow>(
      `
        WITH queue_lock AS (
          SELECT pg_advisory_xact_lock(hashtext($1))
        ),
        existing AS (
          SELECT id
          FROM queue_jobs
          WHERE queue_name = $1
            AND job_key = $3
            AND status IN ('queued', 'running')
          LIMIT 1
        ),
        queue_load AS (
          SELECT COUNT(*)::int AS active_count
          FROM queue_jobs
          WHERE queue_name = $1
            AND status IN ('queued', 'running')
        ),
        eligibility AS (
          SELECT
            (active_count < $6 OR EXISTS(SELECT 1 FROM existing)) AS can_accept
          FROM queue_load
        ),
        idempotency_existing AS (
          SELECT key
          FROM idempotency_keys
          WHERE key = $7
          LIMIT 1
        ),
        idempotency_inserted AS (
          INSERT INTO idempotency_keys(key)
          SELECT $7
          FROM eligibility
          WHERE can_accept
            AND NOT EXISTS(SELECT 1 FROM idempotency_existing)
          RETURNING key
        ),
        inserted AS (
          INSERT INTO queue_jobs(
            id,
            queue_name,
            job_key,
            payload,
            status,
            attempt,
            max_attempts,
            available_at,
            created_at,
            updated_at
          )
          SELECT
            $2,
            $1,
            $3,
            $4::jsonb,
            'queued',
            1,
            $5,
            NOW(),
            NOW(),
            NOW()
          FROM queue_load
          WHERE active_count < $6
            AND EXISTS(SELECT 1 FROM idempotency_inserted)
          ON CONFLICT (queue_name, job_key)
            WHERE status IN ('queued', 'running')
          DO NOTHING
          RETURNING id
        )
        SELECT
          CASE
            WHEN EXISTS(SELECT 1 FROM idempotency_existing) THEN 'idempotent_duplicate'
            WHEN NOT EXISTS(SELECT 1 FROM eligibility WHERE can_accept) THEN 'overflow'
            WHEN EXISTS(SELECT 1 FROM inserted) THEN 'inserted'
            WHEN EXISTS(SELECT 1 FROM existing) THEN 'deduplicated'
            ELSE 'overflow'
          END AS outcome,
          COALESCE(
            (SELECT id FROM inserted LIMIT 1),
            (SELECT id FROM existing LIMIT 1)
          ) AS job_id
      `,
      [
        this.name,
        jobId,
        key,
        JSON.stringify(input.payload),
        this.maxAttempts,
        this.maxQueueSize,
        idempotencyKey,
      ],
    );

    const outcome = outcomeResult.rows[0]?.outcome ?? "overflow";
    if (outcome === "overflow") {
      throw new QueueOverflowError(`Queue ${this.name} is full (${this.maxQueueSize}).`);
    }

    const stats = await this.getStats();
    return {
      jobId: outcomeResult.rows[0]?.job_id ?? jobId,
      deduplicated: outcome === "deduplicated",
      idempotentDuplicate: outcome === "idempotent_duplicate",
      queue: stats,
    };
  }

  async getStats(): Promise<QueueStats> {
    const result = await this.db.query<QueueStatsRow>(
      `
        SELECT
          COUNT(*) FILTER (WHERE status = 'queued')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'running')::int AS running,
          COUNT(*) FILTER (WHERE status IN ('queued', 'running'))::int AS inflight_keys
        FROM queue_jobs
        WHERE queue_name = $1
      `,
      [this.name],
    );

    const row = result.rows[0];
    const stats: QueueStats = {
      name: this.name,
      concurrency: this.concurrency,
      maxQueueSize: this.maxQueueSize,
      pending: toNonNegativeInteger(row?.pending),
      running: toNonNegativeInteger(row?.running),
      inflightKeys: toNonNegativeInteger(row?.inflight_keys),
    };
    this.statsSnapshot = {
      value: stats,
      at: Date.now(),
    };
    return stats;
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    for (let index = 0; index < this.concurrency; index += 1) {
      const runner = this.runLoop().finally(() => {
        this.runners.delete(runner);
      });
      this.runners.add(runner);
    }
  }

  async close(timeoutMs = 30_000): Promise<void> {
    this.closing = true;

    const runnerPromises = Array.from(this.runners);
    await Promise.all(runnerPromises);

    const startedAt = Date.now();
    while (this.activeExecutions.size > 0) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(
          `Queue ${this.name} shutdown timeout: active=${this.activeExecutions.size}.`,
        );
      }

      await sleep(50);
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.closing) {
      try {
        const recovered = await this.recoverExpiredJob();
        if (recovered) {
          continue;
        }

        const job = await this.claimNextJob();
        if (!job) {
          await sleep(this.pollIntervalMs);
          continue;
        }

        const execution = this.execute(job).finally(() => {
          this.activeExecutions.delete(execution);
        });
        this.activeExecutions.add(execution);
        await execution;
      } catch (_error) {
        // Keep each runner self-healing even if one DB/handler step throws.
        await sleep(this.pollIntervalMs);
      }
    }
  }

  private async execute(job: QueueJob<TPayload>): Promise<void> {
    await this.emitState(job);
    const heartbeat = this.startHeartbeat(job.id);

    try {
      await this.handler(job);
      clearInterval(heartbeat);
      const completed = await this.completeJob(job.id);
      if (completed) {
        await this.emitState({
          ...job,
          status: "completed",
          finishedAt: Date.now(),
        });
      }
    } catch (error) {
      clearInterval(heartbeat);
      const retryable = this.shouldRetry({
        error,
        job,
      });
      const canRetry = retryable && job.attempt < job.maxAttempts;
      if (canRetry) {
        const retryDelayMs = this.computeRetryDelay(job.attempt);
        const retried = await this.retryJob(job.id, {
          error,
          retryable,
          retryDelayMs,
        });
        if (retried) {
          await this.emitState(
            {
              ...job,
              status: "queued",
              attempt: job.attempt + 1,
            },
            error,
            {
              willRetry: true,
              retryDelayMs,
            },
          );
        }
        return;
      }

      const failedJob = await this.failJob(job.id, error, retryable);
      if (failedJob) {
        await this.emitState(failedJob, error);
        await this.handleDeadLetter(failedJob, error, retryable);
      }
    }
  }

  private async recoverExpiredJob(): Promise<boolean> {
    const expiredResult = await this.db.query<DbQueueJobRow>(
      `
        WITH expired AS (
          SELECT id
          FROM queue_jobs
          WHERE queue_name = $1
            AND status = 'running'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= NOW()
          ORDER BY lease_expires_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE queue_jobs
        SET
          lease_owner = $2,
          lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
          updated_at = NOW()
        WHERE id = (SELECT id FROM expired)
        RETURNING
          id,
          queue_name,
          job_key,
          payload,
          status,
          attempt,
          max_attempts,
          available_at,
          created_at,
          started_at,
          finished_at,
          error_type,
          retryable,
          failure_kind,
          error
      `,
      [this.name, this.workerInstanceId, this.jobTimeoutMs],
    );

    const row = expiredResult.rows[0];
    if (!row) {
      return false;
    }

    const timeoutError = new Error(
      `Queue lease expired before job completion in ${this.name}.`,
    ) as Error & { retryable?: boolean; failureKind?: string };
    timeoutError.name = "QueueLeaseExpiredError";
    timeoutError.retryable = true;
    timeoutError.failureKind = typeof row.failure_kind === "string" ? row.failure_kind : undefined;
    const job = this.toQueueJob(row);
    const canRetry = job.attempt < job.maxAttempts;
    if (canRetry) {
      const retryDelayMs = this.computeRetryDelay(job.attempt);
      const retried = await this.retryJob(job.id, {
        error: timeoutError,
        retryable: true,
        retryDelayMs,
      });
      if (retried) {
        await this.emitState(
          {
            ...job,
            status: "queued",
            attempt: job.attempt + 1,
          },
          timeoutError,
          {
            willRetry: true,
            retryDelayMs,
          },
        );
      }
      return true;
    }

    const failedJob = await this.failJob(job.id, timeoutError, true);
    if (failedJob) {
      await this.emitState(failedJob, timeoutError);
      await this.handleDeadLetter(failedJob, timeoutError, true);
    }
    return true;
  }

  private async claimNextJob(): Promise<QueueJob<TPayload> | null> {
    const result = await this.db.query<DbQueueJobRow>(
      `
        WITH candidate AS (
          SELECT id
          FROM queue_jobs
          WHERE queue_name = $1
            AND status = 'queued'
            AND available_at <= NOW()
          ORDER BY available_at ASC, created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE queue_jobs
        SET
          status = 'running',
          started_at = COALESCE(started_at, NOW()),
          updated_at = NOW(),
          lease_owner = $2,
          lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond')
        WHERE id = (SELECT id FROM candidate)
        RETURNING
          id,
          queue_name,
          job_key,
          payload,
          status,
          attempt,
          max_attempts,
          available_at,
          created_at,
          started_at,
          finished_at,
          error_type,
          retryable,
          failure_kind,
          error
      `,
      [this.name, this.workerInstanceId, this.jobTimeoutMs],
    );

    const row = result.rows[0];
    return row ? this.toQueueJob(row) : null;
  }

  private startHeartbeat(jobId: string): NodeJS.Timeout {
    const intervalMs = Math.max(500, Math.min(5_000, Math.floor(this.jobTimeoutMs / 3)));
    return setInterval(() => {
      void this.db
        .query(
          `
            UPDATE queue_jobs
            SET
              lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
              updated_at = NOW()
            WHERE id = $1
              AND queue_name = $2
              AND status = 'running'
              AND lease_owner = $4
          `,
          [jobId, this.name, this.jobTimeoutMs, this.workerInstanceId],
        )
        .catch(() => {
          // Keep handler execution authoritative; recovery will happen via lease expiry if needed.
        });
    }, intervalMs);
  }

  private async completeJob(jobId: string): Promise<boolean> {
    const result = await this.db.query(
      `
        UPDATE queue_jobs
        SET
          status = 'completed',
          finished_at = NOW(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
        WHERE id = $1
          AND queue_name = $2
          AND lease_owner = $3
      `,
      [jobId, this.name, this.workerInstanceId],
    );

    return result.rowCount > 0;
  }

  private async retryJob(
    jobId: string,
    params: {
      error: unknown;
      retryable: boolean;
      retryDelayMs: number;
    },
  ): Promise<boolean> {
    const result = await this.db.query(
      `
        UPDATE queue_jobs
        SET
          status = 'queued',
          attempt = attempt + 1,
          available_at = NOW() + ($3 * INTERVAL '1 millisecond'),
          lease_owner = NULL,
          lease_expires_at = NULL,
          error_type = $4,
          retryable = $5,
          failure_kind = $6,
          error = $7,
          updated_at = NOW()
        WHERE id = $1
          AND queue_name = $2
          AND lease_owner = $8
      `,
      [
        jobId,
        this.name,
        params.retryDelayMs,
        extractErrorType(params.error),
        params.retryable,
        extractFailureKind(params.error),
        extractErrorMessage(params.error),
        this.workerInstanceId,
      ],
    );

    return result.rowCount > 0;
  }

  private async failJob(
    jobId: string,
    error: unknown,
    retryable: boolean,
  ): Promise<QueueJob<TPayload> | null> {
    const result = await this.db.query<DbQueueJobRow>(
      `
        UPDATE queue_jobs
        SET
          status = 'dead_letter',
          finished_at = NOW(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          error_type = $3,
          retryable = $4,
          failure_kind = $5,
          error = $6,
          updated_at = NOW()
        WHERE id = $1
          AND queue_name = $2
          AND lease_owner = $7
        RETURNING
          id,
          queue_name,
          job_key,
          payload,
          status,
          attempt,
          max_attempts,
          available_at,
          created_at,
          started_at,
          finished_at,
          error_type,
          retryable,
          failure_kind,
          error
      `,
      [
        jobId,
        this.name,
        extractErrorType(error),
        retryable,
        extractFailureKind(error),
        extractErrorMessage(error),
        this.workerInstanceId,
      ],
    );

    const row = result.rows[0];
    return row ? this.toQueueJob(row) : null;
  }

  private async handleDeadLetter(
    job: QueueJob<TPayload>,
    error: unknown,
    retryable: boolean,
  ): Promise<void> {
    if (!this.onDeadLetter) {
      return;
    }

    const event: QueueDeadLetterEvent<TPayload> = {
      queue: this.name,
      key: job.key,
      jobId: job.id,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      payload: job.payload,
      errorType: extractErrorType(error),
      retryable,
      failureKind: extractFailureKind(error),
      error: extractErrorMessage(error),
      createdAt: job.createdAt,
      finishedAt: job.finishedAt ?? Date.now(),
    };

    try {
      await this.onDeadLetter(event);
    } catch (_error) {
      // DLQ persistence must not crash the worker loop.
    }
  }

  private async emitState(
    job: QueueJob<TPayload>,
    error?: unknown,
    retryMeta: { willRetry: boolean; retryDelayMs: number | null } = {
      willRetry: false,
      retryDelayMs: null,
    },
  ): Promise<void> {
    if (!this.onStateChange) {
      return;
    }

    try {
      const stats = await this.getStatsSnapshot();
      const normalizedStatus = job.status === "failed" ? "failed" : job.status;
      const event: QueueStateEvent<TPayload> = {
        queue: this.name,
        key: job.key,
        jobId: job.id,
        status: normalizedStatus,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        willRetry: retryMeta.willRetry,
        retryDelayMs: retryMeta.retryDelayMs,
        payload: job.payload,
        error: error ? extractErrorMessage(error) : undefined,
        stats,
      };
      this.onStateChange(event);
    } catch (_error) {
      // State callbacks are observability only.
    }
  }

  private async getStatsSnapshot(): Promise<QueueStats> {
    const now = Date.now();
    const cached = this.statsSnapshot;
    if (cached && now - cached.at <= this.statsSnapshotTtlMs) {
      return cached.value;
    }

    const value = await this.getStats();
    this.statsSnapshot = {
      value,
      at: now,
    };
    return value;
  }

  private computeRetryDelay(attempt: number): number {
    const exponential = this.retryBaseMs * Math.pow(2, Math.max(0, attempt - 1));
    const jitter = Math.floor(Math.random() * Math.min(1_000, this.retryBaseMs));
    return Math.min(60_000, exponential + jitter);
  }

  private toQueueJob(row: DbQueueJobRow | undefined): QueueJob<TPayload> {
    if (!row) {
      throw new Error(`Queue ${this.name} returned no job row.`);
    }

    return {
      id: String(row.id),
      key: String(row.job_key),
      payload: parsePayload<TPayload>(row.payload),
      status: row.status === "dead_letter" ? "failed" : normalizeStatus(row.status),
      attempt: Math.max(1, Number(row.attempt)),
      maxAttempts: Math.max(1, Number(row.max_attempts)),
      createdAt: new Date(String(row.created_at)).getTime(),
      startedAt: row.started_at ? new Date(String(row.started_at)).getTime() : null,
      finishedAt: row.finished_at ? new Date(String(row.finished_at)).getTime() : null,
    };
  }
}

function normalizeStatus(value: string): "queued" | "running" | "completed" {
  if (value === "running" || value === "completed") {
    return value;
  }

  return "queued";
}

function parsePayload<TPayload>(value: unknown): TPayload {
  if (typeof value === "string") {
    return JSON.parse(value) as TPayload;
  }

  return value as TPayload;
}

function extractErrorType(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function extractFailureKind(error: unknown): string | null {
  if (error && typeof error === "object" && typeof (error as { failureKind?: unknown }).failureKind === "string") {
    return String((error as { failureKind?: unknown }).failureKind);
  }

  return null;
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function toNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return Math.floor(parsed);
}
