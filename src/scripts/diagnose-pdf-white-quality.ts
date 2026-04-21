import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { PNG } from "pngjs";
import { loadProductCodeRules } from "../modules/layout/product-code-rules";
import { LayoutPlanBuilder } from "../modules/layout/layout-plan-builder";
import { loadQrRules } from "../modules/qr/qr-rules";
import { PdfPipelineService } from "../modules/pdf/pdf-pipeline.service";
import { createSilentLogger, normalizeOrderIds } from "./script-utils";
import { createCrmClientFromConfig, loadValidatedConfigFromEnv } from "./script-runtime-utils";
import type { LayoutMaterial, LayoutPlan } from "../modules/layout/layout.types";

type ParsedArgs = {
  orderIds: string[];
  label: string;
  outputJsonPath: string | null;
  rasterizeDpi: number;
};

type PixelMetrics = {
  width: number;
  height: number;
  pixels: number;
  alpha: {
    transparent: number;
    low: number;
    semi: number;
    opaque: number;
  };
  white: {
    strict: number;
    aggressive: number;
  };
  meanGradient: number;
};

type PosterDiagnostic = {
  filename: string;
  outputPath: string;
  sourceUrl: string | null;
  sourceMetrics: PixelMetrics | null;
  outputMetrics: PixelMetrics | null;
  edgePreservationRatio: number | null;
  rmseRgb: number | null;
  whiteRecolorSummary: Record<string, unknown> | null;
  whiteRecolorFinalSummary: Record<string, unknown> | null;
  finalPreflightSummary: Record<string, unknown> | null;
};

type OrderDiagnostic = {
  orderId: string;
  runOrderId: string;
  outputDir: string;
  warnings: string[];
  failedCount: number;
  posters: PosterDiagnostic[];
};

type DiagnosticsReport = {
  label: string;
  rasterizeDpi: number;
  generatedAt: string;
  orderIds: string[];
  orders: OrderDiagnostic[];
};

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv: string[]): ParsedArgs {
  const orderIdArgs: string[] = [];
  let label = "baseline";
  let outputJsonPath: string | null = null;
  let rasterizeDpi = parsePositiveInteger(process.env.RASTERIZE_DPI, 600);

  for (const arg of argv) {
    if (arg.startsWith("--order-ids=")) {
      orderIdArgs.push(arg.slice("--order-ids=".length));
      continue;
    }
    if (arg.startsWith("--label=")) {
      label = arg.slice("--label=".length).trim() || label;
      continue;
    }
    if (arg.startsWith("--output-json=")) {
      const value = arg.slice("--output-json=".length).trim();
      outputJsonPath = value ? path.resolve(process.cwd(), value) : null;
      continue;
    }
    if (arg.startsWith("--rasterize-dpi=")) {
      rasterizeDpi = parsePositiveInteger(arg.slice("--rasterize-dpi=".length), rasterizeDpi);
      continue;
    }

    orderIdArgs.push(arg);
  }

  return {
    orderIds: normalizeOrderIds(orderIdArgs),
    label,
    outputJsonPath,
    rasterizeDpi: Math.max(72, rasterizeDpi),
  };
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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
      reject(new Error(`${command} exited with code ${code}${details ? `: ${details}` : ""}`));
    });
  });
}

async function downloadToFile(url: string, filePath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Source download failed (${response.status}) for ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  await fs.writeFile(filePath, Buffer.from(arrayBuffer));
}

async function rasterizeFirstPageToPng(params: {
  pdfPath: string;
  outputPngPath: string;
  dpi: number;
}): Promise<void> {
  await runCommand("gs", [
    "-q",
    "-dSAFER",
    "-dBATCH",
    "-dNOPAUSE",
    "-sDEVICE=pngalpha",
    "-dTextAlphaBits=4",
    "-dGraphicsAlphaBits=4",
    "-dFirstPage=1",
    "-dLastPage=1",
    `-r${Math.max(72, params.dpi)}`,
    `-sOutputFile=${params.outputPngPath}`,
    params.pdfPath,
  ]);
}

