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

const SOURCE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const LANDING_SHA = "c".repeat(40);
const SEED_DIGEST = `sha256:${"d".repeat(64)}`;

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
      backend: { digest: `sha256:${"1".repeat(64)}`, bytes: 100 },
      mockAgent: { digest: `sha256:${"2".repeat(64)}`, bytes: 101 },
      webDist: { digest: `sha256:${"3".repeat(64)}`, bytes: 102, fileCount: 3 },
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

function baseDependencies(value, calls = [], captureInputs = []) {
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
            outputs: buildProvenance.outputs,
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
        },
      };
    },
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
    runQualityAssurance: async ({ artifacts }) => {
      calls.push("qa");
      return {
        contract: "kandev-highlight-qa-v1",
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
        sensitiveData: { passed: true, findings: [] },
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
  const dependencies = baseDependencies(value, calls, captureInputs);
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
  assert.equal(path.basename(result.phases.stage.manifestPath), "review.json");
  assert.equal(review.qa.status, "technical_pass");
  assert.deepEqual(result.phases.qa.sensitiveData.coverage, [
    "scenario",
    "camera-metadata",
  ]);
  assert.equal(result.phases.qa.sensitiveData.pixelScan, false);
  assert.equal(review.provenance.seedId, value.seed.recipe);
  assert.deepEqual(review.provenance.landingAdapter, {
    sourceSha: LANDING_SHA,
    contractVersion: "1.0.0",
  });
  assert.equal(review.assets.desktop.mp4.width, 1920);
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
