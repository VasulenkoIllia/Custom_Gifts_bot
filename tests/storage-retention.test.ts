import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { StorageRetentionService } from "../src/modules/storage/storage-retention.service";

function noopLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

async function touchWithAge(filePath: string, ageMs: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "x", "utf8");
  const timestamp = new Date(Date.now() - ageMs);
  await fs.utimes(filePath, timestamp, timestamp);
  await fs.utimes(path.dirname(filePath), timestamp, timestamp);
}

test("StorageRetentionService removes stale children and keeps fresh files", async () => {
  const root = path.resolve(process.cwd(), "storage/temp/tests/retention");
  const outputDir = path.join(root, "output");
  const tempDir = path.join(root, "temp");
  await fs.rm(root, { recursive: true, force: true });

  const oldAge = 5 * 60 * 60 * 1000;
  const freshAge = 10 * 60 * 1000;

  await touchWithAge(path.join(outputDir, "old/order.pdf"), oldAge);
  await touchWithAge(path.join(outputDir, "fresh/order.pdf"), freshAge);
  await touchWithAge(path.join(tempDir, "old/tmp.bin"), oldAge);
  await touchWithAge(path.join(tempDir, "fresh/tmp.bin"), freshAge);

  const service = new StorageRetentionService({
    logger: noopLogger(),
    outputDir,
    tempDir,
    outputRetentionHours: 1,
    tempRetentionHours: 1,
    cleanupIntervalMs: 60_000,
  });

  await service.runOnce();

  const oldOutputExists = await fs
    .access(path.join(outputDir, "old"))
    .then(() => true)
    .catch(() => false);
  const freshOutputExists = await fs
    .access(path.join(outputDir, "fresh/order.pdf"))
    .then(() => true)
    .catch(() => false);
  const oldTempExists = await fs
    .access(path.join(tempDir, "old"))
    .then(() => true)
    .catch(() => false);
  const freshTempExists = await fs
    .access(path.join(tempDir, "fresh/tmp.bin"))
    .then(() => true)
    .catch(() => false);

  assert.equal(oldOutputExists, false);
  assert.equal(oldTempExists, false);
  assert.equal(freshOutputExists, true);
  assert.equal(freshTempExists, true);
});
