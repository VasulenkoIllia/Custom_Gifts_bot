import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PdfPipelineService } from "../src/modules/pdf/pdf-pipeline.service";

function createService(rasterizeConcurrency = 2) {
  return new PdfPipelineService({
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never,
    qrRules: {} as never,
    urlShortenerService: null,
    outputRoot: path.join(os.tmpdir(), "pdf-pipeline-final-preflight-test"),
    fontPath: "/tmp/font.ttf",
    emojiFontPath: "",
    emojiRenderMode: "apple_image",
    appleEmojiBaseUrl: "",
    appleEmojiAssetsDir: "",
    colorSpace: "CMYK",
    stickerSizeMm: 100,
    offWhiteHex: "F7F6F2",
    rasterizeDpi: 800,
    highDetailDpi: 1200,
    highDetailSkus: [],
    rasterizeConcurrency,
    finalPreflightMeasureDpi: 200,
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

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function runFinalPdfPreflight(
  service: PdfPipelineService,
  generatedFiles: Array<Record<string, unknown>>,
  rasterizeDpi = 800,
) {
  return (
    service as never as {
      runFinalPdfPreflight: (
        generatedFiles: Array<Record<string, unknown>>,
        rasterizeDpi: number,
      ) => Promise<{ filesProcessed: number; correctedPixels: number }>;
    }
  ).runFinalPdfPreflight(generatedFiles, rasterizeDpi);
}

function patchPreflightHooks(
  service: PdfPipelineService,
  hooks: {
    enforce: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    measure: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    convert: (filePath: string) => Promise<void>;
  },
) {
  const mutableService = service as never as {
    getEnforceOffWhiteInPdf: () => typeof hooks.enforce;
    getMeasureResidualNearWhiteInPdf: () => typeof hooks.measure;
    convertPdfToCmykInPlace: typeof hooks.convert;
  };

  mutableService.getEnforceOffWhiteInPdf = () => hooks.enforce;
  mutableService.getMeasureResidualNearWhiteInPdf = () => hooks.measure;
  mutableService.convertPdfToCmykInPlace = hooks.convert;
}

function makeGeneratedPoster(details: Record<string, unknown> = {}) {
  return {
    type: "poster",
    filename: "poster.pdf",
    path: "/tmp/poster.pdf",
    details,
  };
}

test("final preflight measures residual white without enforcing when residual is below threshold", async () => {
  const service = createService();
  const calls = {
    enforce: 0,
    measure: 0,
    convert: 0,
  };
  const generated = makeGeneratedPoster({ post_embed_color_space: "CMYK" });

  patchPreflightHooks(service, {
    enforce: async () => {
      calls.enforce += 1;
      return {};
    },
    measure: async () => {
      calls.measure += 1;
      return {
        residual_strict_white_pixels: 0,
        residual_aggressive_white_pixels: 0,
      };
    },
    convert: async () => {
      calls.convert += 1;
    },
  });

  const result = await runFinalPdfPreflight(service, [generated]);

  assert.deepEqual(calls, { enforce: 0, measure: 1, convert: 0 });
  assert.equal(result.filesProcessed, 1);
  assert.equal(result.correctedPixels, 0);

  const finalPreflight = generated.details.final_preflight as Record<string, unknown>;
  assert.equal(finalPreflight.applied, false);
  assert.equal(finalPreflight.cmyk_postcheck_applied, true);
  assert.equal(finalPreflight.cmyk_retry_triggered, false);
});

test("final preflight enforces off-white only when measured residual exceeds threshold", async () => {
  const service = createService();
  const calls = {
    enforce: 0,
    measure: 0,
    convert: 0,
    enforceProfiles: [] as unknown[],
  };
  const generated = makeGeneratedPoster({ post_embed_color_space: "CMYK" });

  patchPreflightHooks(service, {
    enforce: async (input) => {
      calls.enforce += 1;
      calls.enforceProfiles.push(input.profile);
      return {
        replaced_pixels: 10,
        cleanup_replaced_pixels: 20,
        forced_opaque_pixels: 1,
        residual_strict_white_pixels: 0,
        residual_aggressive_white_pixels: 0,
      };
    },
    measure: async () => {
      calls.measure += 1;
      return calls.measure === 1
        ? {
            residual_strict_white_pixels: 65,
            residual_aggressive_white_pixels: 0,
          }
        : {
            residual_strict_white_pixels: 0,
            residual_aggressive_white_pixels: 0,
          };
    },
    convert: async () => {
      calls.convert += 1;
    },
  });

  const result = await runFinalPdfPreflight(service, [generated]);

  assert.equal(calls.enforce, 1);
  assert.equal(calls.measure, 2);
  assert.equal(calls.convert, 1);
  assert.deepEqual(calls.enforceProfiles, ["aggressive"]);
  assert.equal(result.correctedPixels, 31);

  const finalPreflight = generated.details.final_preflight as Record<string, unknown>;
  assert.equal(finalPreflight.applied, true);
  assert.equal(finalPreflight.cmyk_retry_triggered, true);
  assert.equal(finalPreflight.cmyk_retry_attempts, 1);
  assert.equal(finalPreflight.residual_strict_white_pixels, 0);
  assert.equal(finalPreflight.residual_aggressive_white_pixels, 0);
});

test("final preflight ignores stale pre-CMYK residual and gates retry on final measurement", async () => {
  const service = createService();
  const calls = {
    enforce: 0,
    measure: 0,
    convert: 0,
  };
  const generated = makeGeneratedPoster({
    post_embed_color_space: "CMYK",
    white_recolor_final: {
      residual_strict_white_pixels: 500,
      residual_aggressive_white_pixels: 500,
    },
  });

  patchPreflightHooks(service, {
    enforce: async () => {
      calls.enforce += 1;
      return {};
    },
    measure: async () => {
      calls.measure += 1;
      return {
        residual_strict_white_pixels: 0,
        residual_aggressive_white_pixels: 0,
      };
    },
    convert: async () => {
      calls.convert += 1;
    },
  });

  const result = await runFinalPdfPreflight(service, [generated]);

  assert.deepEqual(calls, { enforce: 0, measure: 1, convert: 0 });
  assert.equal(result.correctedPixels, 0);

  const finalPreflight = generated.details.final_preflight as Record<string, unknown>;
  assert.equal(finalPreflight.applied, false);
  assert.equal(finalPreflight.cmyk_retry_triggered, false);
  assert.equal(finalPreflight.residual_strict_white_pixels, 0);
  assert.equal(finalPreflight.residual_aggressive_white_pixels, 0);
});

test("final preflight measurements share rasterize semaphore across concurrent orders", async () => {
  const service = createService(1);
  let activeMeasurements = 0;
  let maxActiveMeasurements = 0;

  patchPreflightHooks(service, {
    enforce: async () => ({}),
    measure: async () => {
      activeMeasurements += 1;
      maxActiveMeasurements = Math.max(maxActiveMeasurements, activeMeasurements);
      await sleep(20);
      activeMeasurements -= 1;
      return {
        residual_strict_white_pixels: 0,
        residual_aggressive_white_pixels: 0,
      };
    },
    convert: async () => undefined,
  });

  await Promise.all([
    runFinalPdfPreflight(service, [
      makeGeneratedPoster({ post_embed_color_space: "CMYK" }),
    ]),
    runFinalPdfPreflight(service, [
      {
        ...makeGeneratedPoster({ post_embed_color_space: "CMYK" }),
        filename: "poster-2.pdf",
        path: "/tmp/poster-2.pdf",
      },
    ]),
  ]);

  assert.equal(maxActiveMeasurements, 1);
});
