import type { DatabaseClient } from "../db/postgres-client";
import type {
  TelegramDestination,
  TelegramDestinationCode,
  TelegramForwardMode,
  TelegramRoutingConfig,
} from "./telegram-routing-config";

type TelegramRoutingSettingsRow = {
  forward_mode: string;
};

type TelegramRoutingDestinationRow = {
  destination: string;
  chat_id: string;
  thread_id: string;
};

function normalizeDestination(value: TelegramDestination): TelegramDestination {
  return {
    chatId: String(value.chatId ?? "").trim(),
    threadId: String(value.threadId ?? "").trim(),
  };
}

function normalizeForwardMode(value: unknown): TelegramForwardMode {
  return String(value ?? "").trim().toLowerCase() === "forward" ? "forward" : "copy";
}

function assertRequiredDestination(
  code: TelegramDestinationCode,
  destination: TelegramDestination,
): void {
  if (!destination.chatId) {
    throw new Error(`Telegram routing destination "${code}" is missing chatId.`);
  }
}

export class DbTelegramRoutingConfigStore {
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  async init(): Promise<void> {
    // Schema is created by ensurePostgresSchema.
  }

  async seedIfEmpty(seed: TelegramRoutingConfig): Promise<void> {
    const processing = normalizeDestination(seed.destinations.processing);
    const orders = normalizeDestination(seed.destinations.orders);
    const ops = normalizeDestination(seed.destinations.ops);
    const settingsResult = await this.db.query<{ singleton_key: string }>(
      `
        SELECT singleton_key
        FROM telegram_routing_settings
        WHERE singleton_key = 'default'
        LIMIT 1
      `,
    );

    if (settingsResult.rowCount <= 0) {
      await this.db.query(
        `
          INSERT INTO telegram_routing_settings(singleton_key, forward_mode, updated_at)
          VALUES('default', $1, NOW())
          ON CONFLICT (singleton_key) DO NOTHING
        `,
        [normalizeForwardMode(seed.forwardMode)],
      );
    }

    const destinations: Array<[TelegramDestinationCode, TelegramDestination]> = [
      ["processing", processing],
      ["orders", orders],
      ["ops", ops],
    ];

    const existingDestinationsResult = await this.db.query<{ destination: string }>(
      `
        SELECT destination
        FROM telegram_routing_destinations
        WHERE destination IN ('processing', 'orders', 'ops')
      `,
    );
    const existingDestinations = new Set(
      existingDestinationsResult.rows
        .map((row) => String(row.destination ?? "").trim())
        .filter(Boolean),
    );

    for (const [destination, value] of destinations) {
      if (existingDestinations.has(destination)) {
        continue;
      }

      assertRequiredDestination(destination, value);
      await this.db.query(
        `
          INSERT INTO telegram_routing_destinations(destination, chat_id, thread_id, updated_at)
          VALUES($1, $2, $3, NOW())
          ON CONFLICT (destination) DO NOTHING
        `,
        [destination, value.chatId, value.threadId],
      );
    }
  }

  async load(): Promise<TelegramRoutingConfig> {
    const settings = await this.db.query<TelegramRoutingSettingsRow>(
      `
        SELECT forward_mode
        FROM telegram_routing_settings
        WHERE singleton_key = 'default'
        LIMIT 1
      `,
    );

    if (settings.rowCount <= 0 || !settings.rows[0]) {
      throw new Error("Telegram routing settings are not configured in database.");
    }

    const destinationsResult = await this.db.query<TelegramRoutingDestinationRow>(
      `
        SELECT destination, chat_id, thread_id
        FROM telegram_routing_destinations
        WHERE destination IN ('processing', 'orders', 'ops')
      `,
    );

    const destinations = new Map<TelegramDestinationCode, TelegramDestination>();
    for (const row of destinationsResult.rows) {
      const destination = String(row.destination ?? "").trim() as TelegramDestinationCode;
      if (destination !== "processing" && destination !== "orders" && destination !== "ops") {
        continue;
      }

      destinations.set(destination, {
        chatId: String(row.chat_id ?? "").trim(),
        threadId: String(row.thread_id ?? "").trim(),
      });
    }

    const processing = destinations.get("processing");
    const orders = destinations.get("orders");
    const ops = destinations.get("ops");
    if (!processing?.chatId || !orders?.chatId || !ops?.chatId) {
      throw new Error("Telegram routing destinations are incomplete in database.");
    }

    return {
      forwardMode: normalizeForwardMode(settings.rows[0].forward_mode),
      destinations: {
        processing,
        orders,
        ops,
      },
    };
  }
}
