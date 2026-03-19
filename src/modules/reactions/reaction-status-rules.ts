import fs from "node:fs/promises";

export type ReactionStageRule = {
  heartCount: number;
  statusId: number;
  code: string;
};

export type ReactionStatusRules = {
  materialsStatusId: number;
  missingFileStatusId: number | null;
  missingTelegramStatusId: number | null;
  stages: ReactionStageRule[];
  rollback: "ignore";
};

type RawReactionStatusRules = {
  materialsStatusId?: unknown;
  missingFileStatusId?: unknown;
  missingTelegramStatusId?: unknown;
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

function normalizeStage(value: unknown): ReactionStageRule | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const source = value as Record<string, unknown>;
  const heartCount = parsePositiveInt(source.heartCount);
  const statusId = parsePositiveInt(source.statusId);
  const code = String(source.code ?? "").trim().toUpperCase();

  if (!heartCount || !statusId) {
    return null;
  }

  return {
    heartCount,
    statusId,
    code: code || `STAGE_${heartCount}`,
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
  const stageMap = new Map<number, ReactionStageRule>();

  for (const item of stagesRaw) {
    const normalized = normalizeStage(item);
    if (!normalized) {
      continue;
    }

    const existing = stageMap.get(normalized.heartCount);
    if (!existing) {
      stageMap.set(normalized.heartCount, normalized);
      continue;
    }

    // Keep first stage for a threshold to avoid ambiguous transitions.
  }

  const stages = Array.from(stageMap.values()).sort(
    (left, right) => left.heartCount - right.heartCount,
  );
  if (stages.length === 0) {
    throw new Error("reaction-status-rules: at least one stage is required.");
  }

  return {
    materialsStatusId,
    missingFileStatusId,
    missingTelegramStatusId,
    stages,
    rollback: "ignore",
  };
}

export function resolveStageForHeartCount(
  stages: ReactionStageRule[],
  heartCount: number,
): { index: number; stage: ReactionStageRule } | null {
  if (!Number.isFinite(heartCount) || heartCount <= 0) {
    return null;
  }

  let resolvedIndex = -1;
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    if (!stage) {
      continue;
    }

    if (heartCount >= stage.heartCount) {
      resolvedIndex = index;
      continue;
    }

    break;
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