function saturation(red: number, green: number, blue: number): number {
  const maxChannel = Math.max(red, green, blue);
  const minChannel = Math.min(red, green, blue);
  if (maxChannel === 0) return 0;
  return (maxChannel - minChannel) / maxChannel;
}

function computePixelMetrics(png: PNG): PixelMetrics {
  const pixels = png.width * png.height;
  let alphaTransparent = 0;
  let alphaLow = 0;
  let alphaSemi = 0;
  let alphaOpaque = 0;
  let whiteStrict = 0;
  let whiteAggressive = 0;
  let gradientSum = 0;
  let gradientSamples = 0;

  for (let pixelIndex = 0; pixelIndex < pixels; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    const red = png.data[offset]!;
    const green = png.data[offset + 1]!;
    const blue = png.data[offset + 2]!;
    const alpha = png.data[offset + 3]!;

    if (alpha === 0) {
      alphaTransparent += 1;
      continue;
    }

    if (alpha <= 40) {
      alphaLow += 1;
    } else if (alpha < 255) {
      alphaSemi += 1;
    } else {
      alphaOpaque += 1;
    }

    const minChannel = Math.min(red, green, blue);
    const sat = saturation(red, green, blue);
    if (minChannel >= 254 && sat <= 0.25) {
      whiteStrict += 1;
    }
    if (minChannel >= 252 && sat <= 0.03) {
      whiteAggressive += 1;
    }
  }

  for (let y = 0; y < png.height - 1; y += 1) {
    for (let x = 0; x < png.width - 1; x += 1) {
      const offset = (y * png.width + x) * 4;
      const alpha = png.data[offset + 3]!;
      if (alpha === 0) continue;

      const rightOffset = offset + 4;
      const downOffset = offset + png.width * 4;

      const luminance =
        0.2126 * png.data[offset]! + 0.7152 * png.data[offset + 1]! + 0.0722 * png.data[offset + 2]!;
      const luminanceRight =
        0.2126 * png.data[rightOffset]! +
        0.7152 * png.data[rightOffset + 1]! +
        0.0722 * png.data[rightOffset + 2]!;
      const luminanceDown =
        0.2126 * png.data[downOffset]! +
        0.7152 * png.data[downOffset + 1]! +
        0.0722 * png.data[downOffset + 2]!;

      gradientSum += Math.abs(luminance - luminanceRight);
      gradientSum += Math.abs(luminance - luminanceDown);
      gradientSamples += 2;
    }
  }

  return {
    width: png.width,
    height: png.height,
    pixels,
    alpha: {
      transparent: alphaTransparent,
      low: alphaLow,
      semi: alphaSemi,
      opaque: alphaOpaque,
    },
    white: {
      strict: whiteStrict,
      aggressive: whiteAggressive,
    },
    meanGradient: gradientSamples > 0 ? gradientSum / gradientSamples : 0,
  };
}

function computeRgbRmse(left: PNG, right: PNG): number | null {
  if (left.width !== right.width || left.height !== right.height) {
    return null;
  }

  const pixels = left.width * left.height;
  let sumSquares = 0;
  let samples = 0;

  for (let pixelIndex = 0; pixelIndex < pixels; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    const leftAlpha = left.data[offset + 3]!;
    const rightAlpha = right.data[offset + 3]!;
    if (leftAlpha === 0 && rightAlpha === 0) continue;

    for (let channel = 0; channel < 3; channel += 1) {
      const diff = left.data[offset + channel]! - right.data[offset + channel]!;
      sumSquares += diff * diff;
      samples += 1;
    }
  }

  if (samples <= 0) return null;
  return Math.sqrt(sumSquares / samples);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function pickSummaryFields(stats: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!stats) return null;
  const keys = [
    "applied",
    "threshold",
    "max_saturation",
    "dpi",
    "mode",
    "replaced_pixels",
    "cleanup_replaced_pixels",
    "hard_cleanup_replaced_pixels",
    "forced_opaque_pixels",
    "strip_soft_mask_requested",
    "strip_soft_mask_applied",
    "strip_soft_mask_fallback_pages",
    "iterations_requested",
    "iterations_used",
    "corrected_pixels",
  ];
  const summary: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in stats) {
      summary[key] = stats[key];
    }
  }
  return summary;
}

