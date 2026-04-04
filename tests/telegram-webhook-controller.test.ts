import assert from "node:assert/strict";
import test from "node:test";
import { TelegramWebhookController } from "../src/modules/webhook/telegram-webhook.controller";

function createHeaders(secret: string): Record<string, string> {
  return {
    "x-telegram-bot-api-secret-token": secret,
  };
}

function createLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

test("TelegramWebhookController deduplicates burst updates by stage bucket", async () => {
  const seen = new Set<string>();
  const queue = {
    enqueue: ({ key }: { key: string }) => {
      const deduplicated = seen.has(key);
      if (!deduplicated) {
        seen.add(key);
      }
      return {
        jobId: `job:${key}`,
        deduplicated,
        queue: {
          name: "reaction_intake",
          concurrency: 1,
          maxQueueSize: 100,
          pending: 0,
          running: 0,
          inflightKeys: seen.size,
        },
      };
    },
    getStats: () => ({
      name: "reaction_intake",
      concurrency: 1,
      maxQueueSize: 100,
      pending: 0,
      running: 0,
      inflightKeys: seen.size,
    }),
  };

  const controller = new TelegramWebhookController({
    logger: createLogger(),
    reactionQueue: queue as never,
    webhookSecret: "secret",
    trackedEmojis: ["❤️", "❤", "♥️", "♥", "👍"],
    reactionStages: [
      {
        code: "PRINT",
        emoji: "❤️",
        emojiAliases: ["❤", "♥️", "♥"],
        countThreshold: 1,
        statusId: 22,
        enabled: true,
      },
      {
        code: "PACKING",
        emoji: "👍",
        emojiAliases: [],
        countThreshold: 1,
        statusId: 7,
        enabled: false,
      },
    ],
  });

  const result = await controller.handle({
    headers: createHeaders("secret"),
    requestId: "req-1",
    payload: [
      {
        update_id: 1,
        message_reaction_count: {
          chat: { id: "-100" },
          message_id: 42,
          reactions: [{ type: { type: "emoji", emoji: "❤️" }, total_count: 1 }],
        },
      },
      {
        update_id: 2,
        message_reaction_count: {
          chat: { id: "-100" },
          message_id: 42,
          reactions: [{ type: { type: "emoji", emoji: "❤️" }, total_count: 1 }],
        },
      },
      {
        update_id: 3,
        message_reaction_count: {
          chat: { id: "-100" },
          message_id: 42,
          reactions: [{ type: { type: "emoji", emoji: "👍" }, total_count: 1 }],
        },
      },
    ],
  });

  assert.equal(result.statusCode, 202);
  assert.equal(Number(result.body.enqueued ?? 0), 2);
  assert.equal(Number(result.body.deduplicated ?? 0), 1);
});
