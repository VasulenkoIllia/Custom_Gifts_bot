import type {
  QueueDeadLetterEvent,
  QueueEnqueueInput,
  QueueEnqueueResult,
  QueueJob,
  QueueOptions,
  QueueStats,
} from "./queue.types";

export class QueueOverflowError extends Error {
  readonly statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = "QueueOverflowError";
    this.statusCode = 429;
  }
}

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
  private sequence = 0;

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
  }

  private drain(): void {
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

    void this.execute(job);
  }

  private async execute(job: InternalJob<TPayload>): Promise<void> {
    let willRetry = false;
    try {
      await this.withTimeout(this.handler(job), this.jobTimeoutMs, `Queue job timeout in ${this.name}.`);
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
        setTimeout(() => {
          this.pending.push(job);
          this.drain();
        }, retryDelayMs);
      } else {
        job.status = "failed";
        job.finishedAt = Date.now();
        this.emitState(job, error);
        await this.handleDeadLetter(job, error);
      }
    } finally {
      this.running.delete(job.id);
      if (!willRetry) {
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

    await this.onDeadLetter(event);
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return promise;
    }

    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(message));
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
  }
}
