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
};

export class PostgresClient implements DatabaseClient {
  private readonly pool: Pool;

  constructor(params: CreatePostgresClientParams) {
    this.pool = new Pool({
      connectionString: params.connectionString,
      max: Math.max(1, Math.floor(params.maxPoolSize)),
    });
  }

  async query<TRow = Record<string, unknown>>(
    text: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<DbQueryResult<TRow>> {
    const result = await this.pool.query(text, [...params]);
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
      await client.query("BEGIN");
      const result = await callback(createTransactionClient(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

function createTransactionClient(client: PoolClient): DatabaseClient {
  return {
    query: async <TRow = Record<string, unknown>>(
      text: string,
      params: ReadonlyArray<unknown> = [],
    ): Promise<DbQueryResult<TRow>> => {
      const result = await client.query(text, [...params]);
      return {
        rows: result.rows as TRow[],
        rowCount: result.rowCount ?? 0,
      };
    },
    close: async () => undefined,
  };
}
