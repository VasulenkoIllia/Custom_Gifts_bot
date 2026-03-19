import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/config.types";
import type { Logger } from "../observability/logger";
import { HttpError } from "./http-errors";
import { readRequestBody, parseJsonOrThrow } from "./read-request-body";
import { sendJson } from "./http-response";
import type { AppRuntime } from "./runtime";

type CreateAppHandlerParams = {
  config: AppConfig;
  logger: Logger;
  runtime: AppRuntime;
};

export function createAppHandler({ config, logger, runtime }: CreateAppHandlerParams) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void handleRequest(req, res, { config, logger, runtime });
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  { config, logger, runtime }: CreateAppHandlerParams,
): Promise<void> {
  const requestId = randomUUID();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "custom-gifts-bot",
        phase: config.projectPhase,
        ts_bootstrap: true,
        runtime: "webhook_intake_ready",
        queue: {
          order: runtime.orderQueue.getStats(),
          reaction: runtime.reactionQueue.getStats(),
        },
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhook/keycrm") {
      const rawBody = await readRequestBody(req, config.requestBodyLimitBytes);
      if (!rawBody.trim()) {
        throw new HttpError(400, "Request body is empty.");
      }

      const payload = parseJsonOrThrow(rawBody);
      const result = await runtime.keycrmWebhookController.handle({
        headers: req.headers,
        payload,
        requestId,
      });

      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhook/telegram") {
      const rawBody = await readRequestBody(req, config.requestBodyLimitBytes);
      if (!rawBody.trim()) {
        throw new HttpError(400, "Request body is empty.");
      }

      const payload = parseJsonOrThrow(rawBody);
      const result = await runtime.telegramWebhookController.handle({
        headers: req.headers,
        payload,
        requestId,
      });

      sendJson(res, result.statusCode, result.body);
      return;
    }

    logger.info("http_not_found", {
      requestId,
      method: req.method ?? "UNKNOWN",
      path: url.pathname,
    });
    sendJson(res, 404, { ok: false, message: "Not found.", requestId });
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    logger.error("http_request_failed", {
      requestId,
      method: req.method ?? "UNKNOWN",
      path: url.pathname,
      statusCode,
      message: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, statusCode, {
      ok: false,
      requestId,
      message: error instanceof Error ? error.message : "Unknown error.",
    });
  }
}
