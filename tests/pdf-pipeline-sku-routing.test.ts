import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PdfPipelineService } from "../src/modules/pdf/pdf-pipeline.service";

const HIGH_DETAIL_SKUS = [
  "StarTranspA5Wood",
  "StarTranspA5WoodWW",
  "StarFPA4Wood",
  "MapSquareTA5WoodRGB",
  "MapTrHeartA4WoodMultiWW",
];

function createService(highDetailSkus: string[] = HIGH_DETAIL_SKUS) {
  return new PdfPipelineService({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never,
    qrRules: {} as never,
    urlShortenerService: null,
    outputRoot: path.join(os.tmpdir(), "pdf-pipeline-sku-routing-test"),
    fontPath: "/tmp/font.ttf",
    emojiFontPath: "",
    emojiRenderMode: "apple_image",
    appleEmojiBaseUrl: "",
    appleEmojiAssetsDir: "",
    colorSpace: "CMYK",
    stickerSizeMm: 100,
    offWhiteHex: "FFFEFA",
    rasterizeDpi: 800,
    highDetailDpi: 1200,
    highDetailSkus,
    rasterizeConcurrency: 3,
    spotifyRequestOptions: {
      timeoutMs: 10_000,
      retries: 1,
      retryBaseMs: 200,
    },
    sourceRequestOptions: {
      timeoutMs: 1_000,
      retries: 0,
      retryBaseMs: 100,
    },
    qrPlacementByFormat: {
      A5: { rightMm: 10, bottomMm: 10, sizeMm: 20 },
      A4: { rightMm: 10, bottomMm: 10, sizeMm: 30 },
    },
  });
}

function makePoster(sku: string | null = null) {
  return {
    type: "poster" as const,
    code: "AA5",
    index: 1,
    total: 1,
    filename: "CGU_AA5_100_1_1",
    productId: 10,
    sku,
    sourceUrl: "https://example.com/source.pdf",
    text: null,
    format: "A5" as const,
    standType: null,
  };
}

function resolveRasterizeDpi(service: PdfPipelineService, materials: ReturnType<typeof makePoster>[]) {
  return (
    service as never as {
      resolveRasterizeDpi: (materials: unknown[]) => number;
    }
  ).resolveRasterizeDpi(materials);
}

test("resolveRasterizeDpi returns high-detail DPI when poster SKU is in the list", () => {
  const service = createService();
  const dpi = resolveRasterizeDpi(service, [makePoster("StarTranspA5Wood")]);
  assert.equal(dpi, 1200);
});

test("resolveRasterizeDpi returns high-detail DPI for any high-detail SKU in a multi-material order", () => {
  const service = createService();
  const dpi = resolveRasterizeDpi(service, [
    makePoster("PosterGiftA5WW"),
    makePoster("StarFPA4Wood"),
  ]);
  assert.equal(dpi, 1200);
});

test("resolveRasterizeDpi returns standard DPI when no poster SKU matches", () => {
  const service = createService();
  const dpi = resolveRasterizeDpi(service, [makePoster("PosterGiftA5WW")]);
  assert.equal(dpi, 800);
});

test("resolveRasterizeDpi returns standard DPI when poster has no SKU", () => {
  const service = createService();
  const dpi = resolveRasterizeDpi(service, [makePoster(null)]);
  assert.equal(dpi, 800);
});

test("resolveRasterizeDpi returns standard DPI when materials list is empty", () => {
  const service = createService();
  const dpi = resolveRasterizeDpi(service, []);
  assert.equal(dpi, 800);
});

test("resolveRasterizeDpi returns standard DPI when high-detail SKU list is empty", () => {
  const service = createService([]);
  const dpi = resolveRasterizeDpi(service, [makePoster("StarTranspA5Wood")]);
  assert.equal(dpi, 800);
});
