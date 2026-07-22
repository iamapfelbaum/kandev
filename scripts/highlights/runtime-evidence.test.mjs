import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { computeScenarioDigest } from "./scenario.mjs";

const runtimeEvidence = await import("./runtime-evidence.mjs").catch(
  () => ({}),
);

const SOURCE_SHA = "1".repeat(40);
const MAIN_SHA = "2".repeat(40);
const BASE_SHA = "3".repeat(40);
const SOURCE_DIGEST = digestBytes(
  canonicalJson({
    captureMode: "pr_head",
    sourceSha: SOURCE_SHA,
    prNumber: 42,
    prBaseSha: BASE_SHA,
    prHeadSha: SOURCE_SHA,
  }),
);

test("runtime evidence exposes typed scan inputs and digest-only provenance", async () => {
  const declarations = await fs.readFile(
    new URL("./runtime-evidence.d.ts", import.meta.url),
    "utf8",
  );
  assert.match(declarations, /export interface VerifiedRuntimeEvidence/);
  assert.match(declarations, /export function loadVerifiedRuntimeEvidence/);
});

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

function digestBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function writeJson(filePath, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes, { flag: "wx" });
  return { path: filePath, bytes: bytes.length, digest: digestBytes(bytes) };
}

async function fileIdentity(filePath) {
  const bytes = await fs.readFile(filePath);
  return { path: filePath, bytes: bytes.length, digest: digestBytes(bytes) };
}

function withDigest(body, key) {
  return { ...body, [key]: digestBytes(canonicalJson(body)) };
}

