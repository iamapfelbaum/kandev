/* eslint-disable max-lines, no-nested-ternary, sonarjs/no-duplicate-string */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertDeterministicRuns,
  assertRepositoryStateUnchanged,
  assertRuntimeEvidenceLinks,
  assertTechnicalReview,
  buildPipelineCommandSequence,
  captureRepositoryState,
  commitScenarioAndBindCurrentMain,
  linkIgnoredDependencies,
  normalizeDeterminismEvidence,
  projectSemanticPointerEvidence,
  runWithEvalRetention,
  snapshotCommittedRepository,
} from "./run-pipeline-integration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "../..");
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const HEX_DIGEST = "c".repeat(64);

async function exec(command, args, { cwd } = {}) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const result = await promisify(execFile)(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return { ...result, exitCode: 0 };
}

async function initRepository(root) {
  await fs.mkdir(root, { recursive: true });
  await exec("git", ["init", "--initial-branch=main"], { cwd: root });
  await exec("git", ["config", "user.name", "Highlight Eval"], { cwd: root });
  await exec("git", ["config", "user.email", "highlight-eval@example.invalid"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "committed\n");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["commit", "-m", "fixture"], { cwd: root });
  await exec("git", ["checkout", "-b", "feature/eval"], { cwd: root });
  await fs.writeFile(path.join(root, "FEATURE.md"), "feature head\n");
  await exec("git", ["add", "FEATURE.md"], { cwd: root });
  await exec("git", ["commit", "-m", "feature fixture"], { cwd: root });
  return (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
}

function technicalFixture(root = "/external/eval") {
  const asset = (kind, codec) => ({
    path: `assets/desktop.${kind === "poster" ? "webp" : kind}`,
    bytes: 123,
    sha256: HEX_DIGEST,
    codec,
    width: 1920,
    height: 1200,
    fps: kind === "poster" ? null : 25,
    duration: kind === "poster" ? null : 3,
    audio: false,
  });
  const proof = (name) => ({ path: `${root}/qa/${name}.png`, bytes: 42, sha256: HEX_DIGEST });
  const qaArtifact = (kind) => ({
    kind,
    path: `${root}/render/desktop.${kind === "poster" ? "webp" : kind}`,
    bytes: 123,
    sha256: HEX_DIGEST,
    probe: { codec: kind === "mp4" ? "h264" : kind === "webm" ? "vp9" : "webp" },
    cadence: kind === "poster" ? { skipped: true } : { passed: true },
    fullDecode: kind === "poster" ? { skipped: true } : { passed: true },
    faststart: kind === "mp4" ? { passed: true } : null,
    proofs:
      kind === "poster"
        ? { skipped: true, reason: "still-image" }
        : {
            keyframes: [proof(`${kind}-0`), proof(`${kind}-last`)],
            contactSheet: proof(`${kind}-sheet`),
          },
  });
  return {
    review: {
      contract: "kandev-highlight-review-stage-v2",
      schemaVersion: 2,
      stageDigest: DIGEST,
      promotable: false,
      readyForReview: true,
      qa: {
        status: "technical_pass",
        passed: true,
        reportPath: "qa/report.json",
        reportDigest: DIGEST,
      },
      assets: {
        desktop: {
          webm: asset("webm", "vp9"),
          mp4: asset("mp4", "h264"),
          poster: asset("poster", "webp"),
        },
      },
    },
    qaReport: {
      contract: "kandev-highlight-qa-v1",
      status: "technical_pass",
      passed: true,
      artifacts: [qaArtifact("webm"), qaArtifact("mp4"), qaArtifact("poster")],
      browser: { passed: true, engine: "chromium" },
      sensitiveData: { passed: true, findings: [] },
      containment: { passed: true },
      camera: { passed: true },
    },
  };
}

function runtimeFixture(root = "/external/eval", runId = "fresh-agent-1") {
  const attempt = path.join(root, "quick-start", "runs", runId);
  const hostRoot = path.join(root, "runtime-host", runId);
  const buildRoot = path.join(root, "runtime-builds", runId);
  const resultPath = path.join(hostRoot, "result.json");
  const receiptPath = path.join(attempt, "evidence", "application-runtime.json");
  const captureManifestPath = path.join(attempt, "capture", "evidence", "capture.json");
  const cameraPath = path.join(attempt, "evidence", "camera.json");
  const buildManifestPath = path.join(buildRoot, "evidence", "build.json");
  return {
    commandResult: {
      contract: "kandev-highlight-runtime-command-v1",
      command: "run",
      runtimeId: "kandev-isolated-e2e",
      runId,
      order: ["validate", "storyboard", "capture", "render", "qa", "stage"],
      host: {
        contract: "kandev-highlight-runtime-host-result-v1",
        resultPath,
        resultDigest: DIGEST,
        receiptPath,
        receiptDigest: DIGEST,
      },
      phases: {
        validate: { manifestPath: path.join(attempt, "evidence", "validate.json") },
        storyboard: { manifestPath: path.join(attempt, "evidence", "storyboard.json") },
        capture: { captureManifestPath },
        render: { phaseManifestPath: path.join(attempt, "evidence", "render.json") },
        qa: { phaseManifestPath: path.join(attempt, "evidence", "qa.json") },
        stage: {
          manifestPath: path.join(root, "quick-start", "stages", HEX_DIGEST, "review.json"),
        },
      },
    },
    hostResult: {
      contract: "kandev-highlight-runtime-host-result-v1",
      runtimeId: "kandev-isolated-e2e",
      runId,
      resultDigest: DIGEST,
      bundle: { resultPath },
      source: {
        unchanged: true,
        pre: { mode: "current_main", selectedSha: SHA },
        post: { mode: "current_main", selectedSha: SHA },
      },
      request: { path: path.join(hostRoot, "request.json"), digest: DIGEST },
      applicationRuntime: { receiptPath, digest: DIGEST },
      capture: { attemptRoot: attempt, captureManifestPath, captureManifestDigest: DIGEST },
    },
    receipt: {
      contract: "kandev-highlight-application-runtime-v1",
      receiptDigest: DIGEST,
      runtimeId: "kandev-isolated-e2e",
      source: { pre: { selectedSha: SHA }, post: { selectedSha: SHA }, unchanged: true },
      build: { manifestDigest: DIGEST, sourceSha: SHA },
      capture: { captureManifestPath, captureManifestDigest: DIGEST },
    },
    capture: {
      scenarioDigest: DIGEST,
      source: { selectedSha: SHA },
      sourceDigest: DIGEST,
      build: { manifestPath: buildManifestPath, manifestDigest: DIGEST, sourceSha: SHA },
      seed: { seedId: "kandev.highlight.quick-start", seedDigest: DIGEST },
      frameAlignment: { fps: 25, storyStartFrame: 12, storyEndFrame: 87 },
    },
    camera: {
      contract: "kandev-highlight-camera-evidence-v1",
      recordDigest: DIGEST,
      plan: { initialZoom: 1, durationMs: 3_000 },
      track: {
        keyframes: [
          { tMs: 0, zoom: 1 },
          { tMs: 3_000, zoom: 1 },
        ],
      },
      landing: { sourceSha: SHA },
    },
    expected: {
      attempt,
      hostRoot,
      buildRoot,
      resultPath,
      receiptPath,
      captureManifestPath,
      cameraPath,
      buildManifestPath,
    },
  };
}

test("pipeline command sequence uses production CLI and exact safe arguments", async () => {
  const commands = buildPipelineCommandSequence({
    cloneRoot: "/external/eval/snapshot",
    scenarioPath: "/external/eval/snapshot/eval/quick-start.scenario.json",
    artifactRoot: "/external/eval/artifacts",
    landingRoot: "/workspace/landing",
    reviewPath: "/external/eval/artifacts/quick-start/stages/deadbeef/review.json",
    nodeExecutable: "/usr/bin/node",
  });

  assert.deepEqual(
    commands.map(({ phase }) => phase),
    ["scaffold", "validate", "storyboard", "run-1", "run-2", "stage-recovery", "promote-dry-run"],
  );
  for (const command of commands) {
    assert.equal(command.command, "/usr/bin/node");
    assert.equal(command.cwd, "/external/eval/snapshot");
    assert.equal(command.args[0], "/external/eval/snapshot/scripts/highlights.mjs");
  }
  assert.deepEqual(commands[0].args.slice(1), [
    "scaffold",
    "/external/eval/snapshot/eval/quick-start.scenario.json",
    "--template",
    "quick-start",
  ]);
  assert.deepEqual(commands[1].args.slice(1), [
    "validate",
    "/external/eval/snapshot/eval/quick-start.scenario.json",
  ]);
  assert.deepEqual(commands[2].args.slice(1), [
    "storyboard",
    "/external/eval/snapshot/eval/quick-start.scenario.json",
    "--format",
    "json",
  ]);
  for (const [index, runId] of [
    [3, "fresh-agent-1"],
    [4, "fresh-agent-2"],
  ]) {
    assert.deepEqual(commands[index].args.slice(1), [
      "run",
      "/external/eval/snapshot/eval/quick-start.scenario.json",
      "--artifact-root",
      "/external/eval/artifacts",
      "--source",
      "current_main",
      "--landing-root",
      "/workspace/landing",
      "--runtime",
      "kandev-isolated-e2e",
      "--run-id",
      runId,
    ]);
  }
  assert.deepEqual(commands[5].args.slice(-3), ["--run-id", "fresh-agent-1", "--dry-run"]);
  assert.deepEqual(commands[6].args.slice(-3), [
    "--accept-reviewed-by",
    "fresh-agent-eval",
    "--dry-run",
  ]);
  const packageJson = JSON.parse(await fs.readFile(path.join(WEB_ROOT, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["e2e:highlight-pipeline"],
    "node e2e/highlights/run-pipeline-integration.mjs",
  );
});

test("snapshot is exact committed HEAD and current_main points at the locally committed scenario", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-pipeline-git-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const sourceRoot = path.join(temp, "source");
  const cloneRoot = path.join(temp, "snapshot");
  const sourceHead = await initRepository(sourceRoot);
  const sourceBefore = await captureRepositoryState(sourceRoot);

  const snapshot = await snapshotCommittedRepository({ sourceRoot, cloneRoot });
  assert.equal(snapshot.sourceHead, sourceHead);
  assert.equal(snapshot.snapshotHead, sourceHead);
  assert.equal(snapshot.localOnly, true);
  assert.equal(snapshot.originRoot, path.join(temp, "origin.git"));
  assert.equal(
    (
      await exec("git", ["--git-dir", snapshot.originRoot, "rev-parse", "refs/heads/main"])
    ).stdout.trim(),
    sourceHead,
  );

  const scenarioPath = path.join(cloneRoot, "eval", "quick-start.scenario.json");
  await fs.mkdir(path.dirname(scenarioPath), { recursive: true });
  await fs.writeFile(scenarioPath, '{"schemaVersion":1}\n');
  const bound = await commitScenarioAndBindCurrentMain({ cloneRoot, scenarioPath });
  assert.match(bound.evalHead, /^[a-f0-9]{40}$/);
  assert.equal(bound.headSha, bound.evalHead);
  assert.equal(bound.currentMainSha, bound.evalHead);
  assert.equal(bound.originMainSha, bound.evalHead);
  assert.equal(bound.clean, true);
  assert.equal(
    (
      await exec("git", ["--git-dir", snapshot.originRoot, "rev-parse", "refs/heads/main"])
    ).stdout.trim(),
    bound.evalHead,
  );
  await exec("git", ["update-ref", "refs/remotes/origin/main", sourceHead], { cwd: cloneRoot });
  assert.equal(
    (await exec("git", ["rev-parse", "origin/main"], { cwd: cloneRoot })).stdout.trim(),
    sourceHead,
  );
  await exec("git", ["fetch", "--no-tags", "origin", "main"], { cwd: cloneRoot });
  assert.equal(
    (await exec("git", ["rev-parse", "origin/main"], { cwd: cloneRoot })).stdout.trim(),
    bound.evalHead,
  );
  await assertRepositoryStateUnchanged(
    sourceBefore,
    await captureRepositoryState(sourceRoot),
    "source repository",
  );
});

test("repository-state proof catches tracked and untracked production writes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-pipeline-state-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initRepository(root);
  const before = await captureRepositoryState(root);
  await fs.writeFile(path.join(root, "unexpected.txt"), "write\n");
  const after = await captureRepositoryState(root);
  await assert.rejects(
    () => assertRepositoryStateUnchanged(before, after, "production repository"),
    /production repository.*changed.*unexpected\.txt/i,
  );
});

test("dependency reuse links only ignored node_modules directories into the snapshot", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-pipeline-links-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const sourceRoot = path.join(temp, "source");
  const cloneRoot = path.join(temp, "snapshot");
  await initRepository(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, ".gitignore"), "node_modules/\n");
  await exec("git", ["add", ".gitignore"], { cwd: sourceRoot });
  await exec("git", ["commit", "-m", "ignore dependencies"], { cwd: sourceRoot });
  await Promise.all([
    fs.mkdir(path.join(sourceRoot, "apps", "node_modules", ".pnpm"), { recursive: true }),
    fs.mkdir(path.join(sourceRoot, "apps", "web", "node_modules", ".bin"), { recursive: true }),
  ]);
  await snapshotCommittedRepository({ sourceRoot, cloneRoot });

  const links = await linkIgnoredDependencies({ sourceRoot, cloneRoot });
  assert.equal(links.length, 2);
  for (const link of links) {
    const target = await fs.lstat(link.target);
    assert.equal(target.isDirectory(), true);
    assert.equal(target.isSymbolicLink(), false);
    const entries = await fs.readdir(link.target);
    assert.equal(entries.length, 1);
    assert.equal((await fs.lstat(path.join(link.target, entries[0]))).isSymbolicLink(), true);
  }
  assert.equal((await captureRepositoryState(cloneRoot)).status, "");
});

