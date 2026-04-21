import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PdfPipelineService } from "../src/modules/pdf/pdf-pipeline.service";

function createService(options: {
  autoRouterEnabled: boolean;
  aggressiveWhiteThreshold?: number;
  riskThreshold?: number;
}) {
  return new PdfPipelineService({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never,
    qrRules: {} as never,
    urlShortenerService: null,
    outputRoot: path.join(os.tmpdir(), "pdf-pipeline-auto-router-test"),
    fontPath: "/tmp/font.ttf",
    emojiFontPath: "",
    emojiRenderMode: "apple_image",
    appleEmojiBaseUrl: "",
    appleEmojiAssetsDir: "",
    colorSpace: "CMYK",
    stickerSizeMm: 100,
    offWhiteHex: "FFFEFA",
    rasterizeDpi: 600,
    qualitySafeProfile: false,
    cmykLossless: false,
    autoRouterEnabled: options.autoRouterEnabled,
    autoRouterPreflightDpi: 300,
    autoRouterRiskThreshold: options.riskThreshold ?? 2,
    autoRouterAggressiveWhitePixels: options.aggressiveWhiteThreshold ?? 150_000,
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

const posterMaterial = {
  type: "poster" as const,
  code: "AA5",
  index: 1,
  total: 1,
  filename: "CGU_AA5_100_1_1",
  productId: 10,
  sku: "PosterGiftA5WW",
  sourceUrl: "https://example.com/source.pdf",
  text: null,
  format: "A5" as const,
  standType: null,
};

test("auto-router returns standard profile when router is disabled", async () => {
  const service = createService({ autoRouterEnabled: false });
  const decision = await (service as never as {
    resolvePipelineRoute: (params: {
      orderId: string;
      materials: Array<typeof posterMaterial>;
    }) => Promise<{
      profile: string;
      reason: string;
      riskScore: number;
    }>;
  }).resolvePipelineRoute({
    orderId: "100",
    materials: [posterMaterial],
  });

  assert.equal(decision.profile, "standard");
  assert.equal(decision.reason, "auto_disabled");
  assert.equal(decision.riskScore, 0);
});

test("auto-router switches to quality_safe on high aggressive near-white risk", async () => {
  const service = createService({
    autoRouterEnabled: true,
    aggressiveWhiteThreshold: 150_000,
    riskThreshold: 2,
  });

  (service as never as { downloadSourcePdfWithRetry: () => Promise<void> }).downloadSourcePdfWithRetry =
    async () => undefined;
  (
    service as never as {
      getMeasureResidualNearWhiteInPdf: () => ((
        input: unknown,
      ) => Promise<Record<string, unknown>>) | null;
    }
  ).getMeasureResidualNearWhiteInPdf = () =>
    async () => ({
      residual_strict_white_pixels: 20_000,
      residual_aggressive_white_pixels: 220_000,
      residual_strict_low_alpha_white_pixels: 2_000,
      residual_aggressive_low_alpha_white_pixels: 4_000,
    });

  const decision = await (service as never as {
    resolvePipelineRoute: (params: {
      orderId: string;
      materials: Array<typeof posterMaterial>;
    }) => Promise<{
      profile: string;
      reason: string;
      riskScore: number;
    }>;
  }).resolvePipelineRoute({
    orderId: "100",
    materials: [posterMaterial],
  });

  assert.equal(decision.profile, "quality_safe");
  assert.equal(decision.reason, "auto_risk");
  assert.ok(decision.riskScore >= 2);
});
