import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveAttemptDirectory,
  runDeclarativeHighlightCommand,
  writeContentAddressedStage,
} from "./pipeline.mjs";
import { renderHighlight } from "./render.mjs";

const SOURCE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const LANDING_SHA = "c".repeat(40);
const SEED_DIGEST = `sha256:${"d".repeat(64)}`;
const SENSITIVE_DATA = Object.freeze({
  contract: "kandev-highlight-sensitive-scan-v1",
  passed: true,
  coverage: {
    metadata: true,
    visibleDomText: true,
    browserConsole: true,
    runtimeLogs: false,
    renderedPixelOcr: false,
  },
  findings: [],
});

function runtimeProvenance() {
  return {
    contract: "kandev-highlight-runtime-provenance-v1",
    runtimeId: "kandev-isolated-e2e",
    receiptDigest: `sha256:${"4".repeat(64)}`,
    buildManifestDigest: `sha256:${"e".repeat(64)}`,
    buildContentDigest: `sha256:${"f".repeat(64)}`,
    captureEvidenceDigest: `sha256:${"5".repeat(64)}`,
    runtimeLogDigest: `sha256:${"6".repeat(64)}`,
    source: { mode: "pr_head", selectedSha: SOURCE_SHA },
    scanner: {
      contract: "kandev-highlight-sensitive-scan-v1",
      coverage: structuredClone(SENSITIVE_DATA.coverage),
    },
  };
}

function sourceGateProof() {
  return {
    contract: "kandev-highlight-source-v1",
    source: "pr_head",
    selectedSha: SOURCE_SHA,
    headSha: SOURCE_SHA,
    currentMainSha: BASE_SHA,
    clean: true,
    status: "",
  };
}

function buildProof() {
  return {
    contract: "kandev-highlight-build-provenance-v1",
    manifestDigest: `sha256:${"e".repeat(64)}`,
    source: sourceGateProof(),
    outputs: {
      backend: {
        path: "/external/build/backend",
        digest: `sha256:${"1".repeat(64)}`,
        bytes: 100,
      },
      mockAgent: {
        path: "/external/build/mock-agent",
        digest: `sha256:${"2".repeat(64)}`,
        bytes: 101,
      },
      webDist: {
        path: "/external/build/web-dist",
        digest: `sha256:${"3".repeat(64)}`,
        bytes: 102,
        fileCount: 3,
        files: [
          {
            path: "index.html",
            digest: `sha256:${"4".repeat(64)}`,
            bytes: 34,
          },
          {
            path: "assets/app.js",
            digest: `sha256:${"5".repeat(64)}`,
            bytes: 35,
          },
          {
            path: "assets/app.css",
            digest: `sha256:${"6".repeat(64)}`,
            bytes: 33,
          },
        ],
      },
    },
  };
}

