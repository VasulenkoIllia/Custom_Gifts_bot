import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Logger } from "../../observability/logger";
import type { LayoutMaterial, LayoutPlan } from "../layout/layout.types";
import { embedQrIntoPosterPdf } from "../qr/qr-code";
import type { QrCodeDecision, QrRules } from "../qr/qr-rules";
import { resolveQrCodeDecision } from "../qr/qr-rules";
import { embedSpotifyCodeIntoPosterPdf, resolveSpotifyUri } from "../qr/spotify-code";
import type { GeneratePdfMaterialsInput, PdfPipelineResult } from "./pdf.types";

type LegacyLayoutMaterial = {
  type: "poster" | "engraving" | "sticker";
  code: string;
  product_id: number | null;
  source_url: string | null;
  text: string | null;
  format: "A5" | "A4" | null;
  stand_type: "W" | "WW" | "MWW" | "C" | "K" | null;
  index: number;
  total: number;
  filename: string;
};

type LegacyLayoutPlan = {
  order_number: string;
  urgent: boolean;
  flags: string[];
  notes: string[];
  preview_images: string[];
  qr: {
    requested: boolean;
    original_url: string | null;
    short_url: string | null;
    url: string | null;
    valid: boolean;
    should_generate: boolean;
  };
  materials: LegacyLayoutMaterial[];
};

type LegacyGenerateMaterialFiles = (input: {
  layoutPlan: LegacyLayoutPlan;
  outputRoot: string;
  orderId: string;
  fontPath: string;
  emojiFontPath?: string;
  emojiRenderMode?: "font" | "apple_image";
  appleEmojiBaseUrl?: string;
  appleEmojiAssetsDir?: string;
  stickerSizeMm?: number;
  colorSpace?: "RGB" | "CMYK";
  qrPlacementByFormat?: Record<string, { rightMm: number; bottomMm: number; sizeMm: number }>;
  replaceWhiteWithOffWhite?: boolean;
  offWhiteHex?: string;
  rasterizeDpi?: number;
}) => Promise<PdfPipelineResult>;

type LegacyMaterialGeneratorModule = {
  generateMaterialFiles: LegacyGenerateMaterialFiles;
};

type CreatePdfPipelineServiceParams = {
  logger: Logger;
  qrRules: QrRules;
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
  legacyModulePath: string;
  qrPlacementByFormat: {
    A5: { rightMm: number; bottomMm: number; sizeMm: number };
    A4: { rightMm: number; bottomMm: number; sizeMm: number };
  };
};

type PosterQrDecisionEntry = {
  format: "A5" | "A4" | null;
  decision: QrCodeDecision;
};

export function toLegacyLayoutPlan(layoutPlan: LayoutPlan): LegacyLayoutPlan {
  return {
    order_number: layoutPlan.orderNumber,
    urgent: layoutPlan.urgent,
    flags: layoutPlan.flags,
    notes: layoutPlan.notes,
    preview_images: layoutPlan.previewImages,
    qr: {
      requested: layoutPlan.qr.requested,
      original_url: layoutPlan.qr.originalUrl,
      short_url: null,
      url: layoutPlan.qr.url,
      valid: layoutPlan.qr.valid,
      should_generate: layoutPlan.qr.shouldGenerate,
    },
    materials: layoutPlan.materials.map((item) => ({
      type: item.type,
      code: item.code,
      product_id: item.productId,
      source_url: item.sourceUrl,
      text: item.text,
      format: item.format,
      stand_type: item.standType,
      index: item.index,
      total: item.total,
      filename: item.filename,
    })),
  };
}

export class PdfPipelineService {
  private readonly logger: Logger;
  private readonly qrRules: QrRules;
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
  private readonly legacyModulePath: string;
  private readonly qrPlacementByFormat: {
    A5: { rightMm: number; bottomMm: number; sizeMm: number };
    A4: { rightMm: number; bottomMm: number; sizeMm: number };
  };

  private legacyGenerateMaterialFiles: LegacyGenerateMaterialFiles | null = null;

  constructor(params: CreatePdfPipelineServiceParams) {
    this.logger = params.logger;
    this.qrRules = params.qrRules;
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
    this.legacyModulePath = path.resolve(params.legacyModulePath);
    this.qrPlacementByFormat = params.qrPlacementByFormat;
  }

  async generateForOrder(input: GeneratePdfMaterialsInput): Promise<PdfPipelineResult> {
    await fs.mkdir(this.outputRoot, { recursive: true });

    const orderId = String(input.orderId ?? "").trim();
    if (!orderId) {
      throw new Error("orderId is required for PDF pipeline.");
    }

    const posterQrDecisions = this.resolvePosterQrDecisions(input.layoutPlan);
    const layoutPlan = toLegacyLayoutPlan(input.layoutPlan);
    // QR embedding is executed in this TS layer per poster SKU/profile decision.
    layoutPlan.qr.should_generate = false;
    const generateMaterialFiles = this.getLegacyGenerateMaterialFiles();

    this.logger.info("pdf_pipeline_started", {
      orderId,
      materials: layoutPlan.materials.length,
      colorSpace: this.colorSpace,
      qrPlan: this.buildQrPlanCounters(posterQrDecisions),
    });

    const result = await generateMaterialFiles({
      layoutPlan,
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
      rasterizeDpi: this.rasterizeDpi,
    });

    await this.applyPosterQrEmbeds({
      qrUrl: input.layoutPlan.qr.url,
      result,
      decisions: posterQrDecisions,
    });

    this.logger.info("pdf_pipeline_finished", {
      orderId,
      generated: result.generated.length,
      failed: result.failed.length,
      warnings: result.warnings.length,
      outputDir: result.output_dir,
    });

    return result;
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
            spotifyUriCache = await resolveSpotifyUri(params.qrUrl);
            spotifyUriResolved = true;
          }

          if (!spotifyUriCache) {
            throw new Error("Spotify URI was not resolved.");
          }

          await embedSpotifyCodeIntoPosterPdf({
            posterPdfPath: generatedFile.path,
            spotifyUri: spotifyUriCache,
            placement: decision.spotifyPlacement,
            backgroundHex: this.offWhiteHex,
            codeHex: "000000",
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

  private async convertPdfToCmykInPlace(filePath: string): Promise<void> {
    const tempFilePath = `${filePath}.qr-cmyk.tmp.pdf`;

    try {
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

  private getLegacyGenerateMaterialFiles(): LegacyGenerateMaterialFiles {
    if (this.legacyGenerateMaterialFiles) {
      return this.legacyGenerateMaterialFiles;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const legacyModule = require(this.legacyModulePath) as LegacyMaterialGeneratorModule;
    if (!legacyModule || typeof legacyModule.generateMaterialFiles !== "function") {
      throw new Error(
        `Legacy material generator is invalid: ${this.legacyModulePath}`,
      );
    }

    this.legacyGenerateMaterialFiles = legacyModule.generateMaterialFiles;
    return this.legacyGenerateMaterialFiles;
  }
}
