import assert from "node:assert/strict";
import test from "node:test";
import { normalizeKeycrmWebhook } from "../src/modules/webhook/keycrm-webhook-payload";

test("normalizeKeycrmWebhook extracts supported events and skips unsupported", () => {
  const payload = [
    {
      event: "order.change_order_status",
      context: {
        id: 28658,
        status_id: 20,
        status_changed_at: "2026-03-19T00:00:00Z",
        source_uuid: "abc",
      },
    },
    {
      event: "order.created",
      context: {
        id: 28659,
      },
    },
    {
      body: {
        event: "order.change_order_status",
        context: {
          id: 28660,
          status_id: 22,
          updated_at: "2026-03-19T01:00:00Z",
        },
      },
    },
  ];

  const result = normalizeKeycrmWebhook(payload);
  assert.equal(result.totalEvents, 3);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.skipped.length, 1);

  assert.equal(result.candidates[0]?.orderId, "28658");
  assert.equal(result.candidates[0]?.statusId, 20);
  assert.equal(result.candidates[1]?.orderId, "28660");

  const keyA = result.candidates[0]?.idempotencyKey;
  const keyB = result.candidates[1]?.idempotencyKey;
  assert.ok(keyA?.startsWith("keycrm:"));
  assert.ok(keyB?.startsWith("keycrm:"));
  assert.notEqual(keyA, keyB);
});
