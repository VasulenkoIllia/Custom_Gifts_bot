"use strict";

class QueueOverflowError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueueOverflowError";
    this.statusCode = 429;
  }
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

class OrderQueue {
  constructor({
    concurrency = 2,
    maxQueueSize = 100,
    jobTimeoutMs = 15 * 60 * 1000,
    onJobStateChange = null,
  } = {}) {
    this.concurrency = toPositiveInteger(concurrency, 2);
    this.maxQueueSize = toPositiveInteger(maxQueueSize, 100);
    this.jobTimeoutMs = toPositiveInteger(jobTimeoutMs, 15 * 60 * 1000);
    this.onJobStateChange = typeof onJobStateChange === "function" ? onJobStateChange : null;

    this.pending = [];
    this.runningJobs = new Map();
    this.inFlightByOrder = new Map();
    this.activeOrderIds = new Set();
    this.sequence = 0;
  }

  getStats() {
    return {
      concurrency: this.concurrency,
      max_queue_size: this.maxQueueSize,
      job_timeout_ms: this.jobTimeoutMs,
      pending: this.pending.length,
      running: this.runningJobs.size,
      in_flight_orders: this.inFlightByOrder.size,
    };
  }

  enqueue(
    {
      orderId,
      source = "unknown",
      dedupe = true,
      metadata = {},
    },
    handler,
  ) {
    if (typeof handler !== "function") {
      throw new Error("Queue handler must be a function.");
    }

    const normalizedOrderId = String(orderId ?? "").trim();
    if (!normalizedOrderId) {
      throw new Error("orderId is required for queue.");
    }

    if (dedupe) {
      const existing = this.inFlightByOrder.get(normalizedOrderId);
      if (existing) {
        return {
          jobId: existing.job.id,
          deduplicated: true,
          promise: existing.promise,
          queue: this.getStats(),
        };
      }
    }

    const totalInMemoryJobs = this.pending.length + this.runningJobs.size;
    if (totalInMemoryJobs >= this.maxQueueSize) {
      throw new QueueOverflowError(`Order queue is full (${this.maxQueueSize}).`);
    }

    const job = {
      id: `job_${Date.now()}_${++this.sequence}`,
      orderId: normalizedOrderId,
      source,
      metadata,
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      handler,
      resolve: null,
      reject: null,
    };

    const promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });

    this.inFlightByOrder.set(normalizedOrderId, { job, promise });
    this.pending.push(job);
    this.#emitState(job);
    this.#drain();

    return {
      jobId: job.id,
      deduplicated: false,
      promise,
      queue: this.getStats(),
    };
  }

  #emitState(job, extras = {}) {
    if (!this.onJobStateChange) {
      return;
    }

    this.onJobStateChange({
      job_id: job.id,
      order_id: job.orderId,
      source: job.source,
      status: job.status,
      created_at: new Date(job.createdAt).toISOString(),
      started_at: job.startedAt ? new Date(job.startedAt).toISOString() : null,
      finished_at: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      ...extras,
      queue: this.getStats(),
    });
  }

  #drain() {
    while (this.runningJobs.size < this.concurrency) {
      const nextIndex = this.pending.findIndex(
        (job) => !this.activeOrderIds.has(job.orderId),
      );

      if (nextIndex < 0) {
        break;
      }

      const [job] = this.pending.splice(nextIndex, 1);
      this.#start(job);
    }
  }

  #start(job) {
    job.status = "running";
    job.startedAt = Date.now();

    this.runningJobs.set(job.id, job);
    this.activeOrderIds.add(job.orderId);
    this.#emitState(job);

    void this.#execute(job);
  }

  async #execute(job) {
    try {
      const result = await this.#withTimeout(
        Promise.resolve().then(() => job.handler(job)),
        this.jobTimeoutMs,
        `Order job timeout after ${this.jobTimeoutMs}ms`,
      );

      job.status = "completed";
      job.finishedAt = Date.now();
      job.resolve(result);
      this.#emitState(job);
    } catch (error) {
      job.status = "failed";
      job.finishedAt = Date.now();
      job.reject(error);
      this.#emitState(job, { error: error?.message ?? "Unknown queue error" });
    } finally {
      this.runningJobs.delete(job.id);
      this.activeOrderIds.delete(job.orderId);

      const inflight = this.inFlightByOrder.get(job.orderId);
      if (inflight && inflight.job.id === job.id) {
        this.inFlightByOrder.delete(job.orderId);
      }

      this.#drain();
    }
  }

  async #withTimeout(promise, timeoutMs, message) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return promise;
    }

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(message));
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timeoutId);
    });
  }
}

module.exports = {
  OrderQueue,
  QueueOverflowError,
};
