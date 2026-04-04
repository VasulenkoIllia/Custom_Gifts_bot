import fs from "node:fs/promises";
import type { AppConfig } from "../config/config.types";
import { OpsAlertService } from "../modules/alerts/ops-alert.service";
import { CrmClient } from "../modules/crm/crm-client";
import { PostgresClient } from "../modules/db/postgres-client";
import { DbRetentionService } from "../modules/db/db-retention.service";
import {
  applyPostgresMigrations,
  assertPostgresMigrationsApplied,
} from "../modules/db/postgres-migrations";
import { RuntimeHealthService } from "../modules/health/runtime-health.service";
import { LayoutPlanBuilder } from "../modules/layout/layout-plan-builder";
import { loadProductCodeRules } from "../modules/layout/product-code-rules";
import { DbIdempotencyStore } from "../modules/orders/order-idempotency";
import { PdfPipelineService } from "../modules/pdf/pdf-pipeline.service";
import { DbDeadLetterStore } from "../modules/queue/db-dead-letter-store";
import { loadQrRules } from "../modules/qr/qr-rules";
import { DbReactionStatusRulesStore } from "../modules/reactions/db-reaction-status-rules-store";
import { loadReactionStatusRules } from "../modules/reactions/reaction-status-rules";
import type { OrderIntakeJobPayload, ReactionIntakeJobPayload } from "../modules/queue/queue-jobs";
import { DbQueueService } from "../modules/queue/db-queue.service";
import type { QueueProducer } from "../modules/queue/queue.types";
import { StorageRetentionService } from "../modules/storage/storage-retention.service";
import { DbForwardingBatchStore } from "../modules/telegram/db-forwarding-batch-store";
import { DbForwardingEventStore } from "../modules/telegram/db-forwarding-event-store";
import { DbTelegramDeliveryStore } from "../modules/telegram/db-telegram-delivery-store";
import { DbTelegramMessageMapStore } from "../modules/telegram/db-telegram-message-map-store";
import { DbTelegramRoutingConfigStore } from "../modules/telegram/db-telegram-routing-config-store";
import { TelegramDeliveryService } from "../modules/telegram/telegram-delivery.service";
import { TelegramForwardingService } from "../modules/telegram/telegram-forwarding.service";
import { UrlShortenerService } from "../modules/url-shortener/shortener-service";
import { KeycrmWebhookController } from "../modules/webhook/keycrm-webhook.controller";
import { TelegramWebhookController } from "../modules/webhook/telegram-webhook.controller";
import { resolveRetryableError } from "../modules/errors/worker-errors";
import type { Logger } from "../observability/logger";
import { createOrderIntakeWorker } from "../workers/order-intake-worker";
import { createReactionIntakeWorker } from "../workers/reaction-intake-worker";

export type AppRuntime = {
  httpEnabled: boolean;
  keycrmWebhookController?: KeycrmWebhookController;
  telegramWebhookController?: TelegramWebhookController;
  orderQueue: QueueProducer<OrderIntakeJobPayload>;
  reactionQueue: QueueProducer<ReactionIntakeJobPayload>;
  healthService: RuntimeHealthService;
  idempotencyStore: DbIdempotencyStore;
  deadLetterStore: DbDeadLetterStore;
  storageRetentionService: StorageRetentionService;
  dbRetentionService: DbRetentionService;
  shutdown: () => Promise<void>;
};

function isReceiverRole(role: AppConfig["appRole"]): boolean {
  return role === "all" || role === "receiver";
}

function isOrderWorkerRole(role: AppConfig["appRole"]): boolean {
  return role === "all" || role === "workers" || role === "order_worker";
}

function isReactionWorkerRole(role: AppConfig["appRole"]): boolean {
  return role === "all" || role === "workers" || role === "reaction_worker";
}

