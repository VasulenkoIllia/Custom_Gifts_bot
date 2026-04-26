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
  createRasterizeSemaphore,
  type RasterizeSemaphore,
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
  highDetailDpi: number;
  highDetailSkus: string[];
  rasterizeConcurrency: number;
  cmykLossless?: boolean;
  finalPreflightMeasureDpi?: number;
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
  private static readonly PREFLIGHT_RETRY_STRICT_PIXELS = 64;
  private static readonly PREFLIGHT_RETRY_AGGRESSIVE_PIXELS = 256;

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
  private readonly highDetailDpi: number;
  private readonly highDetailSkus: Set<string>;
  private readonly cmykLossless: boolean;
  private readonly finalPreflightMeasureDpi: number;
  private readonly rasterizeSemaphore: RasterizeSemaphore;
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
    this.rasterizeDpi = Math.max(72, Math.floor(Number(params.rasterizeDpi)));
    this.highDetailDpi = Math.max(72, Math.floor(Number(params.highDetailDpi)));
    this.highDetailSkus = new Set(params.highDetailSkus.map((s) => s.trim()).filter(Boolean));
    this.cmykLossless = Boolean(params.cmykLossless);
    this.finalPreflightMeasureDpi = Number.isFinite(Number(params.finalPreflightMeasureDpi))
      ? Math.max(72, Math.floor(Number(params.finalPreflightMeasureDpi)))
      : 200;
    this.rasterizeSemaphore = createRasterizeSemaphore(
      Math.max(1, Math.floor(Number(params.rasterizeConcurrency))),
    );
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
      const effectiveRasterizeDpi = this.resolveRasterizeDpi(input.layoutPlan.materials);

      this.logger.info("pdf_pipeline_started", {
        orderId,
        materials: materialGeneratorLayoutPlan.materials.length,
        colorSpace: this.colorSpace,
        rasterizeDpi: effectiveRasterizeDpi,
        highDetail: effectiveRasterizeDpi === this.highDetailDpi,
        qrPlan: this.buildQrPlanCounters(posterQrDecisions),
        sourceCacheHits: posterSourceCache?.sourcePathByUrl.size ?? 0,
      });

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
        cmykLossless: this.cmykLossless,
        deferPosterCmykConversion: this.colorSpace === "CMYK",
        sourceRequestOptions: this.sourceRequestOptions,
        posterSourcePathByUrl: this.toPosterSourcePathRecord(posterSourceCache?.sourcePathByUrl),
        rasterizeSemaphore: this.rasterizeSemaphore,
      });
      const generationMs = Date.now() - generationStartedAt;

      result.rasterize_dpi = effectiveRasterizeDpi;

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
        highDetail: effectiveRasterizeDpi === this.highDetailDpi,
        finalPreflightMeasureDpi: this.finalPreflightMeasureDpi,
        timingTotalMs: totalMs,
        timingSourceCacheBuildMs: sourceCacheBuildMs,
        timingGenerationMs: generationMs,
        timingQrEmbedMs: qrEmbedMs,
        timingFinalPreflightMs: finalPreflightMs,
      });

      return result;
    } finally {
      await this.cleanupPosterSourceCache(posterSourceCache);
    }
  }

  private resolveRasterizeDpi(materials: LayoutMaterial[]): number {
    const hasHighDetail = materials.some(
      (m) => m.type === "poster" && m.sku && this.highDetailSkus.has(m.sku),
    );
    return hasHighDetail ? this.highDetailDpi : this.rasterizeDpi;
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
    if (!hasDuplicateSourceUrls) {
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
    await this.withRasterizeSlot(async () => {
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
    });
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
      const wasCmykAppliedAfterOverlay =
        details?.post_embed_color_space === "CMYK" || details?.color_space === "CMYK";
      let residualAfterRetry = {
        strict: 0,
        aggressive: 0,
        strictLowAlpha: 0,
        aggressiveLowAlpha: 0,
      };
      let fileCorrectedPixels = 0;
      let cmykApplied = false;
      let cmykPostcheckApplied = false;
      let cmykRetryTriggered = false;
      let cmykRetryAttempts = 0;
      const cmykRetryPaletteUsed: string[] = [];

      if (this.colorSpace === "CMYK" && !wasCmykAppliedAfterOverlay) {
        await this.convertPdfToCmykInPlace(generatedFile.path);
        cmykApplied = true;
      }

      if (this.colorSpace === "CMYK" && measureResidual) {
        cmykPostcheckApplied = true;
        const measuredResidual = await this.withRasterizeSlot(() =>
          measureResidual({
            filePath: generatedFile.path,
            rasterizeDpi: effectiveMeasureDpi,
          }),
        );
        residualAfterRetry = this.extractResidualWhiteCounts(measuredResidual);

        if (this.hasResidualWhiteCounts(residualAfterRetry)) {
          const cmykRetryPalette = this.buildCmykRetryOffWhitePalette();
          for (const retryOffWhiteHex of cmykRetryPalette) {
            cmykRetryTriggered = true;
            cmykRetryAttempts += 1;
            cmykRetryPaletteUsed.push(retryOffWhiteHex);

            const retryStats = await this.withRasterizeSlot(() =>
              enforce({
                filePath: generatedFile.path,
                offWhiteHex: retryOffWhiteHex,
                rasterizeDpi: effectiveRasterizeDpi,
                profile: "aggressive",
              }),
            );

            const retryCorrectedPixels = this.extractCorrectedPixelCount(retryStats);
            fileCorrectedPixels += retryCorrectedPixels;
            correctedPixels += retryCorrectedPixels;
            if (retryCorrectedPixels <= 0) {
              break;
            }

            await this.convertPdfToCmykInPlace(generatedFile.path);
            cmykApplied = true;

            const measuredAfterRetry = await this.withRasterizeSlot(() =>
              measureResidual({
                filePath: generatedFile.path,
                rasterizeDpi: effectiveMeasureDpi,
              }),
            );
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
          applied: cmykRetryTriggered,
          retry_triggered: cmykRetryTriggered,
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
          retry_threshold_strict_pixels: PdfPipelineService.PREFLIGHT_RETRY_STRICT_PIXELS,
          retry_threshold_aggressive_pixels: PdfPipelineService.PREFLIGHT_RETRY_AGGRESSIVE_PIXELS,
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
      counts.strict > PdfPipelineService.PREFLIGHT_RETRY_STRICT_PIXELS ||
      counts.aggressive > PdfPipelineService.PREFLIGHT_RETRY_AGGRESSIVE_PIXELS
    );
  }

  private async withRasterizeSlot<T>(operation: () => Promise<T>): Promise<T> {
    await this.rasterizeSemaphore.acquire();
    try {
      return await operation();
    } finally {
      this.rasterizeSemaphore.release();
    }
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
    const base = this.normalizeHexColor(this.offWhiteHex) ?? "F7F6F2";
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
