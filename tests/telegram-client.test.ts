import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildPreviewCaption,
  sendOrderFilesToTelegram,
} from "../src/modules/telegram/telegram-client";

test("buildPreviewCaption includes engraving and sticker text when present", () => {
  const caption = buildPreviewCaption({
    orderId: "29068",
    previewDetails: {
      engravingTexts: ["25.05.25", "Найкращому татові"],
      stickerTexts: ["Любимо тебе"],
    },
  });

  assert.match(caption, /^Замовлення 29068\nПрев'ю макету/);
  assert.match(caption, /\nГравіювання:\n- 25\.05\.25\n- Найкращому татові/);
  assert.match(caption, /\nСтікер:\n- Любимо тебе/);
});

test("sendOrderFilesToTelegram keeps preview ids separate from file message ids", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-client-test-"));
  const pdfPath = path.join(tempDir, "CGU_AA5_29403_1_1.pdf");
  await fs.writeFile(pdfPath, Buffer.from("%PDF-1.4\n% test\n"));

  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let previewCaption = "";
  let fileCaption = "";

  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const urlString = String(url);
    calls.push(urlString);

    if (urlString.includes("/sendPhoto")) {
      const form = init?.body;
      if (form instanceof FormData) {
        previewCaption = String(form.get("caption") ?? "");
      }
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 700 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (urlString.includes("/sendDocument")) {
      const form = init?.body;
      if (form instanceof FormData) {
        fileCaption = String(form.get("caption") ?? "");
      }
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 701 },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    throw new Error(`Unexpected fetch URL: ${urlString}`);
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await sendOrderFilesToTelegram({
    botToken: "token",
    chatId: "-100123",
    messageThreadId: "456",
    orderId: "29403",
    flags: [],
    warnings: [],
    qrUrl: null,
    previewImages: ["https://example.com/preview.jpg"],
    previewDetails: {
      engravingTexts: ["23.06.1999"],
      stickerTexts: ["Cancer"],
    },
    generatedFiles: [
      {
        filename: "CGU_AA5_29403_1_1.pdf",
        path: pdfPath,
      },
    ],
  });

  assert.deepEqual(calls.length, 2);
  assert.deepEqual(result.preview_message_ids, [700]);
  assert.deepEqual(result.message_ids, [701]);
  assert.equal(result.preview_count, 1);
  assert.equal(result.message_count, 1);
  assert.match(previewCaption, /\nГравіювання:\n- 23\.06\.1999/);
  assert.match(previewCaption, /\nСтікер:\n- Cancer/);
  assert.doesNotMatch(fileCaption, /Гравіювання|Стікер/);
});
