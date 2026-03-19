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

test("reaction worker applies monotonic status transitions by heart count", async () => {
  const statusUpdates: Array<{ orderId: string; statusId: number }> = [];
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
    reactionRules: {
      materialsStatusId: 20,
      rollback: "ignore",
      stages: [
        { heartCount: 1, statusId: 22, code: "PRINT" },
        { heartCount: 2, statusId: 7, code: "PACKING" },
      ],
    } satisfies ReactionStatusRules,
  });

  await worker({
    id: "r1",
    key: "k1",
    status: "queued",
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    payload: {
      updateId: 1,
      chatId: "-100",
      messageId: 10,
      heartCount: 1,
      receivedAt: new Date().toISOString(),
    },
  });

  await worker({
    id: "r2",
    key: "k2",
    status: "queued",
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    payload: {
      updateId: 2,
      chatId: "-100",
      messageId: 10,
      heartCount: 2,
      receivedAt: new Date().toISOString(),
    },
  });

  await worker({
    id: "r3",
    key: "k3",
    status: "queued",
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    payload: {
      updateId: 3,
      chatId: "-100",
      messageId: 10,
      heartCount: 1,
      receivedAt: new Date().toISOString(),
    },
  });

  assert.deepEqual(statusUpdates, [
    { orderId: "3003", statusId: 22 },
    { orderId: "3003", statusId: 7 },
  ]);
});