async function evidenceFixture(
  t,
  {
    visibleDomText = ["Quick start", "Review API"],
    browserConsole = [],
    visibleDomTextTruncated = false,
    browserConsoleTruncated = false,
    runtimeLog = "worker launched from /home/capture/repo and connected to http://127.0.0.1:4173\n",
    runtimeLogLimitBytes = 8 * 1024 * 1024,
    runtimeLogDiscardedBytes = 0,
    teardown = {},
    substituteRequestScenario = false,
    sourceDigest = SOURCE_DIGEST,
    hostHeadSha = SOURCE_SHA,
    mutateSummary,
    mutateBuildManifest,
    mutateCaptureReceipt,
    mutateRuntimeReceipt,
  } = {},
) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "highlight-runtime-evidence-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, "repo");
  const artifactRoot = path.join(root, "artifacts");
  const scenarioId = "quick-start";
  const runId = "runtime-001";
  const scenarioPath = path.join(repositoryRoot, "quick-start.scenario.json");
  const buildManifestPath = path.join(
    artifactRoot,
    "runtime-builds",
    runId,
    "evidence",
    "build-provenance.json",
  );
  const attemptRoot = path.join(artifactRoot, scenarioId, "runs", runId);
  const hostRoot = path.join(artifactRoot, "runtime-host", runId);
  const captureEvidencePath = path.join(
    attemptRoot,
    "capture",
    "evidence",
    "capture-content.json",
  );
  const captureManifestPath = path.join(
    attemptRoot,
    "capture",
    "evidence",
    "capture.json",
  );
  const phaseManifestPath = path.join(attemptRoot, "evidence", "capture.json");
  const runtimeReceiptPath = path.join(
    attemptRoot,
    "evidence",
    "application-runtime.json",
  );
  const rawMasterPath = path.join(
    attemptRoot,
    "capture",
    "raw",
    `${scenarioId}.source.mp4`,
  );
  const requestPath = path.join(hostRoot, "request.json");
  const workerResultPath = path.join(hostRoot, "worker-result.json");
  const logPath = path.join(hostRoot, "playwright.log");
  const failurePath = path.join(hostRoot, "failure.json");
  const resultPath = path.join(hostRoot, "result.json");

  await fs.mkdir(repositoryRoot, { recursive: true });
  await fs.mkdir(path.dirname(buildManifestPath), { recursive: true });
  await fs.mkdir(path.dirname(rawMasterPath), { recursive: true });
  await fs.mkdir(hostRoot, { recursive: true });
  const scenario = JSON.parse(
    await fs.readFile(
      new URL("./examples/quick-start.scenario.json", import.meta.url),
      "utf8",
    ),
  );
  const scenarioBytes = Buffer.from(`${JSON.stringify(scenario, null, 2)}\n`);
  const scenarioDigest = computeScenarioDigest(scenario);
  await fs.writeFile(scenarioPath, scenarioBytes, { flag: "wx" });
  const requestScenarioPath = substituteRequestScenario
    ? path.join(repositoryRoot, "substituted.scenario.json")
    : scenarioPath;
  if (substituteRequestScenario) {
    await fs.writeFile(
      requestScenarioPath,
      `${JSON.stringify({ ...scenario, id: "substituted-story" }, null, 2)}\n`,
      { flag: "wx" },
    );
  }
  const rawMaster = Buffer.from("raw-master");
  await fs.writeFile(rawMasterPath, rawMaster, { flag: "wx" });

  const captureContent = {
    contract: "kandev-highlight-capture-content-v1",
    version: 1,
    bounds: {
      maxVisibleDomTextRecords: 512,
      maxVisibleDomTextBytes: 65_536,
      maxBrowserConsoleRecords: 128,
      maxBrowserConsoleTextBytes: 2_048,
    },
    visibleDomText,
    browserConsole,
    truncated: {
      visibleDomText: visibleDomTextTruncated,
      browserConsole: browserConsoleTruncated,
    },
  };
  const captureContentIdentity = await writeJson(
    captureEvidencePath,
    captureContent,
  );
  const captureEvidence = {
    contract: "kandev-highlight-capture-evidence-v1",
    version: 1,
    path: captureEvidencePath,
    bytes: captureContentIdentity.bytes,
    digest: captureContentIdentity.digest,
    visibleDomText: {
      records: visibleDomText.length,
      bytes: visibleDomText.reduce(
        (sum, value) => sum + Buffer.byteLength(value),
        0,
      ),
      digest: digestBytes(canonicalJson(visibleDomText)),
      truncated: visibleDomTextTruncated,
    },
    browserConsole: {
      records: browserConsole.length,
      bytes: browserConsole.reduce(
        (sum, value) => sum + Buffer.byteLength(value.text),
        0,
      ),
      digest: digestBytes(canonicalJson(browserConsole)),
      truncated: browserConsoleTruncated,
    },
  };
  mutateSummary?.(captureEvidence);

  const sourceProof = {
    contract: "kandev-highlight-source-v1",
    source: "pr_head",
    repoRoot: repositoryRoot,
    selectedSha: SOURCE_SHA,
    headSha: SOURCE_SHA,
    currentMainSha: MAIN_SHA,
    clean: true,
    status: "",
  };
  const buildOutputs = {
    backend: { digest: `sha256:${"a".repeat(64)}`, bytes: 101 },
    mockAgent: { digest: `sha256:${"b".repeat(64)}`, bytes: 102 },
    webDist: { digest: `sha256:${"c".repeat(64)}`, bytes: 103, fileCount: 4 },
  };
  const buildManifestBody = {
    contract: "kandev-highlight-build-provenance-v1",
    builtAt: "2026-07-22T00:00:00.000Z",
    source: sourceProof,
    commands: [],
    environment: {},
    outputs: {
      backend: {
        path: path.join(repositoryRoot, "apps/backend/bin/kandev"),
        ...buildOutputs.backend,
      },
      mockAgent: {
        path: path.join(repositoryRoot, "apps/backend/bin/mock-agent"),
        ...buildOutputs.mockAgent,
      },
      webDist: {
        path: path.join(repositoryRoot, "apps/web/dist"),
        ...buildOutputs.webDist,
        files: [],
      },
    },
  };
  mutateBuildManifest?.(buildManifestBody);
  const buildManifest = withDigest(buildManifestBody, "manifestDigest");
  await writeJson(buildManifestPath, buildManifest);
  const build = {
    contract: buildManifest.contract,
    manifestDigest: buildManifest.manifestDigest,
    sourceSha: SOURCE_SHA,
    outputs: buildOutputs,
  };
  const workerRequest = {
    contract: "kandev-highlight-runtime-worker-request-v1",
    version: 1,
    runtimeId: "kandev-isolated-e2e",
    scenarioPath: requestScenarioPath,
    artifactRoot,
    repositoryRoot,
    buildManifestPath,
    source: "pr_head",
    runId,
    pullRequest: { number: 42, baseSha: BASE_SHA },
    bundleRoot: hostRoot,
    sourceProof,
    build,
    tools: {
      ffmpeg: "/usr/bin/ffmpeg",
      xvfb: "/usr/bin/Xvfb",
      chromium: "/verified/chromium",
      backend: "/verified/kandev",
      mockAgent: "/verified/mock-agent",
      webBuild: "/verified/index.html",
    },
    ports: { offset: 7, backend: 18_087 },
  };
  await writeJson(requestPath, workerRequest);

  const fixtureTempRoot = path.join(hostRoot, "fixture-root");
  const preTeardown = {
    contract: "kandev-highlight-application-runtime-pre-teardown-v1",
    version: 1,
    runtimeId: "kandev-isolated-e2e",
    origin: "http://localhost:18087",
    ports: { backend: 18_087, frontend: 18_087 },
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
      contract: "kandev-highlight-source-v1",
      mode: "pr_head",
      selectedSha: SOURCE_SHA,
    },
    build: {
      contract: "kandev-highlight-build-provenance-v1",
      manifestDigest: build.manifestDigest,
      sourceSha: SOURCE_SHA,
      outputs: {
        backend: build.outputs.backend.digest,
        mockAgent: build.outputs.mockAgent.digest,
        webDist: build.outputs.webDist.digest,
      },
    },
  };
  const captureReceipt = {
    contract: "kandev-highlight-source-capture-v1",
    scenarioDigest,
    sourceDigest,
    source: sourceProof,
    build: {
      contract: build.contract,
      manifestDigest: build.manifestDigest,
      sourceSha: SOURCE_SHA,
      outputs: structuredClone(build.outputs),
    },
    buildVerification: {
      contract: "kandev-highlight-build-verification-v1",
      stable: true,
      beforeStory: {
        contract: "kandev-highlight-build-boundary-v1",
        manifestDigest: build.manifestDigest,
        sourceSha: SOURCE_SHA,
        outputs: {
          backend: build.outputs.backend.digest,
          mockAgent: build.outputs.mockAgent.digest,
          webDist: build.outputs.webDist.digest,
        },
      },
      afterStory: {
        contract: "kandev-highlight-build-boundary-v1",
        manifestDigest: build.manifestDigest,
        sourceSha: SOURCE_SHA,
        outputs: {
          backend: build.outputs.backend.digest,
          mockAgent: build.outputs.mockAgent.digest,
          webDist: build.outputs.webDist.digest,
        },
      },
    },
    navigation: {
      contract: "kandev-highlight-navigation-evidence-v1",
      version: 1,
      configuredUrl: "http://localhost:18087/board",
      allowedOrigin: "http://localhost:18087",
      finalUrl: "http://localhost:18087/board",
      finalOrigin: "http://localhost:18087",
      events: [],
      checkpoints: [{ label: "story end" }],
      violations: [],
    },
    captureEpochMs: 1_000,
    storyEpochMs: 1_080,
    storyStartOffsetMs: 80,
    storyOffsetMs: 80,
    storyDurationMs: 1_000,
    storyMedia: {
      start: { frameCount: 2, mediaTimeMs: 80 },
      end: { frameCount: 27, mediaTimeMs: 1_080 },
    },
    capture: {
      frameAlignment: {
        contract: "kandev-highlight-media-frame-alignment-v1",
        expectedStoryFrames: 25,
        observedStoryFrames: 25,
        expectedStoryDurationMs: 1_000,
        observedMediaDurationMs: 1_000,
        frameDelta: 0,
        mediaDurationDeltaMs: 0,
        toleranceFrames: 1,
      },
    },
    rawMaster: {
      path: rawMasterPath,
      bytes: rawMaster.length,
      digest: digestBytes(rawMaster),
    },
    applicationRuntime: preTeardown,
    captureEvidence,
    trustedInputLedger: [],
  };
  mutateCaptureReceipt?.(captureReceipt);
  await writeJson(captureManifestPath, captureReceipt);
  const phaseBody = {
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
  await writeJson(phaseManifestPath, withDigest(phaseBody, "recordDigest"));
  const workerResult = {
    contract: "kandev-highlight-runtime-worker-result-v1",
    version: 1,
    runtimeId: "kandev-isolated-e2e",
    runId,
    applicationRuntime: preTeardown,
    capture: {
      phaseManifestPath,
      captureManifestPath,
      rawMasterPath,
      scenarioDigest,
      sourceDigest,
      rawMasterDigest: captureReceipt.rawMaster.digest,
      captureEvidence,
    },
  };
  await writeJson(workerResultPath, workerResult);
  await fs.writeFile(logPath, runtimeLog, { flag: "wx" });

  const [
    requestIdentity,
    workerIdentity,
    logIdentity,
    phaseIdentity,
    captureIdentity,
  ] = await Promise.all([
    fileIdentity(requestPath),
    fileIdentity(workerResultPath),
    fileIdentity(logPath),
    fileIdentity(phaseManifestPath),
    fileIdentity(captureManifestPath),
  ]);
  const hostSourceProof = {
    contract: "kandev-highlight-source-v1",
    mode: "pr_head",
    selectedSha: SOURCE_SHA,
    headSha: hostHeadSha,
    currentMainSha: MAIN_SHA,
  };
  const hostSource = {
    pre: hostSourceProof,
    post: structuredClone(hostSourceProof),
    unchanged: true,
  };
  const scenarioEvidence = {
    id: scenarioId,
    path: scenarioPath,
    bytes: scenarioBytes.length,
    digest: scenarioDigest,
  };
  const execution = {
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
      limitBytes: runtimeLogLimitBytes,
      capturedBytes: logIdentity.bytes,
      discardedBytes: runtimeLogDiscardedBytes,
      truncated: runtimeLogDiscardedBytes > 0,
    },
  };
  const hostTeardown = {
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
    ...teardown,
  };
  const succeeded =
    Object.entries(hostTeardown).every(
      ([key, value]) => key === "capture" || value === true,
    ) && Object.values(hostTeardown.capture).every((value) => value === true);
  const runtimeReceiptBody = {
    contract: "kandev-highlight-application-runtime-v1",
    version: 1,
    runtimeId: "kandev-isolated-e2e",
    scenario: scenarioEvidence,
    request: requestIdentity,
    preTeardown,
    source: hostSource,
    build: {
      manifestDigest: build.manifestDigest,
      sourceSha: SOURCE_SHA,
      outputs: {
        backend: build.outputs.backend.digest,
        mockAgent: build.outputs.mockAgent.digest,
        webDist: build.outputs.webDist.digest,
      },
    },
    capture: {
      phaseManifestPath,
      phaseManifestDigest: phaseIdentity.digest,
      captureManifestPath,
      captureManifestDigest: captureIdentity.digest,
      attemptRoot,
      scenarioDigest,
      sourceDigest,
      rawMaster: captureReceipt.rawMaster,
      rawMasterDigest: captureReceipt.rawMaster.digest,
      captureEvidenceDigest: captureEvidence.digest,
    },
    execution,
    teardown: hostTeardown,
    log: logIdentity,
    workerResult: workerIdentity,
    completedAt: "2026-07-22T00:02:00.000Z",
  };
  mutateRuntimeReceipt?.(runtimeReceiptBody);
  const runtimeReceipt = withDigest(runtimeReceiptBody, "receiptDigest");
  await writeJson(runtimeReceiptPath, runtimeReceipt);
  const resultBody = {
    contract: "kandev-highlight-runtime-host-result-v1",
    version: 1,
    status: succeeded ? "succeeded" : "failed",
    runtimeId: "kandev-isolated-e2e",
    runId,
    scenario: scenarioEvidence,
    source: hostSource,
    bundle: {
      path: hostRoot,
      requestPath,
      workerResultPath,
      logPath,
      failurePath,
      resultPath,
    },
    request: requestIdentity,
    workerResult: workerIdentity,
    log: logIdentity,
    applicationRuntime: {
      receiptPath: runtimeReceiptPath,
      digest: runtimeReceipt.receiptDigest,
    },
    capture: {
      attemptRoot,
      scenarioDigest,
      sourceDigest,
      phaseManifestPath,
      phaseManifestDigest: phaseIdentity.digest,
      captureManifestPath,
      captureManifestDigest: captureIdentity.digest,
      rawMasterPath,
      rawMasterDigest: captureReceipt.rawMaster.digest,
      rawMaster: captureReceipt.rawMaster,
      captureEvidence,
    },
    execution,
    teardown: hostTeardown,
    failure: succeeded
      ? null
      : {
          code: "runtime-teardown-incomplete",
          phase: "teardown",
          retry: {
            nextRunIdRequired: true,
            reason: "immutable-run-id-reserved",
          },
        },
    completedAt: "2026-07-22T00:02:00.000Z",
  };
  await writeJson(resultPath, withDigest(resultBody, "resultDigest"));

  return {
    artifactRoot,
    attemptRoot,
    scenarioId,
    runId,
    captureReceipt,
    buildOutputs,
    captureEvidencePath,
    resultPath,
    runtimeReceiptPath,
    options: {
      artifactRoot,
      attemptRoot,
      scenarioId,
      scenarioPath,
      scenarioDigest,
      runId,
      captureReceipt,
    },
  };
}

