import type { ReactionIntakeJobPayload } from "../modules/queue/queue-jobs";
import type { QueueHandler } from "../modules/queue/queue.types";
import type { Logger } from "../observability/logger";

type CreateReactionIntakeWorkerParams = {
  logger: Logger;
};

export function createReactionIntakeWorker({
  logger,
}: CreateReactionIntakeWorkerParams): QueueHandler<ReactionIntakeJobPayload> {
  return async (job) => {
    logger.info("reaction_intake_received", {
      updateId: job.payload.updateId,
      chatId: job.payload.chatId,
      messageId: job.payload.messageId,
      heartCount: job.payload.heartCount,
      jobId: job.id,
    });
  };
}