test("determinism normalization excludes volatile host data but retains semantic evidence", () => {
  const evidence = {
    scenario: { id: "quick-start", digest: DIGEST, path: "/run-1/scenario.json" },
    timeline: {
      totalDurationMs: 3_000,
      generatedAt: "2026-01-01",
      events: [{ kind: "click", startMs: 500 }],
    },
    seed: {
      seedId: "kandev.highlight.quick-start",
      seedDigest: DIGEST,
      invariants: { columns: ["todo", "done"] },
      generatedIds: ["one"],
    },
    camera: {
      plan: { initialZoom: 1, pointerTrack: [{ tMs: 612, x: 0.3, y: 0.4 }] },
      track: { keyframes: [{ tMs: 0, zoom: 1, x: 0.5, y: 0.5 }] },
      recordDigest: DIGEST,
      path: "/run-1/camera.json",
    },
    pointer: { samples: [{ storyTMs: 600, x: 0.3, y: 0.4 }], browserEpochMs: 99_999, pid: 123 },
    frameTiming: {
      fps: 25,
      storyDurationMs: 3_000,
      relativeStartFrame: 0,
      absoluteMediaStartMs: 88_888,
      recorderPid: 456,
    },
    selectedFrames: [{ storyTimeMs: 200, sha256: HEX_DIGEST, path: "/run-1/frame.png" }],
    runId: "fresh-agent-1",
    capturedAt: "2026-01-01T00:00:00Z",
    ports: { backend: 18080 },
  };
  const second = structuredClone(evidence);
  second.scenario.path = "/run-2/scenario.json";
  second.timeline.generatedAt = "2026-01-02";
  second.seed.generatedIds = ["two"];
  second.camera.path = "/run-2/camera.json";
  second.camera.recordDigest = `sha256:${"d".repeat(64)}`;
  second.camera.plan.pointerTrack[0].tMs = 627;
  second.pointer.browserEpochMs = 111_111;
  second.pointer.pid = 999;
  second.frameTiming.absoluteMediaStartMs = 77_777;
  second.frameTiming.recorderPid = 888;
  second.selectedFrames[0].path = "/run-2/frame.png";
  second.runId = "fresh-agent-2";
  second.capturedAt = "2026-01-02T00:00:00Z";
  second.ports.backend = 18081;

  const normalized = normalizeDeterminismEvidence(evidence);
  assert.deepEqual(normalized, normalizeDeterminismEvidence(second));
  assert.equal(normalized.scenario.id, "quick-start");
  assert.equal(normalized.timeline.events[0].startMs, 500);
  assert.deepEqual(normalized.seed.invariants, { columns: ["todo", "done"] });
  assert.equal(Object.hasOwn(normalized.camera.plan, "pointerTrack"), false);
  assert.equal(normalized.camera.track.keyframes[0].tMs, 0);
  assert.equal(normalized.camera.track.keyframes[0].zoom, 1);
  assert.equal(normalized.pointer.samples[0].storyTMs, 600);
  assert.equal(normalized.frameTiming.storyDurationMs, 3_000);
  assert.equal(normalized.selectedFrames[0].sha256, HEX_DIGEST);
  assert.equal(JSON.stringify(normalized).includes("/run-"), false);
  assert.equal(JSON.stringify(normalized).includes("99999"), false);
});

