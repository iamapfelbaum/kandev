import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { computeScenarioDigest } from "./scenario.mjs";

const runtimeDispatch = await import("./runtime-dispatch.mjs").catch(() => ({}));

const SOURCE_SHA = "1".repeat(40);
const MAIN_SHA = "2".repeat(40);
const BASE_SHA = "3".repeat(40);

test("runtime dispatch exposes a typed public command interface", async () => {
  const declarations = await fs.readFile(
    new URL("./runtime-dispatch.d.ts", import.meta.url),
    "utf8",
  );
  assert.match(declarations, /export interface TrustedHighlightCommandOptions/);
  assert.match(declarations, /export function runTrustedHighlightCommand/);
});

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function scenario({ delivery = true } = {}) {
  return {
    $schema: "https://kandev.com/schemas/highlight-scenario-v1.json",
    schemaVersion: 1,
    id: "quick-start",
    title: "Quick start",
    description: "Show one deterministic result.",
    profile: {
      kind: "desktop",
      viewport: { width: 1920, height: 1200 },
      deviceScaleFactor: 2,
    },
    seed: { recipe: "kandev.highlight.quick-start", parameters: {} },
    setup: { route: "workspace.board", primitives: [] },
    story: {
      recipe: "kandev.short-feature",
      openingSettleMs: 500,
      actions: [{ kind: "pause", durationMs: 500, label: "Hold result" }],
      endingSettleMs: 500,
    },
    ...(delivery
      ? {
          delivery: {
            revision: "r1",
            releaseVersion: "1.2.3",
            summary: "Show one result.",
            caption: "Hold one deterministic result.",
            featureFlags: ["features.highlights"],
            docs: { page: "tasks.md", section: "Quick start" },
            mobileDeclaration: "Desktop delivery only.",
            mobileRequired: false,
          },
        }
      : {}),
  };
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-runtime-dispatch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, "repo");
  const artifactRoot = path.join(root, "artifacts");
  const landingRoot = path.join(root, "landing");
  const scenarioPath = path.join(repoRoot, "quick-start.scenario.json");
  const value = scenario(options);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await fs.mkdir(repoRoot, { recursive: true });
  await fs.writeFile(scenarioPath, bytes);
  return {
    root,
    repoRoot,
    artifactRoot,
    landingRoot,
    scenarioPath,
    scenario: value,
    scenarioBytes: bytes.length,
    scenarioDigest: computeScenarioDigest(value),
  };
}

function sourceProof(repoRoot) {
  return {
    contract: "kandev-highlight-source-v1",
    source: "pr_head",
    repoRoot,
    selectedSha: SOURCE_SHA,
    headSha: SOURCE_SHA,
    currentMainSha: MAIN_SHA,
    clean: true,
    status: "",
  };
}

