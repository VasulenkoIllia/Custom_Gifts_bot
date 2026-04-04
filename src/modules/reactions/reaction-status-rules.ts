import fs from "node:fs/promises";

export type ReactionStageRule = {
  countThreshold: number;
  statusId: number;
  code: string;
  emoji: string;
  emojiAliases: string[];
  enabled: boolean;
};

export type ReactionStatusRules = {
  materialsStatusId: number;
  missingFileStatusId: number | null;
  missingTelegramStatusId: number | null;
  allowedEmojis: string[];
  stages: ReactionStageRule[];
  rollback: "ignore";
};

type RawReactionStatusRules = {
  materialsStatusId?: unknown;
  missingFileStatusId?: unknown;
  missingTelegramStatusId?: unknown;
  allowedEmojis?: unknown;
  stages?: unknown;
  rollback?: unknown;
};

function parsePositiveInt(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }

  return fallback;
}

function normalizeEmojiList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  for (const item of value) {
    const emoji = String(item ?? "").trim();
    if (!emoji) {
      continue;
    }

    seen.add(emoji);
  }

  return Array.from(seen.values());
}

function normalizeStage(value: unknown, index: number): ReactionStageRule | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const source = value as Record<string, unknown>;
  const countThreshold =
    parsePositiveInt(source.countThreshold) ?? parsePositiveInt(source.heartCount);
  const statusId = parsePositiveInt(source.statusId);
  const code = String(source.code ?? "").trim().toUpperCase();
  const emoji = String(source.emoji ?? "").trim();
  const emojiAliases = normalizeEmojiList(source.emojiAliases);
  const enabled = parseBoolean(source.enabled, true);

  if (!countThreshold || !statusId || !emoji) {
    return null;
  }

  return {
    countThreshold,
    statusId,
    code: code || `STAGE_${index + 1}`,
    emoji,
    emojiAliases,
    enabled,
  };
}

export async function loadReactionStatusRules(filePath: string): Promise<ReactionStatusRules> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as RawReactionStatusRules;

  const materialsStatusId = parsePositiveInt(parsed.materialsStatusId);
  if (!materialsStatusId) {
    throw new Error("reaction-status-rules: materialsStatusId is required.");
  }

  const missingFileStatusId = parsePositiveInt(parsed.missingFileStatusId);
  const missingTelegramStatusId = parsePositiveInt(parsed.missingTelegramStatusId);

  const stagesRaw = Array.isArray(parsed.stages) ? parsed.stages : [];
  const stageMap = new Map<string, ReactionStageRule>();

  for (let index = 0; index < stagesRaw.length; index += 1) {
    const item = stagesRaw[index];
    const normalized = normalizeStage(item, index);
    if (!normalized) {
      continue;
    }

    const existing = stageMap.get(normalized.code);
    if (!existing) {
      stageMap.set(normalized.code, normalized);
      continue;
    }

    // Keep first stage for a code to avoid ambiguous transitions.
  }

  const stages = Array.from(stageMap.values());
  if (stages.length === 0) {
    throw new Error("reaction-status-rules: at least one stage is required.");
  }

  const allowedEmojis = normalizeEmojiList(parsed.allowedEmojis);
  for (const stage of stages) {
    allowedEmojis.push(stage.emoji);
    stage.emojiAliases.forEach((emoji) => {
      allowedEmojis.push(emoji);
    });
  }

  const deduplicatedAllowedEmojis = Array.from(
    new Set(allowedEmojis.map((value) => value.trim()).filter(Boolean)),
  );
  if (deduplicatedAllowedEmojis.length === 0) {
    throw new Error("reaction-status-rules: allowedEmojis is required.");
  }

  return {
    materialsStatusId,
    missingFileStatusId,
    missingTelegramStatusId,
    allowedEmojis: deduplicatedAllowedEmojis,
    stages,
    rollback: "ignore",
  };
}

function getStageReactionCount(
  stage: Pick<ReactionStageRule, "emoji" | "emojiAliases">,
  reactionCounts: Record<string, number>,
): number {
  const emojis = new Set<string>([stage.emoji, ...stage.emojiAliases]);
  let total = 0;

  for (const emoji of emojis) {
    const value = Number(reactionCounts[emoji] ?? 0);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }

    total += Math.max(0, Math.floor(value));
  }

  return total;
}

function normalizeReactionCounts(
  reactionCounts: Record<string, number> | null | undefined,
): Record<string, number> {
  if (!reactionCounts || typeof reactionCounts !== "object") {
    return {};
  }

  const normalized: Record<string, number> = {};
  for (const [emoji, value] of Object.entries(reactionCounts)) {
    const key = String(emoji ?? "").trim();
    if (!key) {
      continue;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      continue;
    }

    normalized[key] = Math.max(0, Math.floor(parsed));
  }

  return normalized;
}

export function resolveStageForReactionCounts(
  stages: ReactionStageRule[],
  reactionCounts: Record<string, number> | null | undefined,
): { index: number; stage: ReactionStageRule } | null {
  const normalizedReactionCounts = normalizeReactionCounts(reactionCounts);
  if (Object.keys(normalizedReactionCounts).length === 0) {
    return null;
  }

  let resolvedIndex = -1;
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    if (!stage) {
      continue;
    }

    if (!stage.enabled) {
      continue;
    }

    const count = getStageReactionCount(stage, normalizedReactionCounts);
    if (count >= stage.countThreshold) {
      resolvedIndex = index;
    }
  }

  if (resolvedIndex < 0) {
    return null;
  }

  const stage = stages[resolvedIndex];
  if (!stage) {
    return null;
  }

  return {
    index: resolvedIndex,
    stage,
  };
}

export function resolvePrimaryReactionCount(
  stages: ReactionStageRule[],
  reactionCounts: Record<string, number> | null | undefined,
): number {
  const normalizedReactionCounts = normalizeReactionCounts(reactionCounts);
  if (Object.keys(normalizedReactionCounts).length === 0) {
    return 0;
  }

  const firstStage = stages.find((stage) => stage.enabled) ?? stages[0];
  if (!firstStage) {
    return 0;
  }

  return getStageReactionCount(firstStage, normalizedReactionCounts);
}
