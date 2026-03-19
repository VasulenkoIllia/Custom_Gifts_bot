import assert from "node:assert/strict";
import test from "node:test";
import { OpsAlertService } from "../src/modules/alerts/ops-alert.service";

test("OpsAlertService returns disabled state without chat/token", async () => {
  const service = new OpsAlertService({
    botToken: "",
    chatId: "",
    messageThreadId: "",
    timeoutMs: 1000,
    retries: 0,
    retryBaseMs: 100,
    dedupeWindowMs: 1000,
  });

  const result = await service.send({
    level: "warning",
    module: "test",
    title: "disabled",
  });
  assert.equal(result.sent, false);
  assert.equal(result.deduplicated, false);
});

test("OpsAlertService deduplicates repeated alerts in window", async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;

  global.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  }) as typeof fetch;

  try {
    const service = new OpsAlertService({
      botToken: "token",
      chatId: "-100",
      messageThreadId: "",
      timeoutMs: 1000,
      retries: 0,
      retryBaseMs: 100,
      dedupeWindowMs: 60_000,
    });

    const first = await service.send({
      level: "error",
      module: "queue",
      title: "dlq",
      dedupeKey: "k1",
    });
    const second = await service.send({
      level: "error",
      module: "queue",
      title: "dlq",
      dedupeKey: "k1",
    });

    assert.equal(first.sent, true);
    assert.equal(first.deduplicated, false);
    assert.equal(second.sent, false);
    assert.equal(second.deduplicated, true);
    assert.equal(fetchCalls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
