import assert from "node:assert/strict";
import test from "node:test";

import { runHighlightPipeline } from "./runner.mjs";

function adapters(log) {
  return {
    validate: async (input) => { log.push(["validate", input.dryRun]); return { scenario: input.scenario }; },
    storyboard: async (input) => { log.push(["storyboard", input.dryRun]); return { timeline: { durationMs: 1000 } }; },
    capture: async (input) => { log.push(["capture", input.dryRun]); return { rawPath: "/raw/master.mp4" }; },
    render: async (input) => { log.push(["render", input.dryRun]); return { artifacts: ["delivery.mp4"] }; },
    qa: async (input) => { log.push(["qa", input.dryRun]); return { passed: true }; },
    stage: async (input) => { log.push(["stage", input.dryRun]); return { reviewDir: "/review" }; },
  };
}

test("aggregate runner executes validate to stage in fixed order with threaded results", async () => {
  const log = [];
  const result = await runHighlightPipeline({
    scenario: { id: "tiny-story" },
    adapters: adapters(log),
  });
  assert.deepEqual(log.map(([name]) => name), ["validate", "storyboard", "capture", "render", "qa", "stage"]);
  assert.equal(result.phases.stage.reviewDir, "/review");
  assert.equal(result.order.join("→"), "validate→storyboard→capture→render→qa→stage");
  assert.equal(result.passed, true);
});

test("dry-run reaches every adapter without allowing mutation mode", async () => {
  const log = [];
  const result = await runHighlightPipeline({
    scenario: { id: "tiny-story" },
    adapters: adapters(log),
    dryRun: true,
  });
  assert.ok(log.every(([, dryRun]) => dryRun === true));
  assert.equal(result.dryRun, true);
});

test("phase failures carry phase and completed phase evidence", async () => {
  const log = [];
  const configured = adapters(log);
  configured.render = async () => { throw new Error("encoder unavailable"); };
  await assert.rejects(
    runHighlightPipeline({ scenario: { id: "tiny-story" }, adapters: configured }),
    (error) => {
      assert.equal(error.phase, "render");
      assert.deepEqual(error.completed, ["validate", "storyboard", "capture"]);
      assert.match(error.message, /render.*encoder unavailable/i);
      return true;
    },
  );
});
