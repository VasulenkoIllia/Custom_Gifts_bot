import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import type { Font, GlyphRun } from "@pdf-lib/fontkit";

type MutablePng = {
  width: number;
  height: number;
  data: Buffer;
};

const { PNG } = require("pngjs") as {
  PNG: {
    new (options: { width: number; height: number }): MutablePng;
    sync: {
      write(png: MutablePng): Buffer;
    };
  };
};

const materialGeneratorRuntime = require("../src/modules/pdf/material-generator.js") as {
  generateMaterialFiles: (input: {
    layoutPlan: {
      orderNumber: string;
      urgent: boolean;
      flags: string[];
      notes: string[];
      previewImages: string[];
      qr: {
        requested: boolean;
        valid: boolean;
        shouldGenerate: boolean;
        originalUrl: string | null;
        shortUrl: string | null;
        url: string | null;
      };
      materials: Array<{
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
      }>;
    };
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
    sourceRequestOptions?: {
      timeoutMs: number;
      retries: number;
      retryBaseMs: number;
    };
  }) => Promise<{
    warnings: string[];
    generated: Array<{
      path: string;
      details: Record<string, unknown>;
    }>;
  }>;
  __materialGeneratorTestUtils: {
    createFontSet: (primary: Font, fallbacks?: Font[]) => { primary: Font; fallbacks: Font[] };
    loadFont: (fontPath: string) => Promise<Font>;
    resolveClusterRuns: (
      fontSet: { primary: Font; fallbacks: Font[] },
      cluster: unknown,
      emojiRuntime: unknown,
    ) => Array<
      | { kind: "run"; font: Font; run: GlyphRun; hasDrawableGlyph: boolean }
      | { kind: "emoji"; cluster: string }
    >;
    getLineLayout: (
      fontSet: { primary: Font; fallbacks: Font[] },
      text: string,
      fontSize: number,
      emojiRuntime?: unknown,
    ) => {
      width: number;
      minX: number;
      segments: Array<
        | { kind: "run"; xPt: number; scale: number; glyphs: unknown[]; positions: Array<{ xAdvance: number }> }
        | { kind: "emoji"; cluster: string; xPt: number; widthPt: number; heightPt: number }
      >;
    };
    fitTextToBox: (
      fontSet: { primary: Font; fallbacks: Font[] },
      text: string,
      widthPt: number,
      heightPt: number,
      emojiRuntime?: unknown,
      options?: { initialScale?: number; minFontSize?: number; maxFontSize?: number },
    ) => { fontSize: number; lines: string[] };
  };
};

function hasGhostscript(): boolean {
  return spawnSync("gs", ["--version"], { stdio: "ignore" }).status === 0;
}

function fillRect(
  png: MutablePng,
  params: { x: number; y: number; width: number; height: number; r: number; g: number; b: number; a: number },
): void {
  for (let y = params.y; y < params.y + params.height; y += 1) {
    for (let x = params.x; x < params.x + params.width; x += 1) {
      const index = (y * png.width + x) * 4;
      png.data[index] = params.r;
      png.data[index + 1] = params.g;
      png.data[index + 2] = params.b;
      png.data[index + 3] = params.a;
    }
  }
}

function drawCircle(
  png: MutablePng,
  params: { cx: number; cy: number; radius: number; r: number; g: number; b: number; a: number },
): void {
  const radiusSq = params.radius * params.radius;
  for (let y = params.cy - params.radius; y <= params.cy + params.radius; y += 1) {
    for (let x = params.cx - params.radius; x <= params.cx + params.radius; x += 1) {
      if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
        continue;
      }

      const dx = x - params.cx;
      const dy = y - params.cy;
      if (dx * dx + dy * dy > radiusSq) {
        continue;
      }

      const index = (y * png.width + x) * 4;
      png.data[index] = params.r;
      png.data[index + 1] = params.g;
      png.data[index + 2] = params.b;
      png.data[index + 3] = params.a;
    }
  }
}

async function createTransparentPosterDataUrl(): Promise<string> {
  const width = 180;
  const height = 260;
  const png = new PNG({ width, height });

  fillRect(png, {
    x: 0,
    y: 0,
    width,
    height: 150,
    r: 112,
    g: 168,
    b: 225,
    a: 255,
  });
  fillRect(png, {
    x: 0,
    y: 150,
    width,
    height: 110,
    r: 0,
    g: 0,
    b: 0,
    a: 0,
  });

  fillRect(png, {
    x: 16,
    y: 165,
    width: 148,
    height: 4,
    r: 255,
    g: 254,
    b: 250,
    a: 255,
  });
  fillRect(png, {
    x: 16,
    y: 210,
    width: 148,
    height: 4,
    r: 255,
    g: 254,
    b: 250,
    a: 255,
  });
  drawCircle(png, {
    cx: 60,
    cy: 167,
    radius: 6,
    r: 255,
    g: 254,
    b: 250,
    a: 255,
  });
  drawCircle(png, {
    cx: 126,
    cy: 212,
    radius: 9,
    r: 255,
    g: 254,
    b: 250,
    a: 255,
  });

  const pngBytes = PNG.sync.write(png);
  const pdfDoc = await PDFDocument.create();
  const image = await pdfDoc.embedPng(pngBytes);
  const page = pdfDoc.addPage([180, 260]);
  page.drawImage(image, {
    x: 0,
    y: 0,
    width: 180,
    height: 260,
  });

  const pdfBytes = Buffer.from(await pdfDoc.save());
  return `data:application/pdf;base64,${pdfBytes.toString("base64")}`;
}

