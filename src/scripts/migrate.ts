import { loadConfig } from "../config/load-config";
import { validateConfig } from "../config/validate-config";
import { createLogger } from "../observability/logger";
import { PostgresClient } from "../modules/db/postgres-client";
import { applyPostgresMigrations } from "../modules/db/postgres-migrations";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  validateConfig(config);

  const logger = createLogger({
    service: "custom-gifts-bot",
  });
  const client = new PostgresClient({
    connectionString: config.databaseUrl,
    maxPoolSize: config.databasePoolMax,
    connectionTimeoutMs: config.databasePoolConnectionTimeoutMs,
    idleTimeoutMs: config.databasePoolIdleTimeoutMs,
    queryTimeoutMs: config.databaseQueryTimeoutMs,
  });

  try {
    const result = await applyPostgresMigrations({
      client,
      migrationsDir: config.databaseMigrationsDir,
      logger,
    });

    logger.info("db_migration_finished", {
      appliedCount: result.applied.length,
      skippedCount: result.skipped.length,
      applied: result.applied,
      skipped: result.skipped,
    });
  } finally {
    await client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      service: "custom-gifts-bot",
      event: "db_migration_failed",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