function successfulHostResult(request, fixtureValue) {
  const hostRoot = path.join(request.artifactRoot, "runtime-host", request.runId);
  const attemptRoot = path.join(
    request.artifactRoot,
    fixtureValue.scenario.id,
    "runs",
    request.runId,
  );
  const source = {
    contract: "kandev-highlight-source-v1",
    mode: "pr_head",
    selectedSha: SOURCE_SHA,
    headSha: SOURCE_SHA,
    currentMainSha: MAIN_SHA,
  };
  const body = {
    contract: "kandev-highlight-runtime-host-result-v1",
    version: 1,
    status: "succeeded",
    runtimeId: request.runtimeId,
    runId: request.runId,
    scenario: {
      id: fixtureValue.scenario.id,
      path: request.scenarioPath,
      bytes: fixtureValue.scenarioBytes,
      digest: fixtureValue.scenarioDigest,
    },
    source: {
      pre: source,
      post: structuredClone(source),
      unchanged: true,
    },
    bundle: {
      path: hostRoot,
      requestPath: path.join(hostRoot, "request.json"),
      workerResultPath: path.join(hostRoot, "worker-result.json"),
      logPath: path.join(hostRoot, "playwright.log"),
      failurePath: path.join(hostRoot, "failure.json"),
      resultPath: path.join(hostRoot, "result.json"),
    },
    request: { path: "/external/request", bytes: 1, digest: digest("request") },
    workerResult: { path: "/external/worker", bytes: 1, digest: digest("worker") },
    log: { path: "/external/log", bytes: 1, digest: digest("log") },
    applicationRuntime: {
      receiptPath: path.join(attemptRoot, "evidence", "application-runtime.json"),
      digest: digest("runtime"),
    },
    capture: {
      attemptRoot,
      scenarioDigest: fixtureValue.scenarioDigest,
      sourceDigest: digest("source"),
      phaseManifestPath: path.join(attemptRoot, "evidence", "capture.json"),
      phaseManifestDigest: digest("capture-phase"),
      captureManifestPath: path.join(attemptRoot, "capture", "evidence", "capture.json"),
      captureManifestDigest: digest("capture"),
      rawMasterPath: path.join(
        attemptRoot,
        "capture",
        "raw",
        `${fixtureValue.scenario.id}.source.mp4`,
      ),
      rawMasterDigest: digest("raw"),
      rawMaster: {
        path: path.join(attemptRoot, "capture", "raw", `${fixtureValue.scenario.id}.source.mp4`),
        bytes: 1,
        digest: digest("raw"),
      },
      captureEvidence: {
        contract: "kandev-highlight-capture-evidence-v1",
        version: 1,
        path: "/external/capture-content.json",
        bytes: 1,
        digest: digest("content"),
        visibleDomText: { records: 1, bytes: 4, digest: digest("dom"), truncated: false },
        browserConsole: { records: 0, bytes: 0, digest: digest("[]"), truncated: false },
      },
    },
    execution: {
      exitCode: 0,
      signal: null,
      timedOut: false,
      deadlineMs: 240_000,
      processGroup: {
        pid: 42_424,
        termSent: false,
        killSent: false,
        exited: true,
        gone: true,
      },
      log: {
        limitBytes: 8 * 1024 * 1024,
        capturedBytes: 1,
        discardedBytes: 0,
        truncated: false,
      },
    },
    teardown: {
      playwrightExited: true,
      playwrightProcessGroupGone: true,
      backendPortReleased: true,
      frontendPortReleased: true,
      fixtureTempRootOwned: true,
      fixtureTempRootRemoved: true,
      capture: {
        declared: true,
        cdpPortReleased: true,
        displayReleased: true,
        processesGone: true,
        recorderGone: true,
        profileRemoved: true,
        locksRemoved: true,
      },
    },
    failure: null,
    completedAt: "2026-07-22T00:02:00.000Z",
  };
  return { ...body, resultDigest: digest(canonicalJson(body)) };
}

function dispatch() {
  assert.equal(
    typeof runtimeDispatch.runTrustedHighlightCommand,
    "function",
    "runtime-dispatch Module must export its command Interface",
  );
  return runtimeDispatch.runTrustedHighlightCommand;
}

function dependencies(events, fixtureValue) {
  return {
    verifySourceGate: async () => {
      events.push("source");
      return sourceProof(fixtureValue.repoRoot);
    },
    resolvePrMetadata: async () => {
      events.push("pr");
      return { prNumber: 42, prBaseSha: BASE_SHA, prHeadSha: SOURCE_SHA };
    },
    buildCaptureCheckout: async ({ artifactRoot, source }) => {
      events.push("build");
      assert.equal(artifactRoot, path.join(fixtureValue.artifactRoot, "runtime-builds", "run-001"));
      assert.equal(source, "pr_head");
      return {
        manifestPath: path.join(artifactRoot, "evidence", "build-provenance.json"),
        manifest: {
          contract: "kandev-highlight-build-provenance-v1",
          manifestDigest: digest("build"),
          source: sourceProof(fixtureValue.repoRoot),
        },
      };
    },
    runRuntimeHost: async ({ request }) => {
      events.push("host");
      assert.equal(request.contract, "kandev-highlight-runtime-host-request-v1");
      assert.equal(request.runtimeId, "kandev-isolated-e2e");
      assert.equal(request.runId, "run-001");
      assert.deepEqual(request.pullRequest, { number: 42, baseSha: BASE_SHA });
      return successfulHostResult(request, fixtureValue);
    },
    pipelineRunner: async (options) => {
      events.push(options.command);
      assert.equal(options.runId, "run-001");
      assert.equal(options.source, undefined);
      return {
        contract: "kandev-highlight-command-v1",
        command: options.command,
        runId: options.runId,
        order: [options.command],
        phases: { [options.command]: { phase: options.command } },
      };
    },
  };
}

test("trusted capture defaults to the closed runtime and never calls the pipeline capture adapter", async (t) => {
  const value = await fixture(t);
  const events = [];
  const deps = dependencies(events, value);
  const pipeline = deps.pipelineRunner;
  deps.pipelineRunner = async (options) => {
    assert.notEqual(options.command, "capture", "CLI dispatch must never invoke pipeline capture");
    return pipeline(options);
  };

  const result = await dispatch()({
    command: "capture",
    scenarioPath: value.scenarioPath,
    artifactRoot: value.artifactRoot,
    source: "pr_head",
    runId: "run-001",
    prNumber: 42,
    prBaseSha: BASE_SHA,
    repoRoot: value.repoRoot,
    dependencies: deps,
  });

  assert.deepEqual(events, ["source", "pr", "build", "host"]);
  assert.equal(result.runtimeId, "kandev-isolated-e2e");
  assert.match(result.host.resultDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.order, ["validate", "storyboard", "capture"]);
});

