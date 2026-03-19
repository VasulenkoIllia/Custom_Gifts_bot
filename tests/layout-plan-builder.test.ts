import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { LayoutPlanBuilder } from "../src/modules/layout/layout-plan-builder";
import { loadProductCodeRules } from "../src/modules/layout/product-code-rules";

const rulesPath = path.resolve(process.cwd(), "config/business-rules/product-code-rules.json");

test("LayoutPlanBuilder builds poster+engraving+sticker with fixed ordering and names", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 12345,
    products: [
      {
        id: 1,
        sku: "SpotifyA5Wood",
        name: "Spotify poster",
        properties: [
          { name: "_tib_design_link_1", value: "https://example.com/poster.pdf" },
          { name: "_customization_image", value: "https://example.com/preview.jpg" },
          { name: "Гравіювання", value: "Так" },
          { name: "Текст для гравіювання", value: "Forever" },
          { name: "Стікер-записка", value: "Так" },
          { name: "Текст на стікер", value: "Love" },
          { name: "QR-код", value: "Так" },
          { name: "Посилання до QR-коду", value: "https://example.com/song" }
        ],
        offer: {
          sku: "SpotifyA5Wood",
          properties: [
            { name: "Розмір", value: "A5" },
            { name: "Тип підставки", value: "Дерев'яна звичайна" }
          ]
        }
      }
    ]
  });

  assert.equal(plan.materials.length, 3);
  assert.equal(plan.materials[0]?.filename, "CGU_AA5_12345_1_3");
  assert.equal(plan.materials[1]?.filename, "CGU_A5W_G_12345_2_3");
  assert.equal(plan.materials[2]?.filename, "CGU_S_12345_3_3");
  assert.deepEqual(plan.flags, ["QR +"]);
  assert.equal(plan.qr.requested, true);
  assert.equal(plan.qr.valid, true);
  assert.equal(plan.qr.shouldGenerate, true);
});

test("LayoutPlanBuilder uses special SKU code and urgent suffix", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 500,
    products: [
      {
        id: 2,
        sku: "ShapedNaghtLight6_A5WW",
        name: "Night light",
        properties: [
          { name: "_tib_design_link_1", value: "https://example.com/poster.pdf" },
          { name: "Термінове виготовлення", value: "Так" }
        ],
        offer: {
          sku: "ShapedNaghtLight6_A5WW",
          properties: [{ name: "Розмір", value: "A5" }]
        }
      }
    ]
  });

  assert.equal(plan.urgent, true);
  assert.equal(plan.materials.length, 1);
  assert.equal(plan.materials[0]?.filename, "CGU_HT_500_1_1_T");
});

test("LayoutPlanBuilder prioritizes SKU format and +K stand type for engraving", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 700,
    products: [
      {
        id: 3,
        sku: "FriendAppleA4RGB+K",
        name: "Friend Apple",
        properties: [
          { name: "_tib_design_link_1", value: "https://example.com/poster.pdf" },
          { name: "Гравіювання", value: "Так" },
          { name: "Текст для гравіювання", value: "Text" }
        ],
        offer: {
          sku: "FriendAppleA4RGB+K",
          properties: [
            { name: "Розмір", value: "A5" },
            { name: "Тип підставки", value: "Дерев'яна" }
          ]
        }
      }
    ]
  });

  assert.equal(plan.materials.length, 2);
  assert.equal(plan.materials[0]?.filename, "CGU_AA4_700_1_2");
  assert.equal(plan.materials[1]?.filename, "CGU_A4K_G_700_2_2");
});

test("LayoutPlanBuilder adds note when QR is requested with invalid link", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 888,
    products: [
      {
        id: 4,
        sku: "SpotifyA5Wood",
        name: "Poster",
        properties: [
          { name: "_tib_design_link_1", value: "https://example.com/poster.pdf" },
          { name: "QR-код", value: "Так" },
          { name: "Посилання до QR-коду", value: "not-a-url" }
        ]
      }
    ]
  });

  assert.equal(plan.qr.requested, true);
  assert.equal(plan.qr.valid, false);
  assert.equal(plan.qr.shouldGenerate, false);
  assert.equal(plan.notes.length, 1);
});
