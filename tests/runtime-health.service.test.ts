import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeHealthService } from "../src/modules/health/runtime-health.service";
import type { AppConfig } from "../src/config/config.types";
import type { DbQueryResult, DatabaseClient } from "../src/modules/db/postgres-client";

class HealthyDatabaseClient implements DatabaseClient {
  async query<TRow = Record<string, unknown>>(): Promise<DbQueryResult<TRow>> {
    return {
      rows: [{ ok: 1 } as TRow],
      rowCount: 1,
    };
  }

  async close(): Promise<void> {
    return undefined;
  }
}

function createConfig(role: AppConfig["appRole"]): AppConfig {
  return {
    appRole: role,
    host: "127.0.0.1",
    port: 3000,
    projectPhase: "stage_f_pdf_pipeline",
    databaseUrl: "postgres://example",
    databasePoolMax: 10,
    databasePoolConnectionTimeoutMs: 5_000,
    databasePoolIdleTimeoutMs: 30_000,
    databaseQueryTimeoutMs: 30_000,
    databaseAutoMigrateOnBoot: false,
    databaseMigrationsDir: "migrations",
    requestBodyLimitBytes: 1_000_000,
    keycrmApiBase: "https://example.com",
    keycrmToken: "token",
    keycrmOrderInclude: ["status"],
    keycrmRequestTimeoutMs: 1_000,
    keycrmRequestRetries: 1,
    keycrmRequestRetryBaseMs: 100,
    spotifyRequestTimeoutMs: 1_000,
    spotifyRequestRetries: 1,
    spotifyRequestRetryBaseMs: 100,
    shortenerRequestTimeoutMs: 1_000,
    shortenerRequestRetries: 1,
    shortenerRequestRetryBaseMs: 100,
    lnkUaBearerToken: "",
    cuttlyApiKey: "",
    pdfSourceRequestTimeoutMs: 1_000,
    pdfSourceRequestRetries: 1,
    pdfSourceRequestRetryBaseMs: 100,
    keycrmWebhookSecret: "",
    telegramBotToken: "token",
    telegramChatId: "1",
    telegramMessageThreadId: "",
    telegramOrdersChatId: "1",
    telegramOrdersThreadId: "",
    telegramForwardMode: "copy",
    telegramOpsChatId: "1",
    telegramOpsThreadId: "",
    telegramReactionSecretToken: "",
    telegramRequestTimeoutMs: 1_000,
    telegramRequestRetries: 1,
    telegramRequestRetryBaseMs: 100,
    opsAlertTimeoutMs: 1_000,
    opsAlertRetries: 1,
    opsAlertRetryBaseMs: 100,
    opsAlertDedupeWindowMs: 1_000,
    orderQueueConcurrency: 1,
    orderQueueMaxSize: 10,
    orderQueueMaxAttempts: 1,
    orderQueueRetryBaseMs: 100,
    reactionQueueConcurrency: 1,
    reactionQueueMaxSize: 10,
    reactionQueueMaxAttempts: 1,
    reactionQueueRetryBaseMs: 100,
    queueJobTimeoutMs: 1_000,
    queuePollIntervalMs: 100,
    idempotencyMaxEntries: 10,
    productCodeRulesPath: "config.json",
    reactionStatusRulesPath: "config.json",
    telegramMessageMapMaxEntries: 10,
    qrRulesPath: "rules.json",
    tempDir: "storage/temp",
    outputRetentionHours: 1,
    tempRetentionHours: 1,
    cleanupIntervalMs: 60_000,
    dbCleanupIntervalMs: 60_000,
    dbCleanupBatchSize: 1_000,
    queueJobRetentionHours: 72,
    telegramDeliveryRetentionHours: 720,
    forwardingBatchRetentionHours: 720,
    deadLetterRetentionHours: 336,
    outputDir: "storage/output",
    fontPath: "font.ttf",
    emojiFontPath: "",
    emojiRenderMode: "font",
    appleEmojiBaseUrl: "",
    appleEmojiAssetsDir: "",
    pdfColorSpace: "RGB",
    pdfStickerSizeMm: 100,
    pdfOffWhiteHex: "FFFEFA",
    pdfRasterizeDpi: 300,
    pdfHighDetailDpi: 1200,
    pdfHighDetailSkus: [],
    rasterizeConcurrency: 3,
    qrA5RightMm: 10,
    qrA5BottomMm: 10,
    qrA5SizeMm: 20,
    qrA4RightMm: 10,
    qrA4BottomMm: 10,
    qrA4SizeMm: 30,
    readinessProbeTimeoutMs: 1_000,
    readinessMinDiskFreeBytes: 1,
  };
}

test("RuntimeHealthService reports receiver role as ready without pdf checks", async () => {
  const service = new RuntimeHealthService({
    config: createConfig("receiver"),
    db: new HealthyDatabaseClient(),
    orderQueue: {
      enqueue: async () => ({ jobId: "order", deduplicated: false, queue: orderQueueStats }),
      getStats: async () => orderQueueStats,
    },
    reactionQueue: {
      enqueue: async () => ({ jobId: "reaction", deduplicated: false, queue: reactionQueueStats }),
      getStats: async () => reactionQueueStats,
    },
  });

  const readiness = await service.getReadiness();
  const summary = await service.getHealthSummary();
  const checks = (readiness as { checks: Record<string, { skipped?: boolean }> }).checks;

  assert.equal(readiness.ok, true);
  assert.equal(checks.storage?.skipped, true);
  assert.equal(checks.disk?.skipped, true);
  assert.equal(checks.pdf?.skipped, true);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.queue, {
    order: orderQueueStats,
    reaction: reactionQueueStats,
  });
});

const orderQueueStats = {
  name: "order_intake",
  concurrency: 1,
  maxQueueSize: 10,
  pending: 0,
  running: 0,
  inflightKeys: 0,
};

const reactionQueueStats = {
  name: "reaction_intake",
  concurrency: 1,
  maxQueueSize: 10,
  pending: 0,
  running: 0,
  inflightKeys: 0,
};
