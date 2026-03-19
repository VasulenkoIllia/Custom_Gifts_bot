import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  loadReactionStatusRules,
  resolveStageForHeartCount,
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
  assert.equal(rules.stages.length, 2);
  assert.equal(rules.stages[0]?.heartCount, 1);
  assert.equal(rules.stages[1]?.heartCount, 2);
});

test("resolveStageForHeartCount resolves highest matching stage", () => {
  const stages = [
    { heartCount: 1, statusId: 22, code: "PRINT" },
    { heartCount: 2, statusId: 7, code: "PACKING" },
  ];

  const stageAt1 = resolveStageForHeartCount(stages, 1);
  assert.equal(stageAt1?.index, 0);
  assert.equal(stageAt1?.stage.statusId, 22);

  const stageAt2 = resolveStageForHeartCount(stages, 2);
  assert.equal(stageAt2?.index, 1);
  assert.equal(stageAt2?.stage.statusId, 7);

  const stageAt3 = resolveStageForHeartCount(stages, 3);
  assert.equal(stageAt3?.index, 1);
  assert.equal(stageAt3?.stage.code, "PACKING");
});

test("resolveStageForHeartCount returns null below threshold", () => {
  const stages = [{ heartCount: 1, statusId: 22, code: "PRINT" }];
  assert.equal(resolveStageForHeartCount(stages, 0), null);
});