function loader() {
  assert.equal(
    typeof runtimeEvidence.loadVerifiedRuntimeEvidence,
    "function",
    "runtime-evidence Module must export its loader Interface",
  );
  return runtimeEvidence.loadVerifiedRuntimeEvidence;
}

test("verified loader never relabels infrastructure logs as application scan evidence", async (t) => {
  const fixture = await evidenceFixture(t);
  const loaded = await loader()(fixture.options);

  assert.deepEqual(loaded.captureEvidence, {
    visibleDomText: ["Quick start", "Review API"],
    browserConsole: [],
    truncated: { visibleDomText: false, browserConsole: false },
  });
  assert.deepEqual(loaded.runtimeEvidence.logs, []);
  assert.equal(
    loaded.provenance.contract,
    "kandev-highlight-runtime-provenance-v1",
  );
  assert.equal(loaded.provenance.runtimeId, "kandev-isolated-e2e");
  assert.equal(
    loaded.provenance.buildContentDigest,
    digestBytes(
      canonicalJson({
        sourceSha: SOURCE_SHA,
        outputs: fixture.buildOutputs,
      }),
    ),
  );
  assert.equal(
    loaded.provenance.receiptDigest,
    (await fs.readFile(fixture.runtimeReceiptPath, "utf8")).includes(
      "receiptDigest",
    )
      ? JSON.parse(await fs.readFile(fixture.runtimeReceiptPath, "utf8"))
          .receiptDigest
      : null,
  );
  assert.deepEqual(loaded.provenance.scanner.coverage, {
    metadata: true,
    visibleDomText: true,
    browserConsole: true,
    runtimeLogs: false,
    renderedPixelOcr: false,
  });
  assert.doesNotMatch(
    JSON.stringify(loaded.provenance),
    /\/tmp\/|\/home\/capture|127\.0\.0\.1|Quick start|Review API/i,
  );
});

