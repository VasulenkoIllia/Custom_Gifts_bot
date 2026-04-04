import type { DatabaseClient } from "../db/postgres-client";
import type { TelegramForwardMode, TelegramForwardingResult } from "./telegram-forwarding.service";
import type { TelegramOrderMessageRef } from "./telegram-message-map.types";

export type ForwardingBatchAcquireResult =
  | { outcome: "acquired" }
  | { outcome: "busy" }
  | { outcome: "sent"; result: TelegramForwardingResult };

type ForwardingBatchRow = {
  batch_key: string;
  status: string;
  target_chat_id: string;
  target_thread_id: string;
  forwarded_message_ids: unknown;
  forwarded_count: number;
  skipped_count: number;
  mode_counts: unknown;
};

export class DbForwardingBatchStore {
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  async init(): Promise<void> {
    // Schema is created by ensurePostgresSchema.
  }

  async acquire(params: {
    batchKey: string;
    orderId: string;
    stageCode: string;
    targetChatId: string;
    targetThreadId: string;
    sourceMessages: TelegramOrderMessageRef[];
    leaseOwner: string;
    leaseTtlMs: number;
  }): Promise<ForwardingBatchAcquireResult> {
    const result = await this.db.query<ForwardingBatchRow & { outcome: string }>(
      `
        WITH batch_lock AS (
          SELECT pg_advisory_xact_lock(hashtext($1))
        ),
        existing AS (
          SELECT *
          FROM forwarding_batches
          WHERE batch_key = $1
        ),
        inserted AS (
          INSERT INTO forwarding_batches(
            batch_key,
            order_id,
            stage_code,
            target_chat_id,
            target_thread_id,
            status,
            lease_owner,
            lease_expires_at,
            source_messages,
            created_at,
            updated_at
          )
          SELECT
            $1,
            $2,
            $3,
            $4,
            $5,
            'pending',
            $6,
            NOW() + ($7 * INTERVAL '1 millisecond'),
            $8::jsonb,
            NOW(),
            NOW()
          WHERE NOT EXISTS (SELECT 1 FROM existing)
          RETURNING *
        ),
        reacquired AS (
          UPDATE forwarding_batches
          SET
            lease_owner = $6,
            lease_expires_at = NOW() + ($7 * INTERVAL '1 millisecond'),
            updated_at = NOW()
          WHERE batch_key = $1
            AND status = 'pending'
            AND (
              lease_owner IS NULL
              OR lease_owner = $6
              OR lease_expires_at IS NULL
              OR lease_expires_at <= NOW()
            )
          RETURNING *
        )
        SELECT
          CASE
            WHEN EXISTS(SELECT 1 FROM inserted) OR EXISTS(SELECT 1 FROM reacquired) THEN 'acquired'
            WHEN EXISTS(SELECT 1 FROM existing WHERE status = 'sent') THEN 'sent'
            ELSE 'busy'
          END AS outcome,
          batch_key,
          status,
          target_chat_id,
          target_thread_id,
          forwarded_message_ids,
          forwarded_count,
          skipped_count,
          mode_counts
        FROM (
          SELECT * FROM inserted
          UNION ALL
          SELECT * FROM reacquired
          UNION ALL
          SELECT * FROM existing
        ) AS candidate
        LIMIT 1
      `,
      [
        params.batchKey,
        params.orderId,
        params.stageCode,
        params.targetChatId,
        params.targetThreadId,
        params.leaseOwner,
        params.leaseTtlMs,
        JSON.stringify(params.sourceMessages),
      ],
    );

    const row = result.rows[0];
    if (!row) {
      return { outcome: "acquired" };
    }

    if (row.outcome === "sent") {
      return {
        outcome: "sent",
        result: {
          targetChatId: String(row.target_chat_id ?? "").trim(),
          targetThreadId: String(row.target_thread_id ?? "").trim(),
          forwardedMessageIds: parseNumberArray(row.forwarded_message_ids),
          forwardedCount: Math.max(0, Number(row.forwarded_count ?? 0)),
          skippedCount: Math.max(0, Number(row.skipped_count ?? 0)),
          modeCounts: parseModeCounts(row.mode_counts),
        },
      };
    }

    if (row.outcome === "busy") {
      return { outcome: "busy" };
    }

    return { outcome: "acquired" };
  }

  async complete(
    leaseOwner: string,
    params: {
      batchKey: string;
      forwardedResult: TelegramForwardingResult;
    },
  ): Promise<void> {
    await this.db.query(
      `
        UPDATE forwarding_batches
        SET
          status = 'sent',
          lease_owner = NULL,
          lease_expires_at = NULL,
          forwarded_message_ids = $2::jsonb,
          forwarded_count = $3,
          skipped_count = $4,
          mode_counts = $5::jsonb,
          finished_at = NOW(),
          updated_at = NOW()
        WHERE batch_key = $1
          AND (lease_owner = $6 OR lease_owner IS NULL)
      `,
      [
        params.batchKey,
        JSON.stringify(params.forwardedResult.forwardedMessageIds),
        params.forwardedResult.forwardedCount,
        params.forwardedResult.skippedCount,
        JSON.stringify(params.forwardedResult.modeCounts),
        leaseOwner,
      ],
    );
  }

  async release(batchKey: string, leaseOwner: string): Promise<void> {
    await this.db.query(
      `
        UPDATE forwarding_batches
        SET
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
        WHERE batch_key = $1
          AND status = 'pending'
          AND lease_owner = $2
      `,
      [batchKey, leaseOwner],
    );
  }
}

function parseNumberArray(value: unknown): number[] {
  return parseArray(value)
    .map((item) => Number.parseInt(String(item ?? ""), 10))
    .filter((item) => Number.isFinite(item));
}

function parseModeCounts(value: unknown): Record<TelegramForwardMode, number> {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : typeof value === "string"
        ? safeParseObject(value)
        : {};

  return {
    copy: toNonNegativeInteger(source.copy),
    forward: toNonNegativeInteger(source.forward),
  };
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }

  return [];
}

function safeParseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch (_error) {
    return {};
  }
}

function toNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return Math.floor(parsed);
}
