import { Pool, type PoolClient } from "pg";

export type DbQueryResult<TRow> = {
  rows: TRow[];
  rowCount: number;
};

export type DatabaseClient = {
  query: <TRow = Record<string, unknown>>(
    text: string,
    params?: ReadonlyArray<unknown>,
  ) => Promise<DbQueryResult<TRow>>;
  close: () => Promise<void>;
};

type CreatePostgresClientParams = {
  connectionString: string;
  maxPoolSize: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  queryTimeoutMs: number;
};

export class PostgresClient implements DatabaseClient {
  private readonly pool: Pool;
  private readonly queryTimeoutMs: number;

  constructor(params: CreatePostgresClientParams) {
    this.queryTimeoutMs = Math.max(1_000, Math.floor(params.queryTimeoutMs));
    this.pool = new Pool({
      connectionString: params.connectionString,
      max: Math.max(1, Math.floor(params.maxPoolSize)),
      connectionTimeoutMillis: Math.max(1_000, Math.floor(params.connectionTimeoutMs)),
      idleTimeoutMillis: Math.max(1_000, Math.floor(params.idleTimeoutMs)),
      statement_timeout: this.queryTimeoutMs,
    });
  }

  async query<TRow = Record<string, unknown>>(
    text: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<DbQueryResult<TRow>> {
    const result = await withTimeout(
      this.pool.query(text, [...params]),
      this.queryTimeoutMs,
      "Postgres query timeout.",
    );
    return {
      rows: result.rows as TRow[],
      rowCount: result.rowCount ?? 0,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async withTransaction<TResult>(
    callback: (client: DatabaseClient) => Promise<TResult>,
  ): Promise<TResult> {
    const client = await this.pool.connect();

    try {
      await withTimeout(client.query("BEGIN"), this.queryTimeoutMs, "Postgres BEGIN timeout.");
      const result = await callback(createTransactionClient(client, this.queryTimeoutMs));
      await withTimeout(client.query("COMMIT"), this.queryTimeoutMs, "Postgres COMMIT timeout.");
      return result;
    } catch (error) {
      await withTimeout(
        client.query("ROLLBACK"),
        this.queryTimeoutMs,
        "Postgres ROLLBACK timeout.",
      ).catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

function createTransactionClient(client: PoolClient, queryTimeoutMs: number): DatabaseClient {
  return {
    query: async <TRow = Record<string, unknown>>(
      text: string,
      params: ReadonlyArray<unknown> = [],
    ): Promise<DbQueryResult<TRow>> => {
      const result = await withTimeout(
        client.query(text, [...params]),
        queryTimeoutMs,
        "Postgres transaction query timeout.",
      );
      return {
        rows: result.rows as TRow[],
        rowCount: result.rowCount ?? 0,
      };
    },
    close: async () => undefined,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, Math.max(1_000, Math.floor(timeoutMs)));

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}