test("verified loader rejects a worker request substituted from another scenario", async (t) => {
  const substituted = await evidenceFixture(t, {
    substituteRequestScenario: true,
  });
  await assert.rejects(
    loader()(substituted.options),
    /worker request.*scenario|scenario.*substitut|scenarioPath/i,
  );
});

test("verified loader independently rejects a propagated but false source digest", async (t) => {
  const substituted = await evidenceFixture(t, {
    sourceDigest: `sha256:${"9".repeat(64)}`,
  });
  await assert.rejects(
    loader()(substituted.options),
    /source digest.*recomputed|source.*identity.*digest/i,
  );
});

test("verified loader binds the full compact host source proof", async (t) => {
  const substituted = await evidenceFixture(t, {
    hostHeadSha: "8".repeat(40),
  });
  await assert.rejects(
    loader()(substituted.options),
    /host source.*worker request|source proof.*mismatch/i,
  );
});

for (const { label, fixtureOptions } of [
  {
    label: "build manifest identity mismatch",
    fixtureOptions: {
      mutateBuildManifest: (manifest) => {
        manifest.outputs.backend.digest = `sha256:${"7".repeat(64)}`;
      },
    },
  },
  {
    label: "capture build output omission",
    fixtureOptions: {
      mutateCaptureReceipt: (receipt) => {
        delete receipt.build.outputs.webDist;
      },
    },
  },
  {
    label: "application receipt build output mismatch",
    fixtureOptions: {
      mutateRuntimeReceipt: (receipt) => {
        receipt.build.outputs.mockAgent = `sha256:${"7".repeat(64)}`;
      },
    },
  },
]) {
  test(`verified loader rejects ${label}`, async (t) => {
    const substituted = await evidenceFixture(t, fixtureOptions);
    await assert.rejects(
      loader()(substituted.options),
      /build.*output|output.*identity|backend|mockAgent|webDist/i,
    );
  });
}

