"use strict";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function computeBackoffDelayMs(attempt, baseDelayMs, maxDelayMs = 20_000) {
  const safeAttempt = Math.max(1, attempt);
  const cappedExp = Math.min(8, safeAttempt - 1);
  const exponential = baseDelayMs * (2 ** cappedExp);
  const jitter = Math.floor(Math.random() * Math.min(1_000, baseDelayMs));
  return Math.min(maxDelayMs, exponential + jitter);
}

function isRetryableStatusCode(statusCode) {
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function isRetryableFetchError(error) {
  if (!error) {
    return false;
  }
  if (error.name === "AbortError") {
    return true;
  }
  const message = String(error.message ?? "");
  return /fetch failed|network|timeout|socket|econnreset|etimedout|enotfound|eai_again/i.test(message);
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(String(value ?? ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function parseRetryAfterMs(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const seconds = Number.parseInt(String(value).trim(), 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const asDate = Date.parse(String(value));
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }

  return null;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWithRetry(url, options, { timeoutMs, retries, retryBaseMs }) {
  const maxAttempts = retries + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (response.ok || attempt >= maxAttempts || !isRetryableStatusCode(response.status)) {
        return response;
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const delayMs = retryAfterMs ?? computeBackoffDelayMs(attempt, retryBaseMs);
      await sleep(delayMs);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableFetchError(error)) {
        throw error;
      }
      const delayMs = computeBackoffDelayMs(attempt, retryBaseMs);
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("HTTP request failed.");
}

async function shortenWithTinyUrl(url, requestOptions) {
  const endpoint = `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`;
  const response = await fetchWithRetry(
    endpoint,
    {
      method: "GET",
      headers: {
        Accept: "text/plain",
      },
    },
    requestOptions,
  );

  const body = (await response.text()).trim();
  if (!response.ok) {
    throw new Error(`TinyURL API error (${response.status}): ${body.slice(0, 200)}`);
  }

  if (!isValidHttpUrl(body)) {
    throw new Error(`TinyURL returned invalid URL: ${body.slice(0, 200)}`);
  }

  return body;
}

async function shortenWithIsGd(url, requestOptions) {
  const endpoint = `https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`;
  const response = await fetchWithRetry(
    endpoint,
    {
      method: "GET",
      headers: {
        Accept: "text/plain",
      },
    },
    requestOptions,
  );

  const body = (await response.text()).trim();
  if (!response.ok) {
    throw new Error(`is.gd API error (${response.status}): ${body.slice(0, 200)}`);
  }

  if (!isValidHttpUrl(body)) {
    throw new Error(`is.gd returned invalid URL: ${body.slice(0, 200)}`);
  }

  return body;
}

function describeCuttlyStatus(status) {
  switch (status) {
    case 1:
      return "URL is already shortened.";
    case 2:
      return "Input is not a valid URL.";
    case 3:
      return "Preferred alias is already taken.";
    case 4:
      return "Invalid Cuttly API key.";
    case 5:
      return "URL failed validation.";
    case 6:
      return "URL domain is blocked.";
    case 7:
      return "OK";
    case 8:
      return "Cuttly monthly limit reached.";
    default:
      return "Unknown Cuttly status.";
  }
}

async function shortenWithCuttly(url, apiKey, requestOptions) {
  if (!apiKey) {
    throw new Error("CUTTLY_API_KEY is not configured.");
  }

  const endpoint = new URL("https://cutt.ly/api/api.php");
  endpoint.searchParams.set("key", apiKey);
  endpoint.searchParams.set("short", url);

  const response = await fetchWithRetry(
    endpoint,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    },
    requestOptions,
  );

  const bodyText = await response.text();
  let payload;
  try {
    payload = bodyText ? JSON.parse(bodyText) : null;
  } catch (_error) {
    throw new Error(`Cuttly returned non-JSON response: ${bodyText.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(`Cuttly API error (${response.status}): ${bodyText.slice(0, 200)}`);
  }

  const data = payload?.url;
  const status = Number(data?.status);
  const shortLink = String(data?.shortLink ?? "").trim();

  if (status === 7 && isValidHttpUrl(shortLink)) {
    return shortLink;
  }

  if (status === 1) {
    if (isValidHttpUrl(shortLink)) {
      return shortLink;
    }
    if (isValidHttpUrl(url)) {
      return url;
    }
  }

  throw new Error(`Cuttly shortening failed (${status}): ${describeCuttlyStatus(status)}`);
}

async function shortenUrl(
  url,
  {
    provider = "cuttly",
    timeoutMs = 7000,
    retries = 2,
    retryBaseMs = 500,
    cuttlyApiKey = "",
  } = {},
) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is unavailable. Use Node.js 18+.");
  }

  if (!isValidHttpUrl(url)) {
    throw new Error("Input URL is invalid.");
  }

  const requestOptions = {
    timeoutMs: Number.isFinite(Number(timeoutMs)) ? Math.max(1_000, Number(timeoutMs)) : 7000,
    retries: Number.isFinite(Number(retries)) ? Math.max(0, Math.min(6, Number(retries))) : 2,
    retryBaseMs: Number.isFinite(Number(retryBaseMs))
      ? Math.max(100, Math.min(20_000, Number(retryBaseMs)))
      : 500,
  };

  const providerKey = String(provider ?? "cuttly").trim().toLowerCase();
  if (providerKey === "cuttly") {
    return shortenWithCuttly(url, cuttlyApiKey, requestOptions);
  }
  if (providerKey === "tinyurl") {
    return shortenWithTinyUrl(url, requestOptions);
  }
  if (providerKey === "isgd") {
    return shortenWithIsGd(url, requestOptions);
  }

  throw new Error(`Unsupported URL shortener provider: ${providerKey}`);
}

module.exports = {
  shortenUrl,
};
