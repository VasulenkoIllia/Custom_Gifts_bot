import type { CrmClient } from "../modules/crm/crm-client";
import {
  extractErrorMessage,
  isLikelyTransientErrorMessage,
  OrderProcessingError,
  resolveRetryableError,
} from "../modules/errors/worker-errors";
import type { LayoutPlanBuilder } from "../modules/layout/layout-plan-builder";
import { resolveCaptionQrUrl, type PdfPipelineService } from "../modules/pdf/pdf-pipeline.service";
import type { OrderIntakeJobPayload } from "../modules/queue/queue-jobs";
import type { QueueHandler } from "../modules/queue/queue.types";
import type { TelegramDeliveryService } from "../modules/telegram/telegram-delivery.service";
import type { TelegramMessageMapStore } from "../modules/telegram/telegram-message-map.types";
import type { Logger } from "../observability/logger";

type CreateOrderIntakeWorkerParams = {
  crmClient: Pick<CrmClient, "getOrder">;
  layoutPlanBuilder: LayoutPlanBuilder;
  pdfPipelineService: PdfPipelineService;
  telegramDeliveryService: TelegramDeliveryService;
  telegramMessageMapStore: Pick<TelegramMessageMapStore, "linkMessages">;
  materialsStatusId: number;
  logger: Logger;
};

function normalizeStatusId(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

export function createOrderIntakeWorker({
  crmClient,
  layoutPlanBuilder,
  pdfPipelineService,
  telegramDeliveryService,
  telegramMessageMapStore,
  materialsStatusId,
  logger,
}: CreateOrderIntakeWorkerParams): QueueHandler<OrderIntakeJobPayload> {
  return async (job) => {
    const webhookStatusId = normalizeStatusId(job.payload.statusId);
    if (webhookStatusId !== null && webhookStatusId !== materialsStatusId) {
      logger.info("order_intake_skipped_by_webhook_status", {
        orderId: job.payload.orderId,
        webhookStatusId,
        materialsStatusId,
        jobId: job.id,
      });
      return;
    }

    const order = await crmClient.getOrder(job.payload.orderId);
    const orderStatusId = normalizeStatusId(order.status_id ?? job.payload.statusId);
    if (orderStatusId !== null && orderStatusId !== materialsStatusId) {
      logger.info("order_intake_skipped_by_order_status", {
        orderId: String(order.id),
        orderStatusId,
        materialsStatusId,
        jobId: job.id,
      });
      return;
    }

    const layoutPlan = layoutPlanBuilder.build(order);
    const productCount = Array.isArray(order.products) ? order.products.length : 0;

    logger.info("order_intake_processed", {
      orderId: String(order.id),
      productCount,
      statusId: order.status_id ?? job.payload.statusId,
      sourceUuid: job.payload.sourceUuid,
      jobId: job.id,
      materialsCount: layoutPlan.materials.length,
      materialFilenames: layoutPlan.materials.map((item) => item.filename),
      flags: layoutPlan.flags,
      urgent: layoutPlan.urgent,
    });

    const orderId = String(order.id);
    let pdfResult;
    try {
      pdfResult = await pdfPipelineService.generateForOrder({
        orderId,
        layoutPlan,
      });
    } catch (error) {
      const message = extractErrorMessage(error);
      throw new OrderProcessingError({
        message: `PDF pipeline exception: ${message}`,
        orderId,
        retryable: resolveRetryableError(error),
        failureKind: "pdf_generation",
      });
    }

    if (pdfResult.failed.length > 0) {
      const firstFailure = pdfResult.failed[0];
      const firstFailureMessage = firstFailure
        ? `${firstFailure.filename} -> ${firstFailure.message}`
        : "unknown";
      const errorMessage = `PDF pipeline failed for ${pdfResult.failed.length} material(s). First: ${firstFailureMessage}`;
      throw new OrderProcessingError({
        message: errorMessage,
        orderId,
        retryable: isLikelyTransientErrorMessage(errorMessage),
        failureKind: "pdf_generation",
      });
    }

    logger.info("order_pdf_pipeline_completed", {
      orderId: String(order.id),
      generated: pdfResult.generated.length,
      warnings: pdfResult.warnings,
      outputDir: pdfResult.output_dir,
    });

    const telegramWarnings = Array.from(
      new Set([...layoutPlan.notes, ...pdfResult.warnings]),
    );
    const captionQrUrl = resolveCaptionQrUrl({
      layoutPlan,
      generatedFiles: pdfResult.generated,
    });

    let telegramResult;
    try {
      telegramResult = await telegramDeliveryService.sendOrderMaterials({
        orderId,
        flags: layoutPlan.flags,
        warnings: telegramWarnings,
        qrUrl: captionQrUrl,
        previewImages: layoutPlan.previewImages,
        generatedFiles: pdfResult.generated,
      });
    } catch (error) {
      const message = extractErrorMessage(error);
      throw new OrderProcessingError({
        message: `Telegram delivery failed: ${message}`,
        orderId,
        retryable: resolveRetryableError(error),
        failureKind: "telegram_delivery",
      });
    }

    let linked;
    try {
      linked = await telegramMessageMapStore.linkMessages({
        orderId: String(order.id),
        chatId: telegramResult.chatId,
        messageIds: telegramResult.messageIds,
      });
    } catch (error) {
      const message = extractErrorMessage(error);
      throw new OrderProcessingError({
        message: `Telegram message mapping failed: ${message}`,
        orderId,
        retryable: resolveRetryableError(error),
        failureKind: "telegram_delivery",
      });
    }

    if (linked.linked <= 0) {
      throw new OrderProcessingError({
        message: "Telegram message mapping failed: no file messages were linked.",
        orderId,
        retryable: true,
        failureKind: "telegram_delivery",
      });
    }

    logger.info("order_telegram_delivery_completed", {
      orderId: String(order.id),
      chatId: telegramResult.chatId,
      previewMessageIds: telegramResult.previewMessageIds,
      messageIds: telegramResult.messageIds,
      linkedMessages: linked.linked,
      warnings: telegramResult.warnings ?? [],
      jobId: job.id,
    });

    if (Array.isArray(telegramResult.warnings) && telegramResult.warnings.length > 0) {
      logger.warn("order_telegram_delivery_preview_warnings", {
        orderId: String(order.id),
        warnings: telegramResult.warnings,
        jobId: job.id,
      });
    }
  };
}
