import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRuntimeHostCommand,
  runHighlightRuntimeHost,
  sanitizeRuntimeHostEnvironment,
  validateRuntimeHostRequest,
  validateRuntimeWorkerRequest,
} from "./runtime-host.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const SCENARIO_PATH = path.join(
  REPOSITORY_ROOT,
  "scripts/highlights/examples/quick-start.scenario.json",
);
const SHA = "1".repeat(40);

function digestBytes(value) {
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

function sourceProof() {
  return {
    contract: "kandev-highlight-source-v1",
    source: "pr_head",
    repoRoot: REPOSITORY_ROOT,
    selectedSha: SHA,
    headSha: SHA,
    currentMainSha: "2".repeat(40),
    clean: true,
    status: "",
  };
}

function buildProof(buildManifestPath) {
  return {
    contract: "kandev-highlight-build-provenance-v1",
    builtAt: "2026-07-22T00:00:00.000Z",
    source: sourceProof(),
    commands: [],
    outputs: {
      backend: {
        path: "/verified/build/kandev",
        bytes: 101,
        digest: `sha256:${"a".repeat(64)}`,
      },
      mockAgent: {
        path: "/verified/build/mock-agent",
        bytes: 102,
        digest: `sha256:${"b".repeat(64)}`,
      },
      webDist: {
        path: "/verified/build/web-dist",
        bytes: 103,
        fileCount: 4,
        digest: `sha256:${"c".repeat(64)}`,
        files: [],
      },
    },
    manifestDigest: `sha256:${"d".repeat(64)}`,
    manifestPath: buildManifestPath,
  };
}

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "highlight-runtime-host-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, "artifacts");
  await fs.mkdir(path.join(artifactRoot, "evidence"), { recursive: true });
  const buildManifestPath = path.join(
    artifactRoot,
    "evidence",
    "build-provenance.json",
  );
  await fs.writeFile(buildManifestPath, "{}\n", { flag: "wx" });
  return {
    root,
    artifactRoot,
    buildManifestPath,
    request: {
      contract: "kandev-highlight-runtime-host-request-v1",
      version: 1,
      runtimeId: "kandev-isolated-e2e",
      scenarioPath: SCENARIO_PATH,
      artifactRoot,
      repositoryRoot: REPOSITORY_ROOT,
      buildManifestPath,
      source: "pr_head",
      runId: "host-r01",
      pullRequest: { number: 42, baseSha: "3".repeat(40) },
    },
  };
}

function runtimeProof({ workerRequest, fixtureTempRoot }) {
  return {
    contract: "kandev-highlight-application-runtime-pre-teardown-v1",
    version: 1,
    runtimeId: "kandev-isolated-e2e",
    origin: `http://localhost:${workerRequest.ports.backend}`,
    ports: {
      backend: workerRequest.ports.backend,
      frontend: workerRequest.ports.backend,
    },
    isolation: {
      fixtureTempRoot,
      homeRoot: path.join(fixtureTempRoot, ".kandev"),
      databasePath: path.join(fixtureTempRoot, "kandev.db"),
      worktreeRoot: path.join(fixtureTempRoot, "worktrees"),
      repositoryCloneRoot: path.join(fixtureTempRoot, "repos"),
    },
    providerRouting: {
      profile: "e2e",
      mockAgent: true,
      mockProviders: true,
      liveCredentialsPresent: false,
      environmentSanitized: true,
    },
    source: {
      contract: workerRequest.sourceProof.contract,
      mode: workerRequest.sourceProof.source,
      selectedSha: workerRequest.sourceProof.selectedSha,
    },
    build: {
      contract: workerRequest.build.contract,
      manifestDigest: workerRequest.build.manifestDigest,
      sourceSha: workerRequest.sourceProof.selectedSha,
      outputs: {
        backend: workerRequest.build.outputs.backend.digest,
        mockAgent: workerRequest.build.outputs.mockAgent.digest,
        webDist: workerRequest.build.outputs.webDist.digest,
      },
    },
  };
}

