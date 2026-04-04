import assert from "node:assert/strict";
import test from "node:test";
import {
  TelegramForwardingService,
  type ForwardingEventStore,
  type TelegramForwardingResult,
} from "../src/modules/telegram/telegram-forwarding.service";

function createInMemoryForwardingStore(): ForwardingEventStore {
  const rows = new Map<string, { sourceChatId: string; sourceMessageId: number }>();

  return {
    listForwardedSourceMessages: async (params) => {
      const prefix = [
        params.orderId,
        params.stageCode,
        params.targetChatId,
        params.targetThreadId,
      ].join(":");

      return Array.from(rows.entries())
        .filter(([key]) => key.startsWith(`${prefix}:`))
        .map(([, value]) => ({
          chatId: value.sourceChatId,
          messageId: value.sourceMessageId,
        }))
        .sort(
          (left, right) =>
            left.chatId.localeCompare(right.chatId) || left.messageId - right.messageId,
        );
    },
    recordForwardedMessage: async (params) => {
      const key = [
        params.orderId,
        params.stageCode,
        params.targetChatId,
        params.targetThreadId,
        params.sourceMessageId,
      ].join(":");

      rows.set(key, {
        sourceChatId: params.sourceChatId,
        sourceMessageId: params.sourceMessageId,
      });
    },
  };
}

test("TelegramForwardingService falls back from copy to forward and skips already forwarded messages", async () => {
  const store = createInMemoryForwardingStore();
  const originalFetch = global.fetch;
  const calls: Array<{ methodName: string; sourceMessageIds: number[] }> = [];
  let nextTargetMessageId = 900;

  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const methodName = url.split("/").pop() ?? "";
    const body = init?.body as FormData;
    const sourceMessageIds = JSON.parse(String(body.get("message_ids") ?? "[]")) as number[];
    calls.push({ methodName, sourceMessageIds });

    if (methodName === "copyMessages") {
      return new Response(
        JSON.stringify({
          ok: false,
          description: "copy disabled",
        }),
        { status: 400 },
      );
    }

    const result = sourceMessageIds.map(() => {
      nextTargetMessageId += 1;
      return { message_id: nextTargetMessageId };
    });
    return new Response(
      JSON.stringify({
        ok: true,
        result,
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const service = new TelegramForwardingService({
      botToken: "token",
      targetChatId: "-200",
      targetThreadId: "77",
      primaryMode: "copy",
      requestOptions: {
        timeoutMs: 1_000,
        retries: 0,
        retryBaseMs: 100,
      },
      eventStore: store,
    });

    const first = await service.forwardOrderMaterials({
      orderId: "4004",
      stageCode: "PRINT",
      sourceMessages: [
        { chatId: "-100", messageId: 10 },
        { chatId: "-100", messageId: 11 },
      ],
    });

    assert.equal(first.forwardedCount, 2);
    assert.equal(first.skippedCount, 0);
    assert.deepEqual(first.modeCounts, {
      copy: 0,
      forward: 2,
    });

    const second = await service.forwardOrderMaterials({
      orderId: "4004",
      stageCode: "PRINT",
      sourceMessages: [
        { chatId: "-100", messageId: 10 },
        { chatId: "-100", messageId: 11 },
      ],
    });

    assert.equal(second.forwardedCount, 0);
    assert.equal(second.skippedCount, 2);
    assert.deepEqual(calls, [
      { methodName: "copyMessages", sourceMessageIds: [10, 11] },
      { methodName: "forwardMessages", sourceMessageIds: [10, 11] },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("TelegramForwardingService reuses stored batch result when forwarding was already completed", async () => {
  const store = createInMemoryForwardingStore();
  const batchRows = new Map<string, { result: TelegramForwardingResult }>();
  const originalFetch = global.fetch;
  let fetchCalls = 0;

  global.fetch = (async () => {
    fetchCalls += 1;
    return new Response(
      JSON.stringify({
        ok: true,
        result: [{ message_id: 910 }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const service = new TelegramForwardingService({
      botToken: "token",
      targetChatId: "-200",
      targetThreadId: "",
      primaryMode: "forward",
      requestOptions: {
        timeoutMs: 1_000,
        retries: 0,
        retryBaseMs: 100,
      },
      eventStore: store,
      batchStore: {
        acquire: async (params) => {
          const existing = batchRows.get(params.batchKey);
          if (existing) {
            return {
              outcome: "sent",
              result: existing.result,
            };
          }
          return {
            outcome: "acquired",
          };
        },
        complete: async (_leaseOwner, params) => {
          batchRows.set(params.batchKey, {
            result: params.forwardedResult,
          });
        },
        release: async () => undefined,
      },
    });

    const first = await service.forwardOrderMaterials({
      orderId: "4005",
      stageCode: "PRINT",
      sourceMessages: [{ chatId: "-100", messageId: 15 }],
    });
    const second = await service.forwardOrderMaterials({
      orderId: "4005",
      stageCode: "PRINT",
      sourceMessages: [{ chatId: "-100", messageId: 15 }],
    });

    assert.equal(fetchCalls, 1);
    assert.deepEqual(second, first);
  } finally {
    global.fetch = originalFetch;
  }
});