function scenario(kind = "desktop", { delivery = true } = {}) {
  const native = kind === "native-mobile";
  return {
    $schema: "https://kandev.com/schemas/highlight-scenario-v1.json",
    schemaVersion: 1,
    id: native ? "quick-mobile" : "quick-desktop",
    title: native ? "Quick mobile" : "Quick desktop",
    profile: {
      kind,
      viewport: native
        ? { width: 430, height: 932 }
        : { width: 1920, height: 1200 },
      deviceScaleFactor: native ? 3 : 2,
    },
    seed: { recipe: "kandev.empty-workspace", parameters: {} },
    setup: { route: "workspace.board", primitives: [] },
    story: {
      openingSettleMs: 500,
      actions: [{ kind: "pause", durationMs: 1000, label: "Show state" }],
      endingSettleMs: 500,
    },
    ...(delivery
      ? {
          delivery: {
            revision: "r1",
            releaseVersion: "1.2.3",
            summary: "Show a short deterministic state.",
            caption: "Open the seeded board and hold the result.",
            featureFlags: ["features.highlights"],
            docs: { page: "tasks.md", section: "Quick demo" },
            mobileDeclaration: native
              ? "Feature has a native mobile surface."
              : "Feature has no accepted native mobile delivery in this revision.",
          },
        }
      : {}),
  };
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function recordDigest(record) {
  const source = structuredClone(record);
  delete source.recordDigest;
  return `sha256:${digest(canonicalJson(source))}`;
}

function timeline(value) {
  return {
    schemaVersion: 1,
    scenarioId: value.id,
    title: value.title,
    profile: value.profile.kind,
    viewport: value.profile.viewport,
    scenarioDigest: `sha256:${digest(canonicalJson(value))}`,
    totalDurationMs: 2000,
    events: [
      {
        index: 0,
        kind: "openingSettle",
        sourcePointer: "/story/openingSettleMs",
        startMs: 0,
        endMs: 500,
        actionDurationMs: 500,
        controlsCamera: false,
      },
      {
        index: 1,
        kind: "pause",
        sourcePointer: "/story/actions/0",
        startMs: 500,
        endMs: 1500,
        actionDurationMs: 1000,
        controlsCamera: false,
      },
      {
        index: 2,
        kind: "endingSettle",
        sourcePointer: "/story/endingSettleMs",
        startMs: 1500,
        endMs: 2000,
        actionDurationMs: 500,
        controlsCamera: false,
      },
    ],
  };
}

function landingAdapter() {
  return {
    provenance: { sha: LANDING_SHA, clean: true },
    contracts: {
      camera: { id: "kandev.highlight-camera", version: "1.0.0" },
      encoder: { id: "kandev.highlight-encoder", version: "1.0.0" },
    },
    materializeCameraTrack(plan) {
      return {
        contract: "kandev.highlight-camera",
        highlightProfile: plan.profile,
        formFactor: plan.profile === "native-mobile" ? "mobile" : "landing",
        fps: 25,
        durationMs: 2000,
        openingSettleMs: 500,
        endingSettleMs: 500,
        safeMargin: { top: 0.02, right: 0.02, bottom: 0.02, left: 0.02 },
        keyframes: [
          { tMs: 0, zoom: 1, x: 0.5, y: 0.5 },
          { tMs: 2000, zoom: 1, x: 0.5, y: 0.5 },
        ],
      };
    },
    buildHighlightEncodingPlan(input) {
      return {
        mp4: {
          command: "ffmpeg",
          args: [
            "-n",
            "-i",
            input.rawPath,
            path.join(input.outputDir, `${input.slug}.mp4`),
          ],
        },
        webm: {
          command: "ffmpeg",
          args: [
            "-n",
            "-i",
            input.rawPath,
            path.join(input.outputDir, `${input.slug}.webm`),
          ],
        },
        poster: {
          command: "ffmpeg",
          args: [
            "-n",
            "-i",
            input.rawPath,
            path.join(input.outputDir, `${input.slug}.webp`),
          ],
        },
      };
    },
  };
}

function baseDependencies(
  value,
  calls = [],
  captureInputs = [],
  qaInputs = [],
) {
  const compiled = timeline(value);
  return {
    readScenario: async () => value,
    compileTimeline: () => compiled,
    computeScenarioDigest: () => compiled.scenarioDigest,
    requireDeliveryMetadata(input) {
      if (!input.delivery)
        throw new Error("/delivery: promotion delivery metadata is required");
      return {
        revision: input.delivery.revision,
        highlight: {
          id: input.id,
          title: input.title,
          summary: input.delivery.summary,
          caption: input.delivery.caption,
          releaseVersion: input.delivery.releaseVersion,
          featureFlags: input.delivery.featureFlags,
          docs: input.delivery.docs,
          mobileDeclaration: input.delivery.mobileDeclaration,
        },
      };
    },
    verifySourceGate: async () => sourceGateProof(),
    resolvePrMetadata: async () => ({
      prNumber: 42,
      prBaseSha: BASE_SHA,
      prHeadSha: SOURCE_SHA,
    }),
    loadLandingAdapter: async () => landingAdapter(),
    frontendUrl: "http://127.0.0.1:4173",
    captureBindings: {
      seedRegistry: { [value.seed.recipe]: async () => ({}) },
      primitiveRegistry: {},
      navigateRoute: async () => {},
      buildProvenance: buildProof(),
    },
    clock: () => new Date("2026-07-22T12:00:00.000Z"),
    captureScenario: async ({
      artifactRoot,
      sourceDigest,
      source,
      buildProvenance,
    }) => {
      calls.push("capture");
      captureInputs.push({ source, sourceDigest });
      await fs.mkdir(path.join(artifactRoot, "raw"), { recursive: true });
      const rawMasterPath = path.join(
        artifactRoot,
        "raw",
        `${value.id}.source.mp4`,
      );
      const rawBytes = Buffer.from("raw-master-bytes");
      await fs.writeFile(rawMasterPath, rawBytes, { flag: "wx" });
      const execution = {
        storyEpochMs: 1000,
        storyDurationMs: 2000,
        steps: [],
        cursorEvidence: [],
        cursorResyncEvidence: [
          {
            point: {
              x: value.profile.viewport.width / 2,
              y: value.profile.viewport.height / 2,
            },
          },
        ],
      };
      return {
        contract: "kandev-highlight-capture-result-v1",
        rawMasterPath,
        execution,
        timeline: compiled,
        receipt: {
          contract: "kandev-highlight-source-capture-v1",
          scenarioDigest: compiled.scenarioDigest,
          sourceDigest,
          source,
          build: {
            contract: buildProvenance.contract,
            manifestDigest: buildProvenance.manifestDigest,
            sourceSha: buildProvenance.source.selectedSha,
            outputs: {
              backend: {
                digest: buildProvenance.outputs.backend.digest,
                bytes: buildProvenance.outputs.backend.bytes,
              },
              mockAgent: {
                digest: buildProvenance.outputs.mockAgent.digest,
                bytes: buildProvenance.outputs.mockAgent.bytes,
              },
              webDist: {
                digest: buildProvenance.outputs.webDist.digest,
                bytes: buildProvenance.outputs.webDist.bytes,
                fileCount: buildProvenance.outputs.webDist.fileCount,
              },
            },
          },
          storyStartOffsetMs: 100,
          storyDurationMs: 2000,
          rawMaster: {
            path: rawMasterPath,
            bytes: rawBytes.length,
            digest: `sha256:${digest(rawBytes)}`,
          },
          seed: {
            seedId: value.seed.recipe,
            seedDigest: SEED_DIGEST,
            invariants: { workspaceId: "seed-proof-001", tasks: 0 },
          },
          execution,
          captureEvidence: {
            visibleDomText: ["Safe seeded board"],
            browserConsole: [],
          },
          applicationRuntime: { logs: ["isolated runtime ready"] },
        },
      };
    },
    loadRuntimeEvidence: async () => ({
      contract: "kandev-highlight-runtime-evidence-v1",
      captureEvidence: {
        visibleDomText: ["Safe seeded board"],
        browserConsole: [],
        truncated: { visibleDomText: false, browserConsole: false },
      },
      runtimeEvidence: { logs: [] },
      provenance: runtimeProvenance(),
    }),
    renderHighlight: async ({
      scenario: input,
      artifactRoot,
      runId,
      camera,
      landingAdapter: adapter,
    }) => {
      calls.push("render");
      const stageDir = path.join(artifactRoot, input.id, runId);
      await fs.mkdir(stageDir, { recursive: true });
      const names = {
        mp4: `${input.profile.kind === "native-mobile" ? "mobile" : "desktop"}-${input.id}.mp4`,
        webm: `${input.profile.kind === "native-mobile" ? "mobile" : "desktop"}-${input.id}.webm`,
        poster: `${input.profile.kind === "native-mobile" ? "mobile" : "desktop"}-${input.id}.webp`,
      };
      for (const [kind, name] of Object.entries(names))
        await fs.writeFile(path.join(stageDir, name), `${kind}-delivery`, {
          flag: "wx",
        });
      return {
        stageDir,
        cameraTrack: adapter.materializeCameraTrack(camera),
        manifest: {
          contract: "kandev-highlight-render-v1",
          profile: input.profile.kind,
          artifacts: Object.entries(names).map(([kind, artifactPath]) => ({
            kind,
            path: artifactPath,
          })),
        },
      };
    },
    runQualityAssurance: async ({
      artifacts,
      captureEvidence,
      runtimeEvidence,
    }) => {
      calls.push("qa");
      qaInputs.push({ captureEvidence, runtimeEvidence });
      return {
        contract: "kandev-highlight-qa-v1",
        scenarioId: value.id,
        passed: true,
        artifacts: await Promise.all(
          artifacts.map(async ({ path: filePath, expected }) => {
            const bytes = await fs.readFile(filePath);
            return {
              kind: expected.kind,
              path: filePath,
              bytes: bytes.length,
              sha256: digest(bytes),
              probe: {
                codec: expected.codec,
                width: expected.width,
                height: expected.height,
                fps: expected.fps,
                durationMs: expected.durationMs,
                audioStreams: 0,
              },
            };
          }),
        ),
        camera: { passed: true },
        containment: { passed: true },
        sensitiveData: structuredClone(SENSITIVE_DATA),
        browser: { passed: true },
      };
    },
  };
}

async function roots(t, value) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-pipeline-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const repoRoot = path.join(base, "repo");
  const artifactRoot = path.join(base, "artifacts");
  await fs.mkdir(path.join(repoRoot, "docs/public"), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, "docs/public/tasks.md"),
    "# Tasks\n\n## Quick demo\n",
  );
  const scenarioPath = path.join(repoRoot, `${value.id}.scenario.json`);
  await fs.writeFile(scenarioPath, `${JSON.stringify(value, null, 2)}\n`);
  return { base, repoRoot, artifactRoot, scenarioPath };
}

async function inventoryTree(root) {
  const entries = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        entries.push(`dir:${relative}`);
        await walk(absolute);
      } else {
        const bytes = await fs.readFile(absolute);
        entries.push(`file:${relative}:${bytes.length}:${digest(bytes)}`);
      }
    }
  }
  await walk(root);
  return entries.sort();
}

