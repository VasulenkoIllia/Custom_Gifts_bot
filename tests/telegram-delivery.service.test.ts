import assert from "node:assert/strict";
import test from "node:test";
import { TelegramDeliveryService } from "../src/modules/telegram/telegram-delivery.service";

test("TelegramDeliveryService throws when telegram runtime returns no file message ids", async () => {
  const service = new TelegramDeliveryService({
    botToken: "token",
    chatId: "-100",
    messageThreadId: "",
    requestOptions: {
      timeoutMs: 30_000,
      retries: 2,
      retryBaseMs: 900,
    },
    sender: async () => ({ chat_id: "-100", message_ids: [] }),
  });

  await assert.rejects(
    async () =>
      service.sendOrderMaterials({
        orderId: "1001",
        flags: [],
        warnings: [],
        qrUrl: null,
        previewImages: [],
        generatedFiles: [
          {
            type: "poster",
            filename: "CGU_AA5_1001_1_1.pdf",
            path: "/tmp/file.pdf",
            details: {},
          },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { retryable?: unknown }).retryable, true);
      return true;
    },
  );
});

test("TelegramDeliveryService propagates preview warnings from telegram runtime", async () => {
  const service = new TelegramDeliveryService({
    botToken: "token",
    chatId: "-100",
    messageThreadId: "",
    requestOptions: {
      timeoutMs: 30_000,
      retries: 2,
      retryBaseMs: 900,
    },
    sender: async () => ({
      chat_id: "-100123",
      message_ids: [501, "502"],
      preview_message_ids: ["500"],
      preview_errors: ["Preview image download failed (404)"],
      caption: "ok",
    }),
  });

  const result = await service.sendOrderMaterials({
    orderId: "1002",
    flags: [],
    warnings: [],
    qrUrl: null,
    previewImages: ["https://example.com/preview.jpg"],
    generatedFiles: [
      {
        type: "poster",
        filename: "CGU_AA5_1002_1_1.pdf",
        path: "/tmp/file2.pdf",
        details: {},
      },
    ],
  });

  assert.equal(result.chatId, "-100123");
  assert.deepEqual(result.messageIds, [501, 502]);
  assert.deepEqual(result.previewMessageIds, [500]);
  assert.deepEqual(result.warnings, ["⚠️ Preview warning: Preview image download failed (404)"]);
});

test("TelegramDeliveryService reuses stored delivery result without calling runtime sender twice", async () => {
  let senderCalls = 0;
  const deliveryRows = new Map<
    string,
    {
      status: "pending" | "sent";
      orderId: string;
      chatId: string;
      messageIds: number[];
      previewMessageIds: number[];
      caption: string;
      warnings: string[];
    }
  >();

  const service = new TelegramDeliveryService({
    botToken: "token",
    chatId: "-100",
    messageThreadId: "",
    requestOptions: {
      timeoutMs: 30_000,
      retries: 2,
      retryBaseMs: 900,
    },
    sender: async () => {
      senderCalls += 1;
      return {
        chat_id: "-100999",
        message_ids: [601],
        preview_message_ids: [600],
        caption: "cached",
      };
    },
    deliveryStore: {
      acquire: async (params) => {
        const row = deliveryRows.get(params.deliveryKey);
        if (!row) {
          deliveryRows.set(params.deliveryKey, {
            status: "pending",
            orderId: params.orderId,
            chatId: "",
            messageIds: [],
            previewMessageIds: [],
            caption: "",
            warnings: [],
          });
          return { outcome: "acquired" };
        }
        if (row.status === "sent") {
          return {
            outcome: "sent",
            record: {
              deliveryKey: params.deliveryKey,
              orderId: row.orderId,
              chatId: row.chatId,
              messageIds: row.messageIds,
              previewMessageIds: row.previewMessageIds,
              caption: row.caption,
              warnings: row.warnings,
            },
          };
        }
        return { outcome: "busy" };
      },
      complete: async (_leaseOwner, record) => {
        deliveryRows.set(record.deliveryKey, {
          status: "sent",
          orderId: record.orderId,
          chatId: record.chatId,
          messageIds: record.messageIds,
          previewMessageIds: record.previewMessageIds,
          caption: record.caption,
          warnings: record.warnings,
        });
      },
      release: async () => undefined,
    },
  });

  const input = {
    orderId: "1003",
    flags: [],
    warnings: [],
    qrUrl: null,
    previewImages: [],
    generatedFiles: [
      {
        type: "poster" as const,
        filename: "CGU_AA5_1003_1_1.pdf",
        path: "/tmp/file3.pdf",
        details: {},
      },
    ],
  };

  const first = await service.sendOrderMaterials(input);
  const second = await service.sendOrderMaterials(input);

  assert.equal(senderCalls, 1);
  assert.deepEqual(second, first);
});
