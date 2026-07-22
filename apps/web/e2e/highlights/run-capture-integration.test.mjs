import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileTimeline, readScenario } from "../../../../scripts/highlights/scenario.mjs";
import {
  buildIntegrationCommand,
  preflightCaptureIntegration,
  resolveIntegrationArtifactRoot,
} from "./run-capture-integration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "../..");
const REPO_ROOT = path.resolve(WEB_ROOT, "../..");

test("checked quick-start scenario is executable, short, semantic, and has no camera zoom", async () => {
  const scenario = await readScenario(path.join(HERE, "quick-start.scenario.json"));
  const timeline = compileTimeline(scenario);

  assert.equal(scenario.profile.kind, "desktop");
  assert.deepEqual(scenario.profile.viewport, { width: 1920, height: 1200 });
  assert.equal(scenario.profile.deviceScaleFactor, 2);
  assert.equal(scenario.seed.recipe, "kandev.highlight.quick-start");
  assert.ok(timeline.totalDurationMs <= 4_000);
  assert.equal(timeline.initialCameraZoom, 1);
  const waits = timeline.events.filter((event) => event.kind === "waitForVisible");
  assert.equal(waits.length, 2);
  assert.equal(
    waits.every((event) => event.durationMs === 0 && event.timeoutBoundMs === 5_000),
    true,
  );
  assert.equal(
    scenario.story.actions.some((action) => action.kind.startsWith("camera")),
    false,
  );
  for (const action of scenario.story.actions) {
    for (const target of [action.target, action.from, action.to].filter(Boolean)) {
      assert.ok(target.testId || (target.role && target.name));
      assert.equal("css" in target || "xpath" in target, false);
    }
  }
});

test("integration command uses dedicated config and package exposes exact documented command", async () => {
  const command = buildIntegrationCommand({ webRoot: WEB_ROOT, packageManagerScript: null });
  const packageJson = JSON.parse(await fs.readFile(path.join(WEB_ROOT, "package.json"), "utf8"));

  assert.deepEqual(command, {
    command: "pnpm",
    args: ["exec", "playwright", "test", "--config", "e2e/highlights/playwright.config.ts"],
    cwd: WEB_ROOT,
  });
  assert.equal(
    packageJson.scripts["e2e:highlight-capture"],
    "node e2e/highlights/run-capture-integration.mjs",
  );
});

test("integration command reuses the active package manager when bare pnpm is unavailable", () => {
  const command = buildIntegrationCommand({
    webRoot: WEB_ROOT,
    nodeExecutable: "/usr/bin/node",
    packageManagerScript: "/opt/corepack/pnpm.js",
  });

  assert.deepEqual(command, {
    command: "/usr/bin/node",
    args: [
      "/opt/corepack/pnpm.js",
      "exec",
      "playwright",
      "test",
      "--config",
      "e2e/highlights/playwright.config.ts",
    ],
    cwd: WEB_ROOT,
  });
});

test("artifact allocation is external, unique, and refuses repository paths", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-integration-root-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));

  const first = await resolveIntegrationArtifactRoot({
    parent: temp,
    repositoryRoots: [REPO_ROOT],
  });
  const second = await resolveIntegrationArtifactRoot({
    parent: temp,
    repositoryRoots: [REPO_ROOT],
  });

  assert.notEqual(first, second);
  assert.equal(path.dirname(first), temp);
  assert.equal((await fs.stat(first)).isDirectory(), true);
  await assert.rejects(
    () =>
      resolveIntegrationArtifactRoot({
        parent: path.join(REPO_ROOT, ".capture"),
        repositoryRoots: [REPO_ROOT],
      }),
    /outside repository/,
  );
});

test("preflight reports every missing external prerequisite with repair commands", async () => {
  await assert.rejects(
    () =>
      preflightCaptureIntegration({
        webRoot: WEB_ROOT,
        findExecutable: async (name) => (name === "ffmpeg" ? "/usr/bin/ffmpeg" : null),
        resolveChromium: async () => "/missing/playwright/chromium",
        exists: async () => false,
      }),
    (error) => {
      assert.match(error.message, /Xvfb.*install/i);
      assert.match(error.message, /Playwright Chromium.*pnpm exec playwright install chromium/i);
      assert.match(error.message, /make -C apps\/backend build/i);
      assert.match(error.message, /pnpm --filter @kandev\/web build/i);
      return true;
    },
  );
});
