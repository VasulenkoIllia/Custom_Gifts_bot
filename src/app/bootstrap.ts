import { createServer } from "node:http";
import { loadConfig } from "../config/load-config";
import { validateConfig } from "../config/validate-config";
import { createLogger } from "../observability/logger";
import { createRuntime } from "./runtime";
import { createAppHandler } from "./server";

export async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  validateConfig(config);

  const logger = createLogger({
    service: "custom-gifts-bot",
  });

  const runtime = await createRuntime(config, logger);
  const server = runtime.httpEnabled
    ? createServer(createAppHandler({ config, logger, runtime }))
    : null;

  if (server) {
    server.on("error", (error) => {
      logger.error("server_failed", {
        host: config.host,
        port: config.port,
        role: config.appRole,
        message: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });

    server.listen(config.port, config.host, () => {
      logger.info("server_started", {
        host: config.host,
        port: config.port,
        phase: config.projectPhase,
        role: config.appRole,
        health: "/health",
        liveness: "/health/liveness",
        readiness: "/health/readiness",
        webhook_keycrm: "/webhook/keycrm",
        webhook_telegram: "/webhook/telegram",
      });
    });
  }

  const shutdown = (signal: string): void => {
    logger.info("server_shutdown_requested", { signal });
    const finishShutdown = (): void => {
      void runtime
        .shutdown()
        .then(() => {
          logger.info("server_stopped", { signal });
          process.exit(0);
        })
        .catch((error) => {
          logger.error("server_shutdown_failed", {
            signal,
            message: error instanceof Error ? error.message : String(error),
          });
          process.exit(1);
        });
    };

    if (server) {
      server.close(() => {
        finishShutdown();
      });
      return;
    }

    finishShutdown();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
