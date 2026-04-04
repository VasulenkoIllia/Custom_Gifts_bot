import assert from "node:assert/strict";
import test from "node:test";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const telegramClientRuntime = require("../src/modules/telegram/telegram-client.runtime.js") as {
  buildCaption: (input: {
    orderId: string;
    fileNames: string[];
    flags: string[];
    warnings: string[];
    qrUrl: string | null;
  }) => string;
};

test("telegram runtime buildCaption puts warnings first and hides QR link when absent", () => {
  const caption = telegramClientRuntime.buildCaption({
    orderId: "555",
    fileNames: ["CGU_AA5_555_1_1.pdf"],
    flags: ["QR +"],
    warnings: ["🚨 QR не згенеровано", "⚠️ Preview warning: 404"],
    qrUrl: null,
  });

  assert.match(caption, /^Попередження:\n🚨 QR не згенеровано\n⚠️ Preview warning: 404/);
  assert.doesNotMatch(caption, /Посилання QR:/);
  assert.doesNotMatch(caption, /\nПримітки:\n🚨 QR не згенеровано/);
});

test("telegram runtime buildCaption adds green check when no warnings exist", () => {
  const caption = telegramClientRuntime.buildCaption({
    orderId: "556",
    fileNames: ["CGU_AA5_556_1_1.pdf"],
    flags: [],
    warnings: [],
    qrUrl: null,
  });

  assert.match(caption, /^✅ Замовлення 556/);
});

test("telegram runtime buildCaption highlights manual A6 and keychain flags", () => {
  const caption = telegramClientRuntime.buildCaption({
    orderId: "557",
    fileNames: ["CGU_AA5_557_1_3.pdf"],
    flags: ["QR +", "A6 +", "B +"],
    warnings: [],
    qrUrl: null,
  });

  assert.match(caption, /\n📌 QR \+\n📌 A6 \+\n📌 B \+/);
});
