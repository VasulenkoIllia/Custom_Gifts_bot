import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Logger } from "../../observability/logger";
import type { LayoutMaterial, LayoutPlan } from "../layout/layout.types";
import { embedQrIntoPosterPdf } from "../qr/qr-code";
import type { QrCodeDecision, QrRules } from "../qr/qr-rules";
import { resolveQrCodeDecision } from "../qr/qr-rules";
import {
  embedSpotifyCodeIntoPosterPdf,
  resolveSpotifyUri,
  type SpotifyRequestOptions,
} from "../qr/spotify-code";
import type { ShortenUrlResult, UrlShortenerService } from "../url-shortener/shortener-service";
import type { GeneratePdfMaterialsInput, PdfGeneratedFile, PdfPipelineResult } from "./pdf.types";
import {
  generateMaterialFiles,
  enforceOffWhiteInPdf,
  measureResidualNearWhiteInPdf,
} from "./material-generator";

type MaterialGeneratorLayoutMaterial = {
  type: "poster" | "engraving" | "sticker";
  code: string;
  productId: number | null;
  sourceUrl: string | null;
  text: string | null;
  format: "A5" | "A4" | null;
  standType: "W" | "WW" | "MWW" | "C" | "K" | null;
  index: number;
  total: number;
  filename: string;
};

type MaterialGeneratorLayoutPlan = {
  orderNumber: string;
  urgent: boolean;
  flags: string[];
  notes: string[];
  previewImages: string[];
  qr: {
    requested: boolean;
    originalUrl: string | null;
    shortUrl: string | null;
    url: string | null;
    valid: boolean;
    shouldGenerate: boolean;
  };
  materials: MaterialGeneratorLayoutMaterial[];
};

type CreatePdfPipelineServiceParams = {
  logger: Logger;
  qrRules: QrRules;
  urlShortenerService?: Pick<UrlShortenerService, "shorten"> | null;
  outputRoot: string;
  fontPath: string;
  emojiFontPath: string;
  emojiRenderMode: "font" | "apple_image";
  appleEmojiBaseUrl: string;
  appleEmojiAssetsDir: string;
  colorSpace: "RGB" | "CMYK";
  stickerSizeMm: number;
  offWhiteHex: string;
  rasterizeDpi: number;
  rasterizeDpiStandard?: number;
  rasterizeDpiQualitySafe?: number;
  qualitySafeProfile?: boolean;
  cmykLossless?: boolean;
  autoRouterEnabled?: boolean;
  autoRouterPreflightDpi?: number;
  autoRouterRiskThreshold?: number;
  autoRouterAggressiveWhitePixels?: number;
  finalPreflightMeasureDpi?: number;
  finalPreflightRetryStrictPixels?: number;
  finalPreflightRetryAggressivePixels?: number;
  spotifyRequestOptions: SpotifyRequestOptions;
  sourceRequestOptions: {
    timeoutMs: number;
    retries: number;
    retryBaseMs: number;
  };
  qrPlacementByFormat: {
    A5: { rightMm: number; bottomMm: number; sizeMm: number };
    A4: { rightMm: number; bottomMm: number; sizeMm: number };
  };
};

type PosterQrDecisionEntry = {
  sku: string | null;
  format: "A5" | "A4" | null;
  decision: QrCodeDecision;
};

type QrDecisionWarningSource = {
  filename: string;
  sku: string | null;
  decision: Pick<QrCodeDecision, "strategy" | "reason">;
};

type MaterialGeneratorLayoutPlanOptions = {
  effectiveQrUrl?: string | null;
  shortQrUrl?: string | null;
};

type QrUrlResolution = {
  url: string | null;
  shortUrl: string | null;
  provider: ShortenUrlResult["provider"] | null;
  warnings: string[];
};

type PipelineProfile = "standard" | "quality_safe";

type PipelineRouteReason =
  | "forced_quality_safe"
  | "auto_disabled"
  | "auto_no_measure"
  | "auto_no_posters"
  | "auto_preflight_failed"
  | "auto_safe"
  | "auto_risk";

type PosterRiskSample = {
  filename: string;
  sourceUrl: string;
  strictWhitePixels: number;
  aggressiveWhitePixels: number;
  strictLowAlphaWhitePixels: number;
  aggressiveLowAlphaWhitePixels: number;
  score: number;
  reasons: string[];
};

type PipelineRouteDecision = {
  profile: PipelineProfile;
  reason: PipelineRouteReason;
  riskScore: number;
  riskReasons: string[];
  posterRiskSamples: PosterRiskSample[];
};

type PosterSourceCache = {
  dir: string;
  sourcePathByUrl: Map<string, string>;
};

export function toMaterialGeneratorLayoutPlan(
  layoutPlan: LayoutPlan,
  options: MaterialGeneratorLayoutPlanOptions = {},
): MaterialGeneratorLayoutPlan {
  return {
    orderNumber: layoutPlan.orderNumber,
    urgent: layoutPlan.urgent,
    flags: [...layoutPlan.flags],
    notes: [...layoutPlan.notes],
    previewImages: [...layoutPlan.previewImages],
    qr: {
      requested: layoutPlan.qr.requested,
      originalUrl: layoutPlan.qr.originalUrl,
      shortUrl: options.shortQrUrl ?? null,
      url: options.effectiveQrUrl ?? layoutPlan.qr.url,
      valid: layoutPlan.qr.valid,
      shouldGenerate: layoutPlan.qr.shouldGenerate,
    },
    materials: layoutPlan.materials.map((item) => ({ ...item })),
  };
}

export function buildQrDecisionWarnings(items: QrDecisionWarningSource[]): string[] {
  const warnings = new Set<string>();

  for (const item of items) {
    if (item.decision.strategy !== "none") {
      continue;
    }

    const filename = String(item.filename ?? "").trim() || "невідомий макет";
    const sku = String(item.sku ?? "").trim();
    const skuLabel = sku ? `SKU ${sku}` : "товару без SKU";

    if (item.decision.reason === "sku_not_whitelisted") {
      warnings.add(
        `🚨 QR-код замовлено, але для ${filename} (${skuLabel}) не налаштовані правила QR. QR не згенеровано і не вбудовано в макет.`,
      );
      continue;
    }

    if (item.decision.reason === "missing_sku") {
      warnings.add(
        `🚨 QR-код замовлено, але для ${filename} відсутній SKU. QR не згенеровано і не вбудовано в макет.`,
      );
      continue;
    }

    if (item.decision.reason === "missing_format") {
      warnings.add(
        `🚨 QR-код замовлено, але для ${filename} не вдалося визначити формат. QR не згенеровано і не вбудовано в макет.`,
      );
    }
  }

  return Array.from(warnings);
}