async function writeSuccessfulWorkerResult({ env, logPath }) {
  const workerRequest = JSON.parse(
    await fs.readFile(env.KANDEV_HIGHLIGHT_RUNTIME_REQUEST, "utf8"),
  );
  const fixtureTempRoot = path.join(
    path.dirname(workerRequest.bundleRoot),
    "fixture-temp-gone",
  );
  const preTeardown = runtimeProof({ workerRequest, fixtureTempRoot });
  const captureRoot = path.join(
    workerRequest.artifactRoot,
    "quick-start",
    "runs",
    workerRequest.runId,
  );
  const evidenceRoot = path.join(captureRoot, "evidence");
  const sourceCaptureRoot = path.join(captureRoot, "capture", "evidence");
  const rawMasterPath = path.join(
    captureRoot,
    "capture",
    "raw",
    "quick-start.source.mp4",
  );
  await fs.mkdir(path.dirname(rawMasterPath), { recursive: true });
  await fs.mkdir(evidenceRoot, { recursive: true });
  await fs.mkdir(sourceCaptureRoot, { recursive: true });
  await fs.writeFile(rawMasterPath, "raw-master", { flag: "wx" });
  const rawCaptureEvidence = {
    contract: "kandev-highlight-capture-content-v1",
    version: 1,
    bounds: {
      maxVisibleDomTextRecords: 512,
      maxVisibleDomTextBytes: 65536,
      maxBrowserConsoleRecords: 128,
      maxBrowserConsoleTextBytes: 2048,
    },
    visibleDomText: ["Quick start", "Review API"],
    browserConsole: [],
    truncated: { visibleDomText: false, browserConsole: false },
  };
  const rawEvidenceBytes = Buffer.from(
    `${JSON.stringify(rawCaptureEvidence, null, 2)}\n`,
  );
  const captureEvidencePath = path.join(
    sourceCaptureRoot,
    "capture-content.json",
  );
  await fs.writeFile(captureEvidencePath, rawEvidenceBytes, { flag: "wx" });
  const captureEvidence = {
    contract: "kandev-highlight-capture-evidence-v1",
    version: 1,
    path: captureEvidencePath,
    bytes: rawEvidenceBytes.byteLength,
    digest: digestBytes(rawEvidenceBytes),
    visibleDomText: {
      records: 2,
      bytes: Buffer.byteLength("Quick startReview API"),
      digest: digestBytes(canonicalJson(rawCaptureEvidence.visibleDomText)),
      truncated: false,
    },
    browserConsole: {
      records: 0,
      bytes: 0,
      digest: digestBytes(canonicalJson(rawCaptureEvidence.browserConsole)),
      truncated: false,
    },
  };
  const captureReceipt = {
    contract: "kandev-highlight-source-capture-v1",
    scenarioDigest: `sha256:${"4".repeat(64)}`,
    sourceDigest: `sha256:${"5".repeat(64)}`,
    source: workerRequest.sourceProof,
    build: {
      contract: workerRequest.build.contract,
      manifestDigest: workerRequest.build.manifestDigest,
      sourceSha: workerRequest.sourceProof.selectedSha,
      outputs: workerRequest.build.outputs,
    },
    rawMaster: {
      path: rawMasterPath,
      bytes: Buffer.byteLength("raw-master"),
      digest: digestBytes("raw-master"),
    },
    applicationRuntime: preTeardown,
    captureEvidence,
  };
  const captureManifestPath = path.join(sourceCaptureRoot, "capture.json");
  await fs.writeFile(
    captureManifestPath,
    `${JSON.stringify(captureReceipt, null, 2)}\n`,
    {
      flag: "wx",
    },
  );
  const phaseSource = {
    contract: "kandev-highlight-capture-phase-v1",
    phase: "capture",
    completedAt: "2026-07-22T00:01:00.000Z",
    value: {
      contract: "kandev-highlight-capture-result-v1",
      rawMasterPath,
      captureManifestPath,
      receipt: captureReceipt,
      execution: { contract: "kandev-highlight-execution-v1" },
      timeline: { schemaVersion: 1 },
    },
  };
  const phaseManifest = {
    ...phaseSource,
    recordDigest: digestBytes(canonicalJson(phaseSource)),
  };
  const phaseManifestPath = path.join(evidenceRoot, "capture.json");
  await fs.writeFile(
    phaseManifestPath,
    `${JSON.stringify(phaseManifest, null, 2)}\n`,
    {
      flag: "wx",
    },
  );
  const workerResult = {
    contract: "kandev-highlight-runtime-worker-result-v1",
    version: 1,
    runtimeId: workerRequest.runtimeId,
    runId: workerRequest.runId,
    applicationRuntime: preTeardown,
    capture: {
      phaseManifestPath,
      captureManifestPath,
      rawMasterPath,
      scenarioDigest: captureReceipt.scenarioDigest,
      sourceDigest: captureReceipt.sourceDigest,
      rawMasterDigest: captureReceipt.rawMaster.digest,
      captureEvidence,
    },
  };
  await fs.writeFile(
    env.KANDEV_HIGHLIGHT_RUNTIME_WORKER_RESULT,
    `${JSON.stringify(workerResult, null, 2)}\n`,
    { flag: "wx" },
  );
  await fs.appendFile(logPath, "fixed Playwright worker completed\n");
  return { exitCode: 0, signal: null };
}

