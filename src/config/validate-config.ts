import type { AppConfig } from "./config.types";

export function validateConfig(config: AppConfig): void {
  if (!config.host) {
    throw new Error("HOST is invalid.");
  }

  if (!Number.isFinite(config.port) || config.port <= 0) {
    throw new Error("PORT is invalid.");
  }

  if (!config.keycrmApiBase) {
    throw new Error("KEYCRM_API_BASE is required.");
  }

  if (!config.keycrmToken) {
    throw new Error("KEYCRM_TOKEN is required.");
  }

  if (!Array.isArray(config.keycrmOrderInclude) || config.keycrmOrderInclude.length === 0) {
    throw new Error("KEYCRM_ORDER_INCLUDE is invalid.");
  }

  if (!Number.isFinite(config.requestBodyLimitBytes) || config.requestBodyLimitBytes <= 0) {
    throw new Error("REQUEST_BODY_LIMIT_BYTES is invalid.");
  }

  if (!Number.isFinite(config.keycrmRequestTimeoutMs) || config.keycrmRequestTimeoutMs <= 0) {
    throw new Error("KEYCRM_REQUEST_TIMEOUT_MS is invalid.");
  }

  if (!Number.isFinite(config.keycrmRequestRetries) || config.keycrmRequestRetries < 0) {
    throw new Error("KEYCRM_REQUEST_RETRIES is invalid.");
  }

  if (!Number.isFinite(config.keycrmRequestRetryBaseMs) || config.keycrmRequestRetryBaseMs <= 0) {
    throw new Error("KEYCRM_REQUEST_RETRY_BASE_MS is invalid.");
  }

  if (!Number.isFinite(config.orderQueueConcurrency) || config.orderQueueConcurrency <= 0) {
    throw new Error("ORDER_QUEUE_CONCURRENCY is invalid.");
  }

  if (!Number.isFinite(config.orderQueueMaxSize) || config.orderQueueMaxSize <= 0) {
    throw new Error("ORDER_QUEUE_MAX_SIZE is invalid.");
  }

  if (!Number.isFinite(config.reactionQueueConcurrency) || config.reactionQueueConcurrency <= 0) {
    throw new Error("REACTION_QUEUE_CONCURRENCY is invalid.");
  }

  if (!Number.isFinite(config.reactionQueueMaxSize) || config.reactionQueueMaxSize <= 0) {
    throw new Error("REACTION_QUEUE_MAX_SIZE is invalid.");
  }

  if (!Number.isFinite(config.queueJobTimeoutMs) || config.queueJobTimeoutMs <= 0) {
    throw new Error("QUEUE_JOB_TIMEOUT_MS is invalid.");
  }

  if (!config.idempotencyStorePath) {
    throw new Error("IDEMPOTENCY_STORE_PATH is invalid.");
  }
}