test("determinism assertion reports first semantic or decoded-frame mismatch", () => {
  const first = normalizeDeterminismEvidence({
    scenario: { id: "quick-start", digest: DIGEST },
    timeline: { totalDurationMs: 3_000, events: [] },
    seed: { seedId: "seed", seedDigest: DIGEST, invariants: {} },
    camera: { plan: { initialZoom: 1 }, track: { keyframes: [{ tMs: 0, zoom: 1 }] } },
    pointer: { samples: [] },
    frameTiming: { fps: 25, storyDurationMs: 3_000, relativeStartFrame: 0 },
    selectedFrames: [{ storyTimeMs: 200, sha256: HEX_DIGEST }],
  });
  const cameraMismatch = structuredClone(first);
  cameraMismatch.camera.track.keyframes[0].zoom = 1.1;
  assert.throws(
    () => assertDeterministicRuns(first, cameraMismatch),
    /camera\.track\.keyframes\[0\]\.zoom/i,
  );
  const frameMismatch = structuredClone(first);
  frameMismatch.selectedFrames[0].sha256 = "d".repeat(64);
  assert.throws(
    () => assertDeterministicRuns(first, frameMismatch),
    /selectedFrames\[0\]\.sha256/i,
  );
});

test("pointer projection compares planned trajectory timing, not browser clock jitter", () => {
  const execution = {
    storyDurationMs: 3_000,
    timingToleranceMs: 64,
    steps: [
      {
        index: 0,
        pointer: "/story/actions/0",
        kind: "click",
        plannedStartMs: 600,
        plannedEndMs: 1_020,
        startedAtMs: 607,
        endedAtMs: 1_017,
      },
    ],
    cursorEvidence: [
      {
        label: "Open",
        requestedDurationMs: 420,
        storyStartedAtMs: 607,
        storyEndedAtMs: 1_017,
        samples: [
          { offsetMs: 210, storyTMs: 819, progress: 0.5, x: 900, y: 600 },
          { offsetMs: 420, storyTMs: 1_017, progress: 1, x: 1_000, y: 500 },
        ],
      },
    ],
    cursorResyncEvidence: [{ point: { x: 960, y: 864 }, storyStartedAtMs: -20 }],
  };
  const jittered = structuredClone(execution);
  jittered.steps[0].startedAtMs += 15;
  jittered.steps[0].endedAtMs += 12;
  jittered.cursorEvidence[0].storyStartedAtMs += 15;
  jittered.cursorEvidence[0].storyEndedAtMs += 12;
  jittered.cursorEvidence[0].samples[0].storyTMs += 13;
  jittered.cursorEvidence[0].samples[1].storyTMs += 12;

  const projected = projectSemanticPointerEvidence(execution);
  assert.deepEqual(projected, projectSemanticPointerEvidence(jittered));
  assert.equal(projected.movements[0].requestedDurationMs, 420);
  assert.deepEqual(
    projected.movements[0].samples.map(({ offsetMs }) => offsetMs),
    [210, 420],
  );
  assert.equal(JSON.stringify(projected).includes("storyTMs"), false);
});

