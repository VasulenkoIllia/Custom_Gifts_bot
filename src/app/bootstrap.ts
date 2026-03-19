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
  const server = createServer(createAppHandler({ config, logger, runtime }));

  server.listen(config.port, config.host, () => {
    logger.info("server_started", {
      host: config.host,
      port: config.port,
      phase: config.projectPhase,
      webhook_keycrm: "/webhook/keycrm",
      webhook_telegram: "/webhook/telegram",
    });
  });
}