test("verified loader rejects tampered, escaped, and symlinked capture evidence", async (t) => {
  const tampered = await evidenceFixture(t);
  await fs.appendFile(tampered.captureEvidencePath, "tampered");
  await assert.rejects(
    loader()(tampered.options),
    /capture.*evidence.*digest|bytes/i,
  );

  const escaped = await evidenceFixture(t);
  const outside = path.join(path.dirname(escaped.artifactRoot), "outside.json");
  await fs.writeFile(outside, "{}\n");
  const escapedReceipt = structuredClone(escaped.captureReceipt);
  escapedReceipt.captureEvidence.path = outside;
  await assert.rejects(
    loader()({ ...escaped.options, captureReceipt: escapedReceipt }),
    /capture.*evidence.*outside|fixed.*path|escapes/i,
  );

  const linked = await evidenceFixture(t);
  const target = path.join(
    path.dirname(linked.artifactRoot),
    "linked-content.json",
  );
  await fs.copyFile(linked.captureEvidencePath, target);
  await fs.unlink(linked.captureEvidencePath);
  await fs.symlink(target, linked.captureEvidencePath);
  await assert.rejects(
    loader()(linked.options),
    /symlink|non-symlink|canonical/i,
  );
});

test("verified loader recomputes summaries and requires nonempty visible DOM evidence", async (t) => {
  const badSummary = await evidenceFixture(t, {
    mutateSummary(summary) {
      summary.visibleDomText.records += 1;
    },
  });
  await assert.rejects(
    loader()(badSummary.options),
    /visibleDomText.*records|summary/i,
  );

  const emptyDom = await evidenceFixture(t, { visibleDomText: [] });
  await assert.rejects(
    loader()(emptyDom.options),
    /visible DOM.*nonempty|visibleDomText.*nonempty/i,
  );

  const emptyConsole = await evidenceFixture(t, { browserConsole: [] });
  const loaded = await loader()(emptyConsole.options);
  assert.deepEqual(loaded.captureEvidence.browserConsole, []);
});

