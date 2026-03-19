import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileIdempotencyStore } from "../src/modules/orders/order-idempotency";

test("FileIdempotencyStore reserve deduplicates and persists", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cgu-idempotency-"));
  const filePath = path.join(tempDir, "order-webhooks.json");

  const store = new FileIdempotencyStore(filePath);
  await store.init();

  const first = await store.reserve("keycrm:order:1");
  const second = await store.reserve("keycrm:order:1");

  assert.equal(first.created, true);
  assert.equal(second.created, false);

  const size = await store.size();
  assert.equal(size, 1);

  const reloaded = new FileIdempotencyStore(filePath);
  await reloaded.init();
  const third = await reloaded.reserve("keycrm:order:1");
  assert.equal(third.created, false);

  await fs.rm(tempDir, { recursive: true, force: true });
});
