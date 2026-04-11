import type {
  QueueDeadLetterEvent,
  QueueEnqueueInput,
  QueueEnqueueResult,
  QueueJob,
  QueueOptions,
  QueueStats,
} from "./queue.types";
import { QueueClosedError, QueueOverflowError } from "./queue-errors";
export { QueueClosedError, QueueOverflowError } from "./queue-errors";

type InternalJob<TPayload> = QueueJob<TPayload> & {
  deadLettered: boolean;
};

export class QueueService<TPayload> {
  private readonly name: string;
  private readonly concurrency: number;
  private readonly maxQueueSize: number;
  private readonly jobTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly shouldRetry: NonNullable<QueueOptions<TPayload>["shouldRetry"]>;
  private readonly onDeadLetter: NonNullable<QueueOptions<TPayload>["onDeadLetter"]> | null;
  private readonly handler: QueueOptions<TPayload>["handler"];
  private readonly onStateChange: QueueOptions<TPayload>["onStateChange"];

  private readonly pending: InternalJob<TPayload>[] = [];
  private readonly running = new Map<string, InternalJob<TPayload>>();
  private readonly inFlightByKey = new Map<string, Promise<void>>();
  private readonly scheduledRetries = new Map<NodeJS.Timeout, InternalJob<TPayload>>();
  private sequence = 0;
  private closed = false;

  constructor(options: QueueOptions<TPayload>) {
    this.name = options.name;
    this.concurrency = options.concurrency;
    this.maxQueueSize = options.maxQueueSize;
    this.jobTimeoutMs = options.jobTimeoutMs;
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
  }

  enqueue(input: QueueEnqueueInput<TPayload>): QueueEnqueueResult {
    if (this.closed) {
      throw new QueueClosedError(`Queue ${this.name} is closed.`);
    }

    const key = String(input.key ?? "").trim();
    if (!key) {
      throw new Error("Queue key is required.");
    }

    const existing = this.inFlightByKey.get(key);
    if (existing) {
      return {
        jobId: `inflight:${key}`,
        deduplicated: true,
        queue: this.getStats(),
      };
    }

    if (this.pending.length + this.running.size >= this.maxQueueSize) {
      throw new QueueOverflowError(`Queue ${this.name} is full (${this.maxQueueSize}).`);
    }

    const job: InternalJob<TPayload> = {
      id: `${this.name}_${Date.now()}_${++this.sequence}`,
      key,
      payload: input.payload,
      status: "queued",
      attempt: 1,
      maxAttempts: this.maxAttempts,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      deadLettered: false,
    };
    this.inFlightByKey.set(key, Promise.resolve());
    this.pending.push(job);
    this.emitState(job);
    this.drain();

    return {
      jobId: job.id,
      deduplicated: false,
      queue: this.getStats(),
    };
  }

  getStats(): QueueStats {
    return {
      name: this.name,
      concurrency: this.concurrency,
      maxQueueSize: this.maxQueueSize,
      pending: this.pending.length,
      running: this.running.size,
      inflightKeys: this.inFlightByKey.size,
    };
  }

  private emitState(
    job: QueueJob<TPayload>,
    error?: unknown,
    retryMeta: { willRetry: boolean; retryDelayMs: number | null } = {
      willRetry: false,
      retryDelayMs: null,
    },
  ): void {
    if (!this.onStateChange) {
      return;
    }

    try {
      this.onStateChange({
        queue: this.name,
        key: job.key,
        jobId: job.id,
        status: job.status,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        willRetry: retryMeta.willRetry,
        retryDelayMs: retryMeta.retryDelayMs,
        payload: job.payload,
        error: error instanceof Error ? error.message : error ? String(error) : undefined,
        stats: this.getStats(),
      });
    } catch (_error) {
      // Queue processing must continue even if logging callback fails.
    }
  }

  private drain(): void {
    if (this.closed && this.pending.length === 0) {
      return;
    }

    while (this.running.size < this.concurrency) {
      const next = this.pending.shift();
      if (!next) {
        break;
      }
      this.start(next);
    }
  }

