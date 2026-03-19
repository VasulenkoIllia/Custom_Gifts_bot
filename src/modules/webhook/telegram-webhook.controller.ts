import type { Logger } from "../../observability/logger";
import type { ReactionIntakeJobPayload } from "../queue/queue-jobs";
import { QueueOverflowError, QueueService } from "../queue/queue-service";
import { normalizeTelegramUpdates } from "./telegram-webhook-payload";
import { validateWebhookSecret } from "./webhook-auth";
import type { WebhookHandleInput, WebhookHandleResult } from "./webhook.types";

type CreateTelegramWebhookControllerParams = {
  logger: Logger;
  reactionQueue: QueueService<ReactionIntakeJobPayload>;
  webhookSecret: string;
  trackedHeartEmojis: string[];
};

const TELEGRAM_SECRET_HEADERS = ["x-telegram-bot-api-secret-token"];

export class TelegramWebhookController {
  private readonly logger: Logger;
  private readonly reactionQueue: QueueService<ReactionIntakeJobPayload>;
  private readonly webhookSecret: string;
  private readonly trackedHeartEmojis: string[];

  constructor(params: CreateTelegramWebhookControllerParams) {
    this.logger = params.logger;
    this.reactionQueue = params.reactionQueue;
    this.webhookSecret = params.webhookSecret;
    this.trackedHeartEmojis = params.trackedHeartEmojis;
  }

  async handle(input: WebhookHandleInput): Promise<WebhookHandleResult> {
    const isSecretValid = validateWebhookSecret(
      input.headers,
      this.webhookSecret,
      TELEGRAM_SECRET_HEADERS,
    );

    if (!isSecretValid) {
      return {
        statusCode: 401,
        body: {
          ok: false,
          message: "Invalid Telegram secret token.",
        },
      };
    }

    const updates = normalizeTelegramUpdates(input.payload, this.trackedHeartEmojis);
    let enqueued = 0;
    let deduplicated = 0;
    const errors: Array<{ updateId: number | null; reason: string }> = [];

    for (const update of updates) {
      const enqueueKey =
        update.updateId !== null
          ? `update:${update.updateId}`
          : `reaction:${update.chatId ?? "unknown"}:${update.messageId ?? "unknown"}:${update.heartCount ?? "none"}`;

      try {
        const enqueueResult = this.reactionQueue.enqueue({
          key: enqueueKey,
          payload: {
            updateId: update.updateId,
            chatId: update.chatId,
            messageId: update.messageId,
            heartCount: update.heartCount,
            receivedAt: new Date().toISOString(),
          },
        });

        if (enqueueResult.deduplicated) {
          deduplicated += 1;
        } else {
          enqueued += 1;
        }
      } catch (error) {
        if (error instanceof QueueOverflowError) {
          errors.push({
            updateId: update.updateId,
            reason: "queue_overflow",
          });
          continue;
        }

        errors.push({
          updateId: update.updateId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.info("telegram_webhook_intake", {
      requestId: input.requestId,
      updates: updates.length,
      enqueued,
      deduplicated,
      errors: errors.length,
    });

    const hasErrors = errors.length > 0;
    return {
      statusCode: hasErrors ? 207 : 202,
      body: {
        ok: !hasErrors,
        requestId: input.requestId,
        updates: updates.length,
        enqueued,
        deduplicated,
        errors,
        queue: this.reactionQueue.getStats(),
      },
    };
  }
}