function findPosterSourceUrl(layoutPlan: LayoutPlan, generatedFilename: string): string | null {
  const baseName = generatedFilename.replace(/\.pdf$/i, "");
  const material = layoutPlan.materials.find(
    (item): item is LayoutMaterial & { type: "poster" } => item.type === "poster" && item.filename === baseName,
  );
  return material?.sourceUrl ? String(material.sourceUrl) : null;
}

async function diagnosePoster(params: {
  sourceUrl: string;
  outputPdfPath: string;
  rasterizeDpi: number;
  tempDir: string;
  fileKey: string;
  details: Record<string, unknown> | null;
}): Promise<PosterDiagnostic> {
  const sourcePdfPath = path.join(params.tempDir, `${params.fileKey}-source.pdf`);
  const sourcePngPath = path.join(params.tempDir, `${params.fileKey}-source.png`);
  const outputPngPath = path.join(params.tempDir, `${params.fileKey}-output.png`);

  await downloadToFile(params.sourceUrl, sourcePdfPath);
  await rasterizeFirstPageToPng({
    pdfPath: sourcePdfPath,
    outputPngPath: sourcePngPath,
    dpi: params.rasterizeDpi,
  });
  await rasterizeFirstPageToPng({
    pdfPath: params.outputPdfPath,
    outputPngPath: outputPngPath,
    dpi: params.rasterizeDpi,
  });

  const sourcePng = PNG.sync.read(await fs.readFile(sourcePngPath));
  const outputPng = PNG.sync.read(await fs.readFile(outputPngPath));
  const sourceMetrics = computePixelMetrics(sourcePng);
  const outputMetrics = computePixelMetrics(outputPng);
  const rmseRgb = computeRgbRmse(sourcePng, outputPng);
  const edgePreservationRatio =
    sourceMetrics.meanGradient > 0 ? outputMetrics.meanGradient / sourceMetrics.meanGradient : null;

  const whiteRecolor = pickSummaryFields(toRecord(params.details?.white_recolor));
  const whiteRecolorFinal = pickSummaryFields(toRecord(params.details?.white_recolor_final));
  const finalPreflight = pickSummaryFields(toRecord(params.details?.final_preflight));

  return {
    filename: path.basename(params.outputPdfPath),
    outputPath: params.outputPdfPath,
    sourceUrl: params.sourceUrl,
    sourceMetrics,
    outputMetrics,
    edgePreservationRatio,
    rmseRgb,
    whiteRecolorSummary: whiteRecolor,
    whiteRecolorFinalSummary: whiteRecolorFinal,
    finalPreflightSummary: finalPreflight,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.orderIds.length <= 0) {
    throw new Error("Provide order IDs via --order-ids=29645,29644,...");
  }

  const config = loadValidatedConfigFromEnv();
  const logger = createSilentLogger();
  const crmClient = createCrmClientFromConfig(config);
  const productCodeRules = await loadProductCodeRules(config.productCodeRulesPath);
  const qrRules = await loadQrRules(config.qrRulesPath);
  const layoutPlanBuilder = new LayoutPlanBuilder(productCodeRules);

  const pipelineService = new PdfPipelineService({
    logger,
    qrRules,
    urlShortenerService: null,
    outputRoot: config.outputDir,
    fontPath: config.fontPath,
    emojiFontPath: config.emojiFontPath,
    emojiRenderMode: config.emojiRenderMode,
    appleEmojiBaseUrl: config.appleEmojiBaseUrl,
    appleEmojiAssetsDir: config.appleEmojiAssetsDir,
    colorSpace: config.pdfColorSpace,
    stickerSizeMm: config.pdfStickerSizeMm,
    offWhiteHex: config.pdfOffWhiteHex,
    rasterizeDpi: config.pdfRasterizeDpi,
    qualitySafeProfile: Boolean(config.pdfWhiteQualitySafeProfile),
    cmykLossless: Boolean(config.pdfCmykLossless),
    spotifyRequestOptions: {
      timeoutMs: config.spotifyRequestTimeoutMs,
      retries: config.spotifyRequestRetries,
      retryBaseMs: config.spotifyRequestRetryBaseMs,
    },
    sourceRequestOptions: {
      timeoutMs: config.pdfSourceRequestTimeoutMs,
      retries: config.pdfSourceRequestRetries,
      retryBaseMs: config.pdfSourceRequestRetryBaseMs,
    },
    qrPlacementByFormat: {
      A5: {
        rightMm: config.qrA5RightMm,
        bottomMm: config.qrA5BottomMm,
        sizeMm: config.qrA5SizeMm,
      },
      A4: {
        rightMm: config.qrA4RightMm,
        bottomMm: config.qrA4BottomMm,
        sizeMm: config.qrA4SizeMm,
      },
    },
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `pdf-white-diagnose-${args.label}-`));
  const orders: OrderDiagnostic[] = [];

  try {
    for (const orderId of args.orderIds) {
      const order = await crmClient.getOrder(orderId);
      const layoutPlan = layoutPlanBuilder.build(order);
      const runOrderId = `${orderId}_${args.label}_${randomUUID().slice(0, 8)}`;
      const pipelineResult = await pipelineService.generateForOrder({
        orderId: runOrderId,
        layoutPlan,
      });

      const posters: PosterDiagnostic[] = [];

      for (const generated of pipelineResult.generated) {
        if (generated.type !== "poster") continue;

        const sourceUrl = findPosterSourceUrl(layoutPlan, generated.filename);
        if (!sourceUrl) {
          posters.push({
            filename: generated.filename,
            outputPath: generated.path,
            sourceUrl: null,
            sourceMetrics: null,
            outputMetrics: null,
            edgePreservationRatio: null,
            rmseRgb: null,
            whiteRecolorSummary: pickSummaryFields(toRecord(generated.details?.white_recolor)),
            whiteRecolorFinalSummary: pickSummaryFields(
              toRecord(generated.details?.white_recolor_final),
            ),
            finalPreflightSummary: pickSummaryFields(toRecord(generated.details?.final_preflight)),
          });
          continue;
        }

        const key = `${orderId}-${generated.filename.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${randomUUID().slice(0, 6)}`;
        const diagnosed = await diagnosePoster({
          sourceUrl,
          outputPdfPath: generated.path,
          rasterizeDpi: args.rasterizeDpi,
          tempDir,
          fileKey: key,
          details: toRecord(generated.details),
        });
        posters.push(diagnosed);
      }

      orders.push({
        orderId,
        runOrderId,
        outputDir: pipelineResult.output_dir,
        warnings: pipelineResult.warnings,
        failedCount: pipelineResult.failed.length,
        posters,
      });
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  const report: DiagnosticsReport = {
    label: args.label,
    rasterizeDpi: args.rasterizeDpi,
    generatedAt: new Date().toISOString(),
    orderIds: args.orderIds,
    orders,
  };

  const json = JSON.stringify(report, null, 2);
  process.stdout.write(`${json}\n`);

  if (args.outputJsonPath) {
    await fs.mkdir(path.dirname(args.outputJsonPath), { recursive: true });
    await fs.writeFile(args.outputJsonPath, `${json}\n`, "utf8");
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
