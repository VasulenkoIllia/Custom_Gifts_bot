import assert from "node:assert/strict";
import test from "node:test";
import { toLegacyLayoutPlan } from "../src/modules/pdf/pdf-pipeline.service";

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
