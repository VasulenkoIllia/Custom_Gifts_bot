import type { CrmClient } from "../modules/crm/crm-client";
import { extractErrorMessage, resolveRetryableError } from "../modules/errors/worker-errors";
import {
  resolvePrimaryReactionCount,
  resolveStageForReactionCounts,
  type ReactionStatusRules,
} from "../modules/reactions/reaction-status-rules";
import type { ReactionIntakeJobPayload } from "../modules/queue/queue-jobs";
import type { QueueHandler } from "../modules/queue/queue.types";
import type { TelegramMessageMapStore } from "../modules/telegram/telegram-message-map.types";
import type { TelegramForwardingService } from "../modules/telegram/telegram-forwarding.service";
import type { Logger } from "../observability/logger";

type CreateReactionIntakeWorkerParams = {
  crmClient: Pick<CrmClient, "updateOrderStatus">;
  messageMapStore: Pick<
    TelegramMessageMapStore,
    | "getOrderIdByMessage"
    | "listMessagesByOrder"
    | "markMessageHeartCount"
    | "getOrderState"
    | "upsertOrderState"
  >;
  telegramForwardingService: Pick<TelegramForwardingService, "forwardOrderMaterials">;
  reactionRules: ReactionStatusRules;
  logger: Logger;
};

function createReactionProcessingError(message: string, error: unknown): Error {
  const wrapped = new Error(`${message}: ${extractErrorMessage(error)}`) as Error & {
    retryable?: boolean;
    failureKind?: string;
  };
  wrapped.name = "ReactionProcessingError";
  wrapped.retryable = resolveRetryableError(error);
  wrapped.failureKind = "reaction_processing";
  return wrapped;
}

export function createReactionIntakeWorker({
  crmClient,
  messageMapStore,
  telegramForwardingService,
  reactionRules,
  logger,
}: CreateReactionIntakeWorkerParams): QueueHandler<ReactionIntakeJobPayload> {
  return async (job) => {
    const chatId = String(job.payload.chatId ?? "").trim();
    const messageId = Number.parseInt(String(job.payload.messageId ?? ""), 10);
    const emojiCounts =
      job.payload.emojiCounts && typeof job.payload.emojiCounts === "object"
        ? job.payload.emojiCounts
        : {};
    const primaryReactionCount = resolvePrimaryReactionCount(reactionRules.stages, emojiCounts);

    if (!chatId || !Number.isFinite(messageId)) {
      logger.info("reaction_intake_skipped_invalid_identity", {
        updateId: job.payload.updateId,
        chatId: job.payload.chatId,
        messageId: job.payload.messageId,
        reactionCount: primaryReactionCount,
        emojiCounts: job.payload.emojiCounts,
        jobId: job.id,
      });
      return;
    }

    let orderId: string | null = null;
    try {
      orderId = await messageMapStore.getOrderIdByMessage(chatId, messageId);
    } catch (error) {
      throw createReactionProcessingError("Failed to resolve order by Telegram message", error);
    }
    if (!orderId) {
      logger.info("reaction_intake_skipped_message_unmapped", {
        updateId: job.payload.updateId,
        chatId,
        messageId,
        reactionCount: primaryReactionCount,
        emojiCounts,
        jobId: job.id,
      });
      return;
    }

    try {
      await messageMapStore.markMessageHeartCount(chatId, messageId, primaryReactionCount);
    } catch (error) {
      throw createReactionProcessingError("Failed to persist reaction count", error);
    }

    const targetStage = resolveStageForReactionCounts(reactionRules.stages, emojiCounts);
    if (!targetStage) {
      logger.info("reaction_intake_no_target_stage", {
        orderId,
        chatId,
        messageId,
        reactionCount: primaryReactionCount,
        emojiCounts,
        jobId: job.id,
      });
      return;
    }

    let currentState: Awaited<ReturnType<typeof messageMapStore.getOrderState>> | null = null;
    try {
      currentState = await messageMapStore.getOrderState(orderId);
    } catch (error) {
      throw createReactionProcessingError("Failed to load reaction workflow state", error);
    }
    const currentStageIndex = Number.isFinite(currentState?.highestStageIndex)
      ? Number(currentState?.highestStageIndex)
      : -1;
    if (targetStage.index <= currentStageIndex) {
      logger.info("reaction_intake_stage_already_applied", {
        orderId,
        chatId,
        messageId,
        reactionCount: primaryReactionCount,
        emojiCounts,
        targetStage: targetStage.stage.code,
        targetStatusId: targetStage.stage.statusId,
        currentStageIndex,
        jobId: job.id,
      });
      return;
    }

    const stagesToApply = reactionRules.stages
      .map((stage, index) => ({ stage, index }))
      .filter((item) => item.index > currentStageIndex && item.index <= targetStage.index && item.stage.enabled);

    if (stagesToApply.length === 0) {
      logger.info("reaction_intake_no_enabled_stage_to_apply", {
        orderId,
        chatId,
        messageId,
        targetStage: targetStage.stage.code,
        targetStageIndex: targetStage.index,
        currentStageIndex,
        jobId: job.id,
      });
      return;
    }

    let appliedStatusId = targetStage.stage.statusId;
    for (const stageEntry of stagesToApply) {
      try {
        await crmClient.updateOrderStatus(orderId, stageEntry.stage.statusId);
      } catch (error) {
        throw createReactionProcessingError("Failed to update CRM order status from reaction", error);
      }
      appliedStatusId = stageEntry.stage.statusId;

      if (stageEntry.stage.code === "PRINT") {
        let sourceMessages;
        try {
          sourceMessages = await messageMapStore.listMessagesByOrder(orderId);
        } catch (error) {
          throw createReactionProcessingError(
            "Failed to load Telegram PDF messages for forwarding",
            error,
          );
        }

        try {
          const forwardingResult = await telegramForwardingService.forwardOrderMaterials({
            orderId,
            stageCode: stageEntry.stage.code,
            sourceMessages,
          });
          logger.info("reaction_intake_forwarded_to_orders", {
            orderId,
            stageCode: stageEntry.stage.code,
            forwardedCount: forwardingResult.forwardedCount,
            skippedCount: forwardingResult.skippedCount,
            targetChatId: forwardingResult.targetChatId,
            targetThreadId: forwardingResult.targetThreadId,
            modeCounts: forwardingResult.modeCounts,
            jobId: job.id,
          });
        } catch (error) {
          throw createReactionProcessingError(
            "Failed to forward Telegram order materials",
            error,
          );
        }
      }
    }

    try {
      await messageMapStore.upsertOrderState({
        orderId,
        highestStageIndex: targetStage.index,
        appliedStatusId,
        lastHeartCount: primaryReactionCount,
      });
    } catch (error) {
      throw createReactionProcessingError("Failed to persist reaction workflow state", error);
    }

    logger.info("reaction_intake_received", {
      orderId,
      updateId: job.payload.updateId,
      chatId,
      messageId,
      reactionCount: primaryReactionCount,
      emojiCounts,
      appliedStage: targetStage.stage.code,
      appliedStatusId,
      jobId: job.id,
    });
  };
}
