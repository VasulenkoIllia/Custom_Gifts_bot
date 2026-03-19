import type { AppConfig } from "../config/config.types";
import { CrmClient } from "../modules/crm/crm-client";
import { FileIdempotencyStore } from "../modules/orders/order-idempotency";
import type { OrderIntakeJobPayload, ReactionIntakeJobPayload } from "../modules/queue/queue-jobs";
import { QueueService } from "../modules/queue/queue-service";
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

  const orderQueue = new QueueService<OrderIntakeJobPayload>({
    name: "order_intake",
    concurrency: config.orderQueueConcurrency,
    maxQueueSize: config.orderQueueMaxSize,
    jobTimeoutMs: config.queueJobTimeoutMs,
    handler: createOrderIntakeWorker({
      crmClient,
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
    handler: createReactionIntakeWorker({ logger }),
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