export function resolveCaptionQrUrl(params: {
  layoutPlan: LayoutPlan;
  generatedFiles: PdfGeneratedFile[];
}): string | null {
  if (!params.layoutPlan.qr.requested || !params.layoutPlan.qr.valid || !params.layoutPlan.qr.url) {
    return null;
  }

  let hasEmbeddedCode = false;

  for (const file of params.generatedFiles) {
    if (file.type !== "poster") {
      continue;
    }

    const details =
      file.details && typeof file.details === "object"
        ? (file.details as Record<string, unknown>)
        : null;
    const qrMeta =
      details && details.qr && typeof details.qr === "object"
        ? (details.qr as Record<string, unknown>)
        : null;

    if (qrMeta?.embedded !== true) {
      continue;
    }

    hasEmbeddedCode = true;
    const embeddedUrl = String(qrMeta.url ?? "").trim();
    if (embeddedUrl) {
      return embeddedUrl;
    }
  }

  return hasEmbeddedCode ? params.layoutPlan.qr.url : null;
}

export class PdfPipelineService {
  private readonly logger: Logger;
  private readonly qrRules: QrRules;
  private readonly urlShortenerService: Pick<UrlShortenerService, "shorten"> | null;
  private readonly outputRoot: string;
  private readonly fontPath: string;
  private readonly emojiFontPath: string;
  private readonly emojiRenderMode: "font" | "apple_image";
  private readonly appleEmojiBaseUrl: string;
  private readonly appleEmojiAssetsDir: string;
  private readonly colorSpace: "RGB" | "CMYK";
  private readonly stickerSizeMm: number;
  private readonly offWhiteHex: string;
  private readonly rasterizeDpi: number;
  private readonly rasterizeDpiStandard: number;
  private readonly rasterizeDpiQualitySafe: number;
  private readonly qualitySafeProfile: boolean;
  private readonly cmykLossless: boolean;
  private readonly autoRouterEnabled: boolean;
  private readonly autoRouterPreflightDpi: number;
  private readonly autoRouterRiskThreshold: number;
  private readonly autoRouterAggressiveWhitePixels: number;
  private readonly finalPreflightMeasureDpi: number;
  private readonly finalPreflightRetryStrictPixels: number;
  private readonly finalPreflightRetryAggressivePixels: number;
  private readonly spotifyRequestOptions: SpotifyRequestOptions;
  private readonly sourceRequestOptions: {
    timeoutMs: number;
    retries: number;
    retryBaseMs: number;
  };
  private readonly qrPlacementByFormat: {
    A5: { rightMm: number; bottomMm: number; sizeMm: number };
    A4: { rightMm: number; bottomMm: number; sizeMm: number };
  };

  constructor(params: CreatePdfPipelineServiceParams) {
    this.logger = params.logger;
    this.qrRules = params.qrRules;
    this.urlShortenerService = params.urlShortenerService ?? null;
    this.outputRoot = path.resolve(params.outputRoot);
    this.fontPath = path.resolve(params.fontPath);
    this.emojiFontPath = params.emojiFontPath ? path.resolve(params.emojiFontPath) : "";
    this.emojiRenderMode = params.emojiRenderMode;
    this.appleEmojiBaseUrl = params.appleEmojiBaseUrl;
    this.appleEmojiAssetsDir = params.appleEmojiAssetsDir
      ? path.resolve(params.appleEmojiAssetsDir)
      : "";
    this.colorSpace = params.colorSpace;
    this.stickerSizeMm = params.stickerSizeMm;
    this.offWhiteHex = params.offWhiteHex;
    this.rasterizeDpi = params.rasterizeDpi;
    this.rasterizeDpiStandard = Number.isFinite(Number(params.rasterizeDpiStandard))
      ? Math.max(72, Math.floor(Number(params.rasterizeDpiStandard)))
      : this.rasterizeDpi;
    this.rasterizeDpiQualitySafe = Number.isFinite(Number(params.rasterizeDpiQualitySafe))
      ? Math.max(72, Math.floor(Number(params.rasterizeDpiQualitySafe)))
      : this.rasterizeDpi;
    this.qualitySafeProfile = Boolean(params.qualitySafeProfile);
    this.cmykLossless = Boolean(params.cmykLossless);
    this.autoRouterEnabled = Boolean(params.autoRouterEnabled);
    this.autoRouterPreflightDpi = Number.isFinite(Number(params.autoRouterPreflightDpi))
      ? Math.max(72, Math.floor(Number(params.autoRouterPreflightDpi)))
      : 300;
    this.autoRouterRiskThreshold = Number.isFinite(Number(params.autoRouterRiskThreshold))
      ? Math.max(1, Math.floor(Number(params.autoRouterRiskThreshold)))
      : 2;
    this.autoRouterAggressiveWhitePixels = Number.isFinite(
      Number(params.autoRouterAggressiveWhitePixels),
    )
      ? Math.max(1, Math.floor(Number(params.autoRouterAggressiveWhitePixels)))
      : 150_000;
    const maxRasterizeDpi = Math.max(this.rasterizeDpiStandard, this.rasterizeDpiQualitySafe);
    this.finalPreflightMeasureDpi = Number.isFinite(Number(params.finalPreflightMeasureDpi))
      ? Math.max(
          72,
          Math.min(maxRasterizeDpi, Math.floor(Number(params.finalPreflightMeasureDpi))),
        )
      : Math.max(72, Math.min(maxRasterizeDpi, 450));
    this.finalPreflightRetryStrictPixels = Number.isFinite(Number(params.finalPreflightRetryStrictPixels))
      ? Math.max(0, Math.floor(Number(params.finalPreflightRetryStrictPixels)))
      : 64;
    this.finalPreflightRetryAggressivePixels = Number.isFinite(
      Number(params.finalPreflightRetryAggressivePixels),
    )
      ? Math.max(0, Math.floor(Number(params.finalPreflightRetryAggressivePixels)))
      : 256;
    this.spotifyRequestOptions = params.spotifyRequestOptions;
    this.sourceRequestOptions = params.sourceRequestOptions;
    this.qrPlacementByFormat = params.qrPlacementByFormat;
  }

