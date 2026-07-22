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
  selectIntegrationPortOffset,
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

test("integration selects a proven-free deterministic isolated backend port", async () => {
  const seen = [];
  const selected = await selectIntegrationPortOffset({
    preferredOffset: 7,
    isPortFree: async (port) => {
      seen.push(port);
      return port === 18_088;
    },
  });

  assert.deepEqual(selected, { offset: 8, backendPort: 18_088 });
  assert.deepEqual(seen, [18_087, 18_088]);
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

test("artifact allocation rejects a parent symlink that resolves inside a repository", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-integration-symlink-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, "repository");
  const externalRoot = path.join(root, "external");
  const linkedParent = path.join(externalRoot, "linked-artifacts");
  await fs.mkdir(repositoryRoot);
  await fs.mkdir(externalRoot);
  await fs.symlink(repositoryRoot, linkedParent, "dir");

  await assert.rejects(
    () =>
      resolveIntegrationArtifactRoot({
        parent: linkedParent,
        repositoryRoots: [repositoryRoot],
      }),
    /outside repository.*symlink|after symlink resolution/i,
  );
});

test("integration rebuilds clean checkout and attests exact backend, agent, and web tree hashes", async (t) => {
  const { buildCaptureCheckout, verifyCaptureBuildProvenance } =
    await import("./run-capture-integration.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-build-proof-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, "repo");
  const webRoot = path.join(repoRoot, "apps", "web");
  const backendDir = path.join(repoRoot, "apps", "backend", "bin");
  const webDist = path.join(webRoot, "dist");
  const artifactRoot = path.join(root, "artifacts");
  await Promise.all([
    fs.mkdir(backendDir, { recursive: true }),
    fs.mkdir(path.join(webDist, "assets"), { recursive: true }),
    fs.mkdir(artifactRoot),
  ]);
  await Promise.all([
    fs.writeFile(path.join(backendDir, "kandev"), "backend-current-sha"),
    fs.writeFile(path.join(backendDir, "mock-agent"), "agent-current-sha"),
    fs.writeFile(path.join(webDist, "index.html"), "<main>current sha</main>"),
    fs.writeFile(path.join(webDist, "assets", "app.js"), "current-sha-js"),
  ]);
  const source = {
    contract: "kandev-highlight-source-v1",
    source: "pr_head",
    selectedSha: "1".repeat(40),
    headSha: "1".repeat(40),
    currentMainSha: "2".repeat(40),
    clean: true,
    status: "",
  };
  const commands = [];
  let gateCalls = 0;
  const result = await buildCaptureCheckout({
    repoRoot,
    webRoot,
    artifactRoot,
    verifySource: async () => {
      gateCalls += 1;
      return source;
    },
    runCommand: async (command) => commands.push(command),
    packageManager: { command: "/usr/bin/node", args: ["/opt/pnpm.js"] },
    now: () => new Date("2026-07-22T12:00:00.000Z"),
  });

  assert.equal(gateCalls, 2, "source gate runs before and after build");
  assert.equal(commands.length, 2);
  assert.deepEqual(commands[0], {
    command: "make",
    args: ["-C", "apps/backend", "build"],
    cwd: repoRoot,
  });
  assert.deepEqual(commands[1], {
    command: "/usr/bin/node",
    args: ["/opt/pnpm.js", "--filter", "@kandev/web", "build"],
    cwd: path.join(repoRoot, "apps"),
  });
  assert.equal(result.manifest.source.selectedSha, source.selectedSha);
  assert.match(result.manifest.manifestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.manifest.outputs.backend.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.manifest.outputs.mockAgent.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.manifest.outputs.webDist.fileCount, 2);
  assert.match(result.manifest.outputs.webDist.digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    await verifyCaptureBuildProvenance(result.manifestPath, {
      expectedSourceSha: source.selectedSha,
    }),
    result.manifest,
  );

  await fs.writeFile(path.join(webDist, "index.html"), "tampered");
  await assert.rejects(
    () =>
      verifyCaptureBuildProvenance(result.manifestPath, {
        expectedSourceSha: source.selectedSha,
      }),
    /web dist.*digest|build output.*changed/i,
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
