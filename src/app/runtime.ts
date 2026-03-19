import type { AppConfig } from "../config/config.types";
import { OpsAlertService } from "../modules/alerts/ops-alert.service";
import { CrmClient } from "../modules/crm/crm-client";
import { PostgresClient } from "../modules/db/postgres-client";
import { ensurePostgresSchema } from "../modules/db/postgres-schema";
import { LayoutPlanBuilder } from "../modules/layout/layout-plan-builder";
import { loadProductCodeRules } from "../modules/layout/product-code-rules";
import { DbIdempotencyStore } from "../modules/orders/order-idempotency";
import { PdfPipelineService } from "../modules/pdf/pdf-pipeline.service";
import { DbDeadLetterStore } from "../modules/queue/db-dead-letter-store";
import { loadQrRules } from "../modules/qr/qr-rules";
import { loadReactionStatusRules } from "../modules/reactions/reaction-status-rules";
import type { OrderIntakeJobPayload, ReactionIntakeJobPayload } from "../modules/queue/queue-jobs";
import { QueueService } from "../modules/queue/queue-service";
import { StorageRetentionService } from "../modules/storage/storage-retention.service";
import { DbTelegramMessageMapStore } from "../modules/telegram/db-telegram-message-map-store";
import { TelegramDeliveryService } from "../modules/telegram/telegram-delivery.service";
import { KeycrmWebhookController } from "../modules/webhook/keycrm-webhook.controller";
import { TelegramWebhookController } from "../modules/webhook/telegram-webhook.controller";
import type { Logger } from "../observability/logger";
import { createOrderIntakeWorker } from "../workers/order-intake-worker";
import { createReactionIntakeWorker } from "../workers/reaction-intake-worker";

export type AppRuntime = {
  keycrmWebhookController: KeycrmWebhookController;
  telegramWebhookController: TelegramWebhookController;
  orderQueue: QueueService<OrderIntakeJobPayload>;
  reactionQueue: QueueService<ReactionIntakeJobPayload>;
  idempotencyStore: DbIdempotencyStore;
  deadLetterStore: DbDeadLetterStore;
  storageRetentionService: StorageRetentionService;
  shutdown: () => Promise<void>;
};

export async function createRuntime(config: AppConfig, logger: Logger): Promise<AppRuntime> {
  const postgresClient = new PostgresClient({
    connectionString: config.databaseUrl,
    maxPoolSize: config.databasePoolMax,
  });
  await ensurePostgresSchema(postgresClient);

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
  const reactionStatusRules = await loadReactionStatusRules(config.reactionStatusRulesPath);
  const layoutPlanBuilder = new LayoutPlanBuilder(productCodeRules);
  const opsAlertService = new OpsAlertService({
    botToken: config.telegramBotToken,
    chatId: config.telegramOpsChatId || config.telegramChatId,
    messageThreadId: config.telegramOpsThreadId,
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
  const telegramDeliveryService = new TelegramDeliveryService({
    botToken: config.telegramBotToken,
    chatId: config.telegramChatId,
    messageThreadId: config.telegramMessageThreadId,
    requestOptions: {
      timeoutMs: config.telegramRequestTimeoutMs,
      retries: config.telegramRequestRetries,
      retryBaseMs: config.telegramRequestRetryBaseMs,
    },
    legacyModulePath: config.telegramLegacyClientPath,
  });
  const pdfPipelineService = new PdfPipelineService({
    logger,
    qrRules,
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
    legacyModulePath: config.pdfLegacyModulePath,
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
  await storageRetentionService.start();

  const shouldRetryQueueError = (error: unknown): boolean =>
    (error as { retryable?: unknown })?.retryable === true;

  const orderQueue = new QueueService<OrderIntakeJobPayload>({
    name: "order_intake",
    concurrency: config.orderQueueConcurrency,
    maxQueueSize: config.orderQueueMaxSize,
    jobTimeoutMs: config.queueJobTimeoutMs,
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

  const reactionQueue = new QueueService<ReactionIntakeJobPayload>({
    name: "reaction_intake",
    concurrency: config.reactionQueueConcurrency,
    maxQueueSize: config.reactionQueueMaxSize,
    jobTimeoutMs: config.queueJobTimeoutMs,
    maxAttempts: config.reactionQueueMaxAttempts,
    retryBaseMs: config.reactionQueueRetryBaseMs,
    shouldRetry: ({ error }) => shouldRetryQueueError(error),
    handler: createReactionIntakeWorker({
      logger,
      crmClient,
      messageMapStore: telegramMessageMapStore,
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

  const keycrmWebhookController = new KeycrmWebhookController({
    logger,
    orderQueue,
    idempotencyStore,
    webhookSecret: config.keycrmWebhookSecret,
  });

  const telegramWebhookController = new TelegramWebhookController({
    logger,
    reactionQueue,
    webhookSecret: config.telegramReactionSecretToken,
    trackedHeartEmojis: ["❤️", "❤", "♥️", "♥"],
    reactionStages: reactionStatusRules.stages.map((item) => item.heartCount),
  });

  return {
    keycrmWebhookController,
    telegramWebhookController,
    orderQueue,
    reactionQueue,
    idempotencyStore,
    deadLetterStore,
    storageRetentionService,
    shutdown: async () => {
      storageRetentionService.stop();
      await postgresClient.close();
    },
  };
}