test("technical review assertion requires review gate, browser media proofs, hashes, and no raw payload", () => {
  const fixture = technicalFixture();
  assert.doesNotThrow(() => assertTechnicalReview(fixture));
  for (const mutate of [
    (value) => {
      value.review.promotable = true;
    },
    (value) => {
      value.qaReport.browser.passed = false;
    },
    (value) => {
      delete value.qaReport.artifacts[0].proofs.contactSheet;
    },
    (value) => {
      value.qaReport.artifacts[0].bytes = 0;
    },
    (value) => {
      value.qaReport.artifacts[0].sha256 = "bad";
    },
    (value) => {
      value.review.rawDomText = "secret visible DOM";
    },
    (value) => {
      value.review.runtimeLogs = ["secret log"];
    },
  ]) {
    const invalid = structuredClone(fixture);
    mutate(invalid);
    assert.throws(
      () => assertTechnicalReview(invalid),
      /review|browser|contact.?sheet|bytes|sha|raw|log/i,
    );
  }
});

test("runtime evidence assertion binds fixed host, build, source, seed, frame, and camera links", () => {
  const fixture = runtimeFixture();
  assert.doesNotThrow(() => assertRuntimeEvidenceLinks(fixture));
  for (const mutate of [
    (value) => {
      value.commandResult.order = ["validate", "capture", "storyboard", "render", "qa", "stage"];
    },
    (value) => {
      value.hostResult.bundle.resultPath += ".moved";
    },
    (value) => {
      value.receipt.build.sourceSha = "f".repeat(40);
    },
    (value) => {
      value.capture.seed.seedId = "wrong";
    },
    (value) => {
      value.capture.frameAlignment.fps = 30;
    },
    (value) => {
      value.camera.track.keyframes[0].zoom = 1.2;
    },
  ]) {
    const invalid = structuredClone(fixture);
    mutate(invalid);
    assert.throws(
      () => assertRuntimeEvidenceLinks(invalid),
      /order|result|source|seed|frame|camera|zoom/i,
    );
  }
});

