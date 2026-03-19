import assert from "node:assert/strict";
import test from "node:test";
import { OrderProcessingError } from "../src/modules/errors/worker-errors";
import { createOrderIntakeWorker } from "../src/workers/order-intake-worker";

function logger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function baseJobPayload() {
  return {
    orderId: "123",
    statusId: 20,
    webhookEvent: "order.change_order_status",
    sourceUuid: null,
    receivedAt: new Date().toISOString(),
  };
}

test("order worker skips when webhook status is not materials", async () => {
  let getOrderCalled = false;
  const worker = createOrderIntakeWorker({
    logger: logger(),
    materialsStatusId: 20,
    crmClient: {
      getOrder: async () => {
        getOrderCalled = true;
        return { id: 1 };
      },
    },
    layoutPlanBuilder: {
      build: () => {
        throw new Error("must not run");
      },
    } as never,
    pdfPipelineService: {
      generateForOrder: async () => {
        throw new Error("must not run");
      },
    } as never,
    telegramDeliveryService: {
      sendOrderMaterials: async () => {
        throw new Error("must not run");
      },
    } as never,
    telegramMessageMapStore: {
      linkMessages: async () => ({ linked: 0 }),
    } as never,
  });

  await worker({
    id: "j1",
    key: "k1",
    status: "queued",
    attempt: 1,
    maxAttempts: 3,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    payload: {
      ...baseJobPayload(),
      statusId: 22,
    },
  });

  assert.equal(getOrderCalled, false);
});

test("order worker throws typed pdf_generation error", async () => {
  const worker = createOrderIntakeWorker({
    logger: logger(),
    materialsStatusId: 20,
    crmClient: {
      getOrder: async () => ({ id: 123, status_id: 20, products: [] }),
    },
    layoutPlanBuilder: {
      build: () => ({
        orderNumber: "123",
        urgent: false,
        flags: [],
        notes: [],
        previewImages: [],
        qr: {
          requested: false,
          valid: false,
          shouldGenerate: false,
          originalUrl: null,
          url: null,
        },
        materials: [],
      }),
    } as never,
    pdfPipelineService: {
      generateForOrder: async () => {
        throw new Error("network timeout while generating");
      },
    } as never,
    telegramDeliveryService: {
      sendOrderMaterials: async () => ({ chatId: "", messageIds: [], previewMessageIds: [], caption: "" }),
    } as never,
    telegramMessageMapStore: {
      linkMessages: async () => ({ linked: 0 }),
    } as never,
  });

  await assert.rejects(
    async () =>
      worker({
        id: "j2",
        key: "k2",
        status: "queued",
        attempt: 1,
        maxAttempts: 3,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        payload: baseJobPayload(),
      }),
    (error: unknown) => {
      assert.ok(error instanceof OrderProcessingError);
      assert.equal(error.failureKind, "pdf_generation");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("order worker throws typed telegram_delivery error", async () => {
  const worker = createOrderIntakeWorker({
    logger: logger(),
    materialsStatusId: 20,
    crmClient: {
      getOrder: async () => ({ id: 123, status_id: 20, products: [] }),
    },
    layoutPlanBuilder: {
      build: () => ({
        orderNumber: "123",
        urgent: false,
        flags: [],
        notes: [],
        previewImages: [],
        qr: {
          requested: false,
          valid: false,
          shouldGenerate: false,
          originalUrl: null,
          url: null,
        },
        materials: [],
      }),
    } as never,
    pdfPipelineService: {
      generateForOrder: async () => ({
        output_dir: "/tmp",
        color_space: "CMYK" as const,
        warnings: [],
        generated: [],
        failed: [],
      }),
    } as never,
    telegramDeliveryService: {
      sendOrderMaterials: async () => {
        throw new Error("telegram 429");
      },
    } as never,
    telegramMessageMapStore: {
      linkMessages: async () => ({ linked: 0 }),
    } as never,
  });

  await assert.rejects(
    async () =>
      worker({
        id: "j3",
        key: "k3",
        status: "queued",
        attempt: 1,
        maxAttempts: 3,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        payload: baseJobPayload(),
      }),
    (error: unknown) => {
      assert.ok(error instanceof OrderProcessingError);
      assert.equal(error.failureKind, "telegram_delivery");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});
