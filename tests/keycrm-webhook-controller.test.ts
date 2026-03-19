import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileIdempotencyStore } from "../src/modules/orders/order-idempotency";
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

test("KeycrmWebhookController deduplicates duplicate webhook events", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cgu-keycrm-webhook-"));
  const idempotencyPath = path.join(tempDir, "idempotency.json");

  const logger = createNoopLogger();
  const queue = new QueueService<OrderIntakeJobPayload>({
    name: "order_intake_test",
    concurrency: 1,
    maxQueueSize: 10,
    jobTimeoutMs: 5_000,
    handler: async () => undefined,
  });

  const idempotencyStore = new FileIdempotencyStore(idempotencyPath);
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

  await fs.rm(tempDir, { recursive: true, force: true });
});
