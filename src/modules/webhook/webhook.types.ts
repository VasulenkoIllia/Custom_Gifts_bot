import type { IncomingHttpHeaders } from "node:http";

export type WebhookHandleInput = {
  headers: IncomingHttpHeaders;
  payload: unknown;
  requestId: string;
  url?: URL;
};

export type WebhookHandleResult = {
  statusCode: number;
  body: Record<string, unknown>;
};
