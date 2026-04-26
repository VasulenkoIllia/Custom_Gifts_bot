import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/load-config";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "load-config-test-"));
}

test("loadConfig loads high-detail SKU routing file and normalizes entries", () => {
  const tempDir = createTempDir();
  try {
    const skuPath = path.join(tempDir, "high-detail-skus.json");
    fs.writeFileSync(skuPath, JSON.stringify(["StarTranspA5Wood", " StarTranspA5Wood ", "", "MapTrHeartA4Wood"]));

    const config = loadConfig({
      PDF_HIGH_DETAIL_SKUS_PATH: skuPath,
    });

    assert.deepEqual(config.pdfHighDetailSkus, ["StarTranspA5Wood", "MapTrHeartA4Wood"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig fails fast when high-detail SKU routing file is missing", () => {
  assert.throws(
    () =>
      loadConfig({
        PDF_HIGH_DETAIL_SKUS_PATH: path.join(os.tmpdir(), "missing-high-detail-skus.json"),
      }),
    /PDF_HIGH_DETAIL_SKUS_PATH is invalid/,
  );
});

test("loadConfig fails fast when high-detail SKU routing file is malformed", () => {
  const tempDir = createTempDir();
  try {
    const skuPath = path.join(tempDir, "high-detail-skus.json");
    fs.writeFileSync(skuPath, JSON.stringify({ sku: "StarTranspA5Wood" }));

    assert.throws(
      () =>
        loadConfig({
          PDF_HIGH_DETAIL_SKUS_PATH: skuPath,
        }),
      /expected a JSON array/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