  private start(job: InternalJob<TPayload>): void {
    job.status = "running";
    job.startedAt = Date.now();
    job.finishedAt = null;
    this.running.set(job.id, job);
    this.emitState(job);

    void this.execute(job).catch(() => {
      // execute() must not leak unhandled rejections
    });
  }

  private async execute(job: InternalJob<TPayload>): Promise<void> {
    let willRetry = false;
    let keepInFlightUntilSettled = false;
    const handlerPromise = this.handler(job);
    let handlerSettled = false;
    void handlerPromise
      .finally(() => {
        handlerSettled = true;
        if (keepInFlightUntilSettled) {
          this.inFlightByKey.delete(job.key);
          this.drain();
        }
      })
      .catch(() => {
        // handler rejection is observed by withTimeout/execute catch path
      });

    try {
      await this.withTimeout(handlerPromise, this.jobTimeoutMs, `Queue job timeout in ${this.name}.`);
      job.status = "completed";
      job.finishedAt = Date.now();
      this.emitState(job);
    } catch (error) {
      const retryable = this.shouldRetry({
        error,
        job,
      });
      const canRetry = retryable && job.attempt < job.maxAttempts;
      if (canRetry) {
        const retryDelayMs = this.computeRetryDelay(job.attempt);
        job.status = "queued";
        job.attempt += 1;
        willRetry = true;
        this.emitState(job, error, {
          willRetry: true,
          retryDelayMs,
        });
        const timer = setTimeout(() => {
          this.scheduledRetries.delete(timer);
          if (this.closed) {
            this.inFlightByKey.delete(job.key);
            this.drain();
            return;
          }

          this.pending.push(job);
          this.drain();
        }, retryDelayMs);
        this.scheduledRetries.set(timer, job);
      } else {
        job.status = "failed";
        job.finishedAt = Date.now();
        this.emitState(job, error);
        await this.handleDeadLetter(job, error);

        if (error instanceof QueueJobTimeoutError && !handlerSettled) {
          keepInFlightUntilSettled = true;
        }
      }
    } finally {
      this.running.delete(job.id);
      if (!willRetry && !keepInFlightUntilSettled) {
        this.inFlightByKey.delete(job.key);
      }
      this.drain();
    }
  }

  private computeRetryDelay(attempt: number): number {
    const exponential = this.retryBaseMs * Math.pow(2, Math.max(0, attempt - 1));
    const jitter = Math.floor(Math.random() * Math.min(1000, this.retryBaseMs));
    return Math.min(60_000, exponential + jitter);
  }

  private async handleDeadLetter(job: InternalJob<TPayload>, error: unknown): Promise<void> {
    if (job.deadLettered) {
      return;
    }

    job.deadLettered = true;
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
      errorType: error instanceof Error ? error.name : "UnknownError",
      retryable: (error as { retryable?: unknown })?.retryable === true,
      failureKind:
        typeof (error as { failureKind?: unknown })?.failureKind === "string"
          ? String((error as { failureKind?: unknown }).failureKind)
          : null,
      error: error instanceof Error ? error.message : String(error),
      createdAt: job.createdAt,
      finishedAt: job.finishedAt ?? Date.now(),
    };

    try {
      await this.onDeadLetter(event);
    } catch (_deadLetterError) {
      // Queue should not crash when DLQ callback fails (e.g. DB/Telegram outage).
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return promise;
    }

    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new QueueJobTimeoutError(message));
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
  }

  async close(timeoutMs = 30_000): Promise<void> {
    this.closed = true;

    for (const [timer, job] of this.scheduledRetries.entries()) {
      clearTimeout(timer);
      this.scheduledRetries.delete(timer);
      this.inFlightByKey.delete(job.key);
    }

    const startedAt = Date.now();
    while (this.pending.length > 0 || this.running.size > 0) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(
          `Queue ${this.name} shutdown timeout: pending=${this.pending.length}, running=${this.running.size}.`,
        );
      }

      await sleep(50);
    }
  }
}

class QueueJobTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueJobTimeoutError";
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
