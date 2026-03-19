import type { Logger } from "../../observability/logger";
import type { IdempotencyStore } from "../orders/order-idempotency";
import type { OrderIntakeJobPayload } from "../queue/queue-jobs";
import { QueueOverflowError, QueueService } from "../queue/queue-service";
import { normalizeKeycrmWebhook } from "./keycrm-webhook-payload";
import { validateWebhookSecret } from "./webhook-auth";
import type { WebhookHandleInput, WebhookHandleResult } from "./webhook.types";

type CreateKeycrmWebhookControllerParams = {
  logger: Logger;
  orderQueue: QueueService<OrderIntakeJobPayload>;
  idempotencyStore: IdempotencyStore;
  webhookSecret: string;
};

const KEYCRM_SECRET_HEADERS = ["x-keycrm-webhook-secret", "x-webhook-secret"];

export class KeycrmWebhookController {
  private readonly logger: Logger;
  private readonly orderQueue: QueueService<OrderIntakeJobPayload>;
  private readonly idempotencyStore: IdempotencyStore;
  private readonly webhookSecret: string;

  constructor(params: CreateKeycrmWebhookControllerParams) {
    this.logger = params.logger;
    this.orderQueue = params.orderQueue;
    this.idempotencyStore = params.idempotencyStore;
    this.webhookSecret = params.webhookSecret;
  }

  async handle(input: WebhookHandleInput): Promise<WebhookHandleResult> {
    const isSecretValid = validateWebhookSecret(
      input.headers,
      this.webhookSecret,
      KEYCRM_SECRET_HEADERS,
    );

    if (!isSecretValid) {
      return {
        statusCode: 401,
        body: {
          ok: false,
          message: "Invalid KeyCRM webhook secret.",
        },
      };
    }

    const normalized = normalizeKeycrmWebhook(input.payload);

    let enqueued = 0;
    let queueDeduplicated = 0;
    let idempotentDuplicates = 0;
    const errors: Array<{ orderId: string; reason: string }> = [];

    for (const candidate of normalized.candidates) {
      const reservation = await this.idempotencyStore.reserve(candidate.idempotencyKey);
      if (!reservation.created) {
        idempotentDuplicates += 1;
        continue;
      }

      try {
        const enqueueResult = this.orderQueue.enqueue({
          key: `order:${candidate.orderId}`,
          payload: {
            orderId: candidate.orderId,
            statusId: candidate.statusId,
            webhookEvent: "order.change_order_status",
            sourceUuid: candidate.sourceUuid,
            receivedAt: new Date().toISOString(),
          },
        });

        if (enqueueResult.deduplicated) {
          queueDeduplicated += 1;
        } else {
          enqueued += 1;
        }
      } catch (error) {
        await this.idempotencyStore.remove(candidate.idempotencyKey);

        if (error instanceof QueueOverflowError) {
          errors.push({
            orderId: candidate.orderId,
            reason: "queue_overflow",
          });
          continue;
        }

        errors.push({
          orderId: candidate.orderId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.info("keycrm_webhook_intake", {
      requestId: input.requestId,
      totalEvents: normalized.totalEvents,
      candidates: normalized.candidates.length,
      skipped: normalized.skipped.length,
      idempotentDuplicates,
      queueDeduplicated,
      enqueued,
      errors: errors.length,
    });

    const hasErrors = errors.length > 0;
    return {
      statusCode: hasErrors ? 207 : 202,
      body: {
        ok: !hasErrors,
        requestId: input.requestId,
        totalEvents: normalized.totalEvents,
        accepted: normalized.candidates.length,
        skipped: normalized.skipped,
        idempotentDuplicates,
        queueDeduplicated,
        enqueued,
        errors,
        queue: this.orderQueue.getStats(),
      },
    };
  }
}
