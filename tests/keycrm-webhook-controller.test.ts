import assert from "node:assert/strict";
import test from "node:test";
import type {
  IdempotencyEntry,
  IdempotencyReserveResult,
  IdempotencyStore,
} from "../src/modules/orders/order-idempotency";
import type { OrderIntakeJobPayload } from "../src/modules/queue/queue-jobs";
import { QueueService } from "../src/modules/queue/queue-service";
import { KeycrmWebhookController } from "../src/modules/webhook/keycrm-webhook.controller";
import type { Logger } from "../src/observability/logger";

function createNoopLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly keys = new Map<string, IdempotencyEntry>();

  async init(): Promise<void> {
    // no-op for in-memory test store
  }

  async reserve(key: string): Promise<IdempotencyReserveResult> {
    const normalized = String(key ?? "").trim();
    const existing = this.keys.get(normalized);
    if (existing) {
      return {
        created: false,
        entry: existing,
      };
    }

    const entry: IdempotencyEntry = {
      key: normalized,
      createdAt: new Date().toISOString(),
    };
    this.keys.set(normalized, entry);
    return {
      created: true,
      entry,
    };
  }

  async remove(key: string): Promise<boolean> {
    return this.keys.delete(String(key ?? "").trim());
  }
}

test("KeycrmWebhookController deduplicates duplicate webhook events", async () => {
  const logger = createNoopLogger();
  const queue = new QueueService<OrderIntakeJobPayload>({
    name: "order_intake_test",
    concurrency: 1,
    maxQueueSize: 10,
    jobTimeoutMs: 5_000,
      handler: async () => undefined,
  });

  const idempotencyStore = new InMemoryIdempotencyStore();
  await idempotencyStore.init();

  const controller = new KeycrmWebhookController({
    logger,
    orderQueue: queue,
    idempotencyStore,
    webhookSecret: "",
  });

  const payload = {
    event: "order.change_order_status",
    context: {
      id: 1001,
      status_id: 20,
      status_changed_at: "2026-03-19T10:00:00Z",
    },
  };

  const first = await controller.handle({
    headers: {},
    payload,
    requestId: "req-1",
  });

  const second = await controller.handle({
    headers: {},
    payload,
    requestId: "req-2",
  });

  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 202);

  const firstBody = first.body as Record<string, unknown>;
  const secondBody = second.body as Record<string, unknown>;

  assert.equal(firstBody.enqueued, 1);
  assert.equal(secondBody.enqueued, 0);
  assert.equal(secondBody.idempotentDuplicates, 1);
});