function dependencies(buildManifestPath, overrides = {}) {
  const events = [];
  return {
    events,
    value: {
      verifySourceGate: async () => {
        events.push("source");
        return sourceProof();
      },
      verifyBuildProvenance: async () => {
        events.push("build");
        return buildProof(buildManifestPath);
      },
      preflightCaptureIntegration: async () => {
        events.push("tools");
        return {
          ffmpeg: "/usr/bin/ffmpeg",
          xvfb: "/usr/bin/Xvfb",
          chromium:
            "/verified/ms-playwright/chromium-1228/chrome-linux64/chrome",
          backend: "/verified/build/kandev",
          mockAgent: "/verified/build/mock-agent",
          webBuild: "/verified/build/web-dist/index.html",
        };
      },
      selectIntegrationPortOffset: async () => {
        events.push("port");
        return { offset: 7, backendPort: 18_087 };
      },
      processRunner: async ({ env, logPath }) => {
        events.push("spawn");
        return writeSuccessfulWorkerResult({ env, logPath });
      },
      waitForPortRelease: async (port) => {
        events.push(`release:${port}`);
        return true;
      },
      clock: () => new Date("2026-07-22T00:02:00.000Z"),
      ...overrides,
    },
  };
}

test("request contract rejects extra keys, unknown runtimes, and injected paths before writes", async (t) => {
  const value = await fixture(t);
  assert.deepEqual(validateRuntimeHostRequest(value.request), value.request);
  for (const invalid of [
    { ...value.request, modulePath: "/tmp/evil.mjs" },
    { ...value.request, runtimeId: "../evil.mjs" },
    { ...value.request, scenarioPath: "./relative.json" },
    { ...value.request, artifactRoot: REPOSITORY_ROOT },
    { ...value.request, buildManifestPath: "/tmp/unrelated.json" },
    { ...value.request, pullRequest: { number: 0, baseSha: "bad" } },
  ]) {
    assert.throws(
      () => validateRuntimeHostRequest(invalid),
      /not allowed|unknown Highlight runtime|absolute|outside|pullRequest/i,
    );
  }
});

test("child environment is an allowlist with no provider, cloud, API, or GitHub credentials", () => {
  const clean = sanitizeRuntimeHostEnvironment(
    {
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      TZ: "UTC",
      GH_TOKEN: "secret-gh",
      GITHUB_TOKEN: "secret-github",
      OPENAI_API_KEY: "secret-openai",
      AWS_SECRET_ACCESS_KEY: "secret-aws",
      GOOGLE_APPLICATION_CREDENTIALS: "/secret/cloud.json",
      KANDEV_PROVIDER_TOKEN: "secret-provider",
      ARBITRARY_PASSWORD: "secret-password",
      NODE_OPTIONS: "--require=/tmp/evil.cjs",
    },
    {
      homeRoot: "/external/host-home",
      requestPath: "/external/request.json",
      workerResultPath: "/external/worker-result.json",
      portOffset: 7,
      playwrightBrowsersPath: "/verified/ms-playwright",
    },
  );

  assert.deepEqual(clean, {
    PATH: "/usr/bin",
    LANG: "C.UTF-8",
    TZ: "UTC",
    HOME: "/external/host-home",
    CI: "1",
    E2E_PORT_OFFSET: "7",
    PLAYWRIGHT_BROWSERS_PATH: "/verified/ms-playwright",
    KANDEV_HIGHLIGHT_RUNTIME_REQUEST: "/external/request.json",
    KANDEV_HIGHLIGHT_RUNTIME_WORKER_RESULT: "/external/worker-result.json",
  });
  assert.doesNotMatch(
    JSON.stringify(clean),
    /secret|TOKEN|API_KEY|PASSWORD|CREDENTIAL/i,
  );
});

