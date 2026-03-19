import type { AppConfig } from "./config.types";
import path from "node:path";

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseCsv(value: string | undefined, fallback: string[]): string[] {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return fallback;
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    host: String(env.HOST ?? "127.0.0.1").trim() || "127.0.0.1",
    port: Number.parseInt(env.PORT ?? "3000", 10),
    projectPhase: "stage_d_intake",
    requestBodyLimitBytes: parsePositiveInteger(env.REQUEST_BODY_LIMIT_BYTES, 1_000_000),
    keycrmApiBase: String(env.KEYCRM_API_BASE ?? "").trim(),
    keycrmToken: String(env.KEYCRM_TOKEN ?? "").trim(),
    keycrmOrderInclude: parseCsv(env.KEYCRM_ORDER_INCLUDE, [
      "products.offer",
      "tags",
      "custom_fields",
      "status",
      "manager",
      "shipping.deliveryService",
      "shipping.lastHistory",
    ]),
    keycrmRequestTimeoutMs: parsePositiveInteger(env.KEYCRM_REQUEST_TIMEOUT_MS, 15_000),
    keycrmRequestRetries: parsePositiveInteger(env.KEYCRM_REQUEST_RETRIES, 2),
    keycrmRequestRetryBaseMs: parsePositiveInteger(env.KEYCRM_REQUEST_RETRY_BASE_MS, 500),
    keycrmWebhookSecret: String(env.KEYCRM_WEBHOOK_SECRET ?? "").trim(),
    telegramBotToken: String(env.TELEGRAM_BOT_TOKEN ?? "").trim(),
    telegramChatId: String(env.TELEGRAM_CHAT_ID ?? "").trim(),
    telegramReactionSecretToken: String(env.TELEGRAM_REACTION_SECRET_TOKEN ?? "").trim(),
    orderQueueConcurrency: parsePositiveInteger(env.ORDER_QUEUE_CONCURRENCY, 1),
    orderQueueMaxSize: parsePositiveInteger(env.ORDER_QUEUE_MAX_SIZE, 200),
    reactionQueueConcurrency: parsePositiveInteger(env.REACTION_QUEUE_CONCURRENCY, 1),
    reactionQueueMaxSize: parsePositiveInteger(env.REACTION_QUEUE_MAX_SIZE, 300),
    queueJobTimeoutMs: parsePositiveInteger(env.QUEUE_JOB_TIMEOUT_MS, 10 * 60 * 1000),
    idempotencyStorePath: path.resolve(
      process.cwd(),
      String(env.IDEMPOTENCY_STORE_PATH ?? "storage/files/idempotency/order-webhooks.json"),
    ),
  };
}
