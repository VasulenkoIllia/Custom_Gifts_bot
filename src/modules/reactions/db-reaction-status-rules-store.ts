import type { DatabaseClient } from "../db/postgres-client";
import type { ReactionStageRule, ReactionStatusRules } from "./reaction-status-rules";

type ReactionRuleConfigRow = {
  materials_status_id: number;
  missing_file_status_id: number | null;
  missing_telegram_status_id: number | null;
  rollback_mode: string;
};

type ReactionStageRuleRow = {
  code: string;
  sort_order: number;
  count_threshold: number;
  status_id: number;
  emoji: string;
  emoji_aliases: unknown;
  enabled: boolean;
};

function normalizeEmojiAliases(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return normalizeEmojiAliases(parsed);
    } catch (_error) {
      return [];
    }
  }

  return [];
}

function buildAllowedEmojis(stages: ReactionStageRule[]): string[] {
  const seen = new Set<string>();

  for (const stage of stages) {
    const values = [stage.emoji, ...stage.emojiAliases];
    for (const emoji of values) {
      const normalized = String(emoji ?? "").trim();
      if (normalized) {
        seen.add(normalized);
      }
    }
  }

  return Array.from(seen.values());
}

export class DbReactionStatusRulesStore {
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  async init(): Promise<void> {
    // Schema is created by ensurePostgresSchema.
  }

  async seedIfEmpty(seed: ReactionStatusRules): Promise<void> {
    await this.db.query(
      `
        INSERT INTO reaction_rule_config(
          singleton_key,
          materials_status_id,
          missing_file_status_id,
          missing_telegram_status_id,
          rollback_mode,
          updated_at
        )
        VALUES('default', $1, $2, $3, $4, NOW())
        ON CONFLICT (singleton_key) DO NOTHING
      `,
      [
        seed.materialsStatusId,
        seed.missingFileStatusId,
        seed.missingTelegramStatusId,
        seed.rollback,
      ],
    );

    for (let index = 0; index < seed.stages.length; index += 1) {
      const stage = seed.stages[index];
      if (!stage) {
        continue;
      }
      await this.db.query(
        `
          INSERT INTO reaction_stage_rules(
            code,
            sort_order,
            count_threshold,
            status_id,
            emoji,
            emoji_aliases,
            enabled,
            updated_at
          )
          VALUES($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())
          ON CONFLICT (code) DO NOTHING
        `,
        [
          stage.code,
          index,
          stage.countThreshold,
          stage.statusId,
          stage.emoji,
          JSON.stringify(stage.emojiAliases),
          stage.enabled,
        ],
      );
    }
  }

  async load(): Promise<ReactionStatusRules> {
    const configResult = await this.db.query<ReactionRuleConfigRow>(
      `
        SELECT materials_status_id, missing_file_status_id, missing_telegram_status_id, rollback_mode
        FROM reaction_rule_config
        WHERE singleton_key = 'default'
        LIMIT 1
      `,
    );

    if (configResult.rowCount <= 0 || !configResult.rows[0]) {
      throw new Error("Reaction status rules are not configured in database.");
    }

    const stagesResult = await this.db.query<ReactionStageRuleRow>(
      `
        SELECT code, sort_order, count_threshold, status_id, emoji, emoji_aliases, enabled
        FROM reaction_stage_rules
        ORDER BY sort_order ASC, code ASC
      `,
    );

    if (stagesResult.rowCount <= 0) {
      throw new Error("Reaction stage rules are not configured in database.");
    }

    const stages: ReactionStageRule[] = stagesResult.rows.map((row) => ({
      code: String(row.code ?? "").trim().toUpperCase(),
      countThreshold: Math.max(1, Math.floor(Number(row.count_threshold))),
      statusId: Math.max(1, Math.floor(Number(row.status_id))),
      emoji: String(row.emoji ?? "").trim(),
      emojiAliases: normalizeEmojiAliases(row.emoji_aliases),
      enabled: Boolean(row.enabled),
    }));

    const config = configResult.rows[0];

    return {
      materialsStatusId: Math.max(1, Math.floor(Number(config.materials_status_id))),
      missingFileStatusId:
        Number.isFinite(Number(config.missing_file_status_id)) &&
        Number(config.missing_file_status_id) > 0
          ? Math.floor(Number(config.missing_file_status_id))
          : null,
      missingTelegramStatusId:
        Number.isFinite(Number(config.missing_telegram_status_id)) &&
        Number(config.missing_telegram_status_id) > 0
          ? Math.floor(Number(config.missing_telegram_status_id))
          : null,
      allowedEmojis: buildAllowedEmojis(stages),
      stages,
      rollback: String(config.rollback_mode ?? "").trim() === "ignore" ? "ignore" : "ignore",
    };
  }
}
