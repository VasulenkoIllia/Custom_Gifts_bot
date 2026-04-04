import type { AppConfig } from "../config/config.types";
import { loadConfig } from "../config/load-config";
import { validateConfig } from "../config/validate-config";
import { CrmClient } from "../modules/crm/crm-client";
import { createSilentLogger } from "./script-utils";

export function loadValidatedConfigFromEnv(): AppConfig {
  const config = loadConfig(process.env);
  validateConfig(config);
  return config;
}

export function createCrmClientFromConfig(config: AppConfig): CrmClient {
  return new CrmClient({
    apiBase: config.keycrmApiBase,
    token: config.keycrmToken,
    orderInclude: config.keycrmOrderInclude,
    requestTimeoutMs: config.keycrmRequestTimeoutMs,
    retries: config.keycrmRequestRetries,
    retryBaseMs: config.keycrmRequestRetryBaseMs,
    logger: createSilentLogger(),
  });
}

export function resolveLocalAppBaseUrl(config: AppConfig): string {
  return `http://${config.host}:${config.port}`;
}