export async function createRuntime(config: AppConfig, logger: Logger): Promise<AppRuntime> {
  const postgresClient = new PostgresClient({
    connectionString: config.databaseUrl,
    maxPoolSize: config.databasePoolMax,
  });
  if (config.databaseAutoMigrateOnBoot) {
    await applyPostgresMigrations({
      client: postgresClient,
      migrationsDir: config.databaseMigrationsDir,
      logger,
    });
  } else {
    await assertPostgresMigrationsApplied({
      client: postgresClient,
      migrationsDir: config.databaseMigrationsDir,
    });
  }

  const crmClient = new CrmClient({
    apiBase: config.keycrmApiBase,
    token: config.keycrmToken,
    orderInclude: config.keycrmOrderInclude,
    requestTimeoutMs: config.keycrmRequestTimeoutMs,
    retries: config.keycrmRequestRetries,
    retryBaseMs: config.keycrmRequestRetryBaseMs,
    logger,
  });

  const idempotencyStore = new DbIdempotencyStore(postgresClient, config.idempotencyMaxEntries);
  await idempotencyStore.init();
  const deadLetterStore = new DbDeadLetterStore(postgresClient);
  await deadLetterStore.init();
  const productCodeRules = await loadProductCodeRules(config.productCodeRulesPath);
  const qrRules = await loadQrRules(config.qrRulesPath);
  const reactionSeed = await loadReactionStatusRules(config.reactionStatusRulesPath);
  const reactionStatusRulesStore = new DbReactionStatusRulesStore(postgresClient);
  await reactionStatusRulesStore.init();
  await reactionStatusRulesStore.seedIfEmpty(reactionSeed);
  const reactionStatusRules = await reactionStatusRulesStore.load();
  const telegramRoutingStore = new DbTelegramRoutingConfigStore(postgresClient);
  await telegramRoutingStore.init();
  await telegramRoutingStore.seedIfEmpty({
    forwardMode: config.telegramForwardMode,
    destinations: {
      processing: {
        chatId: config.telegramChatId,
        threadId: config.telegramMessageThreadId,
      },
      orders: {
        chatId: config.telegramOrdersChatId,
        threadId: config.telegramOrdersThreadId,
      },
      ops: {
        chatId: config.telegramOpsChatId || config.telegramChatId,
        threadId: config.telegramOpsThreadId,
      },
    },
  });
  const telegramRoutingConfig = await telegramRoutingStore.load();
  const layoutPlanBuilder = new LayoutPlanBuilder(productCodeRules);
  const opsAlertService = new OpsAlertService({
    botToken: config.telegramBotToken,
    chatId: telegramRoutingConfig.destinations.ops.chatId,
    messageThreadId: telegramRoutingConfig.destinations.ops.threadId,
    timeoutMs: config.opsAlertTimeoutMs,
    retries: config.opsAlertRetries,
    retryBaseMs: config.opsAlertRetryBaseMs,
    dedupeWindowMs: config.opsAlertDedupeWindowMs,
  });
  const telegramMessageMapStore = new DbTelegramMessageMapStore(
    postgresClient,
    config.telegramMessageMapMaxEntries,
  );
  await telegramMessageMapStore.init();
  const forwardingEventStore = new DbForwardingEventStore(postgresClient);
  await forwardingEventStore.init();
  const telegramDeliveryStore = new DbTelegramDeliveryStore(postgresClient);
  await telegramDeliveryStore.init();
  const forwardingBatchStore = new DbForwardingBatchStore(postgresClient);
  await forwardingBatchStore.init();
  const telegramDeliveryService = new TelegramDeliveryService({
    botToken: config.telegramBotToken,
    chatId: telegramRoutingConfig.destinations.processing.chatId,
    messageThreadId: telegramRoutingConfig.destinations.processing.threadId,
    requestOptions: {
      timeoutMs: config.telegramRequestTimeoutMs,
      retries: config.telegramRequestRetries,
      retryBaseMs: config.telegramRequestRetryBaseMs,
    },
    deliveryStore: telegramDeliveryStore,
    leaseTtlMs: config.queueJobTimeoutMs,
  });
  const telegramForwardingService = new TelegramForwardingService({
    botToken: config.telegramBotToken,
    targetChatId: telegramRoutingConfig.destinations.orders.chatId,
    targetThreadId: telegramRoutingConfig.destinations.orders.threadId,
    primaryMode: telegramRoutingConfig.forwardMode,
    requestOptions: {
      timeoutMs: config.telegramRequestTimeoutMs,
      retries: config.telegramRequestRetries,
      retryBaseMs: config.telegramRequestRetryBaseMs,
    },
    eventStore: forwardingEventStore,
    batchStore: forwardingBatchStore,
    leaseTtlMs: config.queueJobTimeoutMs,
  });
  const urlShortenerService = new UrlShortenerService({
    timeoutMs: config.shortenerRequestTimeoutMs,
    retries: config.shortenerRequestRetries,
    retryBaseMs: config.shortenerRequestRetryBaseMs,
    lnkUaBearerToken: config.lnkUaBearerToken,
    cuttlyApiKey: config.cuttlyApiKey,
  });
  const pdfPipelineService = new PdfPipelineService({
    logger,
    qrRules,
    urlShortenerService,
    outputRoot: config.outputDir,
    fontPath: config.fontPath,
    emojiFontPath: config.emojiFontPath,
    emojiRenderMode: config.emojiRenderMode,
    appleEmojiBaseUrl: config.appleEmojiBaseUrl,
    appleEmojiAssetsDir: config.appleEmojiAssetsDir,
    colorSpace: config.pdfColorSpace,
    stickerSizeMm: config.pdfStickerSizeMm,
    offWhiteHex: config.pdfOffWhiteHex,
    rasterizeDpi: config.pdfRasterizeDpi,
    spotifyRequestOptions: {
      timeoutMs: config.spotifyRequestTimeoutMs,
      retries: config.spotifyRequestRetries,
      retryBaseMs: config.spotifyRequestRetryBaseMs,
    },
    sourceRequestOptions: {
      timeoutMs: config.pdfSourceRequestTimeoutMs,
      retries: config.pdfSourceRequestRetries,
      retryBaseMs: config.pdfSourceRequestRetryBaseMs,
    },
    qrPlacementByFormat: {
      A5: {
        rightMm: config.qrA5RightMm,
        bottomMm: config.qrA5BottomMm,
        sizeMm: config.qrA5SizeMm,
      },
      A4: {
        rightMm: config.qrA4RightMm,
        bottomMm: config.qrA4BottomMm,
        sizeMm: config.qrA4SizeMm,
      },
    },
  });
  const storageRetentionService = new StorageRetentionService({
    logger,
    outputDir: config.outputDir,
    tempDir: config.tempDir,
    outputRetentionHours: config.outputRetentionHours,
    tempRetentionHours: config.tempRetentionHours,
    cleanupIntervalMs: config.cleanupIntervalMs,
  });
  const dbRetentionService = new DbRetentionService({
    db: postgresClient,
    logger,
    cleanupIntervalMs: config.dbCleanupIntervalMs,
    queueJobRetentionHours: config.queueJobRetentionHours,
    telegramDeliveryRetentionHours: config.telegramDeliveryRetentionHours,
    forwardingBatchRetentionHours: config.forwardingBatchRetentionHours,
    deadLetterRetentionHours: config.deadLetterRetentionHours,
  });
  if (isOrderWorkerRole(config.appRole)) {
    await Promise.all([
      fs.mkdir(config.outputDir, { recursive: true }),
      fs.mkdir(config.tempDir, { recursive: true }),
    ]);
    await storageRetentionService.start();
    await dbRetentionService.start();
  }

  const shouldRetryQueueError = (error: unknown): boolean => resolveRetryableError(error);

  const orderQueue = new DbQueueService<OrderIntakeJobPayload>({
    db: postgresClient,
    name: "order_intake",
    concurrency: config.orderQueueConcurrency,
    maxQueueSize: config.orderQueueMaxSize,
    jobTimeoutMs: config.queueJobTimeoutMs,
    pollIntervalMs: config.queuePollIntervalMs,
    maxAttempts: config.orderQueueMaxAttempts,
    retryBaseMs: config.orderQueueRetryBaseMs,
    shouldRetry: ({ error }) => shouldRetryQueueError(error),
    handler: createOrderIntakeWorker({
      crmClient,
      layoutPlanBuilder,
      pdfPipelineService,
      telegramDeliveryService,
      telegramMessageMapStore,
      materialsStatusId: reactionStatusRules.materialsStatusId,
      logger,
    }),
    onStateChange: (event) => {
      logger.info("queue_state_change", {
        queue: event.queue,
        status: event.status,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        willRetry: event.willRetry,
        retryDelayMs: event.retryDelayMs,
        key: event.key,
        jobId: event.jobId,
        error: event.error,
      });
    },
    onDeadLetter: async (event) => {
      await deadLetterStore.append(event);

      const orderId = String(event.payload?.orderId ?? "").trim();
      const failureKind = String(event.failureKind ?? "").trim();
      try {
        if (
          failureKind === "pdf_generation" &&
          reactionStatusRules.missingFileStatusId &&
          orderId
        ) {
          await crmClient.updateOrderStatus(orderId, reactionStatusRules.missingFileStatusId);
        } else if (
          failureKind === "telegram_delivery" &&
          reactionStatusRules.missingTelegramStatusId &&
          orderId
        ) {
          await crmClient.updateOrderStatus(orderId, reactionStatusRules.missingTelegramStatusId);
        }
      } catch (error) {
        logger.error("order_dead_letter_status_update_failed", {
          orderId,
          failureKind,
          message: error instanceof Error ? error.message : String(error),
        });
      }

      const alertResult = await opsAlertService.send({
        level: "critical",
        module: "order_intake",
        title: "Job moved to DLQ",
        orderId,
        details: `${event.errorType}: ${event.error}`,
        dedupeKey: `${event.queue}:${orderId}:${failureKind || "unknown"}`,
      });

      logger.error("queue_dead_letter_recorded", {
        queue: event.queue,
        jobId: event.jobId,
        orderId,
        failureKind: event.failureKind,
        errorType: event.errorType,
        error: event.error,
        alertSent: alertResult.sent,
        alertDeduplicated: alertResult.deduplicated,
      });
    },
  });

  const reactionQueueConcurrency = 1;
  if (config.reactionQueueConcurrency !== reactionQueueConcurrency) {
    logger.warn("reaction_queue_concurrency_forced", {
      configured: config.reactionQueueConcurrency,
      forced: reactionQueueConcurrency,
      reason: "order status transitions must remain monotonic and serialized",
    });
  }

  const reactionQueue = new DbQueueService<ReactionIntakeJobPayload>({
    db: postgresClient,
    name: "reaction_intake",
    concurrency: reactionQueueConcurrency,
    maxQueueSize: config.reactionQueueMaxSize,
    jobTimeoutMs: config.queueJobTimeoutMs,
    pollIntervalMs: config.queuePollIntervalMs,
    maxAttempts: config.reactionQueueMaxAttempts,
    retryBaseMs: config.reactionQueueRetryBaseMs,
    shouldRetry: ({ error }) => shouldRetryQueueError(error),
    handler: createReactionIntakeWorker({
      logger,
      crmClient,
      messageMapStore: telegramMessageMapStore,
      telegramForwardingService,
      reactionRules: reactionStatusRules,
    }),
    onStateChange: (event) => {
      logger.info("queue_state_change", {
        queue: event.queue,
        status: event.status,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        willRetry: event.willRetry,
        retryDelayMs: event.retryDelayMs,
        key: event.key,
        jobId: event.jobId,
        error: event.error,
      });
    },
    onDeadLetter: async (event) => {
      await deadLetterStore.append(event);
      const alertResult = await opsAlertService.send({
        level: "error",
        module: "reaction_intake",
        title: "Reaction job moved to DLQ",
        details: `${event.errorType}: ${event.error}`,
        dedupeKey: `${event.queue}:${event.payload?.chatId ?? ""}:${event.payload?.messageId ?? ""}`,
      });

      logger.error("queue_dead_letter_recorded", {
        queue: event.queue,
        jobId: event.jobId,
        errorType: event.errorType,
        error: event.error,
        alertSent: alertResult.sent,
        alertDeduplicated: alertResult.deduplicated,
      });
    },
  });

  if (isOrderWorkerRole(config.appRole)) {
    orderQueue.start();
  }
  if (isReactionWorkerRole(config.appRole)) {
    reactionQueue.start();
  }

  const keycrmWebhookController = isReceiverRole(config.appRole)
    ? new KeycrmWebhookController({
        logger,
        orderQueue,
        idempotencyStore,
        webhookSecret: config.keycrmWebhookSecret,
      })
    : undefined;

  const telegramWebhookController = isReceiverRole(config.appRole)
    ? new TelegramWebhookController({
        logger,
        reactionQueue,
        webhookSecret: config.telegramReactionSecretToken,
        trackedEmojis: reactionStatusRules.allowedEmojis,
        reactionStages: reactionStatusRules.stages,
      })
    : undefined;
  const healthService = new RuntimeHealthService({
    config,
    db: postgresClient,
    orderQueue,
    reactionQueue,
  });

  return {
    httpEnabled: true,
    keycrmWebhookController,
    telegramWebhookController,
    orderQueue,
    reactionQueue,
    healthService,
    idempotencyStore,
    deadLetterStore,
    storageRetentionService,
    dbRetentionService,
    shutdown: async () => {
      storageRetentionService.stop();
      dbRetentionService.stop();
      const queueShutdownTimeoutMs = Math.max(30_000, config.queueJobTimeoutMs + 5_000);
      try {
        await Promise.allSettled([
          orderQueue.close(queueShutdownTimeoutMs),
          reactionQueue.close(queueShutdownTimeoutMs),
        ]);
      } finally {
        await postgresClient.close();
      }
    },
  };
}