test("trusted run validates delivery before build and orders host capture then render QA stage", async (t) => {
  const value = await fixture(t);
  const events = [];
  const deps = dependencies(events, value);

  const result = await dispatch()({
    command: "run",
    scenarioPath: value.scenarioPath,
    artifactRoot: value.artifactRoot,
    landingRoot: value.landingRoot,
    source: "pr_head",
    runId: "run-001",
    prNumber: 42,
    prBaseSha: BASE_SHA,
    repoRoot: value.repoRoot,
    dependencies: deps,
  });

  assert.deepEqual(events, ["source", "pr", "build", "host", "render", "qa", "stage"]);
  assert.deepEqual(result.order, ["validate", "storyboard", "capture", "render", "qa", "stage"]);
  assert.deepEqual(result.phases.render, { phase: "render" });
  assert.deepEqual(result.phases.qa, { phase: "qa" });
  assert.deepEqual(result.phases.stage, { phase: "stage" });

  const missing = await fixture(t, { delivery: false });
  let expensiveCalls = 0;
  await assert.rejects(
    dispatch()({
      command: "run",
      scenarioPath: missing.scenarioPath,
      artifactRoot: missing.artifactRoot,
      source: "pr_head",
      runId: "run-001",
      repoRoot: missing.repoRoot,
      dependencies: {
        buildCaptureCheckout: async () => {
          expensiveCalls += 1;
        },
        runRuntimeHost: async () => {
          expensiveCalls += 1;
        },
      },
    }),
    /delivery.*required/i,
  );
  assert.equal(expensiveCalls, 0);
});

test("trusted dry-run emits an exact runtime plan without writes, builds, spawns, or landing loads", async (t) => {
  const value = await fixture(t);
  const before = await fs.readdir(value.root, { recursive: true });
  const forbidden = async () => {
    throw new Error("dry-run invoked an expensive adapter");
  };

  const plan = await dispatch()({
    command: "run",
    scenarioPath: value.scenarioPath,
    artifactRoot: value.artifactRoot,
    landingRoot: value.landingRoot,
    source: "pr_head",
    runtimeId: "kandev-isolated-e2e",
    runId: "run-001",
    prNumber: 42,
    prBaseSha: BASE_SHA,
    repoRoot: value.repoRoot,
    dryRun: true,
    dependencies: {
      verifySourceGate: forbidden,
      resolvePrMetadata: forbidden,
      buildCaptureCheckout: forbidden,
      runRuntimeHost: forbidden,
      pipelineRunner: forbidden,
      loadLandingAdapter: forbidden,
      buildRuntimeHostCommand: () => ({
        command: "/verified/node",
        args: ["playwright", "test", "--config", "pipeline-playwright.config.ts"],
        cwd: path.join(value.repoRoot, "apps/web"),
      }),
    },
  });

  assert.equal(plan.contract, "kandev-highlight-runtime-dry-run-v1");
  assert.equal(plan.zeroWrites, true);
  assert.equal(plan.runtime.runtimeId, "kandev-isolated-e2e");
  assert.equal(plan.paths.build, path.join(value.artifactRoot, "runtime-builds", "run-001"));
  assert.equal(plan.paths.hostBundle, path.join(value.artifactRoot, "runtime-host", "run-001"));
  assert.deepEqual(plan.order, ["validate", "storyboard", "capture", "render", "qa", "stage"]);
  assert.deepEqual(await fs.readdir(value.root, { recursive: true }), before);
});

test("trusted dispatch rejects unknown runtime IDs before source, build, or host work", async (t) => {
  const value = await fixture(t);
  let calls = 0;
  const forbidden = async () => {
    calls += 1;
  };

  await assert.rejects(
    dispatch()({
      command: "capture",
      scenarioPath: value.scenarioPath,
      artifactRoot: value.artifactRoot,
      source: "pr_head",
      runtimeId: "../custom-runtime.mjs",
      runId: "run-001",
      repoRoot: value.repoRoot,
      dependencies: {
        verifySourceGate: forbidden,
        buildCaptureCheckout: forbidden,
        runRuntimeHost: forbidden,
      },
    }),
    /unknown Highlight runtime.*kandev-isolated-e2e/i,
  );
  assert.equal(calls, 0);
});