async function createTempOutputRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function loadPrimaryFontSet(): Promise<{ primary: Font; fallbacks: Font[] }> {
  const primary = await materialGeneratorRuntime.__materialGeneratorTestUtils.loadFont(
    path.resolve(process.cwd(), "assets/fonts/Caveat-VariableFont_wght.ttf"),
  );
  return materialGeneratorRuntime.__materialGeneratorTestUtils.createFontSet(primary, []);
}

test("generateMaterialFiles preserves soft mask for posters with internal transparency", async (t) => {
  if (!hasGhostscript()) {
    t.skip("Ghostscript is not available in the test environment.");
  }

  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "material-generator-runtime-"));
  t.after(async () => {
    await fs.rm(outputRoot, { recursive: true, force: true });
  });

  const result = await materialGeneratorRuntime.generateMaterialFiles({
    layoutPlan: {
      orderNumber: "test-29061",
      urgent: false,
      flags: [],
      notes: [],
      previewImages: [],
      qr: {
        requested: false,
        valid: false,
        shouldGenerate: false,
        originalUrl: null,
        shortUrl: null,
        url: null,
      },
      materials: [
        {
          type: "poster",
          code: "AA5",
          productId: 1,
          sourceUrl: await createTransparentPosterDataUrl(),
          text: null,
          format: "A5",
          standType: null,
          index: 1,
          total: 1,
          filename: "TEST_AA5_1_1",
        },
      ],
    },
    outputRoot,
    orderId: "test-29061",
    fontPath: path.resolve(process.cwd(), "assets/fonts/Caveat-VariableFont_wght.ttf"),
    emojiFontPath: "",
    emojiRenderMode: "apple_image",
    appleEmojiBaseUrl: "",
    appleEmojiAssetsDir: "",
    stickerSizeMm: 100,
    colorSpace: "RGB",
    qrPlacementByFormat: {
      A5: { rightMm: 10, bottomMm: 10, sizeMm: 20 },
      A4: { rightMm: 10, bottomMm: 10, sizeMm: 30 },
    },
    replaceWhiteWithOffWhite: true,
    offWhiteHex: "FFFEFA",
    rasterizeDpi: 144,
    sourceRequestOptions: {
      timeoutMs: 1_000,
      retries: 0,
      retryBaseMs: 100,
    },
  });

  assert.equal(result.generated.length, 1);
  const generated = result.generated[0];
  assert.ok(generated);

  const whiteRecolor =
    generated.details.white_recolor && typeof generated.details.white_recolor === "object"
      ? (generated.details.white_recolor as Record<string, unknown>)
      : null;

  assert.ok(whiteRecolor);
  assert.equal(whiteRecolor?.strip_soft_mask_requested, true);
  assert.equal(whiteRecolor?.strip_soft_mask_applied, false);
  assert.equal(whiteRecolor?.strip_soft_mask_fallback_pages, 1);
  assert.equal(whiteRecolor?.iterations_requested, 3);
  assert.equal(whiteRecolor?.smart_retry_enabled, false);
  assert.equal("white_recolor_final" in generated.details, false);

  const outputPdf = await fs.readFile(generated.path);
  assert.ok(outputPdf.includes(Buffer.from("/SMask")));
});

test("generateMaterialFiles does not emit apple emoji warning when text has no emoji", async (t) => {
  const outputRoot = await createTempOutputRoot("material-generator-no-emoji-");
  t.after(async () => {
    await fs.rm(outputRoot, { recursive: true, force: true });
  });

  const result = await materialGeneratorRuntime.generateMaterialFiles({
    layoutPlan: {
      orderNumber: "test-no-emoji",
      urgent: false,
      flags: [],
      notes: [],
      previewImages: [],
      qr: {
        requested: false,
        valid: false,
        shouldGenerate: false,
        originalUrl: null,
        shortUrl: null,
        url: null,
      },
      materials: [
        {
          type: "sticker",
          code: "S",
          productId: 1,
          sourceUrl: null,
          text: "Без емодзі",
          format: null,
          standType: null,
          index: 1,
          total: 1,
          filename: "TEST_S_1_1",
        },
      ],
    },
    outputRoot,
    orderId: "test-no-emoji",
    fontPath: path.resolve(process.cwd(), "assets/fonts/Caveat-VariableFont_wght.ttf"),
    emojiFontPath: "",
    emojiRenderMode: "apple_image",
    appleEmojiBaseUrl: "",
    appleEmojiAssetsDir: "",
    stickerSizeMm: 100,
    colorSpace: "RGB",
    qrPlacementByFormat: {
      A5: { rightMm: 10, bottomMm: 10, sizeMm: 20 },
      A4: { rightMm: 10, bottomMm: 10, sizeMm: 30 },
    },
    replaceWhiteWithOffWhite: true,
    offWhiteHex: "FFFEFA",
    rasterizeDpi: 144,
    sourceRequestOptions: {
      timeoutMs: 1_000,
      retries: 0,
      retryBaseMs: 100,
    },
  });

  assert.equal(
    result.warnings.some((warning) =>
      warning.includes("APPLE_EMOJI_BASE_URL") || warning.includes("apple_image mode"),
    ),
    false,
  );
});

