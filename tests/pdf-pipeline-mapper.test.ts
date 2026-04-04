import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQrDecisionWarnings,
  resolveCaptionQrUrl,
  toLegacyLayoutPlan,
} from "../src/modules/pdf/pdf-pipeline.service";

test("toLegacyLayoutPlan maps layout plan fields for legacy generator", () => {
  const legacy = toLegacyLayoutPlan({
    orderNumber: "999",
    urgent: true,
    flags: ["QR +", "LF +"],
    notes: ["note"],
    previewImages: ["https://example.com/preview.jpg"],
    qr: {
      requested: true,
      valid: true,
      shouldGenerate: true,
      originalUrl: "https://example.com/qr",
      url: "https://example.com/qr",
    },
    materials: [
      {
        type: "poster",
        code: "AA5",
        index: 1,
        total: 2,
        filename: "CGU_AA5_999_1_2_T",
        productId: 10,
        sku: "SpotifyA5Wood",
        sourceUrl: "https://example.com/poster.pdf",
        text: null,
        format: "A5",
        standType: null,
      },
      {
        type: "engraving",
        code: "A5W_G",
        index: 2,
        total: 2,
        filename: "CGU_A5W_G_999_2_2_T",
        productId: 10,
        sku: "SpotifyA5Wood",
        sourceUrl: null,
        text: "Text",
        format: "A5",
        standType: "W",
      },
    ],
  });

  assert.equal(legacy.order_number, "999");
  assert.equal(legacy.urgent, true);
  assert.equal(legacy.materials.length, 2);
  assert.equal(legacy.materials[0]?.source_url, "https://example.com/poster.pdf");
  assert.equal(legacy.materials[1]?.stand_type, "W");
  assert.equal(legacy.qr.should_generate, true);
  assert.equal(legacy.qr.short_url, null);
});

test("toLegacyLayoutPlan supports resolved short QR URL metadata", () => {
  const legacy = toLegacyLayoutPlan(
    {
      orderNumber: "111",
      urgent: false,
      flags: ["QR +"],
      notes: [],
      previewImages: [],
      qr: {
        requested: true,
        valid: true,
        shouldGenerate: true,
        originalUrl: "https://example.com/long",
        url: "https://example.com/long",
      },
      materials: [],
    },
    {
      effectiveQrUrl: "https://lnk.ua/abc123",
      shortQrUrl: "https://lnk.ua/abc123",
    },
  );

  assert.equal(legacy.qr.original_url, "https://example.com/long");
  assert.equal(legacy.qr.url, "https://lnk.ua/abc123");
  assert.equal(legacy.qr.short_url, "https://lnk.ua/abc123");
});

test("buildQrDecisionWarnings emits alert warning for unsupported QR SKU", () => {
  const warnings = buildQrDecisionWarnings([
    {
      filename: "CGU_AA5_29071_1_2_T",
      sku: "MDPA5WoodRGB",
      decision: {
        strategy: "none",
        reason: "sku_not_whitelisted",
      },
    },
    {
      filename: "CGU_AA5_29069_1_2",
      sku: "YouTubeA5WoodMultiWW",
      decision: {
        strategy: "qr",
        reason: "regular_qr",
      },
    },
  ]);

  assert.deepEqual(warnings, [
    "🚨 QR-код замовлено, але для CGU_AA5_29071_1_2_T (SKU MDPA5WoodRGB) не налаштовані правила QR. QR не згенеровано і не вбудовано в макет.",
  ]);
});

test("resolveCaptionQrUrl returns embedded QR URL and hides non-embedded cases", () => {
  const baseLayoutPlan = {
    orderNumber: "100",
    urgent: false,
    flags: ["QR +"],
    notes: [],
    previewImages: [],
    qr: {
      requested: true,
      valid: true,
      shouldGenerate: true,
      originalUrl: "https://example.com/original",
      url: "https://example.com/original",
    },
    materials: [],
  };

  const visibleUrl = resolveCaptionQrUrl({
    layoutPlan: baseLayoutPlan,
    generatedFiles: [
      {
        type: "poster",
        filename: "CGU_AA5_100_1_1.pdf",
        path: "/tmp/one.pdf",
        details: {
          qr: {
            embedded: true,
            url: "https://lnk.ua/short-1",
          },
        },
      },
    ],
  });

  const hiddenUrl = resolveCaptionQrUrl({
    layoutPlan: baseLayoutPlan,
    generatedFiles: [
      {
        type: "poster",
        filename: "CGU_AA5_100_1_1.pdf",
        path: "/tmp/one.pdf",
        details: {},
      },
    ],
  });

  assert.equal(visibleUrl, "https://lnk.ua/short-1");
  assert.equal(hiddenUrl, null);
});
