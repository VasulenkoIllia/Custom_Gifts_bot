import assert from "node:assert/strict";
import test from "node:test";
import { UrlShortenerService } from "../src/modules/url-shortener/shortener-service";

function createService(overrides: Partial<ConstructorParameters<typeof UrlShortenerService>[0]> = {}) {
  return new UrlShortenerService({
    timeoutMs: 2_000,
    retries: 0,
    retryBaseMs: 100,
    lnkUaBearerToken: "public",
    cuttlyApiKey: "cuttly-key",
    ...overrides,
  });
}

test("UrlShortenerService uses lnk.ua as primary provider", async () => {
  const originalFetch = global.fetch;
  const calls: Array<{ url: string; method: string }> = [];

  global.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: String(init?.method ?? "GET"),
    });

    assert.equal(url, "https://lnk.ua/api/v1/link/create");
    assert.equal(init?.headers instanceof Headers, false);
    assert.equal((init?.headers as Record<string, string>)?.Authorization, "Bearer public");

    return new Response(
      JSON.stringify({
        result: {
          lnk: "https://lnk.ua/test123",
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  };

  try {
    const result = await createService().shorten("https://example.com/very/long/link");

    assert.equal(result.url, "https://lnk.ua/test123");
    assert.equal(result.shortened, true);
    assert.equal(result.provider, "lnk_ua");
    assert.deepEqual(result.warnings, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "POST");
  } finally {
    global.fetch = originalFetch;
  }
});

test("UrlShortenerService falls back to cutt.ly when lnk.ua fails", async () => {
  const originalFetch = global.fetch;
  const calls: string[] = [];

  global.fetch = async (input) => {
    const url = String(input);
    calls.push(url);

    if (url === "https://lnk.ua/api/v1/link/create") {
      return new Response(JSON.stringify({ message: "service down" }), {
        status: 503,
        headers: {
          "content-type": "application/json",
        },
      });
    }

    assert.match(url, /^https:\/\/cutt\.ly\/api\/api\.php\?/);
    return new Response(
      JSON.stringify({
        url: {
          status: 7,
          shortLink: "https://cutt.ly/fallback",
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  };

  try {
    const result = await createService().shorten("https://example.com/fallback");

    assert.equal(result.url, "https://cutt.ly/fallback");
    assert.equal(result.provider, "cuttly");
    assert.equal(result.shortened, true);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? "", /shortener primary failed/);
    assert.deepEqual(calls, [
      "https://lnk.ua/api/v1/link/create",
      "https://cutt.ly/api/api.php?key=cuttly-key&short=https%3A%2F%2Fexample.com%2Ffallback",
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("UrlShortenerService keeps original URL when all providers fail", async () => {
  const originalFetch = global.fetch;

  global.fetch = async () =>
    new Response(JSON.stringify({ message: "down" }), {
      status: 503,
      headers: {
        "content-type": "application/json",
      },
    });

  try {
    const result = await createService({ cuttlyApiKey: "" }).shorten("https://example.com/original");

    assert.equal(result.url, "https://example.com/original");
    assert.equal(result.provider, "original");
    assert.equal(result.shortened, false);
    assert.equal(result.warnings.length, 3);
    assert.match(result.warnings[0] ?? "", /lnk\.ua/);
    assert.match(result.warnings[1] ?? "", /CUTTLY_API_KEY/);
    assert.match(result.warnings[2] ?? "", /оригінальне посилання/);
  } finally {
    global.fetch = originalFetch;
  }
});
