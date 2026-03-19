import assert from "node:assert/strict";
import test from "node:test";
import { CrmClient } from "../src/modules/crm/crm-client";
import type { Logger } from "../src/observability/logger";

function createNoopLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

test("CrmClient.getOrder unwraps data envelope", async () => {
  const originalFetch = globalThis.fetch;

  let calledUrl = "";
  globalThis.fetch = async (input) => {
    calledUrl = String(input);
    return new Response(JSON.stringify({ data: { id: 777, products: [] } }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  };

  try {
    const client = new CrmClient({
      apiBase: "https://openapi.keycrm.app/v1",
      token: "token",
      orderInclude: ["products.offer", "status"],
      requestTimeoutMs: 5000,
      retries: 0,
      retryBaseMs: 100,
      logger: createNoopLogger(),
    });

    const order = await client.getOrder("777");

    assert.equal(order.id, 777);
    assert.ok(calledUrl.includes("/order/777"));
    assert.ok(calledUrl.includes("include=products.offer%2Cstatus"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CrmClient.updateOrderStatus sends PUT with status_id", async () => {
  const originalFetch = globalThis.fetch;

  let calledMethod = "";
  let calledBody = "";

  globalThis.fetch = async (_input, init) => {
    calledMethod = String(init?.method ?? "");
    calledBody = String(init?.body ?? "");

    return new Response(JSON.stringify({ data: { id: 888, status_id: 22 } }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  };

  try {
    const client = new CrmClient({
      apiBase: "https://openapi.keycrm.app/v1",
      token: "token",
      orderInclude: ["products.offer"],
      requestTimeoutMs: 5000,
      retries: 0,
      retryBaseMs: 100,
      logger: createNoopLogger(),
    });

    const order = await client.updateOrderStatus("888", 22);

    assert.equal(order.id, 888);
    assert.equal(order.status_id, 22);
    assert.equal(calledMethod, "PUT");
    assert.equal(calledBody, JSON.stringify({ status_id: 22 }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
