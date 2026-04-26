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

function opsAlertService() {
  return {
    send: async () => ({ sent: true, deduplicated: false }),
  };
}

test("order worker skips when webhook status is not materials", async () => {
  let getOrderCalled = false;
  const worker = createOrderIntakeWorker({
    logger: logger(),
    materialsStatusId: 20,
    missingFileStatusId: 40,
    opsAlertService: opsAlertService(),
    crmClient: {
      getOrder: async () => {
        getOrderCalled = true;
        return { id: 1 };
      },
      updateOrderStatus: async () => ({ id: 1 }),
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
    missingFileStatusId: 40,
    opsAlertService: opsAlertService(),
    crmClient: {
      getOrder: async () => ({ id: 123, status_id: 20, products: [] }),
      updateOrderStatus: async () => ({ id: 123, status_id: 20, products: [] }),
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
    missingFileStatusId: 40,
    opsAlertService: opsAlertService(),
    crmClient: {
      getOrder: async () => ({ id: 123, status_id: 20, products: [] }),
      updateOrderStatus: async () => ({ id: 123, status_id: 20, products: [] }),
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

test("order worker wraps telegram message-map failures as telegram_delivery error", async () => {
  const worker = createOrderIntakeWorker({
    logger: logger(),
    materialsStatusId: 20,
    missingFileStatusId: 40,
    opsAlertService: opsAlertService(),
    crmClient: {
      getOrder: async () => ({ id: 123, status_id: 20, products: [] }),
      updateOrderStatus: async () => ({ id: 123, status_id: 20, products: [] }),
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
        generated: [
          {
            type: "poster",
            filename: "CGU_AA5_123_1_1.pdf",
            path: "/tmp/CGU_AA5_123_1_1.pdf",
          },
        ],
        failed: [],
      }),
    } as never,
    telegramDeliveryService: {
      sendOrderMaterials: async () => ({
        chatId: "-100",
        messageIds: [101],
        previewMessageIds: [100],
        caption: "ok",
      }),
    } as never,
    telegramMessageMapStore: {
      linkMessages: async () => {
        throw new Error("db connection timeout");
      },
    } as never,
  });

  await assert.rejects(
    async () =>
      worker({
        id: "j4",
        key: "k4",
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
      return true;
    },
  );
});

test("order worker fails when telegram delivery returns zero mapped message ids", async () => {
  const worker = createOrderIntakeWorker({
    logger: logger(),
    materialsStatusId: 20,
    missingFileStatusId: 40,
    opsAlertService: opsAlertService(),
    crmClient: {
      getOrder: async () => ({ id: 123, status_id: 20, products: [] }),
      updateOrderStatus: async () => ({ id: 123, status_id: 20, products: [] }),
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
        generated: [
          {
            type: "poster",
            filename: "CGU_AA5_123_1_1.pdf",
            path: "/tmp/CGU_AA5_123_1_1.pdf",
            details: {},
          },
        ],
        failed: [],
      }),
    } as never,
    telegramDeliveryService: {
      sendOrderMaterials: async () => ({
        chatId: "-100",
        messageIds: [101],
        previewMessageIds: [100],
        caption: "ok",
      }),
    } as never,
    telegramMessageMapStore: {
      linkMessages: async () => ({ linked: 0 }),
    } as never,
  });

  await assert.rejects(
    async () =>
      worker({
        id: "j5",
        key: "k5",
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

test("order worker forwards PDF warnings into telegram delivery payload", async () => {
  let receivedWarnings: string[] | null = null;

  const worker = createOrderIntakeWorker({
    logger: logger(),
    materialsStatusId: 20,
    missingFileStatusId: 40,
    opsAlertService: opsAlertService(),
    crmClient: {
      getOrder: async () => ({ id: 123, status_id: 20, products: [] }),
      updateOrderStatus: async () => ({ id: 123, status_id: 20, products: [] }),
    },
    layoutPlanBuilder: {
      build: () => ({
        orderNumber: "123",
        urgent: false,
        flags: ["QR +"],
        notes: [],
        previewImages: [],
        qr: {
          requested: true,
          valid: true,
          shouldGenerate: true,
          originalUrl: "https://example.com/track",
          url: "https://example.com/track",
        },
        materials: [
          {
            type: "poster",
            code: "AA5",
            index: 1,
            total: 1,
            filename: "CGU_AA5_123_1_1",
            productId: 10,
            sku: "MDPA5WoodRGB",
            sourceUrl: "https://example.com/poster.pdf",
            text: null,
            format: "A5",
            standType: null,
          },
        ],
      }),
    } as never,
    pdfPipelineService: {
      generateForOrder: async () => ({
        output_dir: "/tmp",
        color_space: "CMYK" as const,
        warnings: [
          "🚨 QR-код замовлено, але для CGU_AA5_123_1_1 (SKU MDPA5WoodRGB) не налаштовані правила QR. QR не згенеровано і не вбудовано в макет.",
        ],
        generated: [
          {
            type: "poster",
            filename: "CGU_AA5_123_1_1.pdf",
            path: "/tmp/CGU_AA5_123_1_1.pdf",
          },
        ],
        failed: [],
      }),
    } as never,
    telegramDeliveryService: {
      sendOrderMaterials: async (input: { warnings: string[] }) => {
        receivedWarnings = input.warnings;
        return {
          chatId: "-100",
          messageIds: [101],
          previewMessageIds: [],
          caption: "ok",
        };
      },
    } as never,
    telegramMessageMapStore: {
      linkMessages: async () => ({ linked: 1 }),
    } as never,
  });

  await worker({
    id: "j6",
    key: "k6",
    status: "queued",
    attempt: 1,
    maxAttempts: 3,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    payload: baseJobPayload(),
  });

  assert.deepEqual(receivedWarnings, [
    "🚨 QR-код замовлено, але для CGU_AA5_123_1_1 (SKU MDPA5WoodRGB) не налаштовані правила QR. QR не згенеровано і не вбудовано в макет.",
  ]);
});

test("order worker hides QR url in caption payload when QR was not embedded", async () => {
  let receivedQrUrl = "unexpected";

  const worker = createOrderIntakeWorker({
    logger: logger(),
    materialsStatusId: 20,
    missingFileStatusId: 40,
    opsAlertService: opsAlertService(),
    crmClient: {
      getOrder: async () => ({ id: 123, status_id: 20, products: [] }),
      updateOrderStatus: async () => ({ id: 123, status_id: 20, products: [] }),
    },
    layoutPlanBuilder: {
      build: () => ({
        orderNumber: "123",
        urgent: false,
        flags: ["QR +"],
        notes: [],
        previewImages: [],
        qr: {
          requested: true,
          valid: true,
          shouldGenerate: true,
          originalUrl: "https://example.com/track",
          url: "https://example.com/track",
        },
        materials: [
          {
            type: "poster",
            code: "AA5",
            index: 1,
            total: 1,
            filename: "CGU_AA5_123_1_1",
            productId: 10,
            sku: "MDPA5WoodRGB",
            sourceUrl: "https://example.com/poster.pdf",
            text: null,
            format: "A5",
            standType: null,
          },
        ],
      }),
    } as never,
    pdfPipelineService: {
      generateForOrder: async () => ({
        output_dir: "/tmp",
        color_space: "CMYK" as const,
        warnings: [
          "🚨 QR-код замовлено, але для CGU_AA5_123_1_1 (SKU MDPA5WoodRGB) не налаштовані правила QR. QR не згенеровано і не вбудовано в макет.",
        ],
        generated: [
          {
            type: "poster",
            filename: "CGU_AA5_123_1_1.pdf",
            path: "/tmp/CGU_AA5_123_1_1.pdf",
            details: {},
          },
        ],
        failed: [],
      }),
    } as never,
    telegramDeliveryService: {
      sendOrderMaterials: async (input: { qrUrl: string | null }) => {
        receivedQrUrl = String(input.qrUrl);
        return {
          chatId: "-100",
          messageIds: [101],
          previewMessageIds: [],
          caption: "ok",
        };
      },
    } as never,
    telegramMessageMapStore: {
      linkMessages: async () => ({ linked: 1 }),
    } as never,
  });

  await worker({
    id: "j7",
    key: "k7",
    status: "queued",
    attempt: 1,
    maxAttempts: 3,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    payload: baseJobPayload(),
  });

  assert.equal(receivedQrUrl, "null");
});

test("order worker forwards rasterize DPI and final white metrics into telegram payload", async () => {
  let receivedPipelineMetrics:
    | {
        rasterizeDpi: number;
        finalWhiteStrictPixels: number;
        finalWhiteAggressivePixels: number;
        finalWhiteCorrectedPixels: number;
        orderProcessingDurationMs: number;
      }
    | null = null;

  const worker = createOrderIntakeWorker({
    logger: logger(),
    materialsStatusId: 20,
    missingFileStatusId: 40,
    opsAlertService: opsAlertService(),
    crmClient: {
      getOrder: async () => ({ id: 123, status_id: 20, products: [] }),
      updateOrderStatus: async () => ({ id: 123, status_id: 20, products: [] }),
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
        materials: [
          {
            type: "poster",
            code: "AA5",
            index: 1,
            total: 1,
            filename: "CGU_AA5_123_1_1",
            productId: 10,
            sku: "PosterGiftA5WW",
            sourceUrl: "https://example.com/poster.pdf",
            text: null,
            format: "A5",
            standType: null,
          },
        ],
      }),
    } as never,
    pdfPipelineService: {
      generateForOrder: async () => ({
        output_dir: "/tmp",
        color_space: "CMYK" as const,
        warnings: [],
        rasterize_dpi: 800,
        generated: [
          {
            type: "poster",
            filename: "CGU_AA5_123_1_1.pdf",
            path: "/tmp/CGU_AA5_123_1_1.pdf",
            details: {
              final_preflight: {
                residual_strict_white_pixels: 0,
                residual_aggressive_white_pixels: 0,
                corrected_pixels: 12,
              },
            },
          },
        ],
        failed: [],
      }),
    } as never,
    telegramDeliveryService: {
      sendOrderMaterials: async (input: {
        pipelineMetrics?: {
          rasterizeDpi: number;
          finalWhiteStrictPixels: number;
          finalWhiteAggressivePixels: number;
          finalWhiteCorrectedPixels: number;
          orderProcessingDurationMs: number;
        } | null;
      }) => {
        receivedPipelineMetrics = input.pipelineMetrics ?? null;
        return {
          chatId: "-100",
          messageIds: [101],
          previewMessageIds: [],
          caption: "ok",
        };
      },
    } as never,
    telegramMessageMapStore: {
      linkMessages: async () => ({ linked: 1 }),
    } as never,
  });

  await worker({
    id: "j8-metrics",
    key: "k8-metrics",
    status: "queued",
    attempt: 1,
    maxAttempts: 3,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    payload: baseJobPayload(),
  });

  const metrics = receivedPipelineMetrics as {
    rasterizeDpi: number;
    finalWhiteStrictPixels: number;
    finalWhiteAggressivePixels: number;
    finalWhiteCorrectedPixels: number;
    orderProcessingDurationMs: number;
  } | null;
  assert.ok(metrics);
  assert.equal(metrics.rasterizeDpi, 800);
  assert.equal(metrics.finalWhiteStrictPixels, 0);
  assert.equal(metrics.finalWhiteAggressivePixels, 0);
  assert.equal(metrics.finalWhiteCorrectedPixels, 12);
  assert.ok(Number.isFinite(metrics.orderProcessingDurationMs));
  assert.ok(metrics.orderProcessingDurationMs >= 0);
});

test("order worker moves order to missing file and alerts ops when poster source is missing", async () => {
  let pdfCalled = false;
  let telegramCalled = false;
  let updatedStatusId: number | null = null;
  const sentAlerts: Array<{ title: string; details?: string; orderId?: string }> = [];
  const sentProcessingAlerts: Array<{ title: string; details?: string; orderId?: string }> = [];

  const worker = createOrderIntakeWorker({
    logger: logger(),
    materialsStatusId: 20,
    missingFileStatusId: 40,
    opsAlertService: {
      send: async (params) => {
        sentAlerts.push({
          title: params.title,
          details: params.details,
          orderId: params.orderId,
        });
        return { sent: true, deduplicated: false };
      },
    },
    processingAlertService: {
      send: async (params) => {
        sentProcessingAlerts.push({
          title: params.title,
          details: params.details,
          orderId: params.orderId,
        });
        return { sent: true, deduplicated: false };
      },
    },
    crmClient: {
      getOrder: async () => ({ id: 28297, status_id: 20, products: [] }),
      updateOrderStatus: async (_orderId: string, statusId: number) => {
        updatedStatusId = statusId;
        return { id: 28297, status_id: statusId, products: [] };
      },
    },
    layoutPlanBuilder: {
      build: () => ({
        orderNumber: "28297",
        urgent: false,
        flags: [],
        notes: [
          '🚨 Для "PhotoPosterA5Wood" відсутній друкарський файл (_tib_design_link_1). Preview не використовується як source для друку.',
        ],
        previewImages: [],
        qr: {
          requested: false,
          valid: false,
          shouldGenerate: false,
          originalUrl: null,
          url: null,
        },
        materials: [
          {
            type: "poster",
            code: "AA5",
            index: 1,
            total: 1,
            filename: "CGU_AA5_28297_1_1",
            productId: 10,
            sku: "PhotoPosterA5Wood",
            sourceUrl: null,
            text: null,
            format: "A5",
            standType: null,
          },
        ],
      }),
    } as never,
    pdfPipelineService: {
      generateForOrder: async () => {
        pdfCalled = true;
        throw new Error("must not run");
      },
    } as never,
    telegramDeliveryService: {
      sendOrderMaterials: async () => {
        telegramCalled = true;
        throw new Error("must not run");
      },
    } as never,
    telegramMessageMapStore: {
      linkMessages: async () => ({ linked: 0 }),
    } as never,
  });

  await worker({
    id: "j8",
    key: "k8",
    status: "queued",
    attempt: 1,
    maxAttempts: 3,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    payload: {
      ...baseJobPayload(),
      orderId: "28297",
    },
  });

  assert.equal(updatedStatusId, 40);
  assert.equal(pdfCalled, false);
  assert.equal(telegramCalled, false);
  assert.equal(sentAlerts.length, 1);
  assert.equal(sentProcessingAlerts.length, 1);
  assert.equal(sentAlerts[0]?.title, 'Замовлення переведено в "Без файлу"');
  assert.equal(sentAlerts[0]?.orderId, "28297");
  assert.equal(sentProcessingAlerts[0]?.title, "Не вдалося сформувати PDF");
  assert.equal(sentProcessingAlerts[0]?.orderId, "28297");
  assert.match(
    sentAlerts[0]?.details ?? "",
    /відсутній друкарський source PDF/i,
  );
  assert.match(
    sentProcessingAlerts[0]?.details ?? "",
    /відсутній друкарський source PDF/i,
  );
});

test("order worker keeps CRM status unchanged when poster source is missing but preview exists", async () => {
  let pdfCalled = false;
  let telegramCalled = false;
  let updatedStatusId: number | null = null;
  const sentAlerts: Array<{ title: string; details?: string; orderId?: string }> = [];
  const sentProcessingAlerts: Array<{ title: string; details?: string; orderId?: string }> = [];

  const worker = createOrderIntakeWorker({
    logger: logger(),
    materialsStatusId: 20,
    missingFileStatusId: 40,
    opsAlertService: {
      send: async (params) => {
        sentAlerts.push({
          title: params.title,
          details: params.details,
          orderId: params.orderId,
        });
        return { sent: true, deduplicated: false };
      },
    },
    processingAlertService: {
      send: async (params) => {
        sentProcessingAlerts.push({
          title: params.title,
          details: params.details,
          orderId: params.orderId,
        });
        return { sent: true, deduplicated: false };
      },
    },
    crmClient: {
      getOrder: async () => ({ id: 29476, status_id: 20, products: [] }),
      updateOrderStatus: async (_orderId: string, statusId: number) => {
        updatedStatusId = statusId;
        return { id: 29476, status_id: statusId, products: [] };
      },
    },
    layoutPlanBuilder: {
      build: () => ({
        orderNumber: "29476",
        urgent: false,
        flags: [],
        notes: [
          '🚨 Для "PosterGiftA5WW" відсутній друкарський файл (_tib_design_link_1). Preview не використовується як source для друку.',
        ],
        previewImages: ["https://cdn.teeinblue.com/customizations/example-preview.jpg"],
        qr: {
          requested: false,
          valid: false,
          shouldGenerate: false,
          originalUrl: null,
          url: null,
        },
        materials: [
          {
            type: "poster",
            code: "AA5",
            index: 1,
            total: 1,
            filename: "CGU_AA5_29476_1_1",
            productId: 10,
            sku: "PosterGiftA5WW",
            sourceUrl: null,
            text: null,
            format: "A5",
            standType: null,
          },
        ],
      }),
    } as never,
    pdfPipelineService: {
      generateForOrder: async () => {
        pdfCalled = true;
        throw new Error("must not run");
      },
    } as never,
    telegramDeliveryService: {
      sendOrderMaterials: async () => {
        telegramCalled = true;
        throw new Error("must not run");
      },
    } as never,
    telegramMessageMapStore: {
      linkMessages: async () => ({ linked: 0 }),
    } as never,
  });

  await worker({
    id: "j8-preview",
    key: "k8-preview",
    status: "queued",
    attempt: 1,
    maxAttempts: 3,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    payload: {
      ...baseJobPayload(),
      orderId: "29476",
      statusId: 20,
    },
  });

  assert.equal(updatedStatusId, null);
  assert.equal(pdfCalled, false);
  assert.equal(telegramCalled, false);
  assert.equal(sentAlerts.length, 1);
  assert.equal(sentProcessingAlerts.length, 1);
  assert.equal(sentAlerts[0]?.title, "Не вдалося сформувати PDF");
  assert.equal(sentAlerts[0]?.orderId, "29476");
  assert.equal(sentProcessingAlerts[0]?.title, "Не вдалося сформувати PDF");
  assert.equal(sentProcessingAlerts[0]?.orderId, "29476");
  assert.match(
    sentAlerts[0]?.details ?? "",
    /відсутній друкарський source PDF/i,
  );
  assert.match(
    sentProcessingAlerts[0]?.details ?? "",
    /відсутній друкарський source PDF/i,
  );
});

test("order worker moves order to missing file and alerts ops when engraving or sticker text is missing", async () => {
  let pdfCalled = false;
  let telegramCalled = false;
  let updatedStatusId: number | null = null;
  const sentAlerts: Array<{ details?: string; orderId?: string }> = [];
  const sentProcessingAlerts: Array<{ details?: string; orderId?: string }> = [];

  const worker = createOrderIntakeWorker({
    logger: logger(),
    materialsStatusId: 20,
    missingFileStatusId: 40,
    opsAlertService: {
      send: async (params) => {
        sentAlerts.push({
          details: params.details,
          orderId: params.orderId,
        });
        return { sent: true, deduplicated: false };
      },
    },
    processingAlertService: {
      send: async (params) => {
        sentProcessingAlerts.push({
          details: params.details,
          orderId: params.orderId,
        });
        return { sent: true, deduplicated: false };
      },
    },
    crmClient: {
      getOrder: async () => ({ id: 903, status_id: 20, products: [] }),
      updateOrderStatus: async (_orderId: string, statusId: number) => {
        updatedStatusId = statusId;
        return { id: 903, status_id: statusId, products: [] };
      },
    },
    layoutPlanBuilder: {
      build: () => ({
        orderNumber: "903",
        urgent: false,
        flags: [],
        notes: [
          "🚨 Замовлено гравіювання, але текст відсутній. Файл CGU_A5W_G_903_2_3 не згенеровано.",
          "🚨 Замовлено стікер, але текст відсутній. Файл CGU_S_903_3_3 не згенеровано.",
        ],
        previewImages: [],
        qr: {
          requested: false,
          valid: false,
          shouldGenerate: false,
          originalUrl: null,
          url: null,
        },
        materials: [
          {
            type: "poster",
            code: "AA5",
            index: 1,
            total: 3,
            filename: "CGU_AA5_903_1_3",
            productId: 20,
            sku: "PhotoPosterA5Wood",
            sourceUrl: "https://example.com/poster.pdf",
            text: null,
            format: "A5",
            standType: null,
          },
        ],
      }),
    } as never,
    pdfPipelineService: {
      generateForOrder: async () => {
        pdfCalled = true;
        throw new Error("must not run");
      },
    } as never,
    telegramDeliveryService: {
      sendOrderMaterials: async () => {
        telegramCalled = true;
        throw new Error("must not run");
      },
    } as never,
    telegramMessageMapStore: {
      linkMessages: async () => ({ linked: 0 }),
    } as never,
  });

  await worker({
    id: "j9",
    key: "k9",
    status: "queued",
    attempt: 1,
    maxAttempts: 3,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    payload: {
      ...baseJobPayload(),
      orderId: "903",
    },
  });

  assert.equal(updatedStatusId, 40);
  assert.equal(pdfCalled, false);
  assert.equal(telegramCalled, false);
  assert.equal(sentAlerts.length, 1);
  assert.equal(sentProcessingAlerts.length, 1);
  assert.equal(sentAlerts[0]?.orderId, "903");
  assert.match(sentAlerts[0]?.details ?? "", /гравіювання, але текст відсутній/i);
  assert.match(sentAlerts[0]?.details ?? "", /стікер, але текст відсутній/i);
  assert.equal(sentProcessingAlerts[0]?.orderId, "903");
  assert.match(sentProcessingAlerts[0]?.details ?? "", /гравіювання, але текст відсутній/i);
  assert.match(sentProcessingAlerts[0]?.details ?? "", /стікер, але текст відсутній/i);
});

test("order worker reports deterministic CDN 403 poster download failures without retry or CRM status change", async () => {
  let updatedStatusId: number | null = null;
  let telegramCalled = false;
  let linkedCalled = false;
  const sentOpsAlerts: Array<{ title?: string; details?: string; orderId?: string }> = [];
  const sentProcessingAlerts: Array<{ title?: string; details?: string; orderId?: string }> = [];

  const worker = createOrderIntakeWorker({
    logger: logger(),
    materialsStatusId: 20,
    missingFileStatusId: 40,
    opsAlertService: {
      send: async (params) => {
        sentOpsAlerts.push({
          title: params.title,
          details: params.details,
          orderId: params.orderId,
        });
        return { sent: true, deduplicated: false };
      },
    },
    processingAlertService: {
      send: async (params) => {
        sentProcessingAlerts.push({
          title: params.title,
          details: params.details,
          orderId: params.orderId,
        });
        return { sent: true, deduplicated: false };
      },
    },
    crmClient: {
      getOrder: async () => ({ id: 29459, status_id: 20, products: [] }),
      updateOrderStatus: async (_orderId: string, statusId: number) => {
        updatedStatusId = statusId;
        return { id: 29459, status_id: statusId, products: [] };
      },
    },
    layoutPlanBuilder: {
      build: () => ({
        orderNumber: "29459",
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
        materials: [
          {
            type: "poster",
            code: "AA5",
            index: 1,
            total: 1,
            filename: "CGU_AA5_29459_1_1",
            productId: 10,
            sku: "MapSquareTA5WoodWW",
            sourceUrl:
              "https://cdn.teeinblue.com/designs/881e379c-7022-462d-acb9-3e20659a0f21/881e379c-7022-462d-acb9-3e20659a0f21-854199.pdf",
            text: null,
            format: "A5",
            standType: null,
          },
        ],
      }),
    } as never,
    pdfPipelineService: {
      generateForOrder: async () => ({
        output_dir: "/tmp",
        color_space: "CMYK" as const,
        warnings: [],
        generated: [],
        failed: [
          {
            type: "poster",
            filename: "CGU_AA5_29459_1_1.pdf",
            path: "/tmp/CGU_AA5_29459_1_1.pdf",
            message: "Failed to download poster PDF (403).",
          },
        ],
      }),
    } as never,
    telegramDeliveryService: {
      sendOrderMaterials: async () => {
        telegramCalled = true;
        throw new Error("must not run");
      },
    } as never,
    telegramMessageMapStore: {
      linkMessages: async () => {
        linkedCalled = true;
        return { linked: 0 };
      },
    } as never,
  });

  await worker({
    id: "j10",
    key: "k10",
    status: "queued",
    attempt: 1,
    maxAttempts: 3,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    payload: {
      ...baseJobPayload(),
      orderId: "29459",
    },
  });

  assert.equal(updatedStatusId, null);
  assert.equal(telegramCalled, false);
  assert.equal(linkedCalled, false);
  assert.equal(sentOpsAlerts.length, 1);
  assert.equal(sentProcessingAlerts.length, 1);
  assert.equal(sentOpsAlerts[0]?.title, "Не вдалося сформувати PDF");
  assert.equal(sentProcessingAlerts[0]?.title, "Не вдалося сформувати PDF");
  assert.equal(sentOpsAlerts[0]?.orderId, "29459");
  assert.equal(sentProcessingAlerts[0]?.orderId, "29459");
  assert.match(sentOpsAlerts[0]?.details ?? "", /CDN \(403\)/);
  assert.match(sentOpsAlerts[0]?.details ?? "", /881e379c-7022-462d-acb9-3e20659a0f21-854199\.pdf/);
  assert.match(sentProcessingAlerts[0]?.details ?? "", /PDF сформувати неможливо/i);
  assert.match(sentProcessingAlerts[0]?.details ?? "", /CGU_AA5_29459_1_1\.pdf/);
});