  async generateForOrder(input: GeneratePdfMaterialsInput): Promise<PdfPipelineResult> {
    await fs.mkdir(this.outputRoot, { recursive: true });

    const orderId = String(input.orderId ?? "").trim();
    if (!orderId) {
      throw new Error("orderId is required for PDF pipeline.");
    }

    const postersMissingSource = input.layoutPlan.materials.filter(
      (item) => item.type === "poster" && !String(item.sourceUrl ?? "").trim(),
    );
    if (postersMissingSource.length > 0) {
      const filenames = postersMissingSource.map((item) => item.filename).join(", ");
      throw new Error(
        `Design source missing for poster(s): ${filenames}. Preview cannot be used as print source.`,
      );
    }

    const posterQrDecisions = this.resolvePosterQrDecisions(input.layoutPlan);
    const qrUrlResolution = await this.resolveQrUrlForEmbedding(
      input.layoutPlan,
      posterQrDecisions,
      orderId,
    );
    const materialGeneratorLayoutPlan = toMaterialGeneratorLayoutPlan(input.layoutPlan, {
      effectiveQrUrl: qrUrlResolution.url,
      shortQrUrl: qrUrlResolution.shortUrl,
    });
    // QR embedding is executed in this TS layer per poster SKU/profile decision.
    materialGeneratorLayoutPlan.qr.shouldGenerate = false;

    const pipelineStartedAt = Date.now();
    const sourceCacheStartedAt = Date.now();
    const posterSourceCache = await this.preparePosterSourceCache(input.layoutPlan.materials, orderId);
    const sourceCacheBuildMs = Date.now() - sourceCacheStartedAt;

    try {
      const routeDecisionStartedAt = Date.now();
      const routeDecision = await this.resolvePipelineRoute({
        orderId,
        materials: input.layoutPlan.materials,
        sourcePathByUrl: posterSourceCache?.sourcePathByUrl,
      });
      const routeDecisionMs = Date.now() - routeDecisionStartedAt;
      const useQualitySafeProfile = routeDecision.profile === "quality_safe";
      const effectiveRasterizeDpi = this.resolveProfileRasterizeDpi(routeDecision.profile);
      const effectiveCmykLossless = this.cmykLossless || useQualitySafeProfile;

      this.logger.info("pdf_pipeline_started", {
        orderId,
        materials: materialGeneratorLayoutPlan.materials.length,
        colorSpace: this.colorSpace,
        rasterizeDpi: effectiveRasterizeDpi,
        qrPlan: this.buildQrPlanCounters(posterQrDecisions),
        routeProfile: routeDecision.profile,
        routeReason: routeDecision.reason,
        routeRiskScore: routeDecision.riskScore,
        routeRiskReasons: routeDecision.riskReasons,
        sourceCacheHits: posterSourceCache?.sourcePathByUrl.size ?? 0,
      });

      const qualitySafeOptions = useQualitySafeProfile
        ? {
            whiteThreshold: 254,
            whiteMaxSaturation: 0.25,
            whiteReplaceMode: "threshold" as const,
            whiteMinAlpha: 0,
            whiteCleanupPasses: 0,
            whiteCleanupMinChannel: 254,
            whiteCleanupMaxSaturation: 0.25,
            whiteHardCleanupPasses: 2,
            whiteHardCleanupMinChannel: 246,
            whiteHardCleanupMinLightness: 98.5,
            whiteHardCleanupDeltaEMax: 14,
            whiteHardCleanupMaxSaturation: 0.6,
            whiteSanitizeTransparentRgb: true,
            whiteAllowSoftMaskFallback: true,
            whiteReplaceIterations: 1,
            whiteFinalEnforce: false,
            whiteFinalIterations: 1,
          }
        : {};

      const generationStartedAt = Date.now();
      const result: PdfPipelineResult = await generateMaterialFiles({
        layoutPlan: materialGeneratorLayoutPlan,
        outputRoot: this.outputRoot,
        orderId,
        fontPath: this.fontPath,
        emojiFontPath: this.emojiFontPath,
        emojiRenderMode: this.emojiRenderMode,
        appleEmojiBaseUrl: this.appleEmojiBaseUrl,
        appleEmojiAssetsDir: this.appleEmojiAssetsDir,
        stickerSizeMm: this.stickerSizeMm,
        colorSpace: this.colorSpace,
        qrPlacementByFormat: this.qrPlacementByFormat,
        replaceWhiteWithOffWhite: true,
        offWhiteHex: this.offWhiteHex,
        rasterizeDpi: effectiveRasterizeDpi,
        whiteFinalDpi: effectiveRasterizeDpi,
        cmykLossless: effectiveCmykLossless,
        deferPosterCmykConversion: this.colorSpace === "CMYK",
        sourceRequestOptions: this.sourceRequestOptions,
        posterSourcePathByUrl: this.toPosterSourcePathRecord(posterSourceCache?.sourcePathByUrl),
        ...qualitySafeOptions,
      });
      const generationMs = Date.now() - generationStartedAt;

      this.attachPipelineRouteDetails({
        generatedFiles: result.generated,
        routeDecision,
        effectiveRasterizeDpi,
      });
      result.pipeline_profile = routeDecision.profile;
      result.pipeline_profile_reason = routeDecision.reason;
      result.pipeline_profile_risk_score = routeDecision.riskScore;
      result.pipeline_profile_risk_details = {
        risk_reasons: routeDecision.riskReasons,
        samples: routeDecision.posterRiskSamples.map((sample) => ({
          filename: sample.filename,
          source_url: sample.sourceUrl,
          strict_white_pixels: sample.strictWhitePixels,
          aggressive_white_pixels: sample.aggressiveWhitePixels,
          strict_low_alpha_white_pixels: sample.strictLowAlphaWhitePixels,
          aggressive_low_alpha_white_pixels: sample.aggressiveLowAlphaWhitePixels,
          score: sample.score,
          reasons: sample.reasons,
        })),
        aggressive_white_threshold: this.autoRouterAggressiveWhitePixels,
        route_risk_threshold: this.autoRouterRiskThreshold,
        preflight_dpi: this.autoRouterPreflightDpi,
      };

      if (qrUrlResolution.warnings.length > 0) {
        result.warnings.push(...qrUrlResolution.warnings);
      }

      const qrDecisionWarnings = buildQrDecisionWarnings(
        Array.from(posterQrDecisions.entries()).map(([filename, entry]) => ({
          filename,
          sku: entry.sku,
          decision: entry.decision,
        })),
      );
      if (qrDecisionWarnings.length > 0) {
        result.warnings.push(...qrDecisionWarnings);
      }

      const qrEmbedStartedAt = Date.now();
      await this.applyPosterQrEmbeds({
        qrUrl: qrUrlResolution.url,
        result,
        decisions: posterQrDecisions,
      });
      const qrEmbedMs = Date.now() - qrEmbedStartedAt;

      const finalPreflightStartedAt = Date.now();
      const finalPreflight = await this.runFinalPdfPreflight(result.generated, effectiveRasterizeDpi);
      const finalPreflightMs = Date.now() - finalPreflightStartedAt;
      const totalMs = Date.now() - pipelineStartedAt;

      this.logger.info("pdf_pipeline_finished", {
        orderId,
        generated: result.generated.length,
        failed: result.failed.length,
        warnings: result.warnings.length,
        outputDir: result.output_dir,
        shortenerProvider: qrUrlResolution.provider,
        finalPreflightFiles: finalPreflight.filesProcessed,
        finalPreflightCorrectedPixels: finalPreflight.correctedPixels,
        rasterizeDpi: effectiveRasterizeDpi,
        finalPreflightMeasureDpi: this.finalPreflightMeasureDpi,
        finalPreflightRetryStrictPixels: this.finalPreflightRetryStrictPixels,
        finalPreflightRetryAggressivePixels: this.finalPreflightRetryAggressivePixels,
        timingTotalMs: totalMs,
        timingSourceCacheBuildMs: sourceCacheBuildMs,
        timingRouteDecisionMs: routeDecisionMs,
        timingGenerationMs: generationMs,
        timingQrEmbedMs: qrEmbedMs,
        timingFinalPreflightMs: finalPreflightMs,
        routeProfile: routeDecision.profile,
        routeReason: routeDecision.reason,
        routeRiskScore: routeDecision.riskScore,
      });

      return result;
    } finally {
      await this.cleanupPosterSourceCache(posterSourceCache);
    }
  }

