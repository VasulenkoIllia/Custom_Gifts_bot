import assert from "node:assert/strict";
import test from "node:test";
import type { DbQueryResult, DatabaseClient } from "../src/modules/db/postgres-client";
import { DbReactionStatusRulesStore } from "../src/modules/reactions/db-reaction-status-rules-store";
import type { ReactionStatusRules } from "../src/modules/reactions/reaction-status-rules";

type ReactionConfigRow = {
  materials_status_id: number;
  missing_file_status_id: number | null;
  missing_telegram_status_id: number | null;
  rollback_mode: string;
};

type ReactionStageRow = {
  code: string;
  sort_order: number;
  count_threshold: number;
  status_id: number;
  emoji: string;
  emoji_aliases: string[];
  enabled: boolean;
};

class InMemoryReactionRulesDb implements DatabaseClient {
  private config: ReactionConfigRow | null = null;
  private readonly stages = new Map<string, ReactionStageRow>();

  async query<TRow = Record<string, unknown>>(
    text: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<DbQueryResult<TRow>> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("INSERT INTO reaction_rule_config(")) {
      if (!this.config) {
        this.config = {
          materials_status_id: Number(params[0]),
          missing_file_status_id:
            Number.isFinite(Number(params[1])) && Number(params[1]) > 0 ? Number(params[1]) : null,
          missing_telegram_status_id:
            Number.isFinite(Number(params[2])) && Number(params[2]) > 0 ? Number(params[2]) : null,
          rollback_mode: String(params[3] ?? "ignore"),
        };
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("INSERT INTO reaction_stage_rules(")) {
      const code = String(params[0] ?? "").trim();
      if (!this.stages.has(code)) {
        this.stages.set(code, {
          code,
          sort_order: Number(params[1]),
          count_threshold: Number(params[2]),
          status_id: Number(params[3]),
          emoji: String(params[4] ?? ""),
          emoji_aliases: JSON.parse(String(params[5] ?? "[]")) as string[],
          enabled: Boolean(params[6]),
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("SELECT materials_status_id, missing_file_status_id, missing_telegram_status_id, rollback_mode FROM reaction_rule_config")) {
      return {
        rows: this.config ? ([this.config] as TRow[]) : [],
        rowCount: this.config ? 1 : 0,
      };
    }

    if (sql.startsWith("SELECT code, sort_order, count_threshold, status_id, emoji, emoji_aliases, enabled FROM reaction_stage_rules")) {
      const rows = Array.from(this.stages.values()).sort(
        (left, right) => left.sort_order - right.sort_order || left.code.localeCompare(right.code),
      );
      return {
        rows: rows as TRow[],
        rowCount: rows.length,
      };
    }

    throw new Error(`Unsupported SQL in test double: ${sql}`);
  }

  async close(): Promise<void> {
    // no-op
  }
}

test("DbReactionStatusRulesStore seeds JSON rules into DB and loads them back", async () => {
  const db = new InMemoryReactionRulesDb();
  const store = new DbReactionStatusRulesStore(db);
  await store.init();

  const seed: ReactionStatusRules = {
    materialsStatusId: 20,
    missingFileStatusId: 40,
    missingTelegramStatusId: 59,
    allowedEmojis: ["❤️", "❤", "♥️", "♥", "👍"],
    rollback: "ignore",
    stages: [
      {
        code: "PRINT",
        emoji: "❤️",
        emojiAliases: ["❤", "♥️", "♥"],
        countThreshold: 1,
        statusId: 22,
        enabled: true,
      },
      {
        code: "PACKING",
        emoji: "👍",
        emojiAliases: [],
        countThreshold: 1,
        statusId: 7,
        enabled: false,
      },
    ],
  };

  await store.seedIfEmpty(seed);
  const loaded = await store.load();

  assert.equal(loaded.materialsStatusId, 20);
  assert.equal(loaded.missingFileStatusId, 40);
  assert.equal(loaded.missingTelegramStatusId, 59);
  assert.deepEqual(loaded.allowedEmojis, ["❤️", "❤", "♥️", "♥", "👍"]);
  assert.equal(loaded.stages.length, 2);
  assert.equal(loaded.stages[0]?.code, "PRINT");
  assert.equal(loaded.stages[1]?.enabled, false);
});