test("generated worker request has an exact non-extensible contract", async (t) => {
  const value = await fixture(t);
  const bundleRoot = path.join(
    value.artifactRoot,
    "runtime-host",
    value.request.runId,
  );
  const workerRequest = {
    contract: "kandev-highlight-runtime-worker-request-v1",
    version: 1,
    runtimeId: value.request.runtimeId,
    scenarioPath: value.request.scenarioPath,
    artifactRoot: value.request.artifactRoot,
    repositoryRoot: value.request.repositoryRoot,
    buildManifestPath: value.request.buildManifestPath,
    source: value.request.source,
    runId: value.request.runId,
    pullRequest: value.request.pullRequest,
    bundleRoot,
    sourceProof: sourceProof(),
    build: {
      contract: "kandev-highlight-build-provenance-v1",
      manifestDigest: `sha256:${"d".repeat(64)}`,
      sourceSha: SHA,
      outputs: {
        backend: { digest: `sha256:${"a".repeat(64)}`, bytes: 101 },
        mockAgent: { digest: `sha256:${"b".repeat(64)}`, bytes: 102 },
        webDist: {
          digest: `sha256:${"c".repeat(64)}`,
          bytes: 103,
          fileCount: 4,
        },
      },
    },
    tools: {
      ffmpeg: "/usr/bin/ffmpeg",
      xvfb: "/usr/bin/Xvfb",
      chromium: "/verified/chromium",
      backend: "/verified/kandev",
      mockAgent: "/verified/mock-agent",
      webBuild: "/verified/dist/index.html",
    },
    ports: { offset: 7, backend: 18_087 },
  };
  assert.deepEqual(validateRuntimeWorkerRequest(workerRequest), workerRequest);
  assert.throws(
    () =>
      validateRuntimeWorkerRequest({
        ...workerRequest,
        modulePath: "/tmp/evil.mjs",
      }),
    /modulePath is not allowed/,
  );
  assert.throws(
    () =>
      validateRuntimeWorkerRequest({
        ...workerRequest,
        tools: { ...workerRequest.tools, chromium: "../evil" },
      }),
    /absolute chromium path/i,
  );
});

test("runtime host command has one fixed Playwright config and no request-derived argv", () => {
  const command = buildRuntimeHostCommand({
    webRoot: path.join(REPOSITORY_ROOT, "apps/web"),
    nodeExecutable: "/verified/node",
  });
  assert.deepEqual(command, {
    command: "/verified/node",
    args: [
      path.join(
        REPOSITORY_ROOT,
        "apps/web/node_modules/@playwright/test/cli.js",
      ),
      "test",
      "--config",
      "e2e/highlights/pipeline-playwright.config.ts",
    ],
    cwd: path.join(REPOSITORY_ROOT, "apps/web"),
  });
});