test("generateMaterialFiles warns about missing apple emoji source only when text contains emoji", async (t) => {
  const outputRoot = await createTempOutputRoot("material-generator-with-emoji-");
  t.after(async () => {
    await fs.rm(outputRoot, { recursive: true, force: true });
  });

  const result = await materialGeneratorRuntime.generateMaterialFiles({
    layoutPlan: {
      orderNumber: "test-with-emoji",
      urgent: false,
      flags: [],
      notes: [],
      previewImages: [],
      qr: {
        requested: false,
        valid: false,
        shouldGenerate: false,
        originalUrl: null,
        shortUrl: null,
        url: null,
      },
      materials: [
        {
          type: "sticker",
          code: "S",
          productId: 1,
          sourceUrl: null,
          text: "Тест 🥰",
          format: null,
          standType: null,
          index: 1,
          total: 1,
          filename: "TEST_S_1_1",
        },
      ],
    },
    outputRoot,
    orderId: "test-with-emoji",
    fontPath: path.resolve(process.cwd(), "assets/fonts/Caveat-VariableFont_wght.ttf"),
    emojiFontPath: "",
    emojiRenderMode: "apple_image",
    appleEmojiBaseUrl: "",
    appleEmojiAssetsDir: "",
    stickerSizeMm: 100,
    colorSpace: "RGB",
    qrPlacementByFormat: {
      A5: { rightMm: 10, bottomMm: 10, sizeMm: 20 },
      A4: { rightMm: 10, bottomMm: 10, sizeMm: 30 },
    },
    replaceWhiteWithOffWhite: true,
    offWhiteHex: "FFFEFA",
    rasterizeDpi: 144,
    sourceRequestOptions: {
      timeoutMs: 1_000,
      retries: 0,
      retryBaseMs: 100,
    },
  });

  assert.equal(
    result.warnings.some((warning) =>
      warning.includes("У тексті є emoji, але для apple_image mode не задано джерело emoji PNG."),
    ),
    true,
  );
});

test("resolveClusterRuns preserves whitespace as spacing instead of fallback question glyph", async () => {
  const fontSet = await loadPrimaryFontSet();

  const runs = materialGeneratorRuntime.__materialGeneratorTestUtils.resolveClusterRuns(
    fontSet,
    " ",
    null,
  );

  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.kind, "run");
  const firstRun = runs[0];
  if (!firstRun || firstRun.kind !== "run") {
    assert.fail("Whitespace cluster should resolve to a layout run.");
  }
  const firstPosition = firstRun.run.positions[0];
  if (!firstPosition) {
    assert.fail("Whitespace run should keep an advance position.");
  }
  assert.ok(firstPosition.xAdvance > 0);
});

test("emoji layout keeps extra side bearing around apple-image emoji clusters", async () => {
  const fontSet = await loadPrimaryFontSet();
  const emojiRuntime = {
    mode: "apple_image",
    assetsDir: path.resolve(process.cwd(), "node_modules/emoji-datasource-apple/img/apple/64"),
    baseUrl: "",
    bytesCache: new Map<string, Buffer | null>(),
    missingWarned: new Set<string>(),
  };

  const layout = materialGeneratorRuntime.__materialGeneratorTestUtils.getLineLayout(
    fontSet,
    "Ти найкращий☺️",
    40,
    emojiRuntime,
  );

  const emojiSegment = layout.segments.find((segment) => segment.kind === "emoji");
  assert.ok(emojiSegment);
  if (!emojiSegment || emojiSegment.kind !== "emoji") {
    assert.fail("Expected an emoji segment in the line layout.");
  }
  assert.ok(emojiSegment.widthPt > 40);
});

test("fitTextToBox caps sticker text size lower than default box fill", async () => {
  const fontSet = await loadPrimaryFontSet();
  const widthPt = 238;
  const heightPt = 238;

  const defaultFit = materialGeneratorRuntime.__materialGeneratorTestUtils.fitTextToBox(
    fontSet,
    "Люблю!",
    widthPt,
    heightPt,
    null,
  );
  const stickerFit = materialGeneratorRuntime.__materialGeneratorTestUtils.fitTextToBox(
    fontSet,
    "Люблю!",
    widthPt,
    heightPt,
    null,
    { initialScale: 0.34, maxFontSize: 36 },
  );

  assert.ok(stickerFit.fontSize < defaultFit.fontSize);
  assert.equal(stickerFit.fontSize, 36);
  assert.ok(stickerFit.fontSize <= Math.floor(Math.min(widthPt, heightPt) * 0.34));
});
