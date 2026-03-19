import type { KeycrmOrder } from "../../domain/orders/order.types";
import type { Logger } from "../../observability/logger";
import { CrmApiError } from "./crm-errors";

type CreateCrmClientParams = {
  apiBase: string;
  token: string;
  orderInclude: string[];
  requestTimeoutMs: number;
  retries: number;
  retryBaseMs: number;
  logger: Logger;
};

type KeycrmEnvelope<T> = {
  data?: T;
};

function isKeycrmOrder(value: unknown): value is KeycrmOrder {
  return Boolean(
    value &&
      typeof value === "object" &&
      "id" in value &&
      Number.isFinite(Number((value as KeycrmOrder).id)),
  );
}

function unwrapOrderPayload(payload: KeycrmEnvelope<KeycrmOrder> | KeycrmOrder): KeycrmOrder {
  if (payload && typeof payload === "object" && "data" in payload && isKeycrmOrder(payload.data)) {
    return payload.data;
  }

  if (isKeycrmOrder(payload)) {
    return payload;
  }

  throw new Error("CRM returned an invalid order payload.");
}

function isRetryableStatusCode(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  if (error instanceof TypeError) {
    return true;
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes("network") || message.includes("timeout") || message.includes("fetch");
  }

  return false;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const seconds = Number.parseInt(value, 10);
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

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function parsePayload<T>(rawText: string): T | string | null {
  if (!rawText.trim()) {
    return null;
  }

  try {
    return JSON.parse(rawText) as T;
  } catch (_error) {
    return rawText;
  }
}

function asMessage(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }

  try {
    return JSON.stringify(payload);
  } catch (_error) {
    return "Unknown CRM response payload.";
  }
}

export class CrmClient {
  private readonly apiBase: string;
  private readonly token: string;
  private readonly orderInclude: string[];
  private readonly requestTimeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private readonly logger: Logger;

  constructor(params: CreateCrmClientParams) {
    this.apiBase = params.apiBase.endsWith("/") ? params.apiBase : `${params.apiBase}/`;
    this.token = params.token;
    this.orderInclude = params.orderInclude;
    this.requestTimeoutMs = params.requestTimeoutMs;
    this.retries = params.retries;
    this.retryBaseMs = params.retryBaseMs;
    this.logger = params.logger;
  }

  async getOrder(orderId: string): Promise<KeycrmOrder> {
    const normalizedOrderId = String(orderId ?? "").trim();
    if (!normalizedOrderId) {
      throw new Error("orderId is required.");
    }

    const url = new URL(`order/${encodeURIComponent(normalizedOrderId)}`, this.apiBase);
    if (this.orderInclude.length > 0) {
      url.searchParams.set("include", this.orderInclude.join(","));
    }

    const payload = await this.request<KeycrmEnvelope<KeycrmOrder> | KeycrmOrder>({
      method: "GET",
      url,
      body: null,
      operation: "crm_get_order",
      operationMeta: {
        orderId: normalizedOrderId,
      },
    });

    return unwrapOrderPayload(payload);
  }

  async updateOrderStatus(orderId: string, statusId: number): Promise<KeycrmOrder> {
    const normalizedOrderId = String(orderId ?? "").trim();
    if (!normalizedOrderId) {
      throw new Error("orderId is required.");
    }

    if (!Number.isFinite(statusId) || statusId <= 0) {
      throw new Error("statusId must be a positive integer.");
    }

    const url = new URL(`order/${encodeURIComponent(normalizedOrderId)}`, this.apiBase);
    const body = JSON.stringify({ status_id: statusId });

    const payload = await this.request<KeycrmEnvelope<KeycrmOrder> | KeycrmOrder>({
      method: "PUT",
      url,
      body,
      operation: "crm_update_order_status",
      operationMeta: {
        orderId: normalizedOrderId,
        statusId,
      },
    });

    return unwrapOrderPayload(payload);
  }

  private async request<T>({
    method,
    url,
    body,
    operation,
    operationMeta,
  }: {
    method: "GET" | "PUT";
    url: URL;
    body: string | null;
    operation: string;
    operationMeta: Record<string, unknown>;
  }): Promise<T> {
    const attempts = this.retries + 1;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(url, {
          method,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.token}`,
          },
          body,
        });

        const rawText = await response.text();
        const parsedPayload = parsePayload<T>(rawText);

        if (!response.ok) {
          const retryable = isRetryableStatusCode(response.status);
          const message = asMessage(parsedPayload).slice(0, 1000);
          const error = new CrmApiError(
            `CRM request failed (${response.status}): ${message}`,
            response.status,
            retryable,
          );

          if (attempt < attempts && retryable) {
            const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
            const delayMs = retryAfterMs ?? this.computeBackoffDelayMs(attempt);

            this.logger.warn("crm_retry", {
              operation,
              attempt,
              delayMs,
              statusCode: response.status,
              ...operationMeta,
            });

            await sleep(delayMs);
            continue;
          }

          throw error;
        }

        this.logger.info(operation, {
          attempt,
          statusCode: response.status,
          ...operationMeta,
        });

        return (parsedPayload as T) ?? (null as T);
      } catch (error) {
        lastError = error;
        const retryable = isRetryableFetchError(error);

        if (attempt < attempts && retryable) {
          const delayMs = this.computeBackoffDelayMs(attempt);
          this.logger.warn("crm_retry", {
            operation,
            attempt,
            delayMs,
            reason: error instanceof Error ? error.message : String(error),
            ...operationMeta,
          });
          await sleep(delayMs);
          continue;
        }

        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("CRM request failed.");
  }

  private async fetchWithTimeout(url: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private computeBackoffDelayMs(attempt: number): number {
    const exponential = this.retryBaseMs * Math.pow(2, Math.max(0, attempt - 1));
    const jitter = Math.floor(Math.random() * 100);
    return Math.min(30_000, exponential + jitter);
  }
}
