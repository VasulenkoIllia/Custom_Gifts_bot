import assert from "node:assert/strict";
import test from "node:test";
import { DbQueueService } from "../src/modules/queue/db-queue.service";
import type { DatabaseClient, DbQueryResult } from "../src/modules/db/postgres-client";

type StoredQueueJob = {
  id: string;
  queue_name: string;
  job_key: string;
  payload: unknown;
  status: "queued" | "running" | "completed" | "dead_letter";
  attempt: number;
  max_attempts: number;
  available_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  error_type: string | null;
  retryable: boolean;
  failure_kind: string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
};

type QueueStatsRow = {
  pending: number;
  running: number;
  inflight_keys: number;
};

type EnqueueOutcomeRow = {
  outcome: "inserted" | "deduplicated" | "overflow";
  job_id: string | null;
};

class InMemoryDbQueueDatabase implements DatabaseClient {
  private readonly jobs = new Map<string, StoredQueueJob>();

  async query<TRow = Record<string, unknown>>(
    text: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<DbQueryResult<TRow>> {
    const sql = normalizeSql(text);

    if (sql.startsWith("WITH queue_lock AS")) {
      return this.enqueue(params) as Promise<DbQueryResult<TRow>>;
    }

    if (sql.startsWith("SELECT COUNT(*) FILTER (WHERE status = 'queued')::int AS pending")) {
      return this.getStats(params) as Promise<DbQueryResult<TRow>>;
    }

    if (sql.startsWith("WITH expired AS")) {
      return this.recoverExpired(params) as Promise<DbQueryResult<TRow>>;
    }

    if (sql.startsWith("WITH candidate AS")) {
      return this.claimNext(params) as Promise<DbQueryResult<TRow>>;
    }

    if (
      sql.startsWith("UPDATE queue_jobs SET status = 'completed'") &&
      sql.includes("WHERE id = $1") &&
      sql.includes("lease_owner = $3")
    ) {
      return this.complete(params) as Promise<DbQueryResult<TRow>>;
    }

    if (
      sql.startsWith("UPDATE queue_jobs SET status = 'queued'") &&
      sql.includes("attempt = attempt + 1")
    ) {
      return this.retry(params) as Promise<DbQueryResult<TRow>>;
    }

    if (
      sql.startsWith("UPDATE queue_jobs SET status = 'dead_letter'") &&
      sql.includes("RETURNING")
    ) {
      return this.fail(params) as Promise<DbQueryResult<TRow>>;
    }

    if (
      sql.startsWith("UPDATE queue_jobs SET lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond')")
    ) {
      return this.heartbeat(params) as Promise<DbQueryResult<TRow>>;
    }

    throw new Error(`Unsupported SQL in test double: ${sql}`);
  }

  async close(): Promise<void> {
    return undefined;
  }

  private async enqueue(params: ReadonlyArray<unknown>): Promise<DbQueryResult<EnqueueOutcomeRow>> {
    const queueName = String(params[0] ?? "").trim();
    const jobId = String(params[1] ?? "").trim();
    const jobKey = String(params[2] ?? "").trim();
    const payload = parseJsonValue(params[3]);
    const maxAttempts = toPositiveInteger(params[4], 1);
    const maxQueueSize = toPositiveInteger(params[5], 1);
    const now = new Date();

    const activeJobs = this.listJobsByQueue(queueName).filter(
      (job) => job.status === "queued" || job.status === "running",
    );
    const existing = activeJobs.find((job) => job.job_key === jobKey) ?? null;
    if (existing) {
      return {
        rows: [{ outcome: "deduplicated", job_id: existing.id }],
        rowCount: 1,
      };
    }

    if (activeJobs.length >= maxQueueSize) {
      return {
        rows: [{ outcome: "overflow", job_id: null }],
        rowCount: 1,
      };
    }

    const row: StoredQueueJob = {
      id: jobId,
      queue_name: queueName,
      job_key: jobKey,
      payload,
      status: "queued",
      attempt: 1,
      max_attempts: maxAttempts,
      available_at: now,
      lease_owner: null,
      lease_expires_at: null,
      error_type: null,
      retryable: false,
      failure_kind: null,
      error: null,
      created_at: now,
      started_at: null,
      finished_at: null,
      updated_at: now,
    };
    this.jobs.set(row.id, row);

    return {
      rows: [{ outcome: "inserted", job_id: row.id }],
      rowCount: 1,
    };
  }

  private async getStats(params: ReadonlyArray<unknown>): Promise<DbQueryResult<QueueStatsRow>> {
    const queueName = String(params[0] ?? "").trim();
    const rows = this.listJobsByQueue(queueName);
    return {
      rows: [
        {
          pending: rows.filter((job) => job.status === "queued").length,
          running: rows.filter((job) => job.status === "running").length,
          inflight_keys: rows.filter((job) => job.status === "queued" || job.status === "running")
            .length,
        },
      ],
      rowCount: 1,
    };
  }

  private async recoverExpired(
    params: ReadonlyArray<unknown>,
  ): Promise<DbQueryResult<StoredQueueJob>> {
    const queueName = String(params[0] ?? "").trim();
    const leaseOwner = String(params[1] ?? "").trim();
    const jobTimeoutMs = toPositiveInteger(params[2], 1_000);
    const now = new Date();
    const expired = this.listJobsByQueue(queueName)
      .filter(
        (job) =>
          job.status === "running" &&
          job.lease_expires_at instanceof Date &&
          job.lease_expires_at.getTime() <= now.getTime(),
      )
      .sort(
        (left, right) =>
          (left.lease_expires_at?.getTime() ?? 0) - (right.lease_expires_at?.getTime() ?? 0),
      )[0];

    if (!expired) {
      return {
        rows: [],
        rowCount: 0,
      };
    }

    expired.lease_owner = leaseOwner;
    expired.lease_expires_at = new Date(now.getTime() + jobTimeoutMs);
    expired.updated_at = now;
    return {
      rows: [cloneJob(expired)],
      rowCount: 1,
    };
  }

  private async claimNext(params: ReadonlyArray<unknown>): Promise<DbQueryResult<StoredQueueJob>> {
    const queueName = String(params[0] ?? "").trim();
    const leaseOwner = String(params[1] ?? "").trim();
    const jobTimeoutMs = toPositiveInteger(params[2], 1_000);
    const now = new Date();
    const candidate = this.listJobsByQueue(queueName)
      .filter(
        (job) => job.status === "queued" && job.available_at.getTime() <= now.getTime(),
      )
      .sort(
        (left, right) =>
          left.available_at.getTime() - right.available_at.getTime() ||
          left.created_at.getTime() - right.created_at.getTime(),
      )[0];

    if (!candidate) {
      return {
        rows: [],
        rowCount: 0,
      };
    }

    candidate.status = "running";
    candidate.started_at = candidate.started_at ?? now;
    candidate.updated_at = now;
    candidate.lease_owner = leaseOwner;
    candidate.lease_expires_at = new Date(now.getTime() + jobTimeoutMs);
    return {
      rows: [cloneJob(candidate)],
      rowCount: 1,
    };
  }

  private async heartbeat(params: ReadonlyArray<unknown>): Promise<DbQueryResult<never>> {
    const jobId = String(params[0] ?? "").trim();
    const queueName = String(params[1] ?? "").trim();
    const jobTimeoutMs = toPositiveInteger(params[2], 1_000);
    const leaseOwner = String(params[3] ?? "").trim();
    const job = this.jobs.get(jobId);

    if (
      job &&
      job.queue_name === queueName &&
      job.status === "running" &&
      job.lease_owner === leaseOwner
    ) {
      const now = new Date();
      job.lease_expires_at = new Date(now.getTime() + jobTimeoutMs);
      job.updated_at = now;
    }

    return {
      rows: [],
      rowCount: 0,
    };
  }

  private async complete(params: ReadonlyArray<unknown>): Promise<DbQueryResult<never>> {
    const jobId = String(params[0] ?? "").trim();
    const queueName = String(params[1] ?? "").trim();
    const leaseOwner = String(params[2] ?? "").trim();
    const job = this.jobs.get(jobId);

    if (
      job &&
      job.queue_name === queueName &&
      job.status === "running" &&
      job.lease_owner === leaseOwner
    ) {
      const now = new Date();
      job.status = "completed";
      job.finished_at = now;
      job.lease_owner = null;
      job.lease_expires_at = null;
      job.updated_at = now;
    }

    return {
      rows: [],
      rowCount: 0,
    };
  }

  private async retry(params: ReadonlyArray<unknown>): Promise<DbQueryResult<never>> {
    const jobId = String(params[0] ?? "").trim();
    const queueName = String(params[1] ?? "").trim();
    const retryDelayMs = toPositiveInteger(params[2], 100);
    const errorType = nullableString(params[3]);
    const retryable = Boolean(params[4]);
    const failureKind = nullableString(params[5]);
    const error = nullableString(params[6]);
    const leaseOwner = String(params[7] ?? "").trim();
    const job = this.jobs.get(jobId);

    if (
      job &&
      job.queue_name === queueName &&
      job.status === "running" &&
      job.lease_owner === leaseOwner
    ) {
      const now = new Date();
      job.status = "queued";
      job.attempt += 1;
      job.available_at = new Date(now.getTime() + retryDelayMs);
      job.lease_owner = null;
      job.lease_expires_at = null;
      job.error_type = errorType;
      job.retryable = retryable;
      job.failure_kind = failureKind;
      job.error = error;
      job.updated_at = now;
    }

    return {
      rows: [],
      rowCount: 0,
    };
  }

  private async fail(params: ReadonlyArray<unknown>): Promise<DbQueryResult<StoredQueueJob>> {
    const jobId = String(params[0] ?? "").trim();
    const queueName = String(params[1] ?? "").trim();
    const errorType = nullableString(params[2]);
    const retryable = Boolean(params[3]);
    const failureKind = nullableString(params[4]);
    const error = nullableString(params[5]);
    const leaseOwner = String(params[6] ?? "").trim();
    const job = this.jobs.get(jobId);

    if (
      !job ||
      job.queue_name !== queueName ||
      job.status !== "running" ||
      job.lease_owner !== leaseOwner
    ) {
      return {
        rows: [],
        rowCount: 0,
      };
    }

    const now = new Date();
    job.status = "dead_letter";
    job.finished_at = now;
    job.lease_owner = null;
    job.lease_expires_at = null;
    job.error_type = errorType;
    job.retryable = retryable;
    job.failure_kind = failureKind;
    job.error = error;
    job.updated_at = now;

    return {
      rows: [cloneJob(job)],
      rowCount: 1,
    };
  }

  private listJobsByQueue(queueName: string): StoredQueueJob[] {
    return Array.from(this.jobs.values()).filter((job) => job.queue_name === queueName);
  }
}

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  return JSON.parse(value) as unknown;
}

