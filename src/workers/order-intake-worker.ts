import type { KeycrmOrderProduct } from "../domain/orders/order.types";
import type { CrmClient } from "../modules/crm/crm-client";
import {
  extractErrorMessage,
  isLikelyTransientErrorMessage,
  OrderProcessingError,
  resolveRetryableError,
} from "../modules/errors/worker-errors";
import type { LayoutPlanBuilder } from "../modules/layout/layout-plan-builder";
import type { LayoutPlan } from "../modules/layout/layout.types";
import { resolveCaptionQrUrl, type PdfPipelineService } from "../modules/pdf/pdf-pipeline.service";
import type { PdfPipelineResult } from "../modules/pdf/pdf.types";
import type { OrderIntakeJobPayload } from "../modules/queue/queue-jobs";
import type { QueueHandler } from "../modules/queue/queue.types";
import type { TelegramDeliveryService } from "../modules/telegram/telegram-delivery.service";
import type { TelegramMessageMapStore } from "../modules/telegram/telegram-message-map.types";
import type { Logger } from "../observability/logger";

type CreateOrderIntakeWorkerParams = {
  crmClient: Pick<CrmClient, "getOrder" | "updateOrderStatus">;
  layoutPlanBuilder: LayoutPlanBuilder;
  pdfPipelineService: PdfPipelineService;
  telegramDeliveryService: TelegramDeliveryService;
  telegramMessageMapStore: Pick<TelegramMessageMapStore, "linkMessages">;
  materialsStatusId: number;
  missingFileStatusId: number | null;
  opsAlertService: {
    send: (params: {
      level: "warning" | "error" | "critical";
      module: string;
      title: string;
      orderId?: string;
      details?: string;
      dedupeKey?: string;
    }) => Promise<{ sent: boolean; deduplicated: boolean }>;
  };
  processingAlertService?: {
    send: (params: {
      level: "warning" | "error" | "critical";
      module: string;
      title: string;
      orderId?: string;
      details?: string;
      dedupeKey?: string;
    }) => Promise<{ sent: boolean; deduplicated: boolean }>;
  } | null;
  logger: Logger;
};

const MISSING_ENGRAVING_TEXT_PREFIX = "🚨 Замовлено гравіювання, але текст відсутній.";
const MISSING_STICKER_TEXT_PREFIX = "🚨 Замовлено стікер, але текст відсутній.";

function collectImmediateMissingFileReasons(layoutPlan: LayoutPlan): string[] {
  const reasons = new Set<string>();

  for (const material of layoutPlan.materials) {
    if (material.type === "poster" && !String(material.sourceUrl ?? "").trim()) {
      reasons.add(
        `Для файлу ${material.filename}.pdf відсутній друкарський source PDF (_tib_design_link_1).`,
      );
    }
  }

  for (const note of layoutPlan.notes ?? []) {
    const normalized = String(note ?? "").trim();
    if (!normalized) {
      continue;
    }

    if (normalized.startsWith(MISSING_ENGRAVING_TEXT_PREFIX)) {
      reasons.add("Замовлено гравіювання, але текст відсутній.");
      continue;
    }

    if (normalized.startsWith(MISSING_STICKER_TEXT_PREFIX)) {
      reasons.add("Замовлено стікер, але текст відсутній.");
    }
  }

  return Array.from(reasons);
}

function shouldKeepOrderStatusOnMissingSource(layoutPlan: LayoutPlan, reasons: string[]): boolean {
  if (reasons.length <= 0) {
    return false;
  }

  const hasPreviewImages = Array.isArray(layoutPlan.previewImages) && layoutPlan.previewImages.length > 0;
  if (!hasPreviewImages) {
    return false;
  }

  const hasPosterWithoutSource = layoutPlan.materials.some(
    (material) => material.type === "poster" && !String(material.sourceUrl ?? "").trim(),
  );
  if (!hasPosterWithoutSource) {
    return false;
  }

  const hasAddonTextMissingReason = reasons.some((reason) => {
    const normalized = String(reason ?? "").trim().toLowerCase();
    return normalized.includes("гравіювання") || normalized.includes("стікер");
  });
  if (hasAddonTextMissingReason) {
    return false;
  }

  return reasons.every((reason) => String(reason ?? "").includes("друкарський source PDF"));
}

