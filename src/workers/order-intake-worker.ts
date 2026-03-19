import type { CrmClient } from "../modules/crm/crm-client";
import type { OrderIntakeJobPayload } from "../modules/queue/queue-jobs";
import type { QueueHandler } from "../modules/queue/queue.types";
import type { Logger } from "../observability/logger";

type CreateOrderIntakeWorkerParams = {
  crmClient: CrmClient;
  logger: Logger;
};

export function createOrderIntakeWorker({
  crmClient,
  logger,
}: CreateOrderIntakeWorkerParams): QueueHandler<OrderIntakeJobPayload> {
  return async (job) => {
    const order = await crmClient.getOrder(job.payload.orderId);
    const productCount = Array.isArray(order.products) ? order.products.length : 0;

    logger.info("order_intake_processed", {
      orderId: String(order.id),
      productCount,
      statusId: order.status_id ?? job.payload.statusId,
      sourceUuid: job.payload.sourceUuid,
      jobId: job.id,
    });
  };
}