test("verified loader rejects truncated covered DOM and console evidence", async (t) => {
  const truncatedDom = await evidenceFixture(t, {
    visibleDomText: ["Safe bounded prefix"],
    visibleDomTextTruncated: true,
  });
  await assert.rejects(
    loader()(truncatedDom.options),
    /visibleDomText.*(?:truncated|incomplete)|(?:truncated|incomplete).*visibleDomText/i,
  );

  const truncatedConsole = await evidenceFixture(t, {
    browserConsole: [],
    browserConsoleTruncated: true,
  });
  await assert.rejects(
    loader()(truncatedConsole.options),
    /browserConsole.*(?:truncated|incomplete)|(?:truncated|incomplete).*browserConsole/i,
  );
});

test("verified loader rejects incomplete teardown and missing typed runtime logs", async (t) => {
  const incomplete = await evidenceFixture(t, {
    teardown: {
      playwrightExited: true,
      backendPortReleased: false,
      fixtureTempRootRemoved: true,
    },
  });
  await assert.rejects(loader()(incomplete.options), /teardown|succeeded/i);

  const noLogs = await evidenceFixture(t, { runtimeLog: "" });
  await assert.rejects(
    loader()(noLogs.options),
    /runtime log.*nonempty|runtimeLogs.*evidence/i,
  );
});

