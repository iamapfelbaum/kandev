import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
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
import { computeScenarioDigest, readScenario } from "./scenario.mjs";

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

function sourceCaptureDigest(workerRequest) {
  return digestBytes(
    canonicalJson({
      captureMode: workerRequest.source,
      sourceSha: workerRequest.sourceProof.selectedSha,
      ...(workerRequest.source === "pr_head"
        ? {
            prNumber: workerRequest.pullRequest.number,
            prBaseSha: workerRequest.pullRequest.baseSha,
            prHeadSha: workerRequest.sourceProof.selectedSha,
          }
        : { sourceRef: "origin/main" }),
    }),
  );
}

async function writeSuccessfulWorkerResult({
  env,
  logPath,
  scenarioDigest: suppliedScenarioDigest,
  captureScenarioId,
  captureRunId,
  captureContentPaddingBytes = 0,
  captureEvidenceTransform,
  applicationRuntimeTransform,
  receiptTransform,
}) {
  const workerRequest = JSON.parse(
    await fs.readFile(env.KANDEV_HIGHLIGHT_RUNTIME_REQUEST, "utf8"),
  );
  const scenario = await readScenario(workerRequest.scenarioPath);
  const scenarioDigest =
    suppliedScenarioDigest ?? computeScenarioDigest(scenario);
  const fixtureTempRoot = env.KANDEV_HIGHLIGHT_FIXTURE_ROOT;
  const preTeardownBase = runtimeProof({ workerRequest, fixtureTempRoot });
  const preTeardown = applicationRuntimeTransform
    ? applicationRuntimeTransform(preTeardownBase, workerRequest)
    : preTeardownBase;
  const captureRoot = path.join(
    workerRequest.artifactRoot,
    captureScenarioId ?? scenario.id,
    "runs",
    captureRunId ?? workerRequest.runId,
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
    `${JSON.stringify(rawCaptureEvidence, null, 2)}\n${" ".repeat(captureContentPaddingBytes)}`,
  );
  const captureEvidencePath = path.join(
    sourceCaptureRoot,
    "capture-content.json",
  );
  await fs.writeFile(captureEvidencePath, rawEvidenceBytes, { flag: "wx" });
  const captureEvidenceBase = {
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
  const captureEvidence = captureEvidenceTransform
    ? captureEvidenceTransform(captureEvidenceBase, rawCaptureEvidence)
    : captureEvidenceBase;
  const captureReceiptBase = {
    contract: "kandev-highlight-source-capture-v1",
    scenarioDigest,
    sourceDigest: sourceCaptureDigest(workerRequest),
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
    runtime: {
      allocation: {
        display: ":240.0",
        displayNumber: 240,
        cdpPort: 50_001,
        artifactRoot: path.join(captureRoot, "capture"),
        profileDir: path.join(
          captureRoot,
          "capture",
          "runtime",
          "browser-profile",
        ),
        lockPath: path.join(captureRoot, "capture", "runtime", "capture.lock"),
      },
      teardown: {
        processesGone: true,
        coordinatesReleased: true,
        profileRemoved: true,
        lockRemoved: true,
        display: ":240.0",
        cdpPort: 50_001,
        processes: [
          { name: "xvfb", pid: 2_147_483_646, gone: true },
          { name: "chromium", pid: 2_147_483_645, gone: true },
        ],
        recorder: { exitCode: 0, signal: null, processGone: true },
      },
    },
    applicationRuntime: preTeardown,
    captureEvidence,
  };
  const captureReceipt = receiptTransform
    ? receiptTransform(captureReceiptBase, workerRequest)
    : captureReceiptBase;
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
  await fs.rm(fixtureTempRoot, { recursive: true, force: true });
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    deadlineMs: 240_000,
    processGroup: {
      pid: 12345,
      termSent: false,
      killSent: false,
      exited: true,
      gone: true,
    },
    log: {
      limitBytes: 8 * 1024 * 1024,
      capturedBytes: null,
      discardedBytes: 0,
      truncated: false,
    },
  };
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
      fixtureRoot: "/external/fixture-root",
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
    KANDEV_HIGHLIGHT_FIXTURE_ROOT: "/external/fixture-root",
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
    "source",
    "release:18087",
    "release:50001",
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
  assert.equal(
    Object.hasOwn(result.capture, "receipt"),
    false,
    "host result must not expose the unbounded internal capture receipt",
  );
  assert.equal(result.teardown.backendPortReleased, true);
  assert.equal(result.teardown.fixtureTempRootRemoved, true);
  assert.equal(result.execution.exitCode, 0);
  assert.equal(result.execution.signal, null);
  assert.deepEqual(Object.keys(result.bundle).sort(), [
    "failurePath",
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
  assert.equal(runtimeReceipt.source.pre.selectedSha, SHA);
  assert.equal(runtimeReceipt.source.post.selectedSha, SHA);
  assert.equal(runtimeReceipt.source.unchanged, true);
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

test("runtime host rejects a self-consistent capture from another scenario run", async (t) => {
  const value = await fixture(t);
  const deps = dependencies(value.buildManifestPath, {
    processRunner: ({ env, logPath }) =>
      writeSuccessfulWorkerResult({
        env,
        logPath,
        scenarioDigest: `sha256:${"9".repeat(64)}`,
        captureScenarioId: "other-story",
        captureRunId: "other-run",
      }),
  });

  await assert.rejects(
    runHighlightRuntimeHost({
      request: value.request,
      dependencies: deps.value,
    }),
    /worker-result-invalid|scenario|attempt|capture path/i,
  );
});

test("runtime host recomputes capture-content summaries instead of trusting the worker", async (t) => {
  const value = await fixture(t);
  const deps = dependencies(value.buildManifestPath, {
    processRunner: ({ env, logPath }) =>
      writeSuccessfulWorkerResult({
        env,
        logPath,
        captureEvidenceTransform: (evidence) => ({
          ...evidence,
          visibleDomText: {
            ...evidence.visibleDomText,
            records: 0,
            bytes: 0,
            digest: `sha256:${"0".repeat(64)}`,
          },
        }),
      }),
  });

  await assert.rejects(
    runHighlightRuntimeHost({
      request: value.request,
      dependencies: deps.value,
    }),
    /worker-result-invalid|capture content|visibleDomText/i,
  );
});

test("runtime host bounds capture-content evidence before reading it", async (t) => {
  const value = await fixture(t);
  const deps = dependencies(value.buildManifestPath, {
    processRunner: ({ env, logPath }) =>
      writeSuccessfulWorkerResult({
        env,
        logPath,
        captureContentPaddingBytes: 600_000,
      }),
  });

  await assert.rejects(
    runHighlightRuntimeHost({
      request: value.request,
      dependencies: deps.value,
    }),
    /worker-result-invalid|capture content|too large|byte bound/i,
  );
});

test("runtime host rechecks source and scenario identity after the child exits", async (t) => {
  const value = await fixture(t);
  const canonicalScenario = await readScenario(value.request.scenarioPath);
  let sourceChecks = 0;
  let scenarioReads = 0;
  const deps = dependencies(value.buildManifestPath, {
    verifySourceGate: async () => {
      sourceChecks += 1;
      return sourceChecks === 1
        ? sourceProof()
        : { ...sourceProof(), status: " M scenario.json", clean: false };
    },
    readScenario: async () => {
      scenarioReads += 1;
      return scenarioReads === 1
        ? canonicalScenario
        : { ...canonicalScenario, title: "changed during capture" };
    },
  });

  await assert.rejects(
    runHighlightRuntimeHost({
      request: value.request,
      dependencies: deps.value,
    }),
    /source|scenario|changed|post-run/i,
  );
  assert.equal(sourceChecks, 2);
  assert.equal(scenarioReads, 2);
});

test("post-reservation exceptions atomically preserve failed result and retry guidance", async (t) => {
  const value = await fixture(t);
  const deps = dependencies(value.buildManifestPath, {
    clock: () => new Date("invalid"),
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
  assert.match(thrown?.message ?? "", /evidence preserved|failed closed/i);
  const bundleRoot = path.join(
    value.artifactRoot,
    "runtime-host",
    value.request.runId,
  );
  const result = JSON.parse(
    await fs.readFile(path.join(bundleRoot, "result.json"), "utf8"),
  );
  const failure = JSON.parse(
    await fs.readFile(path.join(bundleRoot, "failure.json"), "utf8"),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.failure.retry.nextRunIdRequired, true);
  assert.equal(
    result.bundle.failurePath,
    path.join(bundleRoot, "failure.json"),
  );
  assert.equal(failure.contract, "kandev-highlight-runtime-host-failure-v1");
  assert.match(failure.failureDigest, /^sha256:[a-f0-9]{64}$/);
});

test("runtime host rejects a never-created worker-selected fixture root", async (t) => {
  const value = await fixture(t);
  const deps = dependencies(value.buildManifestPath, {
    processRunner: ({ env, logPath }) =>
      writeSuccessfulWorkerResult({
        env,
        logPath,
        applicationRuntimeTransform: (runtime) => ({
          ...runtime,
          isolation: {
            fixtureTempRoot: path.join(value.root, "never-created"),
            homeRoot: path.join(value.root, "never-created", ".kandev"),
            databasePath: path.join(value.root, "never-created", "kandev.db"),
            worktreeRoot: path.join(value.root, "never-created", "worktrees"),
            repositoryCloneRoot: path.join(
              value.root,
              "never-created",
              "repos",
            ),
          },
        }),
      }),
  });

  await assert.rejects(
    runHighlightRuntimeHost({
      request: value.request,
      dependencies: deps.value,
    }),
    /worker-result-invalid|fixture|owned|isolation/i,
  );
});

test("owned runtime process enforces its deadline and proves its process group gone", async (t) => {
  const runtime = await import("./runtime-host.mjs");
  assert.equal(typeof runtime.runOwnedRuntimeProcess, "function");
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "runtime-owned-process-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await runtime.runOwnedRuntimeProcess({
    command: {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
    },
    env: { PATH: process.env.PATH ?? "/usr/bin" },
    logPath: path.join(root, "process.log"),
    deadlineMs: 80,
    termGraceMs: 40,
    killGraceMs: 500,
    logLimitBytes: 1024,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.processGroup.termSent, true);
  assert.equal(result.processGroup.exited, true);
  assert.equal(result.processGroup.gone, true);
});

test("owned runtime process consumes output while bounding the preserved log", async (t) => {
  const runtime = await import("./runtime-host.mjs");
  assert.equal(typeof runtime.runOwnedRuntimeProcess, "function");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-bounded-log-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, "process.log");
  const result = await runtime.runOwnedRuntimeProcess({
    command: {
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('x'.repeat(65536)); process.stderr.write('y'.repeat(65536))",
      ],
      cwd: root,
    },
    env: { PATH: process.env.PATH ?? "/usr/bin" },
    logPath,
    deadlineMs: 2_000,
    termGraceMs: 50,
    killGraceMs: 500,
    logLimitBytes: 1024,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.log.limitBytes, 1024);
  assert.equal(result.log.capturedBytes, 1024);
  assert.equal(result.log.truncated, true);
  assert(result.log.discardedBytes > 0);
  assert.equal((await fs.stat(logPath)).size, 1024);
});

test("owned runtime process removes surviving members after its leader exits", async (t) => {
  const runtime = await import("./runtime-host.mjs");
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "runtime-orphan-group-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const leafPidPath = path.join(root, "leaf.pid");
  let groupPid;
  t.after(() => {
    if (!groupPid) return;
    try {
      process.kill(-groupPid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
  const script = [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const leaf = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    `fs.writeFileSync(${JSON.stringify(leafPidPath)}, String(leaf.pid));`,
    "leaf.unref();",
  ].join("\n");
  const result = await runtime.runOwnedRuntimeProcess({
    command: {
      command: process.execPath,
      args: ["-e", script],
      cwd: root,
    },
    env: { PATH: process.env.PATH ?? "/usr/bin" },
    logPath: path.join(root, "process.log"),
    deadlineMs: 2_000,
    termGraceMs: 50,
    killGraceMs: 500,
    logLimitBytes: 1024,
  });
  groupPid = result.processGroup.pid;

  assert.equal(result.exitCode, 0);
  assert.equal(result.processGroup.termSent, true);
  assert.equal(result.processGroup.gone, true);
  const leafPid = Number(await fs.readFile(leafPidPath, "utf8"));
  assert.throws(() => process.kill(leafPid, 0), { code: "ESRCH" });
});

test("owned runtime process cleans its group when the parent receives a signal", async (t) => {
  const runtime = await import("./runtime-host.mjs");
  assert.equal(typeof runtime.runOwnedRuntimeProcess, "function");
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "runtime-parent-signal-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const signalSource = new EventEmitter();
  const running = runtime.runOwnedRuntimeProcess({
    command: {
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      cwd: root,
    },
    env: { PATH: process.env.PATH ?? "/usr/bin" },
    logPath: path.join(root, "process.log"),
    deadlineMs: 5_000,
    termGraceMs: 40,
    killGraceMs: 500,
    logLimitBytes: 1024,
    signalSource,
  });
  setTimeout(() => signalSource.emit("SIGTERM"), 80);
  const result = await running;

  assert.equal(result.timedOut, false);
  assert.equal(result.processGroup.termSent, true);
  assert.equal(result.processGroup.killSent, true);
  assert.equal(result.processGroup.gone, true);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("runtime host rejects capture receipts that only assert teardown", async (t) => {
  const value = await fixture(t);
  const deps = dependencies(value.buildManifestPath, {
    processRunner: ({ env, logPath }) =>
      writeSuccessfulWorkerResult({
        env,
        logPath,
        receiptTransform: (receipt) => ({
          ...receipt,
          runtime: {
            ...receipt.runtime,
            teardown: {
              ...receipt.runtime.teardown,
              recorder: {
                ...receipt.runtime.teardown.recorder,
                processGone: false,
              },
            },
          },
        }),
      }),
  });

  await assert.rejects(
    runHighlightRuntimeHost({
      request: value.request,
      dependencies: deps.value,
    }),
    /worker-result-invalid|teardown|recorder/i,
  );
});

test("runtime host observes capture CDP and X display release independently", async (t) => {
  const value = await fixture(t);
  const checkedPorts = [];
  const deps = dependencies(value.buildManifestPath, {
    waitForPortRelease: async (port) => {
      checkedPorts.push(port);
      return port !== 50_001;
    },
    isDisplayReleased: async (displayNumber) => displayNumber !== 240,
    isProcessGone: async () => true,
  });

  await assert.rejects(
    runHighlightRuntimeHost({
      request: value.request,
      dependencies: deps.value,
    }),
    /teardown|CDP|display|failed closed/i,
  );
  assert.deepEqual(
    checkedPorts.sort((a, b) => a - b),
    [18_087, 50_001],
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
  const failureEvidence = JSON.parse(
    await fs.readFile(failed.bundle.failurePath, "utf8"),
  );
  assert.equal(
    failureEvidence.contract,
    "kandev-highlight-runtime-host-failure-v1",
  );
  assert.deepEqual(failureEvidence.failure, failed.failure);
  assert.equal(failureEvidence.phase, failed.failure.phase);
  assert.match(failureEvidence.failureDigest, /^sha256:[a-f0-9]{64}$/);
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
  const [fixtureSource, specSource, configSource, backendFixtureSource] =
    await Promise.all([
      fs.readFile(path.join(webRoot, "runtime-fixture.ts"), "utf8"),
      fs.readFile(path.join(webRoot, "pipeline-capture.spec.ts"), "utf8"),
      fs.readFile(path.join(webRoot, "pipeline-playwright.config.ts"), "utf8"),
      fs.readFile(path.join(webRoot, "../fixtures/backend.ts"), "utf8"),
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
  assert.match(backendFixtureSource, /KANDEV_HIGHLIGHT_FIXTURE_ROOT/);
  assert.match(backendFixtureSource, /waitForProcessGroupGone/);
  assert.doesNotMatch(
    backendFixtureSource,
    /Cleanup temp directory[^\n]*ignore errors/i,
  );
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
  assert.match(declarations, /scenario: HighlightScenarioIdentity/);
  assert.match(declarations, /pre: HighlightRuntimeCompactSourceProof/);
  assert.match(
    declarations,
    /post: HighlightRuntimeCompactSourceProof \| null/,
  );
  assert.match(declarations, /unchanged: boolean/);
  assert.match(declarations, /playwrightProcessGroupGone: boolean/);
  assert.match(declarations, /failurePath: string/);
  assert.match(declarations, /runOwnedRuntimeProcess/);
  assert.doesNotMatch(
    declarations,
    /modulePath|shellCommand|javascriptSource|visibleDomText: string\[\]/i,
  );
});
