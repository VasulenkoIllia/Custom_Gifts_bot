import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Logger } from "../../observability/logger";
import { PostgresClient } from "./postgres-client";

type MigrationRow = {
  filename: string;
  checksum: string;
  applied_at: string | Date;
};

type MigrationFile = {
  filename: string;
  checksum: string;
  sql: string;
};

type MigrationResult = {
  applied: string[];
  skipped: string[];
};

const NO_TRANSACTION_MARKER = "-- codex:no-transaction";

export function resolveDefaultMigrationsDir(): string {
  return path.resolve(process.cwd(), "migrations");
}

export async function applyPostgresMigrations(params: {
  client: PostgresClient;
  migrationsDir: string;
  logger?: Logger;
}): Promise<MigrationResult> {
  const migrations = await loadMigrationFiles(params.migrationsDir);
  await ensureMigrationTable(params.client);
  const appliedRows = await listAppliedMigrations(params.client);
  const appliedByFilename = new Map(appliedRows.map((row) => [row.filename, row]));
  const result: MigrationResult = {
    applied: [],
    skipped: [],
  };

  for (const migration of migrations) {
    const existing = appliedByFilename.get(migration.filename);
    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(
          `Migration checksum mismatch for ${migration.filename}. Existing migrations must remain immutable.`,
        );
      }
      result.skipped.push(migration.filename);
      continue;
    }

    params.logger?.info("db_migration_started", {
      filename: migration.filename,
    });

    const apply = async (): Promise<void> => {
      await params.client.query(migration.sql);
      await params.client.query(
        `
          INSERT INTO schema_migrations(filename, checksum)
          VALUES ($1, $2)
        `,
        [migration.filename, migration.checksum],
      );
    };

    if (hasNoTransactionMarker(migration.sql)) {
      await apply();
    } else {
      await params.client.withTransaction(async (tx) => {
        await tx.query(migration.sql);
        await tx.query(
          `
            INSERT INTO schema_migrations(filename, checksum)
            VALUES ($1, $2)
          `,
          [migration.filename, migration.checksum],
        );
      });
    }

    params.logger?.info("db_migration_applied", {
      filename: migration.filename,
    });
    result.applied.push(migration.filename);
  }

  return result;
}

export async function assertPostgresMigrationsApplied(params: {
  client: PostgresClient;
  migrationsDir: string;
}): Promise<void> {
  const migrations = await loadMigrationFiles(params.migrationsDir);
  await ensureMigrationTable(params.client);
  const appliedRows = await listAppliedMigrations(params.client);
  const appliedByFilename = new Map(appliedRows.map((row) => [row.filename, row]));

  for (const migration of migrations) {
    const existing = appliedByFilename.get(migration.filename);
    if (!existing) {
      throw new Error(
        `Missing migration ${migration.filename}. Run the migration step before starting the app.`,
      );
    }

    if (existing.checksum !== migration.checksum) {
      throw new Error(
        `Migration checksum mismatch for ${migration.filename}. Existing migrations must remain immutable.`,
      );
    }
  }
}

async function ensureMigrationTable(client: PostgresClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function listAppliedMigrations(client: PostgresClient): Promise<MigrationRow[]> {
  const result = await client.query<MigrationRow>(`
    SELECT filename, checksum, applied_at
    FROM schema_migrations
    ORDER BY filename ASC
  `);

  return result.rows;
}

async function loadMigrationFiles(migrationsDir: string): Promise<MigrationFile[]> {
  const resolvedDir = path.resolve(migrationsDir);
  const entries = await fs.readdir(resolvedDir, {
    withFileTypes: true,
  });

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const migrations: MigrationFile[] = [];

  for (const filename of files) {
    const fullPath = path.join(resolvedDir, filename);
    const sql = await fs.readFile(fullPath, "utf8");
    const trimmedSql = sql.trim();
    if (!trimmedSql) {
      throw new Error(`Migration ${filename} is empty.`);
    }

    migrations.push({
      filename,
      checksum: sha256(trimmedSql),
      sql: trimmedSql,
    });
  }

  return migrations;
}

function hasNoTransactionMarker(sql: string): boolean {
  return sql
    .split(/\r?\n/u)
    .slice(0, 5)
    .some((line) => line.trim().toLowerCase() === NO_TRANSACTION_MARKER);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
