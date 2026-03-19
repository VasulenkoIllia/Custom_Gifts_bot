import type { CrmClient } from "../modules/crm/crm-client";
import {
  resolveStageForHeartCount,
  type ReactionStatusRules,
} from "../modules/reactions/reaction-status-rules";
import type { ReactionIntakeJobPayload } from "../modules/queue/queue-jobs";
import type { QueueHandler } from "../modules/queue/queue.types";
import type { TelegramMessageMapStore } from "../modules/telegram/telegram-message-map.types";
import type { Logger } from "../observability/logger";

type CreateReactionIntakeWorkerParams = {
  crmClient: Pick<CrmClient, "updateOrderStatus">;
  messageMapStore: Pick<
    TelegramMessageMapStore,
    "getOrderIdByMessage" | "markMessageHeartCount" | "getOrderState" | "upsertOrderState"
  >;
  reactionRules: ReactionStatusRules;
  logger: Logger;
};

export function createReactionIntakeWorker({
  crmClient,
  messageMapStore,
  reactionRules,
  logger,
}: CreateReactionIntakeWorkerParams): QueueHandler<ReactionIntakeJobPayload> {
  return async (job) => {
    const chatId = String(job.payload.chatId ?? "").trim();
    const messageId = Number.parseInt(String(job.payload.messageId ?? ""), 10);
    const heartCount = Number.isFinite(job.payload.heartCount)
      ? Math.max(0, Math.floor(Number(job.payload.heartCount)))
      : null;

    if (!chatId || !Number.isFinite(messageId) || heartCount === null) {
      logger.info("reaction_intake_skipped_invalid_identity", {
        updateId: job.payload.updateId,
        chatId: job.payload.chatId,
        messageId: job.payload.messageId,
        heartCount: job.payload.heartCount,
        jobId: job.id,
      });
      return;
    }

    const orderId = await messageMapStore.getOrderIdByMessage(chatId, messageId);
    if (!orderId) {
      logger.info("reaction_intake_skipped_message_unmapped", {
        updateId: job.payload.updateId,
        chatId,
        messageId,
        heartCount,
        jobId: job.id,
      });
      return;
    }

    await messageMapStore.markMessageHeartCount(chatId, messageId, heartCount);
    const targetStage = resolveStageForHeartCount(reactionRules.stages, heartCount);
    if (!targetStage) {
      logger.info("reaction_intake_no_target_stage", {
        orderId,
        chatId,
        messageId,
        heartCount,
        jobId: job.id,
      });
      return;
    }

    const currentState = await messageMapStore.getOrderState(orderId);
    const currentStageIndex = Number.isFinite(currentState?.highestStageIndex)
      ? Number(currentState?.highestStageIndex)
      : -1;
    if (targetStage.index <= currentStageIndex) {
      logger.info("reaction_intake_stage_already_applied", {
        orderId,
        chatId,
        messageId,
        heartCount,
        targetStage: targetStage.stage.code,
        targetStatusId: targetStage.stage.statusId,
        currentStageIndex,
        jobId: job.id,
      });
      return;
    }

    await crmClient.updateOrderStatus(orderId, targetStage.stage.statusId);
    await messageMapStore.upsertOrderState({
      orderId,
      highestStageIndex: targetStage.index,
      appliedStatusId: targetStage.stage.statusId,
      lastHeartCount: heartCount,
    });

    logger.info("reaction_intake_received", {
      orderId,
      updateId: job.payload.updateId,
      chatId,
      messageId,
      heartCount,
      appliedStage: targetStage.stage.code,
      appliedStatusId: targetStage.stage.statusId,
      jobId: job.id,
    });
  };
}
