export class QueueOverflowError extends Error {
  readonly statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = "QueueOverflowError";
    this.statusCode = 429;
  }
}

export class QueueClosedError extends Error {
  readonly statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = "QueueClosedError";
    this.statusCode = 503;
  }
}