function nullableString(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function toPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function cloneJob(job: StoredQueueJob): StoredQueueJob {
  return {
    ...job,
    available_at: new Date(job.available_at),
    lease_expires_at: job.lease_expires_at ? new Date(job.lease_expires_at) : null,
    created_at: new Date(job.created_at),
    started_at: job.started_at ? new Date(job.started_at) : null,
    finished_at: job.finished_at ? new Date(job.finished_at) : null,
    updated_at: new Date(job.updated_at),
  };
}

function waitForCompletion(timeoutMs: number): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    resolvePromise = () => {
      clearTimeout(timeout);
      resolve();
    };
    rejectPromise = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
  });

  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

test("DbQueueService retries retryable jobs and completes successfully", async () => {
  const db = new InMemoryDbQueueDatabase();
  let attempts = 0;
  const completion = waitForCompletion(2_000);

  const queue = new DbQueueService<{ value: string }>({
    db,
    name: "order_intake",
    concurrency: 1,
    maxQueueSize: 10,
    jobTimeoutMs: 5_000,
    pollIntervalMs: 100,
    maxAttempts: 2,
    retryBaseMs: 10,
    shouldRetry: ({ error }) => (error as { retryable?: unknown })?.retryable === true,
    handler: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("transient db-backed failure") as Error & { retryable?: boolean };
        error.retryable = true;
        throw error;
      }
    },
    onStateChange: (event) => {
      if (event.status === "completed") {
        completion.resolve();
      }
      if (event.status === "failed" && !event.willRetry) {
        completion.reject(new Error("Job should have completed after retry."));
      }
    },
  });

  queue.start();
  await queue.enqueue({
    key: "order:1001",
    payload: { value: "ok" },
  });

  await completion.promise;
  assert.equal(attempts, 2);
  await queue.close();
});

test("DbQueueService moves non-retryable jobs to dead letter", async () => {
  const db = new InMemoryDbQueueDatabase();
  const completion = waitForCompletion(2_000);

  const queue = new DbQueueService<{ value: string }>({
    db,
    name: "reaction_intake",
    concurrency: 1,
    maxQueueSize: 10,
    jobTimeoutMs: 5_000,
    pollIntervalMs: 100,
    maxAttempts: 2,
    retryBaseMs: 10,
    handler: async () => {
      throw new Error("deterministic db-backed failure");
    },
    onDeadLetter: async (event) => {
      assert.equal(event.queue, "reaction_intake");
      assert.equal(event.attempt, 1);
      assert.equal(event.retryable, false);
      completion.resolve();
    },
  });

  queue.start();
  await queue.enqueue({
    key: "reaction:-100:42",
    payload: { value: "dead-letter" },
  });

  await completion.promise;
  await queue.close();
});