  private resolveProfileRasterizeDpi(profile: PipelineProfile): number {
    return profile === "quality_safe" ? this.rasterizeDpiQualitySafe : this.rasterizeDpiStandard;
  }

  private async resolvePipelineRoute(params: {
    orderId: string;
    materials: LayoutMaterial[];
    sourcePathByUrl?: Map<string, string>;
  }): Promise<PipelineRouteDecision> {
    if (this.qualitySafeProfile) {
      return {
        profile: "quality_safe",
        reason: "forced_quality_safe",
        riskScore: this.autoRouterRiskThreshold,
        riskReasons: ["forced_by_pdf_white_quality_safe_profile"],
        posterRiskSamples: [],
      };
    }

    if (!this.autoRouterEnabled) {
      return {
        profile: "standard",
        reason: "auto_disabled",
        riskScore: 0,
        riskReasons: [],
        posterRiskSamples: [],
      };
    }

    const measure = this.getMeasureResidualNearWhiteInPdf();
    if (!measure) {
      return {
        profile: "standard",
        reason: "auto_no_measure",
        riskScore: 0,
        riskReasons: ["measure_residual_near_white_unavailable"],
        posterRiskSamples: [],
      };
    }

    const posters = params.materials.filter(
      (item): item is LayoutMaterial & { sourceUrl: string } =>
        item.type === "poster" && Boolean(String(item.sourceUrl ?? "").trim()),
    );
    if (posters.length === 0) {
      return {
        profile: "standard",
        reason: "auto_no_posters",
        riskScore: 0,
        riskReasons: [],
        posterRiskSamples: [],
      };
    }

    const preflightDir = path.join(
      this.outputRoot,
      `.tmp-route-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await fs.mkdir(preflightDir, { recursive: true });

    const samples: PosterRiskSample[] = [];
    const preflightErrors: string[] = [];
    const sampleBySourceUrl = new Map<string, PosterRiskSample>();
    const preflightErrorBySourceUrl = new Map<string, string>();
    try {
      for (const [index, poster] of posters.entries()) {
        const sourceUrl = String(poster.sourceUrl ?? "").trim();
        const cachedSample = sampleBySourceUrl.get(sourceUrl);
        if (cachedSample) {
          samples.push({
            ...cachedSample,
            filename: poster.filename,
          });
          continue;
        }

        const cachedError = preflightErrorBySourceUrl.get(sourceUrl);
        if (cachedError) {
          preflightErrors.push(`${poster.filename}: ${cachedError}`);
          continue;
        }

        const safePosterFilename = poster.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
        const tempFilePath = path.join(
          preflightDir,
          `${String(index + 1).padStart(2, "0")}-${safePosterFilename}.pdf`,
        );
        const cachedSourcePath = String(params.sourcePathByUrl?.get(sourceUrl) ?? "").trim();
        const useCachedSource = Boolean(cachedSourcePath);
        const sourcePdfPath = useCachedSource ? cachedSourcePath : tempFilePath;

        try {
          if (!useCachedSource) {
            await this.downloadSourcePdfWithRetry({
              sourceUrl,
              outputPath: tempFilePath,
            });
          }
          const measured = await measure({
            filePath: sourcePdfPath,
            rasterizeDpi: this.autoRouterPreflightDpi,
          });
          const sample = this.buildPosterRiskSample({
            filename: poster.filename,
            sourceUrl,
            measured,
          });
          sampleBySourceUrl.set(sourceUrl, sample);
          samples.push(sample);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          preflightErrorBySourceUrl.set(sourceUrl, message);
          preflightErrors.push(`${poster.filename}: ${message}`);
          this.logger.warn("pdf_pipeline_route_preflight_failed", {
            orderId: params.orderId,
            filename: poster.filename,
            sourceUrl,
            message,
            sourceFromCache: useCachedSource,
          });
        } finally {
          if (!useCachedSource) {
            await fs.rm(tempFilePath, { force: true }).catch(() => undefined);
          }
        }
      }
    } finally {
      await fs.rm(preflightDir, { recursive: true, force: true }).catch(() => undefined);
    }

    if (samples.length === 0) {
      return {
        profile: "standard",
        reason: "auto_preflight_failed",
        riskScore: 0,
        riskReasons: preflightErrors,
        posterRiskSamples: [],
      };
    }

    const riskiestSample = samples.reduce((max, current) =>
      current.score > max.score ? current : max,
    );
    const riskScore = riskiestSample.score;
    const shouldUseQualitySafe = riskScore >= this.autoRouterRiskThreshold;
    const riskReasons = [
      ...riskiestSample.reasons.map((reason) => `${riskiestSample.filename}: ${reason}`),
      ...preflightErrors,
    ];

    return {
      profile: shouldUseQualitySafe ? "quality_safe" : "standard",
      reason: shouldUseQualitySafe ? "auto_risk" : "auto_safe",
      riskScore,
      riskReasons,
      posterRiskSamples: samples,
    };
  }

  private buildPosterRiskSample(params: {
    filename: string;
    sourceUrl: string;
    measured: unknown;
  }): PosterRiskSample {
    const source =
      params.measured && typeof params.measured === "object"
        ? (params.measured as Record<string, unknown>)
        : {};
    const strictWhitePixels = this.readPositiveCount(source, "residual_strict_white_pixels");
    const aggressiveWhitePixels = this.readPositiveCount(
      source,
      "residual_aggressive_white_pixels",
    );
    const strictLowAlphaWhitePixels = this.readPositiveCount(
      source,
      "residual_strict_low_alpha_white_pixels",
    );
    const aggressiveLowAlphaWhitePixels = this.readPositiveCount(
      source,
      "residual_aggressive_low_alpha_white_pixels",
    );

    const reasons: string[] = [];
    let score = 0;
    const aggressiveThreshold = this.autoRouterAggressiveWhitePixels;
    const strictThreshold = Math.max(1, Math.floor(this.autoRouterAggressiveWhitePixels * 0.75));
    const aggressiveLowAlphaThreshold = Math.max(
      1,
      Math.floor(this.autoRouterAggressiveWhitePixels * 0.5),
    );

    if (aggressiveWhitePixels >= aggressiveThreshold) {
      score += 2;
      reasons.push(`aggressive_white_pixels>=${aggressiveThreshold} (${aggressiveWhitePixels})`);
    }
    if (strictWhitePixels >= strictThreshold) {
      score += 1;
      reasons.push(`strict_white_pixels>=${strictThreshold} (${strictWhitePixels})`);
    }
    if (aggressiveLowAlphaWhitePixels >= aggressiveLowAlphaThreshold) {
      score += 1;
      reasons.push(
        `aggressive_low_alpha_white_pixels>=${aggressiveLowAlphaThreshold} (${aggressiveLowAlphaWhitePixels})`,
      );
    }

    return {
      filename: params.filename,
      sourceUrl: params.sourceUrl,
      strictWhitePixels,
      aggressiveWhitePixels,
      strictLowAlphaWhitePixels,
      aggressiveLowAlphaWhitePixels,
      score,
      reasons,
    };
  }

  private attachPipelineRouteDetails(params: {
    generatedFiles: PdfPipelineResult["generated"];
    routeDecision: PipelineRouteDecision;
    effectiveRasterizeDpi: number;
  }): void {
    const sampleByFilename = new Map(
      params.routeDecision.posterRiskSamples.map((sample) => [sample.filename, sample]),
    );

    for (const generatedFile of params.generatedFiles) {
      const details =
        generatedFile.details && typeof generatedFile.details === "object"
          ? (generatedFile.details as Record<string, unknown>)
          : {};
      const materialFilename = generatedFile.filename.replace(/\.pdf$/i, "");
      const sourceRisk = sampleByFilename.get(materialFilename);

      generatedFile.details = {
        ...details,
        pipeline_profile: params.routeDecision.profile,
        pipeline_route_reason: params.routeDecision.reason,
        pipeline_route_risk_score: params.routeDecision.riskScore,
        pipeline_route_rasterize_dpi: params.effectiveRasterizeDpi,
        pipeline_route_source_risk: sourceRisk
          ? {
              strict_white_pixels: sourceRisk.strictWhitePixels,
              aggressive_white_pixels: sourceRisk.aggressiveWhitePixels,
              strict_low_alpha_white_pixels: sourceRisk.strictLowAlphaWhitePixels,
              aggressive_low_alpha_white_pixels: sourceRisk.aggressiveLowAlphaWhitePixels,
              score: sourceRisk.score,
              reasons: sourceRisk.reasons,
            }
          : null,
      };
    }
  }

  private resolvePosterQrDecisions(layoutPlan: LayoutPlan): Map<string, PosterQrDecisionEntry> {
    const decisions = new Map<string, PosterQrDecisionEntry>();
    const posters = layoutPlan.materials.filter((item) => item.type === "poster");

    for (const poster of posters) {
      const decision = this.resolveSinglePosterQrDecision({
        material: poster,
        qrRequested: layoutPlan.qr.requested,
        qrValid: layoutPlan.qr.valid,
        qrUrl: layoutPlan.qr.url,
      });
      decisions.set(poster.filename, {
        sku: poster.sku ?? null,
        format: poster.format,
        decision,
      });
    }

    return decisions;
  }

  private resolveSinglePosterQrDecision(params: {
    material: LayoutMaterial;
    qrRequested: boolean;
    qrValid: boolean;
    qrUrl: string | null;
  }): QrCodeDecision {
    if (!params.qrRequested) {
      return {
        strategy: "none",
        profileId: null,
        qrPlacementByFormat: null,
        spotifyPlacement: null,
        reason: "qr_not_requested",
      };
    }

    if (!params.material.sku) {
      return {
        strategy: "none",
        profileId: null,
        qrPlacementByFormat: null,
        spotifyPlacement: null,
        reason: "missing_sku",
      };
    }

    if (!params.material.format) {
      return {
        strategy: "none",
        profileId: null,
        qrPlacementByFormat: null,
        spotifyPlacement: null,
        reason: "missing_format",
      };
    }

    return resolveQrCodeDecision({
      rules: this.qrRules,
      sku: params.material.sku,
      format: params.material.format,
      qrRequested: params.qrRequested,
      qrValid: params.qrValid,
      qrUrl: params.qrUrl,
    });
  }

  private async applyPosterQrEmbeds(params: {
    qrUrl: string | null;
    result: PdfPipelineResult;
    decisions: Map<string, PosterQrDecisionEntry>;
  }): Promise<void> {
    if (params.decisions.size === 0) {
      return;
    }

    let spotifyUriCache: string | null = null;
    let spotifyUriResolved = false;
    const nextGenerated: PdfPipelineResult["generated"] = [];

    for (const generatedFile of params.result.generated) {
      if (generatedFile.type !== "poster") {
        nextGenerated.push(generatedFile);
        continue;
      }

      const materialFilename = generatedFile.filename.replace(/\.pdf$/i, "");
      const entry = params.decisions.get(materialFilename);
      const decision = entry?.decision;
      if (!entry || !decision || decision.strategy === "none") {
        nextGenerated.push(generatedFile);
        continue;
      }

      const format = entry.format;
      if (!format) {
        params.result.failed.push({
          type: generatedFile.type,
          filename: generatedFile.filename,
          path: generatedFile.path,
          message: "Cannot resolve poster format for QR embedding.",
        });
        continue;
      }

      try {
        if (decision.strategy === "qr") {
          const placement = decision.qrPlacementByFormat?.[format];
          if (!placement) {
            throw new Error(`QR placement is not configured for format ${format}.`);
          }
          if (!params.qrUrl) {
            throw new Error("QR URL is empty.");
          }

          await embedQrIntoPosterPdf({
            posterPdfPath: generatedFile.path,
            qrUrl: params.qrUrl,
            placement,
            qrHex: this.offWhiteHex,
          });

          if (this.colorSpace === "CMYK") {
            await this.convertPdfToCmykInPlace(generatedFile.path);
          }

          generatedFile.details = {
            ...generatedFile.details,
            qr: {
              embedded: true,
              strategy: "qr",
              profileId: decision.profileId,
              placement_mm: placement,
              url: params.qrUrl,
            },
            post_embed_color_space: this.colorSpace,
          };
        } else {
          if (!decision.spotifyPlacement) {
            throw new Error("Spotify placement is not configured for this profile.");
          }
          if (!params.qrUrl) {
            throw new Error("Spotify URL is empty.");
          }

          if (!spotifyUriResolved) {
            spotifyUriCache = await resolveSpotifyUri(params.qrUrl, this.spotifyRequestOptions);
            spotifyUriResolved = true;
          }

          if (!spotifyUriCache) {
            throw new Error("Spotify URI was not resolved.");
          }

          await embedSpotifyCodeIntoPosterPdf({
            posterPdfPath: generatedFile.path,
            spotifyUri: spotifyUriCache,
            placement: decision.spotifyPlacement,
            codeHex: this.offWhiteHex,
            requestOptions: this.spotifyRequestOptions,
          });

          if (this.colorSpace === "CMYK") {
            await this.convertPdfToCmykInPlace(generatedFile.path);
          }

          generatedFile.details = {
            ...generatedFile.details,
            qr: {
              embedded: true,
              strategy: "spotify_code",
              profileId: decision.profileId,
              placement_mm: decision.spotifyPlacement,
              spotify_uri: spotifyUriCache,
            },
            post_embed_color_space: this.colorSpace,
          };
        }

        nextGenerated.push(generatedFile);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        params.result.failed.push({
          type: generatedFile.type,
          filename: generatedFile.filename,
          path: generatedFile.path,
          message: `QR embed failed: ${message}`,
        });
        params.result.warnings.push(
          `QR/Spotify code не вбудовано для ${generatedFile.filename}: ${message}`,
        );
      }
    }

    params.result.generated = nextGenerated;
  }

  private buildQrPlanCounters(decisions: Map<string, PosterQrDecisionEntry>): Record<string, number> {
    const counters = {
      none: 0,
      qr: 0,
      spotify_code: 0,
    };

    for (const entry of decisions.values()) {
      if (entry.decision.strategy === "qr") {
        counters.qr += 1;
      } else if (entry.decision.strategy === "spotify_code") {
        counters.spotify_code += 1;
      } else {
        counters.none += 1;
      }
    }

    return counters;
  }

  private async resolveQrUrlForEmbedding(
    layoutPlan: LayoutPlan,
    decisions: Map<string, PosterQrDecisionEntry>,
    orderId: string,
  ): Promise<QrUrlResolution> {
    if (!layoutPlan.qr.url) {
      return {
        url: layoutPlan.qr.url,
        shortUrl: null,
        provider: null,
        warnings: [],
      };
    }

    const requiresRegularQr = Array.from(decisions.values()).some(
      (entry) => entry.decision.strategy === "qr",
    );
    if (!requiresRegularQr) {
      return {
        url: layoutPlan.qr.url,
        shortUrl: null,
        provider: null,
        warnings: [],
      };
    }

    if (!this.urlShortenerService) {
      return {
        url: layoutPlan.qr.url,
        shortUrl: null,
        provider: null,
        warnings: ["URL shortener не налаштований, використано оригінальне посилання."],
      };
    }

    const shortened = await this.urlShortenerService.shorten(layoutPlan.qr.url);
    if (shortened.provider === "original") {
      this.logger.warn("pdf_pipeline_shortener_unavailable", {
        orderId,
        url: layoutPlan.qr.url,
        warnings: shortened.warnings,
      });
    } else {
      this.logger.info("pdf_pipeline_shortener_applied", {
        orderId,
        provider: shortened.provider,
        shortened: shortened.shortened,
      });
    }

    return {
      url: shortened.url,
      shortUrl: shortened.shortened ? shortened.url : null,
      provider: shortened.provider,
      warnings: shortened.warnings,
    };
  }

  private async preparePosterSourceCache(
    materials: LayoutMaterial[],
    orderId: string,
  ): Promise<PosterSourceCache | null> {
    const posterSourceUrls = materials
      .filter((item): item is LayoutMaterial & { sourceUrl: string } => item.type === "poster")
      .map((item) => String(item.sourceUrl ?? "").trim())
      .filter(Boolean);
    const uniqueSourceUrls = Array.from(new Set(posterSourceUrls));
    if (uniqueSourceUrls.length === 0) {
      return null;
    }
    const hasDuplicateSourceUrls = uniqueSourceUrls.length < posterSourceUrls.length;
    const needsRouterPreflightSource = this.autoRouterEnabled && !this.qualitySafeProfile;
    if (!needsRouterPreflightSource && !hasDuplicateSourceUrls) {
      return null;
    }

    const cacheDir = path.join(
      this.outputRoot,
      `.tmp-sources-${orderId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await fs.mkdir(cacheDir, { recursive: true });

    const sourcePathByUrl = new Map<string, string>();
    for (const [index, sourceUrl] of uniqueSourceUrls.entries()) {
      const cachedPath = path.join(cacheDir, `${String(index + 1).padStart(2, "0")}.pdf`);
      try {
        await this.downloadSourcePdfWithRetry({
          sourceUrl,
          outputPath: cachedPath,
        });
        sourcePathByUrl.set(sourceUrl, cachedPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("pdf_pipeline_source_cache_download_failed", {
          orderId,
          sourceUrl,
          message,
        });
        await fs.rm(cachedPath, { force: true }).catch(() => undefined);
      }
    }

    if (sourcePathByUrl.size === 0) {
      await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
      return null;
    }

    return {
      dir: cacheDir,
      sourcePathByUrl,
    };
  }

  private async cleanupPosterSourceCache(cache: PosterSourceCache | null): Promise<void> {
    if (!cache) {
      return;
    }
    await fs.rm(cache.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  private toPosterSourcePathRecord(
    sourcePathByUrl: Map<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!sourcePathByUrl || sourcePathByUrl.size <= 0) {
      return undefined;
    }

    const output: Record<string, string> = {};
    for (const [sourceUrl, sourcePath] of sourcePathByUrl.entries()) {
      output[sourceUrl] = sourcePath;
    }
    return output;
  }

  private async downloadSourcePdfWithRetry(params: {
    sourceUrl: string;
    outputPath: string;
  }): Promise<void> {
    const maxAttempts = Math.max(1, this.sourceRequestOptions.retries + 1);
    const sourceUrl = String(params.sourceUrl ?? "").trim();
    if (!sourceUrl) {
      throw new Error("Source URL is empty.");
    }

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, this.sourceRequestOptions.timeoutMs);

      try {
        const response = await fetch(sourceUrl, {
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = new Error(`Source download failed (${response.status}).`) as Error & {
            statusCode?: number;
          };
          error.statusCode = response.status;
          throw error;
        }

        const body = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(params.outputPath, body);
        return;
      } catch (error) {
        lastError = error;
        const retryable = this.isRetryableSourceDownloadError(error);
        if (!retryable || attempt >= maxAttempts) {
          break;
        }
        await this.sleep(this.computeSourceRetryDelayMs(attempt));
      } finally {
        clearTimeout(timeoutId);
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Failed to download source PDF after retries: ${message}`);
  }

  private isRetryableSourceDownloadError(error: unknown): boolean {
    const statusCode = Number(
      (error as { statusCode?: unknown })?.statusCode ??
        (error as { status?: unknown })?.status ??
        NaN,
    );
    if (Number.isFinite(statusCode)) {
      return (
        statusCode === 408 ||
        statusCode === 409 ||
        statusCode === 425 ||
        statusCode === 429 ||
        statusCode >= 500
      );
    }

    if ((error as { name?: unknown })?.name === "AbortError") {
      return true;
    }

    const message = String((error as { message?: unknown })?.message ?? "");
    return /fetch failed|network|timeout|socket|econnreset|etimedout|enotfound|eai_again/i.test(
      message,
    );
  }

  private computeSourceRetryDelayMs(attempt: number): number {
    const safeAttempt = Math.max(1, attempt);
    const cappedExponent = Math.min(8, safeAttempt - 1);
    const exponential = this.sourceRequestOptions.retryBaseMs * 2 ** cappedExponent;
    const jitter = Math.floor(Math.random() * Math.min(1_000, this.sourceRequestOptions.retryBaseMs));
    return Math.min(20_000, exponential + jitter);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private async convertPdfToCmykInPlace(filePath: string): Promise<void> {
    const tempFilePath = `${filePath}.qr-cmyk.tmp.pdf`;

    try {
      const losslessArgs = this.cmykLossless
        ? [
            "-dAutoFilterColorImages=false",
            "-dAutoFilterGrayImages=false",
            "-dColorImageFilter=/FlateEncode",
            "-dGrayImageFilter=/FlateEncode",
            "-dDownsampleColorImages=false",
            "-dDownsampleGrayImages=false",
          ]
        : [];
      await this.runCommand("gs", [
        "-q",
        "-dSAFER",
        "-dBATCH",
        "-dNOPAUSE",
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.4",
        "-dProcessColorModel=/DeviceCMYK",
        "-dColorConversionStrategy=/CMYK",
        "-dColorConversionStrategyForImages=/CMYK",
        "-dAutoRotatePages=/None",
        ...losslessArgs,
        `-sOutputFile=${tempFilePath}`,
        filePath,
      ]);

      await fs.rename(tempFilePath, filePath);
    } catch (error) {
      await fs.rm(tempFilePath, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async runCommand(command: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        reject(new Error(`${command} failed to start: ${error.message}`));
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        const details = `${stdout}\n${stderr}`.trim();
        reject(
          new Error(
            `${command} exited with code ${code}${details ? `: ${details.slice(0, 500)}` : ""}`,
          ),
        );
      });
    });
  }

  private async runFinalPdfPreflight(
    generatedFiles: PdfPipelineResult["generated"],
    rasterizeDpi: number,
  ): Promise<{ filesProcessed: number; correctedPixels: number }> {
    const enforce = this.getEnforceOffWhiteInPdf();
    const measureResidual = this.getMeasureResidualNearWhiteInPdf();
    if (!enforce) {
      return {
        filesProcessed: 0,
        correctedPixels: 0,
      };
    }

    const effectiveRasterizeDpi = Math.max(72, Math.floor(Number(rasterizeDpi)));
    const effectiveMeasureDpi = Math.max(
      72,
      Math.min(effectiveRasterizeDpi, this.finalPreflightMeasureDpi),
    );
    let correctedPixels = 0;
    let filesProcessed = 0;

    for (const generatedFile of generatedFiles) {
      if (generatedFile.type !== "poster") {
        continue;
      }
      filesProcessed += 1;
      const details =
        generatedFile.details && typeof generatedFile.details === "object"
          ? (generatedFile.details as Record<string, unknown>)
          : null;
      const finalStageStats =
        details?.white_recolor_final && typeof details.white_recolor_final === "object"
          ? (details.white_recolor_final as Record<string, unknown>)
          : null;

      const initialResidual = this.extractResidualWhiteCounts(finalStageStats);
      const shouldRetry = this.hasResidualWhiteCounts(initialResidual);
      const wasCmykAppliedAfterOverlay =
        details?.post_embed_color_space === "CMYK" || details?.color_space === "CMYK";
      let residualAfterRetry = initialResidual;
      let fileCorrectedPixels = 0;
      let cmykApplied = false;
      let cmykPostcheckApplied = false;
      let cmykRetryTriggered = false;
      let cmykRetryAttempts = 0;
      const cmykRetryPaletteUsed: string[] = [];

      if (shouldRetry) {
        const stats = await enforce({
          filePath: generatedFile.path,
          offWhiteHex: this.offWhiteHex,
          rasterizeDpi: effectiveRasterizeDpi,
        });
        residualAfterRetry = this.extractResidualWhiteCounts(stats);
        fileCorrectedPixels = this.extractCorrectedPixelCount(stats);
        correctedPixels += fileCorrectedPixels;
      }

      if (this.colorSpace === "CMYK" && (shouldRetry || !wasCmykAppliedAfterOverlay)) {
        await this.convertPdfToCmykInPlace(generatedFile.path);
        cmykApplied = true;
      }

      if (this.colorSpace === "CMYK" && measureResidual) {
        cmykPostcheckApplied = true;
        const measuredResidual = await measureResidual({
          filePath: generatedFile.path,
          rasterizeDpi: effectiveMeasureDpi,
        });
        residualAfterRetry = this.extractResidualWhiteCounts(measuredResidual);

        if (this.hasResidualWhiteCounts(residualAfterRetry)) {
          const cmykRetryPalette = this.buildCmykRetryOffWhitePalette();
          for (const retryOffWhiteHex of cmykRetryPalette) {
            cmykRetryTriggered = true;
            cmykRetryAttempts += 1;
            cmykRetryPaletteUsed.push(retryOffWhiteHex);

            const retryStats = await enforce({
              filePath: generatedFile.path,
              offWhiteHex: retryOffWhiteHex,
              rasterizeDpi: effectiveRasterizeDpi,
              profile: "aggressive",
            });

            const retryCorrectedPixels = this.extractCorrectedPixelCount(retryStats);
            fileCorrectedPixels += retryCorrectedPixels;
            correctedPixels += retryCorrectedPixels;
            if (retryCorrectedPixels <= 0) {
              break;
            }

            await this.convertPdfToCmykInPlace(generatedFile.path);
            cmykApplied = true;

            const measuredAfterRetry = await measureResidual({
              filePath: generatedFile.path,
              rasterizeDpi: effectiveMeasureDpi,
            });
            residualAfterRetry = this.extractResidualWhiteCounts(measuredAfterRetry);
            if (!this.hasResidualWhiteCounts(residualAfterRetry)) {
              break;
            }
          }
        }
      }

      const preflightFailedAfterRetry = this.hasResidualWhiteCounts(residualAfterRetry);
      generatedFile.details = {
        ...generatedFile.details,
        final_preflight: {
          applied: shouldRetry || cmykRetryTriggered,
          retry_triggered: shouldRetry,
          cmyk_postcheck_applied: cmykPostcheckApplied,
          cmyk_retry_triggered: cmykRetryTriggered,
          cmyk_retry_attempts: cmykRetryAttempts,
          cmyk_retry_palette: cmykRetryPaletteUsed,
          preflight_failed_after_retry: preflightFailedAfterRetry,
          corrected_pixels: fileCorrectedPixels,
          color_space: this.colorSpace,
          cmyk_applied: cmykApplied,
          rasterize_dpi: effectiveRasterizeDpi,
          off_white_hex: this.offWhiteHex,
          measure_dpi: effectiveMeasureDpi,
          retry_threshold_strict_pixels: this.finalPreflightRetryStrictPixels,
          retry_threshold_aggressive_pixels: this.finalPreflightRetryAggressivePixels,
          residual_strict_white_pixels: residualAfterRetry.strict,
          residual_aggressive_white_pixels: residualAfterRetry.aggressive,
          residual_strict_low_alpha_white_pixels: residualAfterRetry.strictLowAlpha,
          residual_aggressive_low_alpha_white_pixels: residualAfterRetry.aggressiveLowAlpha,
        },
      };
    }

    return {
      filesProcessed,
      correctedPixels,
    };
  }

  private readPositiveCount(source: Record<string, unknown>, key: string): number {
    if (!(key in source)) {
      return 0;
    }

    const value = Number(source[key]);
    if (!Number.isFinite(value) || value <= 0) {
      return 0;
    }

    return Math.max(0, Math.floor(value));
  }

  private extractResidualWhiteCounts(stats: unknown): {
    strict: number;
    aggressive: number;
    strictLowAlpha: number;
    aggressiveLowAlpha: number;
  } {
    if (!stats || typeof stats !== "object") {
      return {
        strict: 0,
        aggressive: 0,
        strictLowAlpha: 0,
        aggressiveLowAlpha: 0,
      };
    }

    const source = stats as Record<string, unknown>;
    return {
      strict: this.readPositiveCount(source, "residual_strict_white_pixels"),
      aggressive: this.readPositiveCount(source, "residual_aggressive_white_pixels"),
      strictLowAlpha: this.readPositiveCount(source, "residual_strict_low_alpha_white_pixels"),
      aggressiveLowAlpha: this.readPositiveCount(
        source,
        "residual_aggressive_low_alpha_white_pixels",
      ),
    };
  }

  private hasResidualWhiteCounts(counts: {
    strict: number;
    aggressive: number;
    strictLowAlpha: number;
    aggressiveLowAlpha: number;
  }): boolean {
    return (
      counts.strict > this.finalPreflightRetryStrictPixels ||
      counts.aggressive > this.finalPreflightRetryAggressivePixels
    );
  }

  private extractCorrectedPixelCount(stats: unknown): number {
    if (!stats || typeof stats !== "object") {
      return 0;
    }

    const source = stats as Record<string, unknown>;
    const candidates = [
      Number(source.replaced_pixels ?? 0),
      Number(source.cleanup_replaced_pixels ?? 0),
      Number(source.forced_opaque_pixels ?? 0),
    ];

    return candidates.reduce((sum, value) => {
      if (!Number.isFinite(value) || value <= 0) {
        return sum;
      }
      return sum + Math.max(0, Math.floor(value));
    }, 0);
  }

  private normalizeHexColor(value: string): string | null {
    const normalized = String(value ?? "")
      .trim()
      .replace(/^#/, "")
      .toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(normalized)) {
      return null;
    }
    return normalized;
  }

  private shiftHexTowardGray(value: string, delta: number): string {
    const safeDelta = Math.max(0, Math.min(64, Math.floor(delta)));
    const red = Math.max(0, Number.parseInt(value.slice(0, 2), 16) - safeDelta);
    const green = Math.max(0, Number.parseInt(value.slice(2, 4), 16) - safeDelta);
    const blue = Math.max(0, Number.parseInt(value.slice(4, 6), 16) - safeDelta);
    return [red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  private buildCmykRetryOffWhitePalette(): string[] {
    const base = this.normalizeHexColor(this.offWhiteHex) ?? "FFFEFA";
    const candidates = [this.shiftHexTowardGray(base, 8), this.shiftHexTowardGray(base, 12)];
    return [...new Set(candidates)];
  }

  private getEnforceOffWhiteInPdf(): typeof enforceOffWhiteInPdf | null {
    return enforceOffWhiteInPdf;
  }

  private getMeasureResidualNearWhiteInPdf(): typeof measureResidualNearWhiteInPdf | null {
    return measureResidualNearWhiteInPdf;
  }
}
