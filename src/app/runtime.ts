import type { AppConfig } from "../config/config.types";
import { CrmClient } from "../modules/crm/crm-client";
import { LayoutPlanBuilder } from "../modules/layout/layout-plan-builder";
import { loadProductCodeRules } from "../modules/layout/product-code-rules";
import { FileIdempotencyStore } from "../modules/orders/order-idempotency";
import { PdfPipelineService } from "../modules/pdf/pdf-pipeline.service";
import { loadQrRules } from "../modules/qr/qr-rules";
import { loadReactionStatusRules } from "../modules/reactions/reaction-status-rules";
import type { OrderIntakeJobPayload, ReactionIntakeJobPayload } from "../modules/queue/queue-jobs";
import { QueueService } from "../modules/queue/queue-service";
import { TelegramDeliveryService } from "../modules/telegram/telegram-delivery.service";
import { TelegramMessageMapStore } from "../modules/telegram/telegram-message-map-store";
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
  idempotencyStore: FileIdempotencyStore;
};

export async function createRuntime(config: AppConfig, logger: Logger): Promise<AppRuntime> {
  const crmClient = new CrmClient({
    apiBase: config.keycrmApiBase,
    token: config.keycrmToken,
    orderInclude: config.keycrmOrderInclude,
    requestTimeoutMs: config.keycrmRequestTimeoutMs,
    retries: config.keycrmRequestRetries,
    retryBaseMs: config.keycrmRequestRetryBaseMs,
    logger,
  });

  const idempotencyStore = new FileIdempotencyStore(config.idempotencyStorePath);
  await idempotencyStore.init();
  const productCodeRules = await loadProductCodeRules(config.productCodeRulesPath);
  const qrRules = await loadQrRules(config.qrRulesPath);
  const reactionStatusRules = await loadReactionStatusRules(config.reactionStatusRulesPath);
  const layoutPlanBuilder = new LayoutPlanBuilder(productCodeRules);
  const telegramMessageMapStore = new TelegramMessageMapStore(config.telegramMessageMapPath);
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

  const orderQueue = new QueueService<OrderIntakeJobPayload>({
    name: "order_intake",
    concurrency: config.orderQueueConcurrency,
    maxQueueSize: config.orderQueueMaxSize,
    jobTimeoutMs: config.queueJobTimeoutMs,
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
        key: event.key,
        jobId: event.jobId,
        error: event.error,
      });
    },
  });

  const reactionQueue = new QueueService<ReactionIntakeJobPayload>({
    name: "reaction_intake",
    concurrency: config.reactionQueueConcurrency,
    maxQueueSize: config.reactionQueueMaxSize,
    jobTimeoutMs: config.queueJobTimeoutMs,
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
        key: event.key,
        jobId: event.jobId,
        error: event.error,
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
  });

  return {
    keycrmWebhookController,
    telegramWebhookController,
    orderQueue,
    reactionQueue,
    idempotencyStore,
  };
}
