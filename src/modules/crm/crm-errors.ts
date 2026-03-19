export class CrmApiError extends Error {
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(message: string, statusCode: number, retryable: boolean) {
    super(message);
    this.name = "CrmApiError";
    this.statusCode = statusCode;
    this.retryable = retryable;
  }
}
