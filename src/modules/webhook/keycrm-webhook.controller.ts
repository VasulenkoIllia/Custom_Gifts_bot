import type { Logger } from "../../observability/logger";
import type { IdempotencyStore } from "../orders/order-idempotency";
import type { OrderIntakeJobPayload } from "../queue/queue-jobs";
import { QueueOverflowError } from "../queue/queue-errors";
import type {
  QueueEnqueueWithIdempotencyInput,
  QueueEnqueueWithIdempotencyResult,
  QueueProducer,
} from "../queue/queue.types";
import { normalizeKeycrmWebhook } from "./keycrm-webhook-payload";
import { validateWebhookSecret } from "./webhook-auth";
import type { WebhookHandleInput, WebhookHandleResult } from "./webhook.types";

type CreateKeycrmWebhookControllerParams = {
  logger: Logger;
  orderQueue: QueueProducer<OrderIntakeJobPayload>;
  idempotencyStore: IdempotencyStore;
  webhookSecret: string;
};

const KEYCRM_SECRET_HEADERS = ["x-keycrm-webhook-secret", "x-webhook-secret"];
const KEYCRM_SECRET_QUERY_PARAMS = ["secret", "webhook_secret", "token"];

type QueueWithIdempotentEnqueue = {
  enqueueWithIdempotency: (
    input: QueueEnqueueWithIdempotencyInput<OrderIntakeJobPayload>,
  ) => Promise<QueueEnqueueWithIdempotencyResult>;
};

function validateKeycrmSecret(input: WebhookHandleInput, expectedSecret: string): boolean {
  if (validateWebhookSecret(input.headers, expectedSecret, KEYCRM_SECRET_HEADERS)) {
    return true;
  }

  if (!expectedSecret || !input.url) {
    return !expectedSecret;
  }

  for (const queryParamName of KEYCRM_SECRET_QUERY_PARAMS) {
    const value = input.url.searchParams.get(queryParamName);
    if (typeof value === "string" && value.trim() === expectedSecret) {
      return true;
    }
  }

  return false;
}

function supportsIdempotentEnqueue(
  queue: QueueProducer<OrderIntakeJobPayload>,
): queue is QueueProducer<OrderIntakeJobPayload> & QueueWithIdempotentEnqueue {
  return typeof (queue as Partial<QueueWithIdempotentEnqueue>).enqueueWithIdempotency === "function";
}

export class KeycrmWebhookController {
  private readonly logger: Logger;
  private readonly orderQueue: QueueProducer<OrderIntakeJobPayload>;
  private readonly idempotencyStore: IdempotencyStore;
  private readonly webhookSecret: string;

  constructor(params: CreateKeycrmWebhookControllerParams) {
    this.logger = params.logger;
    this.orderQueue = params.orderQueue;
    this.idempotencyStore = params.idempotencyStore;
    this.webhookSecret = params.webhookSecret;
  }

  async handle(input: WebhookHandleInput): Promise<WebhookHandleResult> {
    const isSecretValid = validateKeycrmSecret(input, this.webhookSecret);

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
      if (supportsIdempotentEnqueue(this.orderQueue)) {
        try {
          const enqueueResult = await this.orderQueue.enqueueWithIdempotency({
            idempotencyKey: candidate.idempotencyKey,
            key: `order:${candidate.orderId}`,
            payload: {
              orderId: candidate.orderId,
              statusId: candidate.statusId,
              webhookEvent: "order.change_order_status",
              sourceUuid: candidate.sourceUuid,
              receivedAt: new Date().toISOString(),
            },
          });

          if (enqueueResult.idempotentDuplicate) {
            idempotentDuplicates += 1;
          } else if (enqueueResult.deduplicated) {
            queueDeduplicated += 1;
          } else {
            enqueued += 1;
          }
        } catch (error) {
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
        continue;
      }

      const reservation = await this.idempotencyStore.reserve(candidate.idempotencyKey);
      if (!reservation.created) {
        idempotentDuplicates += 1;
        continue;
      }

      try {
        const enqueueResult = await this.orderQueue.enqueue({
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
      statusCode: hasErrors ? 503 : 200,
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
        queue: await this.orderQueue.getStats(),
      },
    };
  }
}
