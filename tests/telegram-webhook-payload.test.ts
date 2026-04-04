import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTelegramUpdates } from "../src/modules/webhook/telegram-webhook-payload";

test("normalizeTelegramUpdates ignores non-reaction Telegram updates", () => {
  const payload = {
    ok: true,
    result: [
      {
        update_id: 1001,
        message: {
          message_id: 6,
          chat: { id: -1003710886298 },
          text: "/start",
        },
      },
      {
        update_id: 1002,
        message_reaction_count: {
          chat: { id: -1003710886298 },
          message_id: 42,
          reactions: [{ type: { type: "emoji", emoji: "❤️" }, total_count: 1 }],
        },
      },
    ],
  };

  const updates = normalizeTelegramUpdates(payload, ["❤️"]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.updateId, 1002);
  assert.equal(updates[0]?.chatId, "-1003710886298");
  assert.equal(updates[0]?.messageId, 42);
  assert.equal(updates[0]?.heartCount, 1);
});

test("normalizeTelegramUpdates accepts direct message_reaction updates for tracked emojis", () => {
  const payload = {
    ok: true,
    result: [
      {
        update_id: 2002,
        message_reaction: {
          chat: { id: -1003710886298 },
          message_id: 77,
          old_reaction: [],
          new_reaction: [{ type: "emoji", emoji: "❤️" }],
        },
      },
    ],
  };

  const updates = normalizeTelegramUpdates(payload, ["❤️", "👍"]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.updateId, 2002);
  assert.equal(updates[0]?.chatId, "-1003710886298");
  assert.equal(updates[0]?.messageId, 77);
  assert.deepEqual(updates[0]?.emojiCounts, { "❤️": 1 });
  assert.equal(updates[0]?.heartCount, 1);
});

test("normalizeTelegramUpdates keeps direct reaction removals with zero tracked counts", () => {
  const payload = {
    ok: true,
    result: [
      {
        update_id: 2003,
        message_reaction: {
          chat: { id: -1003710886298 },
          message_id: 78,
          old_reaction: [{ type: "emoji", emoji: "❤️" }],
          new_reaction: [],
        },
      },
    ],
  };

  const updates = normalizeTelegramUpdates(payload, ["❤️", "👍"]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.updateId, 2003);
  assert.equal(updates[0]?.chatId, "-1003710886298");
  assert.equal(updates[0]?.messageId, 78);
  assert.deepEqual(updates[0]?.emojiCounts, {});
  assert.equal(updates[0]?.heartCount, 0);
});