async function rewriteRecord(filePath, mutate) {
  const record = JSON.parse(await fs.readFile(filePath, "utf8"));
  mutate(record);
  record.recordDigest = recordDigest(record);
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`);
}

async function runThroughQa({
  value,
  repoRoot,
  artifactRoot,
  scenarioPath,
  runId,
  dependencies,
}) {
  const common = {
    scenarioPath,
    artifactRoot,
    landingRoot: path.join(path.dirname(repoRoot), "landing"),
    runId,
    repoRoot,
    dependencies,
  };
  await runDeclarativeHighlightCommand({
    ...common,
    command: "capture",
    source: "pr_head",
    prNumber: 42,
    prBaseSha: BASE_SHA,
  });
  await runDeclarativeHighlightCommand({ ...common, command: "render" });
  await runDeclarativeHighlightCommand({ ...common, command: "qa" });
  return common;
}

test("run dry-run is a zero-write complete machine plan", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  let captureCalls = 0;
  const dependencies = baseDependencies(value);
  dependencies.captureScenario = async () => {
    captureCalls += 1;
  };
  const plan = await runDeclarativeHighlightCommand({
    command: "run",
    scenarioPath,
    artifactRoot,
    source: "pr_head",
    landingRoot: path.join(path.dirname(repoRoot), "landing"),
    runId: "ci-001",
    prNumber: 42,
    prBaseSha: BASE_SHA,
    repoRoot,
    dryRun: true,
    dependencies,
  });

  assert.equal(plan.contract, "kandev-highlight-dry-run-v1");
  assert.equal(plan.source.sourceSha, SOURCE_SHA);
  assert.equal(plan.scenario.digest, timeline(value).scenarioDigest);
  assert.deepEqual(plan.profile.delivery, {
    width: 1920,
    height: 1200,
    fps: 25,
  });
  assert.equal(plan.prerequisites.selectors.status, "runtime-required");
  assert.equal(plan.landing.sourceSha, LANDING_SHA);
  assert.ok(
    plan.encodingCommands.every(
      ({ argv }) => Array.isArray(argv) && argv[0] === "ffmpeg",
    ),
  );
  assert.match(plan.paths.stagePattern, /sha256|digest/i);
  assert.equal(captureCalls, 0);
  await assert.rejects(fs.access(artifactRoot), /ENOENT/);
});

test("run writes technical content-addressed review stage and never promotes", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const calls = [];
  const captureInputs = [];
  const qaInputs = [];
  const dependencies = baseDependencies(value, calls, captureInputs, qaInputs);
  dependencies.promoteStagedHighlight = async () => {
    calls.push("PROMOTE");
    throw new Error("must not run");
  };
  const result = await runDeclarativeHighlightCommand({
    command: "run",
    scenarioPath,
    artifactRoot,
    source: "pr_head",
    landingRoot: path.join(path.dirname(repoRoot), "landing"),
    runId: "run-001",
    prNumber: 42,
    prBaseSha: BASE_SHA,
    repoRoot,
    dependencies,
  });

  assert.deepEqual(result.order, [
    "validate",
    "storyboard",
    "capture",
    "render",
    "qa",
    "stage",
  ]);
  assert.deepEqual(calls, ["capture", "render", "qa"]);
  assert.equal(captureInputs.length, 1);
  assert.deepEqual(captureInputs[0].source, {
    contract: "kandev-highlight-source-v1",
    source: "pr_head",
    selectedSha: SOURCE_SHA,
    headSha: SOURCE_SHA,
    currentMainSha: BASE_SHA,
    clean: true,
    status: "",
  });
  assert.equal(result.phases.stage.promotable, false);
  assert.equal(result.phases.stage.readyForReview, true);
  assert.match(path.basename(result.phases.stage.stageDir), /^[a-f0-9]{64}$/);
  const review = JSON.parse(
    await fs.readFile(result.phases.stage.manifestPath, "utf8"),
  );
  assert.equal(review.qa.passed, true);
  assert.equal(review.contract, "kandev-highlight-review-stage-v2");
  assert.equal(review.schemaVersion, 2);
  assert.equal(path.basename(result.phases.stage.manifestPath), "review.json");
  assert.equal(review.qa.status, "technical_pass");
  assert.deepEqual(result.phases.qa.sensitiveData, SENSITIVE_DATA);
  assert.deepEqual(qaInputs, [
    {
      captureEvidence: {
        visibleDomText: ["Safe seeded board"],
        browserConsole: [],
        truncated: { visibleDomText: false, browserConsole: false },
      },
      runtimeEvidence: { logs: [] },
    },
  ]);
  assert.equal(review.provenance.seedId, value.seed.recipe);
  assert.deepEqual(review.provenance.landingAdapter, {
    sourceSha: LANDING_SHA,
    contractVersion: "1.0.0",
  });
  assert.deepEqual(review.provenance.runtime, runtimeProvenance());
  assert.equal(review.assets.desktop.mp4.width, 1920);
});

test("QA loads verified runtime evidence and persists only compact runtime provenance", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const qaInputs = [];
  const dependencies = baseDependencies(value, [], [], qaInputs);
  let evidenceLoads = 0;
  dependencies.loadRuntimeEvidence = async (input) => {
    evidenceLoads += 1;
    assert.equal(input.scenarioId, value.id);
    assert.equal(input.runId, "runtime-qa-001");
    return {
      contract: "kandev-highlight-runtime-evidence-v1",
      captureEvidence: {
        visibleDomText: ["Verified DOM value"],
        browserConsole: [],
        truncated: { visibleDomText: false, browserConsole: false },
      },
      runtimeEvidence: { logs: [] },
      provenance: runtimeProvenance(),
    };
  };

  const common = await runThroughQa({
    value,
    repoRoot,
    artifactRoot,
    scenarioPath,
    runId: "runtime-qa-001",
    dependencies,
  });
  assert.equal(evidenceLoads, 1);
  assert.deepEqual(qaInputs, [
    {
      captureEvidence: {
        visibleDomText: ["Verified DOM value"],
        browserConsole: [],
        truncated: { visibleDomText: false, browserConsole: false },
      },
      runtimeEvidence: { logs: [] },
    },
  ]);
  const qaRecord = JSON.parse(
    await fs.readFile(
      path.join(
        artifactRoot,
        value.id,
        "runs",
        common.runId,
        "evidence",
        "qa.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(qaRecord.value.runtime, runtimeProvenance());
  assert.doesNotMatch(
    JSON.stringify(qaRecord.value),
    /Verified DOM value|verified runtime log/,
  );
});

test("QA rejects a trusted scanner result weaker than catalog runtime coverage", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  dependencies.loadRuntimeEvidence = async () => ({
    contract: "kandev-highlight-runtime-evidence-v1",
    captureEvidence: {
      visibleDomText: ["Safe DOM"],
      browserConsole: [],
      truncated: { visibleDomText: false, browserConsole: false },
    },
    runtimeEvidence: { logs: [] },
    provenance: runtimeProvenance(),
  });
  dependencies.runQualityAssurance = async () => ({
    contract: "kandev-highlight-qa-v1",
    scenarioId: value.id,
    passed: true,
    artifacts: [],
    camera: { passed: true },
    containment: { passed: true },
    sensitiveData: {
      contract: "kandev-highlight-sensitive-scan-v1",
      passed: true,
      coverage: {
        metadata: true,
        visibleDomText: false,
        browserConsole: false,
        runtimeLogs: false,
        renderedPixelOcr: false,
      },
      findings: [],
    },
    browser: { passed: true },
  });

  await runDeclarativeHighlightCommand({
    command: "capture",
    scenarioPath,
    artifactRoot,
    source: "pr_head",
    runId: "weak-scan-001",
    prNumber: 42,
    prBaseSha: BASE_SHA,
    repoRoot,
    dependencies,
  });
  await runDeclarativeHighlightCommand({
    command: "render",
    scenarioPath,
    artifactRoot,
    landingRoot: path.join(path.dirname(repoRoot), "landing"),
    runId: "weak-scan-001",
    repoRoot,
    dependencies,
  });
  await assert.rejects(
    runDeclarativeHighlightCommand({
      command: "qa",
      scenarioPath,
      artifactRoot,
      landingRoot: path.join(path.dirname(repoRoot), "landing"),
      runId: "weak-scan-001",
      repoRoot,
      dependencies,
    }),
    /sensitive-scan coverage visibleDomText.*reported false|runtime coverage/i,
  );
});

test("QA rejects sensitive findings even if an injected QA adapter claims pass", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  dependencies.runQualityAssurance = async () => ({
    contract: "kandev-highlight-qa-v1",
    scenarioId: value.id,
    passed: true,
    artifacts: [],
    camera: { passed: true },
    containment: { passed: true },
    sensitiveData: {
      contract: "kandev-highlight-sensitive-scan-v1",
      passed: false,
      coverage: structuredClone(SENSITIVE_DATA.coverage),
      findings: [
        {
          ruleId: "access-token",
          source: "metadata",
          occurrences: 1,
          redacted: true,
        },
      ],
    },
    browser: { passed: true },
  });

  await assert.rejects(
    runThroughQa({
      value,
      repoRoot,
      artifactRoot,
      scenarioPath,
      runId: "runtime-sensitive-finding",
      dependencies,
    }),
    /sensitive.*(?:pass|finding)|automatic QA/i,
  );
});

test("browser failure leaves no published QA and the same run retries cleanly", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  const successfulQa = dependencies.runQualityAssurance;
  let qaAttempts = 0;
  dependencies.runQualityAssurance = async (input) => {
    qaAttempts += 1;
    if (qaAttempts === 1) {
      await fs.mkdir(input.qaOutputDir, { recursive: true });
      await fs.writeFile(
        path.join(input.qaOutputDir, "partial-contact-sheet.png"),
        "partial-proof",
        { flag: "wx" },
      );
      throw new Error("browser playback failed after proof generation");
    }
    return successfulQa(input);
  };
  const runId = "qa-browser-retry-001";
  const common = {
    scenarioPath,
    artifactRoot,
    landingRoot: path.join(path.dirname(repoRoot), "landing"),
    runId,
    repoRoot,
    dependencies,
  };
  await runDeclarativeHighlightCommand({
    ...common,
    command: "capture",
    source: "pr_head",
    prNumber: 42,
    prBaseSha: BASE_SHA,
  });
  await runDeclarativeHighlightCommand({ ...common, command: "render" });

  await assert.rejects(
    runDeclarativeHighlightCommand({ ...common, command: "qa" }),
    /browser playback failed after proof generation/,
  );
  const attemptRoot = path.join(artifactRoot, value.id, "runs", runId);
  await assert.rejects(fs.access(path.join(attemptRoot, "qa")), /ENOENT/);
  assert.equal(
    (await fs.readdir(attemptRoot)).some((entry) =>
      entry.startsWith(".qa-building-"),
    ),
    false,
  );

  const retried = await runDeclarativeHighlightCommand({
    ...common,
    command: "qa",
  });
  assert.equal(retried.phases.qa.status, "technical_pass");
  assert.equal(qaAttempts, 2);
  const reportPath = path.join(attemptRoot, "qa", "report.json");
  await fs.access(reportPath);
  assert.equal(
    (await fs.readFile(reportPath, "utf8")).includes(".qa-building-"),
    false,
  );
});

test("QA cleanup refuses to delete a replaced private build directory", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  let replacementPath;
  dependencies.runQualityAssurance = async ({ qaOutputDir }) => {
    await fs.rename(qaOutputDir, `${qaOutputDir}-moved`);
    await fs.mkdir(qaOutputDir);
    replacementPath = path.join(qaOutputDir, "do-not-delete.txt");
    await fs.writeFile(replacementPath, "replacement-owned-elsewhere");
    throw new Error("synthetic QA failure after directory replacement");
  };
  const runId = "qa-cleanup-ownership-001";
  const common = {
    scenarioPath,
    artifactRoot,
    landingRoot: path.join(path.dirname(repoRoot), "landing"),
    runId,
    repoRoot,
    dependencies,
  };
  await runDeclarativeHighlightCommand({
    ...common,
    command: "capture",
    source: "pr_head",
    prNumber: 42,
    prBaseSha: BASE_SHA,
  });
  await runDeclarativeHighlightCommand({ ...common, command: "render" });

  await assert.rejects(
    runDeclarativeHighlightCommand({ ...common, command: "qa" }),
    /private build directory could not be cleaned|replaced QA build directory/i,
  );
  assert.equal(
    await fs.readFile(replacementPath, "utf8"),
    "replacement-owned-elsewhere",
  );
});

test("QA refuses to publish a replaced private build directory", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  const successfulQa = dependencies.runQualityAssurance;
  let replacementRoot;
  dependencies.runQualityAssurance = async (input) => {
    const report = await successfulQa(input);
    await fs.rename(input.qaOutputDir, `${input.qaOutputDir}-moved`);
    await fs.mkdir(input.qaOutputDir);
    replacementRoot = input.qaOutputDir;
    return report;
  };
  const runId = "qa-publish-ownership-001";
  const common = {
    scenarioPath,
    artifactRoot,
    landingRoot: path.join(path.dirname(repoRoot), "landing"),
    runId,
    repoRoot,
    dependencies,
  };
  await runDeclarativeHighlightCommand({
    ...common,
    command: "capture",
    source: "pr_head",
    prNumber: 42,
    prBaseSha: BASE_SHA,
  });
  await runDeclarativeHighlightCommand({ ...common, command: "render" });

  await assert.rejects(
    runDeclarativeHighlightCommand({ ...common, command: "qa" }),
    /private build directory could not be cleaned|replaced QA build directory/i,
  );
  assert.equal((await fs.lstat(replacementRoot)).isDirectory(), true);
});

test("QA publication refuses an empty final directory created during the run", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  const successfulQa = dependencies.runQualityAssurance;
  let finalQaRoot;
  dependencies.runQualityAssurance = async (input) => {
    const report = await successfulQa(input);
    finalQaRoot = path.join(path.dirname(input.qaOutputDir), "qa");
    await fs.mkdir(finalQaRoot);
    return report;
  };
  const runId = "qa-publish-race-001";
  const common = {
    scenarioPath,
    artifactRoot,
    landingRoot: path.join(path.dirname(repoRoot), "landing"),
    runId,
    repoRoot,
    dependencies,
  };
  await runDeclarativeHighlightCommand({
    ...common,
    command: "capture",
    source: "pr_head",
    prNumber: 42,
    prBaseSha: BASE_SHA,
  });
  await runDeclarativeHighlightCommand({ ...common, command: "render" });

  await assert.rejects(
    runDeclarativeHighlightCommand({ ...common, command: "qa" }),
    /refusing to overwrite published QA output/i,
  );
  assert.deepEqual(await fs.readdir(finalQaRoot), []);
});

test("published QA without a phase record finalizes without rerunning tools", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  const runId = "qa-finalize-001";
  const common = await runThroughQa({
    value,
    repoRoot,
    artifactRoot,
    scenarioPath,
    runId,
    dependencies,
  });
  const qaPhasePath = path.join(
    artifactRoot,
    value.id,
    "runs",
    runId,
    "evidence",
    "qa.json",
  );
  await fs.unlink(qaPhasePath);
  dependencies.runQualityAssurance = async () => {
    throw new Error("QA tools must not rerun for published output");
  };

  const recovered = await runDeclarativeHighlightCommand({
    ...common,
    command: "qa",
  });

  assert.equal(recovered.phases.qa.status, "technical_pass");
  await fs.access(qaPhasePath);
});

test("QA finalization preserves and rejects a published proof symlink", async (t) => {
  const value = scenario();
  const { base, repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  const basicQa = dependencies.runQualityAssurance;
  dependencies.runQualityAssurance = async (input) => {
    const report = await basicQa(input);
    const keyframePath = path.join(input.qaOutputDir, "proof-keyframe.png");
    const contactSheetPath = path.join(
      input.qaOutputDir,
      "proof-contact-sheet.png",
    );
    const keyframeBytes = Buffer.from("keyframe-proof");
    const contactBytes = Buffer.from("contact-sheet-proof");
    await Promise.all([
      fs.writeFile(keyframePath, keyframeBytes, { flag: "wx" }),
      fs.writeFile(contactSheetPath, contactBytes, { flag: "wx" }),
    ]);
    report.artifacts[0].proofs = {
      keyframes: [
        {
          frame: 0,
          path: keyframePath,
          bytes: keyframeBytes.length,
          sha256: digest(keyframeBytes),
        },
      ],
      contactSheet: {
        path: contactSheetPath,
        bytes: contactBytes.length,
        sha256: digest(contactBytes),
      },
    };
    return report;
  };
  const runId = "qa-proof-symlink-001";
  const common = await runThroughQa({
    value,
    repoRoot,
    artifactRoot,
    scenarioPath,
    runId,
    dependencies,
  });
  const attemptRoot = path.join(artifactRoot, value.id, "runs", runId);
  const qaPhasePath = path.join(attemptRoot, "evidence", "qa.json");
  const keyframePath = path.join(attemptRoot, "qa", "proof-keyframe.png");
  const outsidePath = path.join(base, "outside-proof.png");
  await fs.writeFile(outsidePath, "outside-proof-stays");
  await fs.unlink(qaPhasePath);
  await fs.unlink(keyframePath);
  await fs.symlink(outsidePath, keyframePath);
  dependencies.runQualityAssurance = async () => {
    throw new Error("QA tools must not rerun for suspicious output");
  };

  await assert.rejects(
    runDeclarativeHighlightCommand({ ...common, command: "qa" }),
    /proof.*(?:regular file|symlink)/i,
  );
  assert.equal(await fs.readFile(outsidePath, "utf8"), "outside-proof-stays");
  assert.equal((await fs.lstat(keyframePath)).isSymbolicLink(), true);
});

test("published render without a phase record finalizes without re-encoding", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  const adapter = landingAdapter();
  let encodes = 0;
  adapter.encodeHighlight = async (input) => {
    encodes += 1;
    const outputs = {
      mp4: path.join(input.outputDir, `${input.slug}.mp4`),
      poster: path.join(input.outputDir, `${input.slug}.webp`),
      webm: path.join(input.outputDir, `${input.slug}.webm`),
    };
    await Promise.all(
      Object.values(outputs).map((filePath) =>
        fs.writeFile(filePath, "rendered-delivery", { flag: "wx" }),
      ),
    );
    return Object.fromEntries(
      Object.entries(outputs).map(([kind, filePath]) => [
        kind,
        { path: filePath },
      ]),
    );
  };
  dependencies.loadLandingAdapter = async () => adapter;
  dependencies.renderHighlight = renderHighlight;
  const runId = "render-finalize-001";
  const common = {
    scenarioPath,
    artifactRoot,
    landingRoot: path.join(path.dirname(repoRoot), "landing"),
    runId,
    repoRoot,
    dependencies,
  };
  await runDeclarativeHighlightCommand({
    ...common,
    command: "capture",
    source: "pr_head",
    prNumber: 42,
    prBaseSha: BASE_SHA,
  });
  await runDeclarativeHighlightCommand({ ...common, command: "render" });
  const renderPhasePath = path.join(
    artifactRoot,
    value.id,
    "runs",
    runId,
    "evidence",
    "render.json",
  );
  await fs.unlink(renderPhasePath);
  adapter.encodeHighlight = async () => {
    throw new Error("encoder must not rerun for published output");
  };

  const recovered = await runDeclarativeHighlightCommand({
    ...common,
    command: "render",
  });

  assert.equal(recovered.phases.render.manifest.scenarioId, value.id);
  assert.equal(encodes, 1);
  await fs.access(renderPhasePath);
});

test("run rejects missing delivery metadata before source, landing, or capture work", async (t) => {
  const value = scenario("desktop", { delivery: false });
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const calls = [];
  const dependencies = baseDependencies(value, calls);
  dependencies.verifySourceGate = async () => {
    calls.push("source");
  };
  dependencies.loadLandingAdapter = async () => {
    calls.push("landing");
  };

  await assert.rejects(
    runDeclarativeHighlightCommand({
      command: "run",
      scenarioPath,
      artifactRoot,
      source: "pr_head",
      repoRoot,
      dependencies,
    }),
    /\/delivery.*required/i,
  );
  assert.deepEqual(calls, []);
  await assert.rejects(fs.access(artifactRoot), /ENOENT/);
});

test("capture rejects missing extension bindings before reserving artifacts", async (t) => {
  const value = scenario();
  value.setup.primitives.push({ primitiveId: "fixture.reveal", input: {} });
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  await assert.rejects(
    runDeclarativeHighlightCommand({
      command: "capture",
      scenarioPath,
      artifactRoot,
      source: "pr_head",
      runId: "extension-001",
      prNumber: 42,
      prBaseSha: BASE_SHA,
      allowedExtensionIds: ["fixture.reveal"],
      repoRoot,
      dependencies,
    }),
    /fixture\.reveal.*binding|primitive.*fixture\.reveal/i,
  );
  await assert.rejects(fs.access(artifactRoot), /ENOENT/);
});

test("native-mobile run creates digest review bundle and never relabels it as desktop", async (t) => {
  const value = scenario("native-mobile");
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const result = await runDeclarativeHighlightCommand({
    command: "run",
    scenarioPath,
    artifactRoot,
    source: "pr_head",
    landingRoot: path.join(path.dirname(repoRoot), "landing"),
    runId: "mobile-001",
    prNumber: 42,
    prBaseSha: BASE_SHA,
    repoRoot,
    dependencies: baseDependencies(value),
  });
  const stage = result.phases.stage;
  assert.equal(stage.promotable, false);
  assert.equal(stage.reason, "desktop-stage-required");
  const manifest = JSON.parse(await fs.readFile(stage.manifestPath, "utf8"));
  assert.equal(path.basename(stage.manifestPath), "review.json");
  assert.equal(manifest.profile, "native-mobile");
  assert.equal(manifest.promotable, false);
  assert.ok(manifest.assets.mobile);
  assert.equal(manifest.assets.desktop, undefined);
  await assert.rejects(
    fs.access(path.join(stage.stageDir, "stage.json")),
    /ENOENT/,
  );
});

test("content-addressed review stage refuses same digest collision", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  const first = await runDeclarativeHighlightCommand({
    command: "run",
    scenarioPath,
    artifactRoot,
    source: "pr_head",
    landingRoot: path.join(path.dirname(repoRoot), "landing"),
    runId: "collision-001",
    prNumber: 42,
    prBaseSha: BASE_SHA,
    repoRoot,
    dependencies,
  });
  const input = first.phases.stage.input;
  await assert.rejects(
    writeContentAddressedStage(input),
    /refusing to overwrite|collision/i,
  );
});

test("review stage copies bytes immutably and accepts canonical scenario source bytes", async (t) => {
  const value = scenario();
  const { base, repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const result = await runDeclarativeHighlightCommand({
    command: "run",
    scenarioPath,
    artifactRoot,
    source: "pr_head",
    landingRoot: path.join(base, "landing"),
    runId: "immutable-001",
    prNumber: 42,
    prBaseSha: BASE_SHA,
    repoRoot,
    dependencies: baseDependencies(value),
  });
  const review = result.phases.stage;
  const stagedRaw = path.join(review.stageDir, review.manifest.capture.path);
  const before = await fs.readFile(stagedRaw);
  await fs.writeFile(
    review.input.capture.receipt.rawMaster.path,
    "mutated-attempt",
  );
  assert.deepEqual(await fs.readFile(stagedRaw), before);
  await fs.writeFile(review.input.capture.receipt.rawMaster.path, before);

  const canonicalPath = path.join(repoRoot, "canonical.scenario.json");
  await fs.writeFile(canonicalPath, canonicalJson(value));
  const canonicalInput = {
    ...review.input,
    artifactRoot: path.join(base, "canonical-artifacts"),
    scenarioPath: canonicalPath,
  };
  const canonicalStage = await writeContentAddressedStage(canonicalInput);
  assert.equal(canonicalStage.readyForReview, true);
});

test("attempt discovery refuses ambiguity and selects an explicit immutable run", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-attempt-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "artifacts");
  await fs.mkdir(path.join(root, "story", "runs", "one"), { recursive: true });
  await fs.mkdir(path.join(root, "story", "runs", "two"), { recursive: true });
  await assert.rejects(
    resolveAttemptDirectory({ artifactRoot: root, scenarioId: "story" }),
    /multiple.*--run-id|ambiguous/i,
  );
  assert.equal(
    await resolveAttemptDirectory({
      artifactRoot: root,
      scenarioId: "story",
      runId: "one",
    }),
    path.join(root, "story", "runs", "one"),
  );
});

test("stage recovers a completed attempt without recapturing, rendering, or rerunning QA", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  const common = await runThroughQa({
    value,
    repoRoot,
    artifactRoot,
    scenarioPath,
    runId: "recover-stage-001",
    dependencies,
  });
  const forbidden = async () => {
    throw new Error("recovery must not execute an expensive phase");
  };
  const result = await runDeclarativeHighlightCommand({
    ...common,
    command: "stage",
    dependencies: {
      ...dependencies,
      captureScenario: forbidden,
      renderHighlight: forbidden,
      runQualityAssurance: forbidden,
      loadLandingAdapter: forbidden,
    },
  });

  assert.equal(result.command, "stage");
  assert.deepEqual(result.order, ["stage"]);
  assert.equal(result.runId, "recover-stage-001");
  assert.equal(result.phases.stage.readyForReview, true);
  assert.match(result.phases.stage.manifestPath, /review\.json$/);
});

test("capture persists self-digested immutable phase records", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const runId = "digested-phases-001";
  await runDeclarativeHighlightCommand({
    command: "capture",
    scenarioPath,
    artifactRoot,
    source: "pr_head",
    runId,
    prNumber: 42,
    prBaseSha: BASE_SHA,
    repoRoot,
    dependencies: baseDependencies(value),
  });

  const evidenceRoot = path.join(
    artifactRoot,
    value.id,
    "runs",
    runId,
    "evidence",
  );
  for (const phase of ["validate", "storyboard", "capture"]) {
    const record = JSON.parse(
      await fs.readFile(path.join(evidenceRoot, `${phase}.json`), "utf8"),
    );
    assert.equal(record.recordDigest, recordDigest(record));
  }
});

test("render recovery rejects a tampered phase record with an exact next command", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const runId = "tampered-storyboard-001";
  const dependencies = baseDependencies(value);
  await runDeclarativeHighlightCommand({
    command: "capture",
    scenarioPath,
    artifactRoot,
    source: "pr_head",
    runId,
    prNumber: 42,
    prBaseSha: BASE_SHA,
    repoRoot,
    dependencies,
  });
  const storyboardPath = path.join(
    artifactRoot,
    value.id,
    "runs",
    runId,
    "evidence",
    "storyboard.json",
  );
  const storyboard = JSON.parse(await fs.readFile(storyboardPath, "utf8"));
  storyboard.value.timeline.totalDurationMs += 1;
  await fs.writeFile(
    storyboardPath,
    `${JSON.stringify(storyboard, null, 2)}\n`,
  );

  await assert.rejects(
    runDeclarativeHighlightCommand({
      command: "render",
      scenarioPath,
      artifactRoot,
      landingRoot: path.join(path.dirname(repoRoot), "landing"),
      runId,
      repoRoot,
      dependencies,
    }),
    (error) => {
      assert.match(error.message, /storyboard.*manifest digest/i);
      assert.match(
        error.message,
        /Next command: node scripts\/highlights\.mjs capture .* --artifact-root .* --source pr_head/,
      );
      return true;
    },
  );
});

test("default capture run IDs combine the injected clock with a safe uniqueness token", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const nonces = ["a1b2c3d4", "d4c3b2a1"];
  const dependencies = {
    ...baseDependencies(value),
    runIdNonce: () => nonces.shift(),
  };
  const input = {
    command: "capture",
    scenarioPath,
    artifactRoot,
    source: "pr_head",
    prNumber: 42,
    prBaseSha: BASE_SHA,
    repoRoot,
    dependencies,
  };
  const first = await runDeclarativeHighlightCommand(input);
  const second = await runDeclarativeHighlightCommand(input);
  const digestPrefix = timeline(value).scenarioDigest.slice(7, 19);

  assert.equal(first.runId, `run-${digestPrefix}-20260722T120000000Z-a1b2c3d4`);
  assert.equal(
    second.runId,
    `run-${digestPrefix}-20260722T120000000Z-d4c3b2a1`,
  );
  assert.notEqual(first.runId, second.runId);

  const explicit = await runDeclarativeHighlightCommand({
    ...input,
    runId: "agent-chosen-001",
  });
  assert.equal(explicit.runId, "agent-chosen-001");
});

test("stage dry-run verifies recovery and computes the exact review target with zero writes", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  const common = await runThroughQa({
    value,
    repoRoot,
    artifactRoot,
    scenarioPath,
    runId: "dry-stage-001",
    dependencies,
  });
  const before = await inventoryTree(artifactRoot);
  const forbidden = async () => {
    throw new Error("stage dry-run must only read verified recovery evidence");
  };
  const plan = await runDeclarativeHighlightCommand({
    ...common,
    command: "stage",
    dryRun: true,
    dependencies: {
      ...dependencies,
      captureScenario: forbidden,
      renderHighlight: forbidden,
      runQualityAssurance: forbidden,
      loadLandingAdapter: forbidden,
    },
  });

  assert.equal(plan.contract, "kandev-highlight-stage-dry-run-v1");
  assert.equal(plan.runId, "dry-stage-001");
  assert.deepEqual(plan.verifiedPhases, [
    "validate",
    "storyboard",
    "capture",
    "camera",
    "render",
    "qa",
  ]);
  assert.match(plan.stageDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(path.basename(plan.target), plan.stageDigest.slice(7));
  assert.equal(plan.manifestPath, path.join(plan.target, "review.json"));
  assert.deepEqual(await inventoryTree(artifactRoot), before);
  await assert.rejects(fs.access(plan.target), /ENOENT/);
});

test("render self-digests camera evidence and QA recovery rejects camera edits", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const runId = "camera-digest-001";
  const dependencies = baseDependencies(value);
  const common = {
    scenarioPath,
    artifactRoot,
    landingRoot: path.join(path.dirname(repoRoot), "landing"),
    runId,
    repoRoot,
    dependencies,
  };
  await runDeclarativeHighlightCommand({
    ...common,
    command: "capture",
    source: "pr_head",
    prNumber: 42,
    prBaseSha: BASE_SHA,
  });
  await runDeclarativeHighlightCommand({ ...common, command: "render" });
  const cameraPath = path.join(
    artifactRoot,
    value.id,
    "runs",
    runId,
    "evidence",
    "camera.json",
  );
  const camera = JSON.parse(await fs.readFile(cameraPath, "utf8"));
  assert.equal(camera.recordDigest, recordDigest(camera));
  camera.track.keyframes[0].zoom = 1.01;
  await fs.writeFile(cameraPath, `${JSON.stringify(camera, null, 2)}\n`);

  await assert.rejects(
    runDeclarativeHighlightCommand({ ...common, command: "qa" }),
    (error) => {
      assert.match(error.message, /camera evidence digest|camera.*contract/i);
      assert.match(
        error.message,
        /Next command: node scripts\/highlights\.mjs render .* --run-id "camera-digest-001"/,
      );
      return true;
    },
  );
});

test("render recovery cross-checks source, build, and raw capture proof", async (t) => {
  const cases = [
    {
      name: "source gate",
      mutate: async ({ capturePath }) =>
        rewriteRecord(capturePath, (record) => {
          record.value.receipt.source.selectedSha = "f".repeat(40);
        }),
      message: /capture source.*validate source|source.*continuity/i,
    },
    {
      name: "build manifest",
      mutate: async ({ capturePath }) =>
        rewriteRecord(capturePath, (record) => {
          record.value.receipt.build.manifestDigest = `sha256:${"f".repeat(64)}`;
        }),
      message: /build.*manifest.*validate|build.*continuity/i,
    },
    {
      name: "raw master bytes",
      mutate: async ({ rawPath }) =>
        fs.writeFile(rawPath, "tampered raw bytes"),
      message: /raw master.*digest|raw capture.*hash/i,
    },
  ];

  for (const [index, item] of cases.entries()) {
    await t.test(item.name, async (subtest) => {
      const value = scenario();
      const { repoRoot, artifactRoot, scenarioPath } = await roots(
        subtest,
        value,
      );
      const runId = `capture-proof-${index}`;
      const dependencies = baseDependencies(value);
      await runDeclarativeHighlightCommand({
        command: "capture",
        scenarioPath,
        artifactRoot,
        source: "pr_head",
        runId,
        prNumber: 42,
        prBaseSha: BASE_SHA,
        repoRoot,
        dependencies,
      });
      const attemptRoot = path.join(artifactRoot, value.id, "runs", runId);
      const capturePath = path.join(attemptRoot, "evidence", "capture.json");
      const capture = JSON.parse(await fs.readFile(capturePath, "utf8"));
      await item.mutate({
        capturePath,
        rawPath: capture.value.receipt.rawMaster.path,
      });

      await assert.rejects(
        runDeclarativeHighlightCommand({
          command: "render",
          scenarioPath,
          artifactRoot,
          landingRoot: path.join(path.dirname(repoRoot), "landing"),
          runId,
          repoRoot,
          dependencies,
        }),
        (error) => {
          assert.match(error.message, item.message);
          assert.match(
            error.message,
            /Next command: node scripts\/highlights\.mjs capture .* --source pr_head/,
          );
          return true;
        },
      );
    });
  }
});

test("stage recovery cross-checks landing identity and rendered delivery bytes", async (t) => {
  const cases = [
    {
      name: "landing identity",
      mutate: async ({ renderPath }) =>
        rewriteRecord(renderPath, (record) => {
          record.value.landing.sourceSha = "f".repeat(40);
        }),
      message: /landing.*camera|landing.*identity/i,
    },
    {
      name: "rendered delivery bytes",
      mutate: async ({ render }) => {
        const mp4 = render.value.manifest.artifacts.find(
          (artifact) => artifact.kind === "mp4",
        );
        await fs.writeFile(
          path.join(render.value.stageDir, mp4.path),
          "tampered",
        );
      },
      message: /render.*mp4.*digest|rendered delivery.*hash/i,
    },
  ];

  for (const [index, item] of cases.entries()) {
    await t.test(item.name, async (subtest) => {
      const value = scenario();
      const { repoRoot, artifactRoot, scenarioPath } = await roots(
        subtest,
        value,
      );
      const runId = `render-proof-${index}`;
      const dependencies = baseDependencies(value);
      const common = await runThroughQa({
        value,
        repoRoot,
        artifactRoot,
        scenarioPath,
        runId,
        dependencies,
      });
      const renderPath = path.join(
        artifactRoot,
        value.id,
        "runs",
        runId,
        "evidence",
        "render.json",
      );
      const render = JSON.parse(await fs.readFile(renderPath, "utf8"));
      await item.mutate({ renderPath, render });

      await assert.rejects(
        runDeclarativeHighlightCommand({
          ...common,
          command: "stage",
          dryRun: true,
        }),
        (error) => {
          assert.match(error.message, item.message);
          assert.match(
            error.message,
            new RegExp(
              `Next command: node scripts/highlights\\.mjs render .* --run-id "${runId}"`,
            ),
          );
          return true;
        },
      );
    });
  }
});

test("stage recovery validates QA status, report digest, and render linkage", async (t) => {
  const cases = [
    {
      name: "QA status",
      mutate: async ({ qaPath }) =>
        rewriteRecord(qaPath, (record) => {
          record.value.status = "accepted";
        }),
      message: /QA.*technical_pass|QA.*status/i,
    },
    {
      name: "QA report bytes",
      mutate: async ({ reportPath }) => fs.writeFile(reportPath, "{}\n"),
      message: /QA report.*digest/i,
    },
    {
      name: "QA artifact linkage",
      mutate: async ({ qaPath, reportPath }) => {
        const qa = JSON.parse(await fs.readFile(qaPath, "utf8"));
        const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
        const changedSha = "f".repeat(64);
        qa.value.artifacts.find((artifact) => artifact.kind === "mp4").sha256 =
          changedSha;
        report.artifacts.find((artifact) => artifact.kind === "mp4").sha256 =
          changedSha;
        const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
        await fs.writeFile(reportPath, reportBytes);
        qa.value.reportDigest = `sha256:${digest(reportBytes)}`;
        qa.recordDigest = recordDigest(qa);
        await fs.writeFile(qaPath, `${JSON.stringify(qa, null, 2)}\n`);
      },
      message: /QA.*artifact.*render|mp4.*hash/i,
    },
  ];

  for (const [index, item] of cases.entries()) {
    await t.test(item.name, async (subtest) => {
      const value = scenario();
      const { repoRoot, artifactRoot, scenarioPath } = await roots(
        subtest,
        value,
      );
      const runId = `qa-proof-${index}`;
      const dependencies = baseDependencies(value);
      const common = await runThroughQa({
        value,
        repoRoot,
        artifactRoot,
        scenarioPath,
        runId,
        dependencies,
      });
      const evidenceRoot = path.join(
        artifactRoot,
        value.id,
        "runs",
        runId,
        "evidence",
      );
      const qaPath = path.join(evidenceRoot, "qa.json");
      const qa = JSON.parse(await fs.readFile(qaPath, "utf8"));
      await item.mutate({ qaPath, reportPath: qa.value.reportPath });

      await assert.rejects(
        runDeclarativeHighlightCommand({
          ...common,
          command: "stage",
          dryRun: true,
        }),
        (error) => {
          assert.match(error.message, item.message);
          assert.match(
            error.message,
            new RegExp(
              `Next command: node scripts/highlights\\.mjs qa .* --run-id "${runId}"`,
            ),
          );
          return true;
        },
      );
    });
  }
});

test("recovery errors route missing phases to exact render and QA commands", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  const captureInput = {
    command: "capture",
    scenarioPath,
    artifactRoot,
    source: "pr_head",
    runId: "missing-render-001",
    prNumber: 42,
    prBaseSha: BASE_SHA,
    repoRoot,
    dependencies,
  };
  await runDeclarativeHighlightCommand(captureInput);
  await assert.rejects(
    runDeclarativeHighlightCommand({
      ...captureInput,
      command: "qa",
      landingRoot: path.join(path.dirname(repoRoot), "landing"),
      source: undefined,
    }),
    /Next command: node scripts\/highlights\.mjs render .* --run-id "missing-render-001"/,
  );

  const renderInput = {
    ...captureInput,
    command: "render",
    runId: "missing-qa-001",
    landingRoot: path.join(path.dirname(repoRoot), "landing"),
    source: undefined,
  };
  await runDeclarativeHighlightCommand({
    ...captureInput,
    runId: renderInput.runId,
  });
  await runDeclarativeHighlightCommand(renderInput);
  await assert.rejects(
    runDeclarativeHighlightCommand({ ...renderInput, command: "stage" }),
    /Next command: node scripts\/highlights\.mjs qa .* --run-id "missing-qa-001"/,
  );
});

test("stage auto-selects one run and gives exact stage choices when runs are ambiguous", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  await runThroughQa({
    value,
    repoRoot,
    artifactRoot,
    scenarioPath,
    runId: "only-run",
    dependencies,
  });
  const selected = await runDeclarativeHighlightCommand({
    command: "stage",
    scenarioPath,
    artifactRoot,
    repoRoot,
    dryRun: true,
    dependencies,
  });
  assert.equal(selected.runId, "only-run");

  await runThroughQa({
    value,
    repoRoot,
    artifactRoot,
    scenarioPath,
    runId: "second-run",
    dependencies,
  });
  await assert.rejects(
    runDeclarativeHighlightCommand({
      command: "stage",
      scenarioPath,
      artifactRoot,
      repoRoot,
      dryRun: true,
      dependencies,
    }),
    (error) => {
      assert.match(error.message, /multiple Highlight runs/i);
      assert.match(
        error.message,
        /node scripts\/highlights\.mjs stage .* --run-id "only-run"/,
      );
      assert.match(
        error.message,
        /node scripts\/highlights\.mjs stage .* --run-id "second-run"/,
      );
      return true;
    },
  );
});

test("render and QA dry-runs recover the selected attempt without writing phase outputs", async (t) => {
  const value = scenario();
  const { repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const dependencies = baseDependencies(value);
  const runId = "dry-recovery-001";
  const common = {
    scenarioPath,
    artifactRoot,
    landingRoot: path.join(path.dirname(repoRoot), "landing"),
    repoRoot,
    dependencies,
  };
  await runDeclarativeHighlightCommand({
    ...common,
    command: "capture",
    source: "pr_head",
    runId,
    prNumber: 42,
    prBaseSha: BASE_SHA,
  });
  const beforeRender = await inventoryTree(artifactRoot);
  const renderPlan = await runDeclarativeHighlightCommand({
    ...common,
    command: "render",
    dryRun: true,
  });
  assert.equal(renderPlan.runId, runId);
  assert.deepEqual(renderPlan.verifiedPhases, [
    "validate",
    "storyboard",
    "capture",
  ]);
  assert.deepEqual(await inventoryTree(artifactRoot), beforeRender);

  await runDeclarativeHighlightCommand({
    ...common,
    command: "render",
    runId,
  });
  const beforeQa = await inventoryTree(artifactRoot);
  const qaPlan = await runDeclarativeHighlightCommand({
    ...common,
    command: "qa",
    dryRun: true,
  });
  assert.equal(qaPlan.runId, runId);
  assert.deepEqual(qaPlan.verifiedPhases, [
    "validate",
    "storyboard",
    "capture",
    "camera",
    "render",
  ]);
  assert.deepEqual(await inventoryTree(artifactRoot), beforeQa);
});

test("direct staging rejects capture source and build proof discontinuity", async (t) => {
  const value = scenario();
  const { base, repoRoot, artifactRoot, scenarioPath } = await roots(t, value);
  const result = await runDeclarativeHighlightCommand({
    command: "run",
    scenarioPath,
    artifactRoot,
    source: "pr_head",
    landingRoot: path.join(base, "landing"),
    runId: "direct-stage-proof",
    prNumber: 42,
    prBaseSha: BASE_SHA,
    repoRoot,
    dependencies: baseDependencies(value),
  });
  const input = structuredClone(result.phases.stage.input);
  input.artifactRoot = path.join(base, "discontinuous-stage");
  input.capture.receipt.build.sourceSha = "f".repeat(40);

  await assert.rejects(
    writeContentAddressedStage(input),
    /capture build.*source|source.*build.*continuity/i,
  );
});
