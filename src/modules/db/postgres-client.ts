import { Pool } from "pg";

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
}
