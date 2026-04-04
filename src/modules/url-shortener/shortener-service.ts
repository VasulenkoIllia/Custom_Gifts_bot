type ShortenerProvider = "lnk_ua" | "cuttly";

type RequestOptions = {
  timeoutMs: number;
  retries: number;
  retryBaseMs: number;
};

export type UrlShortenerServiceParams = RequestOptions & {
  lnkUaBearerToken?: string;
  cuttlyApiKey?: string;
};

export type ShortenUrlResult = {
  originalUrl: string;
  url: string;
  shortened: boolean;
  provider: ShortenerProvider | "original";
  warnings: string[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function computeBackoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs = 20_000): number {
  const safeAttempt = Math.max(1, attempt);
  const cappedExp = Math.min(8, safeAttempt - 1);
  const exponential = baseDelayMs * (2 ** cappedExp);
  const jitter = Math.floor(Math.random() * Math.min(1_000, baseDelayMs));
  return Math.min(maxDelayMs, exponential + jitter);
}

function isRetryableStatusCode(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number.parseInt(value.trim(), 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }

  return null;
}

function isRetryableFetchError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const source = error as { name?: unknown; message?: unknown };
  if (source.name === "AbortError") {
    return true;
  }

  const message = String(source.message ?? "");
  return /fetch failed|network|timeout|socket|econnreset|etimedout|enotfound|eai_again/i.test(
    message,
  );
}

function isValidHttpUrl(value: string): boolean {
  const text = String(value ?? "").trim();
  if (!text) {
    return false;
  }

  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (_error) {
    return false;
  }
}

async function fetchWithTimeout(
  url: URL | string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
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

async function fetchWithRetry(
  url: URL | string,
  options: RequestInit,
  requestOptions: RequestOptions,
): Promise<Response> {
  const maxAttempts = requestOptions.retries + 1;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options, requestOptions.timeoutMs);
      if (response.ok || attempt >= maxAttempts || !isRetryableStatusCode(response.status)) {
        return response;
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const delayMs = retryAfterMs ?? computeBackoffDelayMs(attempt, requestOptions.retryBaseMs);
      await sleep(delayMs);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableFetchError(error)) {
        throw error;
      }

      const delayMs = computeBackoffDelayMs(attempt, requestOptions.retryBaseMs);
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("HTTP request failed.");
}

async function readJsonResponse(response: Response, serviceName: string): Promise<Record<string, unknown>> {
  const bodyText = await response.text();
  let payload: unknown = null;

  try {
    payload = bodyText ? JSON.parse(bodyText) : null;
  } catch (_error) {
    throw new Error(`${serviceName} returned non-JSON response: ${bodyText.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(`${serviceName} API error (${response.status}): ${bodyText.slice(0, 200)}`);
  }

  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
}

async function shortenWithLnkUa(
  url: string,
  bearerToken: string | undefined,
  requestOptions: RequestOptions,
): Promise<string> {
  const formData = new FormData();
  formData.set("link", url);

  const response = await fetchWithRetry(
    "https://lnk.ua/api/v1/link/create",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${String(bearerToken ?? "").trim() || "public"}`,
      },
      body: formData,
    },
    requestOptions,
  );

  const payload = await readJsonResponse(response, "lnk.ua");
  const result = payload.result && typeof payload.result === "object"
    ? (payload.result as Record<string, unknown>)
    : {};
  const shortLink = String(result.lnk ?? "").trim();
  if (!isValidHttpUrl(shortLink)) {
    throw new Error(`lnk.ua returned invalid URL: ${shortLink.slice(0, 200)}`);
  }

  return shortLink;
}

function describeCuttlyStatus(status: number): string {
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

async function shortenWithCuttly(
  url: string,
  apiKey: string | undefined,
  requestOptions: RequestOptions,
): Promise<string> {
  const normalizedApiKey = String(apiKey ?? "").trim();
  if (!normalizedApiKey) {
    throw new Error("CUTTLY_API_KEY is not configured.");
  }

  const endpoint = new URL("https://cutt.ly/api/api.php");
  endpoint.searchParams.set("key", normalizedApiKey);
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

  const payload = await readJsonResponse(response, "cutt.ly");
  const data = payload.url && typeof payload.url === "object"
    ? (payload.url as Record<string, unknown>)
    : {};
  const status = Number(data.status);
  const shortLink = String(data.shortLink ?? "").trim();

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

export class UrlShortenerService {
  private readonly requestOptions: RequestOptions;
  private readonly lnkUaBearerToken: string;
  private readonly cuttlyApiKey: string;

  constructor(params: UrlShortenerServiceParams) {
    this.requestOptions = {
      timeoutMs: params.timeoutMs,
      retries: params.retries,
      retryBaseMs: params.retryBaseMs,
    };
    this.lnkUaBearerToken = String(params.lnkUaBearerToken ?? "").trim();
    this.cuttlyApiKey = String(params.cuttlyApiKey ?? "").trim();
  }

  async shorten(url: string): Promise<ShortenUrlResult> {
    if (!isValidHttpUrl(url)) {
      throw new Error("Input URL is invalid.");
    }

    const warnings: string[] = [];
    const providers: ShortenerProvider[] = ["lnk_ua", "cuttly"];

    for (const provider of providers) {
      try {
        const shortUrl =
          provider === "lnk_ua"
            ? await shortenWithLnkUa(url, this.lnkUaBearerToken, this.requestOptions)
            : await shortenWithCuttly(url, this.cuttlyApiKey, this.requestOptions);

        return {
          originalUrl: url,
          url: shortUrl,
          shortened: shortUrl !== url,
          provider,
          warnings,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(
          provider === "lnk_ua"
            ? `shortener primary failed (lnk.ua): ${message}`
            : `shortener fallback failed (cutt.ly): ${message}`,
        );
      }
    }

    warnings.push("URL shortener недоступний, використано оригінальне посилання.");

    return {
      originalUrl: url,
      url,
      shortened: false,
      provider: "original",
      warnings,
    };
  }
}
