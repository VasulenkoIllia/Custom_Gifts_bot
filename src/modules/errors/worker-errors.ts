export type OrderFailureKind = "pdf_generation" | "telegram_delivery" | "unknown";

export class OrderProcessingError extends Error {
  readonly retryable: boolean;
  readonly orderId: string;
  readonly failureKind: OrderFailureKind;

  constructor(params: {
    message: string;
    orderId: string;
    retryable: boolean;
    failureKind: OrderFailureKind;
  }) {
    super(params.message);
    this.name = "OrderProcessingError";
    this.orderId = params.orderId;
    this.retryable = params.retryable;
    this.failureKind = params.failureKind;
  }
}

function isRetryableStatusCode(value: unknown): boolean {
  const statusCode = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(statusCode)) {
    return false;
  }

  return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function isRetryableSystemCode(value: unknown): boolean {
  const code = String(value ?? "").trim().toUpperCase();
  if (!code) {
    return false;
  }

  return [
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_RESPONSE_STATUS_CODE",
  ].includes(code);
}

export function isLikelyTransientErrorMessage(message: string): boolean {
  const source = String(message ?? "").toLowerCase();
  if (!source) {
    return false;
  }

  return /\b(timeout|timed out|network|socket|fetch failed|econnreset|etimedout|econnrefused|ehostunreach|enetunreach|enotfound|eai_again)\b|(?:^|[^\d])429(?:[^\d]|$)|(?:^|[^\d])5\d\d(?:[^\d]|$)/i.test(
    source,
  );
}

export function resolveRetryableError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const candidate = error as {
      retryable?: unknown;
      statusCode?: unknown;
      code?: unknown;
      message?: unknown;
    };

    if (typeof candidate.retryable === "boolean") {
      return candidate.retryable;
    }

    if (isRetryableStatusCode(candidate.statusCode)) {
      return true;
    }

    if (isRetryableSystemCode(candidate.code)) {
      return true;
    }

    if (typeof candidate.message === "string" && isLikelyTransientErrorMessage(candidate.message)) {
      return true;
    }
  }

  if (error instanceof Error) {
    if (isRetryableSystemCode((error as { code?: unknown }).code)) {
      return true;
    }

    return isLikelyTransientErrorMessage(error.message);
  }

  return isLikelyTransientErrorMessage(String(error ?? ""));
}

export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? "Unknown error");
}
