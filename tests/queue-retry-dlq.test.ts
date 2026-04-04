import assert from "node:assert/strict";
import test from "node:test";
import { QueueClosedError, QueueService } from "../src/modules/queue/queue-service";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("QueueService retries retryable jobs and completes successfully", async () => {
  let attempts = 0;
  const completion = new Promise<void>((resolve, reject) => {
    const queue = new QueueService<{ value: string }>({
      name: "q_retry_success",
      concurrency: 1,
      maxQueueSize: 10,
      jobTimeoutMs: 5_000,
      maxAttempts: 3,
      retryBaseMs: 10,
      shouldRetry: ({ error }) => (error as { retryable?: boolean })?.retryable === true,
      handler: async () => {
        attempts += 1;
        if (attempts < 2) {
          const error = new Error("transient");
          (error as { retryable?: boolean }).retryable = true;
          throw error;
        }
      },
      onStateChange: (event) => {
        if (event.status === "completed") {
          resolve();
        }
        if (event.status === "failed" && !event.willRetry) {
          reject(new Error("Job should have completed after retry."));
        }
      },
    });

    queue.enqueue({
      key: "k1",
      payload: { value: "x" },
    });
  });

  await completion;
  assert.equal(attempts, 2);
});

test("QueueService sends non-retryable jobs to dead letter immediately", async () => {
  let deadLetterCalled = false;
  const deadLetter = new Promise<void>((resolve) => {
    const queue = new QueueService<{ value: string }>({
      name: "q_dead_letter_now",
      concurrency: 1,
      maxQueueSize: 10,
      jobTimeoutMs: 5_000,
      maxAttempts: 3,
      retryBaseMs: 10,
      handler: async () => {
        throw new Error("deterministic");
      },
      onDeadLetter: async (event) => {
        deadLetterCalled = true;
        assert.equal(event.attempt, 1);
        assert.equal(event.maxAttempts, 3);
        assert.equal(event.retryable, false);
        resolve();
      },
    });

    queue.enqueue({
      key: "k2",
      payload: { value: "x" },
    });
  });

  await deadLetter;
  assert.equal(deadLetterCalled, true);
});

test("QueueService moves job to dead letter after retry limit", async () => {
  let attempts = 0;
  const deadLetter = new Promise<void>((resolve) => {
    const queue = new QueueService<{ value: string }>({
      name: "q_dead_letter_after_retry",
      concurrency: 1,
      maxQueueSize: 10,
      jobTimeoutMs: 5_000,
      maxAttempts: 2,
      retryBaseMs: 10,
      shouldRetry: ({ error }) => (error as { retryable?: boolean })?.retryable === true,
      handler: async () => {
        attempts += 1;
        const error = new Error("still transient");
        (error as { retryable?: boolean }).retryable = true;
        throw error;
      },
      onDeadLetter: async (event) => {
        assert.equal(event.attempt, 2);
        assert.equal(event.maxAttempts, 2);
        assert.equal(event.retryable, true);
        resolve();
      },
    });

    queue.enqueue({
      key: "k3",
      payload: { value: "x" },
    });
  });

  await deadLetter;
  assert.equal(attempts, 2);
  await wait(5);
});

test("QueueService close waits for running job and rejects new enqueue", async () => {
  const queue = new QueueService<{ value: string }>({
    name: "q_close",
    concurrency: 1,
    maxQueueSize: 10,
    jobTimeoutMs: 5_000,
    handler: async () => {
      await wait(30);
    },
  });

  queue.enqueue({
    key: "k-close-1",
    payload: { value: "x" },
  });

  await queue.close(5_000);

  assert.throws(
    () =>
      queue.enqueue({
        key: "k-close-2",
        payload: { value: "y" },
      }),
    (error: unknown) => error instanceof QueueClosedError,
  );
});
