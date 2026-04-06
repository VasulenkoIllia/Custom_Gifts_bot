import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";

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
      order_number: string;
      urgent: boolean;
      flags: string[];
      notes: string[];
      preview_images: string[];
      qr: {
        requested: boolean;
        valid: boolean;
        should_generate: boolean;
        original_url: string | null;
        short_url: string | null;
        url: string | null;
      };
      materials: Array<{
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
      order_number: "test-29061",
      urgent: false,
      flags: [],
      notes: [],
      preview_images: [],
      qr: {
        requested: false,
        valid: false,
        should_generate: false,
        original_url: null,
        short_url: null,
        url: null,
      },
      materials: [
        {
          type: "poster",
          code: "AA5",
          product_id: 1,
          source_url: await createTransparentPosterDataUrl(),
          text: null,
          format: "A5",
          stand_type: null,
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
      order_number: "test-no-emoji",
      urgent: false,
      flags: [],
      notes: [],
      preview_images: [],
      qr: {
        requested: false,
        valid: false,
        should_generate: false,
        original_url: null,
        short_url: null,
        url: null,
      },
      materials: [
        {
          type: "sticker",
          code: "S",
          product_id: 1,
          source_url: null,
          text: "Без емодзі",
          format: null,
          stand_type: null,
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
      order_number: "test-with-emoji",
      urgent: false,
      flags: [],
      notes: [],
      preview_images: [],
      qr: {
        requested: false,
        valid: false,
        should_generate: false,
        original_url: null,
        short_url: null,
        url: null,
      },
      materials: [
        {
          type: "sticker",
          code: "S",
          product_id: 1,
          source_url: null,
          text: "Тест 🥰",
          format: null,
          stand_type: null,
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
