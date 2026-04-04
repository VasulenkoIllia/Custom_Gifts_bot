import type { Logger } from "../../observability/logger";
import {
  resolveStageForReactionCounts,
  type ReactionStageRule,
} from "../reactions/reaction-status-rules";
import type { ReactionIntakeJobPayload } from "../queue/queue-jobs";
import { QueueOverflowError } from "../queue/db-queue.service";
import type { QueueProducer } from "../queue/queue.types";
import { normalizeTelegramUpdates } from "./telegram-webhook-payload";
import { validateWebhookSecret } from "./webhook-auth";
import type { WebhookHandleInput, WebhookHandleResult } from "./webhook.types";

type CreateTelegramWebhookControllerParams = {
  logger: Logger;
  reactionQueue: QueueProducer<ReactionIntakeJobPayload>;
  webhookSecret: string;
  trackedEmojis: string[];
  reactionStages: ReactionStageRule[];
};

const TELEGRAM_SECRET_HEADERS = ["x-telegram-bot-api-secret-token"];

export class TelegramWebhookController {
  private readonly logger: Logger;
  private readonly reactionQueue: QueueProducer<ReactionIntakeJobPayload>;
  private readonly webhookSecret: string;
  private readonly trackedEmojis: string[];
  private readonly reactionStages: ReactionStageRule[];

  constructor(params: CreateTelegramWebhookControllerParams) {
    this.logger = params.logger;
    this.reactionQueue = params.reactionQueue;
    this.webhookSecret = params.webhookSecret;
    this.trackedEmojis = Array.isArray(params.trackedEmojis)
      ? params.trackedEmojis.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];
    this.reactionStages = Array.isArray(params.reactionStages) ? [...params.reactionStages] : [];
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

    const updates = normalizeTelegramUpdates(input.payload, this.trackedEmojis);
    let enqueued = 0;
    let deduplicated = 0;
    const errors: Array<{ updateId: number | null; reason: string }> = [];

    for (const update of updates) {
      const stageBucket = this.resolveStageBucket(update.emojiCounts, update.heartCount);
      const hasMessageIdentity = Boolean(update.chatId) && update.messageId !== null;
      const enqueueKey = hasMessageIdentity
        ? `reaction:${update.chatId}:${update.messageId}:stage:${stageBucket}`
        : update.updateId !== null
          ? `update:${update.updateId}`
          : `reaction:unknown:${stageBucket}`;

      try {
        const enqueueResult = await this.reactionQueue.enqueue({
          key: enqueueKey,
          payload: {
            updateId: update.updateId,
            chatId: update.chatId,
            messageId: update.messageId,
            heartCount: update.heartCount,
            emojiCounts: update.emojiCounts,
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
        queue: await this.reactionQueue.getStats(),
      },
    };
  }

  private resolveStageBucket(
    emojiCounts: Record<string, number> | null | undefined,
    heartCount: number | null,
  ): string {
    const stage = resolveStageForReactionCounts(this.reactionStages, emojiCounts);
    if (stage) {
      return `${stage.index}:${stage.stage.code}`;
    }

    const legacyHeartCount = Number.isFinite(heartCount) ? Math.max(0, Math.floor(Number(heartCount))) : 0;
    return legacyHeartCount > 0 ? `legacy-heart:${legacyHeartCount}` : "none";
  }
}
