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
    if (req.method === "GET" && url.pathname === "/health/liveness") {
      sendJson(res, 200, runtime.healthService.getLiveness());
      return;
    }

    if (req.method === "GET" && url.pathname === "/health/readiness") {
      const readiness = await runtime.healthService.getReadiness();
      sendJson(res, readiness.ok ? 200 : 503, readiness);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      const summary = await runtime.healthService.getHealthSummary();
      sendJson(res, summary.ok ? 200 : 503, summary);
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhook/keycrm") {
      if (!runtime.keycrmWebhookController) {
        throw new HttpError(503, "Receiver role is disabled for KeyCRM webhook.");
      }
      const rawBody = await readRequestBody(req, config.requestBodyLimitBytes);
      if (!rawBody.trim()) {
        throw new HttpError(400, "Request body is empty.");
      }

      const payload = parseJsonOrThrow(rawBody);
      const result = await runtime.keycrmWebhookController.handle({
        headers: req.headers,
        payload,
        requestId,
        url,
      });

      sendJson(res, result.statusCode, result.body);
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhook/telegram") {
      if (!runtime.telegramWebhookController) {
        throw new HttpError(503, "Receiver role is disabled for Telegram webhook.");
      }
      const rawBody = await readRequestBody(req, config.requestBodyLimitBytes);
      if (!rawBody.trim()) {
        throw new HttpError(400, "Request body is empty.");
      }

      const payload = parseJsonOrThrow(rawBody);
      const result = await runtime.telegramWebhookController.handle({
        headers: req.headers,
        payload,
        requestId,
        url,
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
