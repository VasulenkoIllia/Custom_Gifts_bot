import type { DatabaseClient } from "../db/postgres-client";

export type TelegramDeliveryRecord = {
  deliveryKey: string;
  orderId: string;
  chatId: string;
  messageIds: number[];
  previewMessageIds: number[];
  caption: string;
  warnings: string[];
};

export type TelegramDeliveryAcquireResult =
  | { outcome: "acquired" }
  | { outcome: "busy" }
  | { outcome: "sent"; record: TelegramDeliveryRecord };

type DeliveryRow = {
  delivery_key: string;
  order_id: string;
  status: string;
  chat_id: string | null;
  message_ids: unknown;
  preview_message_ids: unknown;
  caption: string | null;
  warnings: unknown;
};

export class DbTelegramDeliveryStore {
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  async init(): Promise<void> {
    // Schema is created by ensurePostgresSchema.
  }

  async acquire(params: {
    deliveryKey: string;
    orderId: string;
    leaseOwner: string;
    leaseTtlMs: number;
  }): Promise<TelegramDeliveryAcquireResult> {
    const result = await this.db.query<DeliveryRow & { outcome: string }>(
      `
        WITH delivery_lock AS (
          SELECT pg_advisory_xact_lock(hashtext($1))
        ),
        existing AS (
          SELECT *
          FROM telegram_delivery_records
          WHERE delivery_key = $1
        ),
        inserted AS (
          INSERT INTO telegram_delivery_records(
            delivery_key,
            order_id,
            status,
            lease_owner,
            lease_expires_at,
            created_at,
            updated_at
          )
          SELECT
            $1,
            $2,
            'pending',
            $3,
            NOW() + ($4 * INTERVAL '1 millisecond'),
            NOW(),
            NOW()
          WHERE NOT EXISTS (SELECT 1 FROM existing)
          RETURNING *
        ),
        reacquired AS (
          UPDATE telegram_delivery_records
          SET
            lease_owner = $3,
            lease_expires_at = NOW() + ($4 * INTERVAL '1 millisecond'),
            updated_at = NOW()
          WHERE delivery_key = $1
            AND status = 'pending'
            AND (
              lease_owner IS NULL
              OR lease_owner = $3
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
          delivery_key,
          order_id,
          status,
          chat_id,
          message_ids,
          preview_message_ids,
          caption,
          warnings
        FROM (
          SELECT * FROM inserted
          UNION ALL
          SELECT * FROM reacquired
          UNION ALL
          SELECT * FROM existing
        ) AS candidate
        LIMIT 1
      `,
      [params.deliveryKey, params.orderId, params.leaseOwner, params.leaseTtlMs],
    );

    const row = result.rows[0];
    if (!row) {
      return { outcome: "acquired" };
    }

    if (row.outcome === "sent") {
      return {
        outcome: "sent",
        record: toDeliveryRecord(row),
      };
    }

    if (row.outcome === "busy") {
      return { outcome: "busy" };
    }

    return { outcome: "acquired" };
  }

  async complete(
    leaseOwner: string,
    record: TelegramDeliveryRecord,
  ): Promise<void> {
    await this.db.query(
      `
        UPDATE telegram_delivery_records
        SET
          status = 'sent',
          lease_owner = NULL,
          lease_expires_at = NULL,
          chat_id = $3,
          message_ids = $4::jsonb,
          preview_message_ids = $5::jsonb,
          caption = $6,
          warnings = $7::jsonb,
          finished_at = NOW(),
          updated_at = NOW()
        WHERE delivery_key = $1
          AND order_id = $2
          AND (lease_owner = $8 OR lease_owner IS NULL)
      `,
      [
        record.deliveryKey,
        record.orderId,
        record.chatId,
        JSON.stringify(record.messageIds),
        JSON.stringify(record.previewMessageIds),
        record.caption,
        JSON.stringify(record.warnings),
        leaseOwner,
      ],
    );
  }

  async release(deliveryKey: string, leaseOwner: string): Promise<void> {
    await this.db.query(
      `
        UPDATE telegram_delivery_records
        SET
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = NOW()
        WHERE delivery_key = $1
          AND status = 'pending'
          AND lease_owner = $2
      `,
      [deliveryKey, leaseOwner],
    );
  }
}

function toDeliveryRecord(row: DeliveryRow): TelegramDeliveryRecord {
  return {
    deliveryKey: String(row.delivery_key ?? "").trim(),
    orderId: String(row.order_id ?? "").trim(),
    chatId: String(row.chat_id ?? "").trim(),
    messageIds: parseNumberArray(row.message_ids),
    previewMessageIds: parseNumberArray(row.preview_message_ids),
    caption: String(row.caption ?? "").trim(),
    warnings: parseStringArray(row.warnings),
  };
}

function parseNumberArray(value: unknown): number[] {
  const list = parseArray(value);
  return list
    .map((item) => Number.parseInt(String(item ?? ""), 10))
    .filter((item) => Number.isFinite(item));
}

function parseStringArray(value: unknown): string[] {
  const list = parseArray(value);
  return list.map((item) => String(item ?? "").trim()).filter(Boolean);
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
