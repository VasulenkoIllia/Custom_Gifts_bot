import assert from "node:assert/strict";
import test from "node:test";
import type { ReactionStatusRules } from "../src/modules/reactions/reaction-status-rules";
import { createReactionIntakeWorker } from "../src/workers/reaction-intake-worker";

function createNoopLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

test("reaction worker applies monotonic status transitions by emoji stages", async () => {
  const statusUpdates: Array<{ orderId: string; statusId: number }> = [];
  const forwardCalls: Array<{
    orderId: string;
    stageCode: string;
    sourceMessages: Array<{ chatId: string; messageId: number }>;
  }> = [];
  const orderByMessage = new Map<string, string>();
  const orderState = new Map<
    string,
    { highestStageIndex: number; appliedStatusId: number; lastHeartCount: number }
  >();

  orderByMessage.set("-100:10", "3003");

  const worker = createReactionIntakeWorker({
    logger: createNoopLogger(),
    crmClient: {
      updateOrderStatus: async (orderId: string, statusId: number) => {
        statusUpdates.push({ orderId, statusId });
        return { id: Number(orderId), status_id: statusId };
      },
    },
    messageMapStore: {
      getOrderIdByMessage: async (chatId: string, messageId: number) =>
        orderByMessage.get(`${chatId}:${messageId}`) ?? null,
      listMessagesByOrder: async () => [
        { chatId: "-100", messageId: 10 },
        { chatId: "-100", messageId: 11 },
      ],
      markMessageHeartCount: async () => undefined,
      getOrderState: async (orderId: string) => {
        const state = orderState.get(orderId);
        return state
          ? {
              orderId,
              highestStageIndex: state.highestStageIndex,
              appliedStatusId: state.appliedStatusId,
              updatedAt: new Date().toISOString(),
              lastHeartCount: state.lastHeartCount,
            }
          : null;
      },
      upsertOrderState: async (params: {
        orderId: string;
        highestStageIndex: number;
        appliedStatusId: number;
        lastHeartCount: number;
      }) => {
        orderState.set(params.orderId, {
          highestStageIndex: params.highestStageIndex,
          appliedStatusId: params.appliedStatusId,
          lastHeartCount: params.lastHeartCount,
        });
        return {
          orderId: params.orderId,
          highestStageIndex: params.highestStageIndex,
          appliedStatusId: params.appliedStatusId,
          updatedAt: new Date().toISOString(),
          lastHeartCount: params.lastHeartCount,
        };
      },
    },
    telegramForwardingService: {
      forwardOrderMaterials: async (params) => {
        forwardCalls.push({
          orderId: params.orderId,
          stageCode: params.stageCode,
          sourceMessages: params.sourceMessages,
        });
        return {
          targetChatId: "-200",
          targetThreadId: "55",
          forwardedMessageIds: [701, 702],
          forwardedCount: 2,
          skippedCount: 0,
          modeCounts: {
            copy: 2,
            forward: 0,
          },
        };
      },
    },
    reactionRules: {
      materialsStatusId: 20,
      missingFileStatusId: 40,
      missingTelegramStatusId: 59,
      allowedEmojis: ["❤️", "❤", "♥️", "♥", "👍"],
      rollback: "ignore",
      stages: [
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
          enabled: true,
        },
      ],
    } satisfies ReactionStatusRules,
  });

  await worker({
    id: "r1",
    key: "k1",
    status: "queued",
    attempt: 1,
    maxAttempts: 2,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    payload: {
      updateId: 1,
      chatId: "-100",
      messageId: 10,
      emojiCounts: { "❤️": 1 },
      receivedAt: new Date().toISOString(),
    },
  });

  await worker({
    id: "r2",
    key: "k2",
    status: "queued",
    attempt: 1,
    maxAttempts: 2,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    payload: {
      updateId: 2,
      chatId: "-100",
      messageId: 10,
      emojiCounts: { "👍": 1 },
      receivedAt: new Date().toISOString(),
    },
  });

  await worker({
    id: "r3",
    key: "k3",
    status: "queued",
    attempt: 1,
    maxAttempts: 2,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    payload: {
      updateId: 3,
      chatId: "-100",
      messageId: 10,
      emojiCounts: { "❤️": 1 },
      receivedAt: new Date().toISOString(),
    },
  });

  assert.deepEqual(statusUpdates, [
    { orderId: "3003", statusId: 22 },
    { orderId: "3003", statusId: 7 },
  ]);
  assert.deepEqual(forwardCalls, [
    {
      orderId: "3003",
      stageCode: "PRINT",
      sourceMessages: [
        { chatId: "-100", messageId: 10 },
        { chatId: "-100", messageId: 11 },
      ],
    },
  ]);
});

test("reaction worker wraps CRM errors as retryable processing error", async () => {
  const worker = createReactionIntakeWorker({
    logger: createNoopLogger(),
    crmClient: {
      updateOrderStatus: async () => {
        const error = new Error("fetch failed: timeout");
        (error as Error & { code?: string }).code = "ETIMEDOUT";
        throw error;
      },
    },
    messageMapStore: {
      getOrderIdByMessage: async () => "3004",
      listMessagesByOrder: async () => [{ chatId: "-100", messageId: 11 }],
      markMessageHeartCount: async () => undefined,
      getOrderState: async () => null,
      upsertOrderState: async () => ({
        orderId: "3004",
        highestStageIndex: 0,
        appliedStatusId: 22,
        updatedAt: new Date().toISOString(),
        lastHeartCount: 1,
      }),
    },
    telegramForwardingService: {
      forwardOrderMaterials: async () => ({
        targetChatId: "-200",
        targetThreadId: "",
        forwardedMessageIds: [901],
        forwardedCount: 1,
        skippedCount: 0,
        modeCounts: {
          copy: 1,
          forward: 0,
        },
      }),
    },
    reactionRules: {
      materialsStatusId: 20,
      missingFileStatusId: 40,
      missingTelegramStatusId: 59,
      allowedEmojis: ["❤️"],
      rollback: "ignore",
      stages: [
        {
          code: "PRINT",
          emoji: "❤️",
          emojiAliases: [],
          countThreshold: 1,
          statusId: 22,
          enabled: true,
        },
      ],
    } satisfies ReactionStatusRules,
  });

  await assert.rejects(
    async () =>
      worker({
        id: "r4",
        key: "k4",
        status: "queued",
        attempt: 1,
        maxAttempts: 2,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        payload: {
          updateId: 4,
          chatId: "-100",
          messageId: 11,
          emojiCounts: { "❤️": 1 },
          receivedAt: new Date().toISOString(),
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "ReactionProcessingError");
      assert.equal((error as { retryable?: unknown }).retryable, true);
      assert.equal((error as { failureKind?: unknown }).failureKind, "reaction_processing");
      return true;
    },
  );
});
