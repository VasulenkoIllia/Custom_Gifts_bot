import type {
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
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class QueueService<TPayload> {
  private readonly name: string;
  private readonly concurrency: number;
  private readonly maxQueueSize: number;
  private readonly jobTimeoutMs: number;
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
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      resolve: () => {},
      reject: () => {},
    };

    const promise = new Promise<void>((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });

    this.inFlightByKey.set(key, promise);
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

  private emitState(job: QueueJob<TPayload>, error?: unknown): void {
    if (!this.onStateChange) {
      return;
    }

    this.onStateChange({
      queue: this.name,
      key: job.key,
      jobId: job.id,
      status: job.status,
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
    this.running.set(job.id, job);
    this.emitState(job);

    void this.execute(job);
  }

  private async execute(job: InternalJob<TPayload>): Promise<void> {
    try {
      await this.withTimeout(this.handler(job), this.jobTimeoutMs, `Queue job timeout in ${this.name}.`);
      job.status = "completed";
      job.finishedAt = Date.now();
      job.resolve();
      this.emitState(job);
    } catch (error) {
      job.status = "failed";
      job.finishedAt = Date.now();
      job.reject(error);
      this.emitState(job, error);
    } finally {
      this.running.delete(job.id);
      this.inFlightByKey.delete(job.key);
      this.drain();
    }
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
