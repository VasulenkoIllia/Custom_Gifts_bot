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

export function isLikelyTransientErrorMessage(message: string): boolean {
  const source = String(message ?? "").toLowerCase();
  if (!source) {
    return false;
  }

  return /timeout|timed out|network|fetch failed|econnreset|etimedout|enotfound|eai_again|429| 5\d\d|retry/i.test(
    source,
  );
}
