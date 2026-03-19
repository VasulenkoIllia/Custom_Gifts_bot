import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { TelegramMessageMapStore } from "../src/modules/telegram/telegram-message-map-store";

test("TelegramMessageMapStore links messages and resolves order id", async () => {
  const tempPath = path.resolve(
    process.cwd(),
    "storage/temp/tests/telegram-map/telegram-map-1.json",
  );
  await fs.rm(path.dirname(tempPath), { recursive: true, force: true });

  const store = new TelegramMessageMapStore(tempPath, 1000);
  await store.init();
  await store.linkMessages({
    orderId: "1001",
    chatId: "-100100",
    messageIds: [501, 502],
  });

  const by501 = await store.getOrderIdByMessage("-100100", 501);
  const by502 = await store.getOrderIdByMessage("-100100", 502);
  assert.equal(by501, "1001");
  assert.equal(by502, "1001");
});

test("TelegramMessageMapStore stores monotonic order workflow state", async () => {
  const tempPath = path.resolve(
    process.cwd(),
    "storage/temp/tests/telegram-map/telegram-map-2.json",
  );
  await fs.rm(path.dirname(tempPath), { recursive: true, force: true });

  const store = new TelegramMessageMapStore(tempPath, 1000);
  await store.init();

  await store.upsertOrderState({
    orderId: "2002",
    highestStageIndex: 0,
    appliedStatusId: 22,
    lastHeartCount: 1,
  });

  const first = await store.getOrderState("2002");
  assert.equal(first?.highestStageIndex, 0);
  assert.equal(first?.appliedStatusId, 22);

  await store.upsertOrderState({
    orderId: "2002",
    highestStageIndex: 1,
    appliedStatusId: 7,
    lastHeartCount: 2,
  });

  const second = await store.getOrderState("2002");
  assert.equal(second?.highestStageIndex, 1);
  assert.equal(second?.appliedStatusId, 7);
});