test("eval lifecycle cleans setup failures but retains capture failures with actionable JSON", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-pipeline-retain-test-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const setupRoot = path.join(parent, "setup");
  await assert.rejects(
    () =>
      runWithEvalRetention({
        evalRoot: setupRoot,
        task: async () => {
          throw new Error("setup broke");
        },
      }),
    /setup broke/,
  );
  await assert.rejects(() => fs.access(setupRoot), /ENOENT/);

  const captureRoot = path.join(parent, "capture");
  await assert.rejects(
    () =>
      runWithEvalRetention({
        evalRoot: captureRoot,
        task: async ({ markCaptureStarted }) => {
          await markCaptureStarted({ phase: "run-1", argv: ["node", "highlights.mjs", "run"] });
          throw new Error("capture broke");
        },
      }),
    /capture broke/,
  );
  const failure = JSON.parse(await fs.readFile(path.join(captureRoot, "failure.json"), "utf8"));
  assert.equal(failure.contract, "kandev-highlight-pipeline-eval-failure-v1");
  assert.equal(failure.captureStarted, true);
  assert.equal(failure.phase, "run-1");
  assert.match(failure.message, /capture broke/);
  assert.equal(failure.evalRoot, captureRoot);
});

test("snapshot and dry-run repository proofs reject any clone or source mutation", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-pipeline-dry-state-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const sourceRoot = path.join(temp, "source");
  const cloneRoot = path.join(temp, "snapshot");
  await initRepository(sourceRoot);
  await snapshotCommittedRepository({ sourceRoot, cloneRoot });
  const scenarioPath = path.join(cloneRoot, "eval", "scenario.json");
  await fs.mkdir(path.dirname(scenarioPath), { recursive: true });
  await fs.writeFile(scenarioPath, "{}\n");
  await commitScenarioAndBindCurrentMain({ cloneRoot, scenarioPath });
  const sourceBefore = await captureRepositoryState(sourceRoot);
  const cloneBefore = await captureRepositoryState(cloneRoot);
  await assertRepositoryStateUnchanged(
    sourceBefore,
    await captureRepositoryState(sourceRoot),
    "source dry-run",
  );
  await assertRepositoryStateUnchanged(
    cloneBefore,
    await captureRepositoryState(cloneRoot),
    "clone dry-run",
  );
  await fs.writeFile(path.join(cloneRoot, "promotion-write.txt"), "bad\n");
  await assert.rejects(
    () =>
      assertRepositoryStateUnchanged(
        cloneBefore,
        captureRepositoryState(cloneRoot),
        "promotion dry-run",
      ),
    /promotion dry-run.*changed/i,
  );
});
