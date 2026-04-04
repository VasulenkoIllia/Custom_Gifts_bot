import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadQrRules, resolveQrCodeDecision } from "../src/modules/qr/qr-rules";

const rulesPath = path.resolve(process.cwd(), "config/business-rules/qr-rules.json");

test("resolveQrCodeDecision returns spotify_code for spotify link and spotify SKU", async () => {
  const rules = await loadQrRules(rulesPath);
  const decision = resolveQrCodeDecision({
    rules,
    sku: "SpotifyA5Wood",
    format: "A5",
    qrRequested: true,
    qrValid: true,
    qrUrl: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
  });

  assert.equal(decision.strategy, "spotify_code");
  assert.equal(decision.profileId, "spotify");
  assert.equal(decision.spotifyPlacement?.mode, "bottom_center");
});

test("resolveQrCodeDecision returns regular qr for spotify profile with non-spotify link", async () => {
  const rules = await loadQrRules(rulesPath);
  const decision = resolveQrCodeDecision({
    rules,
    sku: "SpotifyA4Wood",
    format: "A4",
    qrRequested: true,
    qrValid: true,
    qrUrl: "https://example.com/page",
  });

  assert.equal(decision.strategy, "qr");
  assert.equal(decision.profileId, "spotify");
  assert.equal(decision.qrPlacementByFormat?.A4.widthMm, 30);
});

test("resolveQrCodeDecision disables code for non-whitelisted sku", async () => {
  const rules = await loadQrRules(rulesPath);
  const decision = resolveQrCodeDecision({
    rules,
    sku: "UnknownA5Wood",
    format: "A5",
    qrRequested: true,
    qrValid: true,
    qrUrl: "https://example.com/page",
  });

  assert.equal(decision.strategy, "none");
  assert.equal(decision.reason, "sku_not_whitelisted");
});

test("resolveQrCodeDecision disables code for invalid url", async () => {
  const rules = await loadQrRules(rulesPath);
  const decision = resolveQrCodeDecision({
    rules,
    sku: "TelegramA5Wood",
    format: "A5",
    qrRequested: true,
    qrValid: false,
    qrUrl: null,
  });

  assert.equal(decision.strategy, "none");
  assert.equal(decision.reason, "qr_url_invalid");
});

test("loadQrRules fails when no valid profiles exist", async () => {
  const tempPath = path.resolve(process.cwd(), "storage/temp/tests/qr-rules/empty.json");
  await fs.mkdir(path.dirname(tempPath), { recursive: true });
  await fs.writeFile(tempPath, JSON.stringify({ profiles: [] }), "utf8");

  await assert.rejects(async () => loadQrRules(tempPath), /at least one valid profile/i);
});

test("loadQrRules fails on duplicate SKU between profiles", async () => {
  const tempPath = path.resolve(process.cwd(), "storage/temp/tests/qr-rules/duplicate-sku.json");
  await fs.mkdir(path.dirname(tempPath), { recursive: true });
  await fs.writeFile(
    tempPath,
    JSON.stringify({
      profiles: [
        {
          id: "p1",
          skus: ["SKU_DUP"],
          qrPlacementByFormat: {
            A5: { mode: "right_bottom", widthMm: 20, heightMm: 20, rightMm: 10, bottomMm: 10 },
            A4: { mode: "right_bottom", widthMm: 30, heightMm: 30, rightMm: 15, bottomMm: 15 },
          },
        },
        {
          id: "p2",
          skus: ["SKU_DUP"],
          qrPlacementByFormat: {
            A5: { mode: "right_bottom", widthMm: 20, heightMm: 20, rightMm: 10, bottomMm: 10 },
            A4: { mode: "right_bottom", widthMm: 30, heightMm: 30, rightMm: 15, bottomMm: 15 },
          },
        },
      ],
    }),
    "utf8",
  );

  await assert.rejects(async () => loadQrRules(tempPath), /assigned to multiple profiles/i);
});
