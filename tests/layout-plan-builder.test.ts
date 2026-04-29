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
  assert.equal(
    plan.notes[0],
    "🚨 Посилання QR невалідне. QR не згенеровано і не вбудовано в макет.",
  );
});

test("LayoutPlanBuilder includes manual A6 and keychain items in total numbering and flags", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 901,
    products: [
      {
        id: 10,
        sku: "PhotoPosterA5Wood",
        name: "Photo poster",
        properties: [
          { name: "_tib_design_link_1", value: "https://example.com/poster.pdf" },
          { name: "A6", value: "Так" },
          { name: "Брелок", value: "Так" }
        ],
        offer: {
          sku: "PhotoPosterA5Wood",
          properties: [{ name: "Розмір", value: "A5" }]
        }
      }
    ]
  });

  assert.equal(plan.materials.length, 1);
  assert.equal(plan.materials[0]?.filename, "CGU_AA5_901_1_3");
  assert.deepEqual(plan.flags, ["A6 +", "B +"]);
});

test("LayoutPlanBuilder counts manual positions across multiple posters without creating extra PDFs", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 902,
    products: [
      {
        id: 11,
        sku: "SpotifyA5Wood",
        name: "Poster one",
        properties: [
          { name: "_tib_design_link_1", value: "https://example.com/poster-1.pdf" },
          { name: "_itemKey", value: "1" },
          { name: "A6", value: "Так" }
        ]
      },
      {
        id: 12,
        sku: "SpotifyA4Wood",
        name: "Poster two",
        properties: [
          { name: "_tib_design_link_1", value: "https://example.com/poster-2.pdf" },
          { name: "_itemKey", value: "2" }
        ],
        offer: {
          sku: "SpotifyA4Wood",
          properties: [{ name: "Розмір", value: "A4" }]
        }
      }
    ]
  });

  assert.equal(plan.materials.length, 2);
  assert.equal(plan.materials[0]?.filename, "CGU_AA5_902_1_3");
  assert.equal(plan.materials[1]?.filename, "CGU_AA4_902_2_3");
  assert.deepEqual(plan.flags, ["A6 +"]);
});

test("LayoutPlanBuilder warns and skips engraving/sticker files when text is missing", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 903,
    products: [
      {
        id: 20,
        sku: "PhotoPosterA5Wood",
        name: "Photo poster",
        properties: [
          { name: "_tib_design_link_1", value: "https://example.com/poster.pdf" },
          { name: "Гравіювання", value: "Так" },
          { name: "Стікер-записка", value: "Так" },
        ],
        offer: {
          sku: "PhotoPosterA5Wood",
          properties: [{ name: "Розмір", value: "A5" }],
        },
      },
    ],
  });

  assert.equal(plan.materials.length, 1);
  assert.equal(plan.materials[0]?.filename, "CGU_AA5_903_1_3");
  assert.deepEqual(plan.notes, [
    "🚨 Замовлено гравіювання, але текст відсутній. Файл CGU_A5W_G_903_2_3 не згенеровано.",
    "🚨 Замовлено стікер, але текст відсутній. Файл CGU_S_903_3_3 не згенеровано.",
  ]);
});

test("LayoutPlanBuilder strips emoji from sticker text and keeps plain text", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 9031,
    products: [
      {
        id: 201,
        sku: "PhotoPosterA5Wood",
        name: "Photo poster",
        properties: [
          { name: "_tib_design_link_1", value: "https://example.com/poster.pdf" },
          { name: "Стікер-записка", value: "Так" },
          { name: "Текст на стікер", value: "Любимо тебе 🥰" },
        ],
        offer: {
          sku: "PhotoPosterA5Wood",
          properties: [{ name: "Розмір", value: "A5" }],
        },
      },
    ],
  });

  assert.equal(plan.materials.length, 2);
  assert.equal(plan.materials[1]?.type, "sticker");
  assert.equal(plan.materials[1]?.text, "Любимо тебе");
  assert.equal(plan.notes.length, 0);
});

test("LayoutPlanBuilder treats emoji-only sticker text as missing text", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 9032,
    products: [
      {
        id: 202,
        sku: "PhotoPosterA5Wood",
        name: "Photo poster",
        properties: [
          { name: "_tib_design_link_1", value: "https://example.com/poster.pdf" },
          { name: "Стікер-записка", value: "Так" },
          { name: "Текст на стікер", value: "🥰❤️" },
        ],
        offer: {
          sku: "PhotoPosterA5Wood",
          properties: [{ name: "Розмір", value: "A5" }],
        },
      },
    ],
  });

  assert.equal(plan.materials.length, 1);
  assert.deepEqual(plan.notes, [
    "🚨 Замовлено стікер, але текст відсутній. Файл CGU_S_9032_2_2 не згенеровано.",
  ]);
});

test("LayoutPlanBuilder keeps emoji-only sticker text as missing even when text field is the only sticker signal", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 9033,
    products: [
      {
        id: 203,
        sku: "PhotoPosterA5Wood",
        name: "Photo poster",
        properties: [
          { name: "_tib_design_link_1", value: "https://example.com/poster.pdf" },
          { name: "Текст на стікер", value: "🥰❤️" },
        ],
        offer: {
          sku: "PhotoPosterA5Wood",
          properties: [{ name: "Розмір", value: "A5" }],
        },
      },
    ],
  });

  assert.equal(plan.materials.length, 1);
  assert.deepEqual(plan.notes, [
    "🚨 Замовлено стікер, але текст відсутній. Файл CGU_S_9033_2_2 не згенеровано.",
  ]);
});

