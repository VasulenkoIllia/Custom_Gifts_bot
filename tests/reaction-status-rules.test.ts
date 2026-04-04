import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  loadReactionStatusRules,
  resolveStageForReactionCounts,
} from "../src/modules/reactions/reaction-status-rules";

const rulesPath = path.resolve(
  process.cwd(),
  "config/business-rules/reaction-status-rules.json",
);

test("loadReactionStatusRules parses materials status and sorted stages", async () => {
  const rules = await loadReactionStatusRules(rulesPath);
  assert.equal(rules.materialsStatusId, 20);
  assert.equal(rules.missingFileStatusId, 40);
  assert.equal(rules.missingTelegramStatusId, 59);
  assert.equal(rules.allowedEmojis.includes("❤️"), true);
  assert.equal(rules.allowedEmojis.includes("👍"), true);
  assert.equal(rules.stages.length, 2);
  assert.equal(rules.stages[0]?.countThreshold, 1);
  assert.equal(rules.stages[1]?.countThreshold, 1);
  assert.equal(rules.stages[0]?.emoji, "❤️");
  assert.equal(rules.stages[1]?.emoji, "👍");
  assert.equal(rules.stages[1]?.enabled, false);
});

test("resolveStageForReactionCounts resolves by emoji thresholds and aliases", () => {
  const stages = [
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
      enabled: true,
    },
  ];

  const stageAt2 = resolveStageForReactionCounts(stages, { "❤️": 1, "👍": 1 });
  assert.equal(stageAt2?.index, 1);
  assert.equal(stageAt2?.stage.statusId, 7);

  const stageViaAlias = resolveStageForReactionCounts(stages, { "♥": 1 });
  assert.equal(stageViaAlias?.index, 0);
  assert.equal(stageViaAlias?.stage.code, "PRINT");
});

test("resolveStageForReactionCounts ignores disabled stages and below-threshold values", () => {
  const stages = [
    {
      code: "PRINT",
      emoji: "❤️",
      emojiAliases: [],
      countThreshold: 1,
      statusId: 22,
      enabled: false,
    },
  ];
  assert.equal(resolveStageForReactionCounts(stages, { "❤️": 1 }), null);
});
