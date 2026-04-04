import type { DatabaseClient } from "../db/postgres-client";

export type IdempotencyEntry = {
  key: string;
  createdAt: string;
};

export type IdempotencyReserveResult = {
  created: boolean;
  entry: IdempotencyEntry;
};

export type IdempotencyStore = {
  init: () => Promise<void>;
  reserve: (key: string) => Promise<IdempotencyReserveResult>;
  remove: (key: string) => Promise<boolean>;
};

type DbIdempotencyRow = {
  key: string;
  created_at: string | Date;
};

export class DbIdempotencyStore implements IdempotencyStore {
  private readonly db: DatabaseClient;
  private readonly maxEntries: number;
  private insertsSinceTrim = 0;

  constructor(db: DatabaseClient, maxEntries = 50_000) {
    this.db = db;
    this.maxEntries = Number.isFinite(maxEntries) ? Math.max(1_000, Math.floor(maxEntries)) : 50_000;
  }

  async init(): Promise<void> {
    await this.trimIfNeeded();
  }

  async reserve(key: string): Promise<IdempotencyReserveResult> {
    const normalizedKey = String(key ?? "").trim();
    if (!normalizedKey) {
      throw new Error("Idempotency key is required.");
    }

    const inserted = await this.db.query<DbIdempotencyRow>(
      `
        INSERT INTO idempotency_keys(key)
        VALUES ($1)
        ON CONFLICT (key) DO NOTHING
        RETURNING key, created_at
      `,
      [normalizedKey],
    );

    if (inserted.rowCount > 0) {
      const row = inserted.rows[0];
      this.insertsSinceTrim += 1;
      if (this.insertsSinceTrim >= 100) {
        await this.trimIfNeeded();
        this.insertsSinceTrim = 0;
      }
      return {
        created: true,
        entry: {
          key: normalizedKey,
          createdAt: new Date(String(row?.created_at ?? new Date().toISOString())).toISOString(),
        },
      };
    }

    const existing = await this.db.query<DbIdempotencyRow>(
      `
        SELECT key, created_at
        FROM idempotency_keys
        WHERE key = $1
        LIMIT 1
      `,
      [normalizedKey],
    );

    const row = existing.rows[0];
    return {
      created: false,
      entry: {
        key: normalizedKey,
        createdAt: new Date(String(row?.created_at ?? new Date().toISOString())).toISOString(),
      },
    };
  }

  async remove(key: string): Promise<boolean> {
    const normalizedKey = String(key ?? "").trim();
    if (!normalizedKey) {
      return false;
    }

    const result = await this.db.query(
      `
        DELETE FROM idempotency_keys
        WHERE key = $1
      `,
      [normalizedKey],
    );

    return result.rowCount > 0;
  }

  private async trimIfNeeded(): Promise<void> {
    await this.db.query(
      `
        DELETE FROM idempotency_keys
        WHERE key IN (
          SELECT key
          FROM idempotency_keys
          ORDER BY created_at DESC
          OFFSET $1
        )
      `,
      [this.maxEntries],
    );
  }
}