test("verified loader accepts truthful bounded host log truncation without exposing infrastructure", async (t) => {
  const runtimeLog = "bounded host log\n";
  const truncated = await evidenceFixture(t, {
    runtimeLog,
    runtimeLogLimitBytes: Buffer.byteLength(runtimeLog),
    runtimeLogDiscardedBytes: 2_048,
  });

  const loaded = await loader()(truncated.options);
  assert.deepEqual(loaded.runtimeEvidence.logs, []);
});

test("verified loader binds immutable scenario bytes and canonical digest", async (t) => {
  const changedBytes = await evidenceFixture(t);
  await fs.appendFile(changedBytes.options.scenarioPath, "\n");
  await assert.rejects(
    loader()(changedBytes.options),
    /scenario bytes|scenario.*digest|scenario.*mismatch/i,
  );

  const changedDigest = await evidenceFixture(t);
  await assert.rejects(
    loader()({
      ...changedDigest.options,
      scenarioDigest: `sha256:${"f".repeat(64)}`,
    }),
    /scenario.*digest|capture receipt.*canonical/i,
  );
});

test("verified loader requires stable build, media alignment, and host input attestations", async (t) => {
  const trustedInput = await evidenceFixture(t, {
    mutateCaptureReceipt(receipt) {
      receipt.trustedInputLedger.push({
        contract: "kandev-highlight-host-input-dispatch-v1",
        sequence: 1,
        authority: "host-cdp",
        dispatchSucceeded: true,
        operation: "activation-start",
        cdpMethod: "Input.dispatchMouseEvent",
        type: "mousePressed",
        inputKind: "desktop",
        coordinates: { x: 20, y: 30 },
        key: null,
        code: null,
        text: null,
        button: "left",
        buttons: 1,
        clickCount: 1,
        touchPoints: [],
      });
    },
  });
  assert.deepEqual(
    (await loader()(trustedInput.options)).runtimeEvidence.logs,
    [],
  );

  const unstableBuild = await evidenceFixture(t, {
    mutateCaptureReceipt(receipt) {
      receipt.buildVerification.stable = false;
    },
  });
  await assert.rejects(
    loader()(unstableBuild.options),
    /build verification.*stable|stable.*build/i,
  );

  const misaligned = await evidenceFixture(t, {
    mutateCaptureReceipt(receipt) {
      receipt.capture.frameAlignment.frameDelta = 2;
    },
  });
  await assert.rejects(
    loader()(misaligned.options),
    /frame alignment.*tolerance/i,
  );

  const untrustedInput = await evidenceFixture(t, {
    mutateCaptureReceipt(receipt) {
      receipt.trustedInputLedger.push({
        contract: "kandev-highlight-dom-input-observation-v1",
        sequence: 0,
        authority: "page-script",
        dispatchSucceeded: true,
      });
    },
  });
  await assert.rejects(
    loader()(untrustedInput.options),
    /trusted input ledger.*(?:invalid|required)|host-cdp/i,
  );
});