test("closed host preflights then writes an immutable digest-linked post-teardown bundle", async (t) => {
  const value = await fixture(t);
  const deps = dependencies(value.buildManifestPath);
  const result = await runHighlightRuntimeHost({
    request: value.request,
    inheritedEnv: {
      PATH: "/usr/bin",
      GH_TOKEN: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
    },
    dependencies: deps.value,
  });

  assert.deepEqual(deps.events, [
    "source",
    "build",
    "tools",
    "port",
    "spawn",
    "release:18087",
  ]);
  assert.equal(result.contract, "kandev-highlight-runtime-host-result-v1");
  assert.equal(result.status, "succeeded");
  assert.equal(result.runtimeId, "kandev-isolated-e2e");
  assert.match(result.resultDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.applicationRuntime.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.capture.phaseManifestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.capture.captureManifestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.capture.rawMasterDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.capture.captureEvidence.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.teardown.backendPortReleased, true);
  assert.equal(result.teardown.fixtureTempRootRemoved, true);
  assert.equal(result.execution.exitCode, 0);
  assert.equal(result.execution.signal, null);
  assert.deepEqual(Object.keys(result.bundle).sort(), [
    "logPath",
    "path",
    "requestPath",
    "resultPath",
    "workerResultPath",
  ]);

  const persisted = JSON.parse(
    await fs.readFile(result.bundle.resultPath, "utf8"),
  );
  assert.deepEqual(persisted, result);
  const runtimeReceipt = JSON.parse(
    await fs.readFile(result.applicationRuntime.receiptPath, "utf8"),
  );
  assert.equal(
    result.applicationRuntime.receiptPath,
    path.join(
      value.artifactRoot,
      "quick-start",
      "runs",
      value.request.runId,
      "evidence",
      "application-runtime.json",
    ),
  );
  assert.equal(
    runtimeReceipt.contract,
    "kandev-highlight-application-runtime-v1",
  );
  assert.equal(
    runtimeReceipt.capture.phaseManifestDigest,
    result.capture.phaseManifestDigest,
  );
  assert.equal(
    runtimeReceipt.capture.captureManifestDigest,
    result.capture.captureManifestDigest,
  );
  assert.equal(runtimeReceipt.source.selectedSha, SHA);
  assert.equal(runtimeReceipt.build.manifestDigest, `sha256:${"d".repeat(64)}`);
  assert.equal(runtimeReceipt.teardown.backendPortReleased, true);
  assert.equal(runtimeReceipt.teardown.fixtureTempRootRemoved, true);
  assert.equal(runtimeReceipt.log.digest, result.log.digest);
  assert.equal(runtimeReceipt.workerResult.digest, result.workerResult.digest);
  assert.match(runtimeReceipt.receiptDigest, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(
    JSON.stringify(result),
    /must-not-leak|Quick start|Review API/,
  );
});

test("invalid static preflight leaves no host bundle and never spawns", async (t) => {
  const value = await fixture(t);
  const deps = dependencies(value.buildManifestPath, {
    verifySourceGate: async () => {
      throw new Error("source checkout is dirty");
    },
  });
  await assert.rejects(
    () =>
      runHighlightRuntimeHost({
        request: value.request,
        dependencies: deps.value,
      }),
    /source checkout is dirty/,
  );
  assert.deepEqual(deps.events, []);
  await assert.rejects(
    () => fs.access(path.join(value.artifactRoot, "runtime-host")),
    /ENOENT/,
  );
});

test("teardown failure preserves request, worker result, and log but fails closed", async (t) => {
  const value = await fixture(t);
  const deps = dependencies(value.buildManifestPath, {
    waitForPortRelease: async () => false,
  });
  let thrown;
  try {
    await runHighlightRuntimeHost({
      request: value.request,
      dependencies: deps.value,
    });
  } catch (error) {
    thrown = error;
  }
  assert.match(thrown?.message ?? "", /backend port 18087 was not released/i);
  assert.match(thrown?.message ?? "", /evidence preserved at .*result\.json/i);
  assert.match(thrown?.resultPath ?? "", /result\.json$/);
  const failed = JSON.parse(await fs.readFile(thrown.resultPath, "utf8"));
  assert.equal(failed.status, "failed");
  assert.equal(failed.teardown.backendPortReleased, false);
  assert.equal(failed.failure.code, "runtime-teardown-incomplete");
  await fs.access(failed.bundle.requestPath);
  await fs.access(failed.bundle.workerResultPath);
  await fs.access(failed.bundle.logPath);
});

test("fixed Playwright worker reuses backendFixture with product-like isolated seed names", async () => {
  const webRoot = path.join(
    REPOSITORY_ROOT,
    "apps",
    "web",
    "e2e",
    "highlights",
  );
  const [fixtureSource, specSource, configSource] = await Promise.all([
    fs.readFile(path.join(webRoot, "runtime-fixture.ts"), "utf8"),
    fs.readFile(path.join(webRoot, "pipeline-capture.spec.ts"), "utf8"),
    fs.readFile(path.join(webRoot, "pipeline-playwright.config.ts"), "utf8"),
  ]);

  assert.match(fixtureSource, /backendFixture\.extend/);
  assert.match(fixtureSource, /Product Workspace/);
  assert.match(fixtureSource, /Product Workflow/);
  assert.doesNotMatch(fixtureSource, /E2E Workspace|E2E Workflow/);
  assert.match(specSource, /runDeclarativeHighlightCommand/);
  assert.match(specSource, /command:\s*"capture"/);
  assert.match(specSource, /createHighlightRegistries/);
  assert.match(specSource, /validateRuntimeWorkerRequest/);
  assert.match(configSource, /testMatch:\s*"pipeline-capture\.spec\.ts"/);
  assert.match(configSource, /workers:\s*1/);
  assert.doesNotMatch(configSource, /testMatch:\s*"capture\.spec\.ts"/);
});

test("runtime host declarations expose versioned closed requests and digest-only compact evidence", async () => {
  const declarations = await fs.readFile(
    new URL("./runtime-host.d.ts", import.meta.url),
    "utf8",
  );
  assert.match(declarations, /kandev-highlight-runtime-host-request-v1/);
  assert.match(declarations, /kandev-highlight-runtime-worker-request-v1/);
  assert.match(declarations, /kandev-highlight-runtime-host-result-v1/);
  assert.match(
    declarations,
    /captureEvidence: HighlightCaptureEvidenceIdentity/,
  );
  assert.match(declarations, /visibleDomText: HighlightCaptureEvidenceSummary/);
  assert.doesNotMatch(
    declarations,
    /modulePath|shellCommand|javascriptSource|visibleDomText: string\[\]/i,
  );
});