test("LayoutPlanBuilder does not use preview image as poster print source", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 904,
    products: [
      {
        id: 21,
        sku: "PhotoPosterA5Wood",
        name: "Preview only poster",
        properties: [
          { name: "_customization_image", value: "https://example.com/preview.jpg" },
        ],
      },
    ],
  });

  assert.equal(plan.previewImages.length, 1);
  assert.equal(plan.materials[0]?.sourceUrl, null);
  assert.equal(
    plan.notes[0],
    '🚨 Для "PhotoPosterA5Wood" відсутній друкарський файл (_tib_design_link_1). Preview не використовується як source для друку.',
  );
});

test("LayoutPlanBuilder warns when preview URL is invalid", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 905,
    products: [
      {
        id: 22,
        sku: "PhotoPosterA5Wood",
        name: "Poster with broken preview",
        properties: [
          { name: "_tib_design_link_1", value: "https://example.com/poster.pdf" },
          { name: "_customization_image", value: "bad-preview-url" },
        ],
      },
    ],
  });

  assert.deepEqual(plan.previewImages, []);
  assert.equal(
    plan.notes[0],
    '⚠️ Для "PhotoPosterA5Wood" _customization_image невалідний, прев\'ю не додано.',
  );
});

test("LayoutPlanBuilder warns about unlinked add-ons", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 906,
    products: [
      {
        id: 23,
        sku: "PhotoPosterA5Wood",
        name: "Poster",
        properties: [
          { name: "_itemKey", value: "base-1" },
          { name: "_tib_design_link_1", value: "https://example.com/poster.pdf" },
        ],
      },
      {
        id: 24,
        sku: "Гравіювання",
        name: "Гравіювання",
        properties: [{ name: "Title", value: "Default Title" }],
      },
    ],
  });

  assert.equal(plan.materials.length, 1);
  assert.equal(
    plan.notes[0],
    '⚠️ Додаткова позиція "Гравіювання" не прив\'язана до основного макета. Перевірте комплект вручну.',
  );
});

test("LayoutPlanBuilder treats Live Photo as manager flag without unlinked warning", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 907,
    products: [
      {
        id: 25,
        sku: "PhotoPosterA5Wood",
        name: "Poster",
        properties: [
          { name: "_itemKey", value: "base-1" },
          { name: "_tib_design_link_1", value: "https://example.com/poster.pdf" },
        ],
      },
      {
        id: 26,
        sku: "Live Photo",
        name: "Live Photo",
        properties: [{ name: "Live Photo", value: "Так" }],
      },
    ],
  });

  assert.deepEqual(plan.flags, ["LF +"]);
  assert.deepEqual(plan.notes, []);
});

test("LayoutPlanBuilder uses A4 engraving bounds for TextcollageA5Wood SKUs", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  for (const sku of [
    "TextcollageA5Wood",
    "TextcollageA5WoodWW",
    "TextcollageA5WoodMultiWW",
    "TextcollageA5WoodRBG",
    "Collage2HeartA5Wood",
    "Collage2HeartA5WoodWW",
    "Collage2HeartA5WoodMultiWW",
    "Collage2HeartA5WoodRGB",
  ]) {
    const plan = builder.build({
      id: 9000,
      products: [
        {
          id: 1,
          sku,
          name: "Poster",
          properties: [
            { name: "_tib_design_link_1", value: "https://example.com/poster.pdf" },
            { name: "Текст для гравіювання", value: "Текст гравіювання" },
          ],
        },
      ],
    });

    const engraving = plan.materials.find((m) => m.type === "engraving");
    assert.ok(engraving, `SKU ${sku}: engraving material expected`);
    assert.equal(engraving.format, "A4", `SKU ${sku}: engraving format must be A4`);
    assert.equal(engraving.text, "Текст гравіювання");

    const poster = plan.materials.find((m) => m.type === "poster");
    assert.ok(poster, `SKU ${sku}: poster material expected`);
    assert.equal(poster.format, "A5", `SKU ${sku}: poster format stays A5`);
  }
});

test("LayoutPlanBuilder keeps A5 engraving bounds for regular A5 SKUs", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 9001,
    products: [
      {
        id: 1,
        sku: "PhotoPosterA5Wood",
        name: "Poster",
        properties: [
          { name: "_tib_design_link_1", value: "https://example.com/poster.pdf" },
          { name: "Текст для гравіювання", value: "Звичайний текст" },
        ],
      },
    ],
  });

  const engraving = plan.materials.find((m) => m.type === "engraving");
  assert.ok(engraving, "engraving material expected");
  assert.equal(engraving.format, "A5", "regular A5 SKU keeps A5 engraving format");
});

test("LayoutPlanBuilder engraving filename code uses poster format regardless of A4 bounds override", async () => {
  const rules = await loadProductCodeRules(rulesPath);
  const builder = new LayoutPlanBuilder(rules);

  const plan = builder.build({
    id: 9002,
    products: [
      {
        id: 1,
        sku: "TextcollageA5WoodWW",
        name: "Poster",
        properties: [
          { name: "_tib_design_link_1", value: "https://example.com/poster.pdf" },
          { name: "Текст для гравіювання", value: "Мій текст" },
        ],
      },
    ],
  });

  const engraving = plan.materials.find((m) => m.type === "engraving");
  assert.ok(engraving, "engraving material expected");
  assert.equal(engraving.format, "A4", "engraving zone uses A4 bounds");
  assert.match(engraving.filename, /CGU_A5WW_G_/, "filename code still uses A5 format prefix");
});