function collectDeterministicDownloadFailureReasons(params: {
  layoutPlan: LayoutPlan;
  failed: Array<{ filename?: string; message?: string }>;
}): string[] {
  const reasons = new Set<string>();

  for (const failure of params.failed) {
    const message = String(failure.message ?? "").trim();
    const filename = String(failure.filename ?? "").trim() || "невідомий файл";
    const statusMatch = message.match(/Failed to download poster PDF \((\d{3})\)\./i);
    const statusCode = statusMatch?.[1] ?? "";

    if (statusCode === "403" || statusCode === "404") {
      const material = params.layoutPlan.materials.find(
        (item) => `${item.filename}.pdf` === filename,
      );
      const sourceUrl = String(material?.sourceUrl ?? "").trim();
      reasons.add(
        sourceUrl
          ? `Для файлу ${filename} друкарський PDF недоступний у CDN (${statusCode}): ${sourceUrl}`
          : `Для файлу ${filename} друкарський PDF недоступний у CDN (${statusCode}).`,
      );
    }
  }

  return Array.from(reasons);
}

function buildMissingFileTelegramDetails(params: {
  orderId: string;
  layoutPlan: LayoutPlan;
  reasons: string[];
}): string {
  const lines: string[] = [
    "PDF сформувати неможливо.",
    "",
    "Причина:",
    ...params.reasons.map((reason) => `- ${reason}`),
  ];

  if (params.layoutPlan.materials.length > 0) {
    lines.push("", "Матеріали:");
    for (const material of params.layoutPlan.materials) {
      const summary = [
        `${material.filename}.pdf`,
        material.type,
        material.sku ? `SKU ${material.sku}` : "",
        material.sourceUrl ? `source: ${material.sourceUrl}` : "",
        material.text ? `text: ${material.text}` : "",
      ]
        .filter(Boolean)
        .join(" | ");
      lines.push(`- ${summary}`);
    }
  }

  if (params.layoutPlan.flags.length > 0) {
    lines.push("", "Прапорці:");
    for (const flag of params.layoutPlan.flags) {
      lines.push(`- ${flag}`);
    }
  }

  if (params.layoutPlan.notes.length > 0) {
    lines.push("", "Нотатки:");
    for (const note of params.layoutPlan.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}

function normalizeStatusId(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function hasParentKey(product: KeycrmOrderProduct): boolean {
  if (!Array.isArray(product.properties)) {
    return false;
  }

  for (const property of product.properties) {
    const name = String(property?.name ?? "").trim().toLowerCase();
    if (name !== "_parentkey") {
      continue;
    }
    if (String(property?.value ?? "").trim()) {
      return true;
    }
  }

  return false;
}

function parsePositiveQuantity(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 1;
  }
  return parsed;
}

function buildQuantityLines(orderProducts: KeycrmOrderProduct[]): string[] {
  if (!Array.isArray(orderProducts) || orderProducts.length === 0) {
    return [];
  }

  const baseProducts = orderProducts.filter((product) => !hasParentKey(product));
  if (baseProducts.length === 0) {
    return [];
  }

  const quantities = new Map<string, number>();
  for (const product of baseProducts) {
    const label =
      String(product.offer?.sku ?? product.sku ?? "").trim() ||
      String(product.name ?? "").trim() ||
      "Товар";
    const quantity = parsePositiveQuantity(
      (product as KeycrmOrderProduct & { quantity?: unknown }).quantity,
    );
    quantities.set(label, (quantities.get(label) ?? 0) + quantity);
  }

  return Array.from(quantities.entries()).map(([label, quantity]) => `${label} × ${quantity} шт`);
}

function buildPreviewDetails(layoutPlan: LayoutPlan, orderProducts: KeycrmOrderProduct[]): {
  quantityLines: string[];
  engravingTexts: string[];
  stickerTexts: string[];
} {
  const quantityLines = buildQuantityLines(orderProducts);
  const engravingTexts = layoutPlan.materials
    .filter((material) => material.type === "engraving")
    .map((material) => String(material.text ?? "").trim())
    .filter(Boolean);
  const stickerTexts = layoutPlan.materials
    .filter((material) => material.type === "sticker")
    .map((material) => String(material.text ?? "").trim())
    .filter(Boolean);

  return {
    quantityLines,
    engravingTexts,
    stickerTexts,
  };
}

function readNonNegativeInt(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function buildPipelineMetricsForTelegram(
  pdfResult: PdfPipelineResult,
  orderProcessingDurationMs: number,
): {
  pipelineProfile: "standard" | "quality_safe";
  pipelineReason: string | null;
  finalWhiteStrictPixels: number;
  finalWhiteAggressivePixels: number;
  orderProcessingDurationMs: number;
} {
  const profile =
    String(pdfResult.pipeline_profile ?? "").trim().toLowerCase() === "quality_safe"
      ? "quality_safe"
      : "standard";
  const reason = String(pdfResult.pipeline_profile_reason ?? "").trim() || null;

  let strictPixels = 0;
  let aggressivePixels = 0;

  for (const generatedFile of pdfResult.generated) {
    const details =
      generatedFile.details && typeof generatedFile.details === "object"
        ? (generatedFile.details as Record<string, unknown>)
        : null;
    if (!details) {
      continue;
    }

    const finalPreflight =
      details.final_preflight && typeof details.final_preflight === "object"
        ? (details.final_preflight as Record<string, unknown>)
        : null;
    const fallbackFinal =
      details.white_recolor_final && typeof details.white_recolor_final === "object"
        ? (details.white_recolor_final as Record<string, unknown>)
        : null;
    const source = finalPreflight ?? fallbackFinal;
    if (!source) {
      continue;
    }

    strictPixels += readNonNegativeInt(source.residual_strict_white_pixels);
    aggressivePixels += readNonNegativeInt(source.residual_aggressive_white_pixels);
  }

  return {
    pipelineProfile: profile,
    pipelineReason: reason,
    finalWhiteStrictPixels: strictPixels,
    finalWhiteAggressivePixels: aggressivePixels,
    orderProcessingDurationMs: Math.max(0, Math.floor(orderProcessingDurationMs)),
  };
}

export function createOrderIntakeWorker({
  crmClient,
  layoutPlanBuilder,
  pdfPipelineService,
  telegramDeliveryService,
  telegramMessageMapStore,
  materialsStatusId,
  missingFileStatusId,
  opsAlertService,
  processingAlertService = null,
  logger,
}: CreateOrderIntakeWorkerParams): QueueHandler<OrderIntakeJobPayload> {
  const handleMissingFile = async (params: {
    orderId: string;
    reasons: string[];
    layoutPlan: LayoutPlan;
    jobId: string;
    updateCrmStatus?: boolean;
    opsTitle?: string;
  }): Promise<void> => {
    logger.warn("order_intake_missing_file_detected", {
      orderId: params.orderId,
      reasons: params.reasons,
      jobId: params.jobId,
    });

    if (params.updateCrmStatus !== false && missingFileStatusId) {
      try {
        await crmClient.updateOrderStatus(params.orderId, missingFileStatusId);
      } catch (error) {
        logger.error("order_intake_missing_file_status_update_failed", {
          orderId: params.orderId,
          statusId: missingFileStatusId,
          message: error instanceof Error ? error.message : String(error),
          jobId: params.jobId,
        });
      }
    }

    const details = buildMissingFileTelegramDetails({
      orderId: params.orderId,
      layoutPlan: params.layoutPlan,
      reasons: params.reasons,
    });

    if (processingAlertService) {
      try {
        await processingAlertService.send({
          level: "error",
          module: "order_intake",
          title: "Не вдалося сформувати PDF",
          orderId: params.orderId,
          details,
          dedupeKey: `processing_missing_file:${params.orderId}`,
        });
      } catch (error) {
        logger.error("order_intake_missing_file_processing_alert_failed", {
          orderId: params.orderId,
          message: error instanceof Error ? error.message : String(error),
          jobId: params.jobId,
        });
      }
    }

    try {
      await opsAlertService.send({
        level: "error",
        module: "order_intake",
        title: params.opsTitle ?? 'Замовлення переведено в "Без файлу"',
        orderId: params.orderId,
        details,
        dedupeKey: `missing_file:${params.orderId}`,
      });
    } catch (error) {
      logger.error("order_intake_missing_file_alert_failed", {
        orderId: params.orderId,
        message: error instanceof Error ? error.message : String(error),
        jobId: params.jobId,
      });
    }
  };

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

    const orderProcessingStartedAt = Date.now();
    const layoutPlan = layoutPlanBuilder.build(order);
    const productCount = Array.isArray(order.products) ? order.products.length : 0;
    const orderId = String(order.id);

    logger.info("order_intake_processed", {
      orderId,
      productCount,
      statusId: order.status_id ?? job.payload.statusId,
      sourceUuid: job.payload.sourceUuid,
      jobId: job.id,
      materialsCount: layoutPlan.materials.length,
      materialFilenames: layoutPlan.materials.map((item) => item.filename),
      flags: layoutPlan.flags,
      urgent: layoutPlan.urgent,
    });

    const immediateMissingFileReasons = collectImmediateMissingFileReasons(layoutPlan);
    if (immediateMissingFileReasons.length > 0) {
      const keepOrderStatus =
        shouldKeepOrderStatusOnMissingSource(layoutPlan, immediateMissingFileReasons);

      await handleMissingFile({
        orderId,
        reasons: immediateMissingFileReasons,
        layoutPlan,
        jobId: job.id,
        updateCrmStatus: keepOrderStatus ? false : undefined,
        opsTitle: keepOrderStatus ? "Не вдалося сформувати PDF" : undefined,
      });
      return;
    }

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
      const deterministicDownloadFailureReasons = collectDeterministicDownloadFailureReasons({
        layoutPlan,
        failed: pdfResult.failed,
      });
      if (
        deterministicDownloadFailureReasons.length > 0 &&
        deterministicDownloadFailureReasons.length === pdfResult.failed.length
      ) {
        await handleMissingFile({
          orderId,
          reasons: deterministicDownloadFailureReasons,
          layoutPlan,
          jobId: job.id,
          updateCrmStatus: false,
          opsTitle: "Не вдалося сформувати PDF",
        });
        return;
      }

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
      orderProcessingDurationMs: Date.now() - orderProcessingStartedAt,
    });

    const telegramWarnings = Array.from(
      new Set([...layoutPlan.notes, ...pdfResult.warnings]),
    );
    const previewDetails = buildPreviewDetails(
      layoutPlan,
      Array.isArray(order.products) ? order.products : [],
    );
    const captionQrUrl = resolveCaptionQrUrl({
      layoutPlan,
      generatedFiles: pdfResult.generated,
    });
    const pipelineMetrics = buildPipelineMetricsForTelegram(
      pdfResult,
      Date.now() - orderProcessingStartedAt,
    );

    let telegramResult;
    try {
      telegramResult = await telegramDeliveryService.sendOrderMaterials({
        orderId,
        flags: layoutPlan.flags,
        warnings: telegramWarnings,
        qrUrl: captionQrUrl,
        previewImages: layoutPlan.previewImages,
        previewDetails,
        pipelineMetrics,
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
      orderProcessingDurationMs: Date.now() - orderProcessingStartedAt,
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
