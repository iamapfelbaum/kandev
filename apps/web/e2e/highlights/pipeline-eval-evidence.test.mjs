import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  assertDeterministicRuns,
  assertRuntimeEvidenceLinks,
  assertTechnicalReview,
  normalizeDeterminismEvidence,
  projectSemanticPointerEvidence,
} from "./run-pipeline-integration.mjs";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const HEX_DIGEST = "c".repeat(64);
const QUICK_START_ID = "quick-start";
const EVAL_ROOT = "/external/eval";
const STILL_IMAGE_REASON = "still-image";

function technicalFixture(root = EVAL_ROOT) {
  const codecs = { mp4: "h264", webm: "vp9", poster: "webp" };
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
    probe: { codec: codecs[kind] },
    cadence: kind === "poster" ? { skipped: true } : { passed: true },
    fullDecode: kind === "poster" ? { skipped: true } : { passed: true },
    faststart: kind === "mp4" ? { passed: true } : null,
    proofs:
      kind === "poster"
        ? { skipped: true, reason: STILL_IMAGE_REASON }
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

function runtimeFixture(root = EVAL_ROOT, runId = "fresh-agent-1") {
  const attempt = path.join(root, QUICK_START_ID, "runs", runId);
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
          manifestPath: path.join(root, QUICK_START_ID, "stages", HEX_DIGEST, "review.json"),
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

test("determinism normalization excludes volatile host data but retains semantic evidence", () => {
  const evidence = {
    scenario: { id: QUICK_START_ID, digest: DIGEST, path: "/run-1/scenario.json" },
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
  second.selectedFrames[0].sha256 = "d".repeat(64);
  second.runId = "fresh-agent-2";
  second.capturedAt = "2026-01-02T00:00:00Z";
  second.ports.backend = 18081;

  const normalized = normalizeDeterminismEvidence(evidence);
  assert.deepEqual(normalized, normalizeDeterminismEvidence(second));
  assert.equal(normalized.scenario.id, QUICK_START_ID);
  assert.equal(normalized.timeline.events[0].startMs, 500);
  assert.deepEqual(normalized.seed.invariants, { columns: ["todo", "done"] });
  assert.equal(Object.hasOwn(normalized.camera.plan, "pointerTrack"), false);
  assert.equal(normalized.camera.track.keyframes[0].tMs, 0);
  assert.equal(normalized.camera.track.keyframes[0].zoom, 1);
  assert.equal(normalized.pointer.samples[0].storyTMs, 600);
  assert.equal(normalized.frameTiming.storyDurationMs, 3_000);
  assert.deepEqual(normalized.selectedFrames[0], { storyTimeMs: 200 });
  assert.equal(JSON.stringify(normalized).includes("/run-"), false);
  assert.equal(JSON.stringify(normalized).includes("99999"), false);
});

test("determinism assertion reports semantic drift and ignores projected frame identity", () => {
  const evidence = {
    scenario: { id: QUICK_START_ID, digest: DIGEST },
    timeline: { totalDurationMs: 3_000, events: [] },
    seed: { seedId: "seed", seedDigest: DIGEST, invariants: {} },
    camera: { plan: { initialZoom: 1 }, track: { keyframes: [{ tMs: 0, zoom: 1 }] } },
    pointer: { samples: [] },
    frameTiming: { fps: 25, storyDurationMs: 3_000, relativeStartFrame: 0 },
    selectedFrames: [{ storyTimeMs: 200, sha256: HEX_DIGEST }],
  };
  const first = normalizeDeterminismEvidence(evidence);
  const cameraMismatch = structuredClone(first);
  cameraMismatch.camera.track.keyframes[0].zoom = 1.1;
  assert.throws(
    () => assertDeterministicRuns(first, cameraMismatch),
    /camera\.track\.keyframes\[0\]\.zoom/i,
  );
  const frameIdentityDrift = structuredClone(evidence);
  frameIdentityDrift.selectedFrames[0].sha256 = "d".repeat(64);
  assert.equal(
    assertDeterministicRuns(first, normalizeDeterminismEvidence(frameIdentityDrift)).passed,
    true,
  );
  const frameMismatch = structuredClone(first);
  frameMismatch.selectedFrames[0].storyTimeMs = 240;
  assert.throws(
    () => assertDeterministicRuns(first, frameMismatch),
    /selectedFrames\[0\]\.storyTimeMs/i,
  );
});

test("semantic determinism excludes exact media identities but retains media contracts", () => {
  const evidence = {
    renderedArtifacts: [
      {
        kind: "mp4",
        path: "/run-1/render/quick-start.mp4",
        bytes: 12_345,
        sha256: "1".repeat(64),
        probe: {
          codec: "h264",
          width: 1920,
          height: 1200,
          fps: 25,
          durationMs: 3_000,
          frameCount: 75,
          audioStreams: 0,
          pixelFormat: "yuv420p",
          bytes: 12_345,
        },
        cadence: { passed: true, frameCount: 75, integerTicksPerFrame: 512 },
        fullDecode: { passed: true },
        faststart: { passed: true, moovOffset: 32, mdatOffset: 64 },
        proofs: {
          keyframes: [
            {
              frame: 0,
              path: "/run-1/qa/mp4-keyframe-01.png",
              bytes: 321,
              sha256: "2".repeat(64),
            },
          ],
          contactSheet: {
            path: "/run-1/qa/mp4-contact-sheet.png",
            bytes: 654,
            sha256: "3".repeat(64),
          },
        },
      },
      {
        kind: "poster",
        path: "/run-1/render/quick-start.webp",
        bytes: 4_321,
        sha256: "4".repeat(64),
        probe: {
          codec: "webp",
          width: 1920,
          height: 1200,
          fps: null,
          durationMs: null,
          frameCount: 1,
          audioStreams: 0,
          pixelFormat: "yuv420p",
          bytes: 4_321,
        },
        cadence: { skipped: true, reason: STILL_IMAGE_REASON },
        fullDecode: { skipped: true, reason: STILL_IMAGE_REASON },
        faststart: null,
        proofs: { skipped: true, reason: STILL_IMAGE_REASON },
      },
    ],
  };
  const relocated = structuredClone(evidence);
  relocated.renderedArtifacts[0].path = "/run-2/render/quick-start.mp4";
  relocated.renderedArtifacts[0].proofs.keyframes[0].path = "/run-2/qa/mp4-keyframe-01.png";
  relocated.renderedArtifacts[0].proofs.contactSheet.path = "/run-2/qa/mp4-contact-sheet.png";
  relocated.renderedArtifacts[1].path = "/run-2/render/quick-start.webp";
  relocated.renderedArtifacts[0].bytes = 12_999;
  relocated.renderedArtifacts[0].sha256 = "5".repeat(64);
  relocated.renderedArtifacts[0].probe.bytes = 12_999;
  relocated.renderedArtifacts[0].proofs.keyframes[0].bytes = 333;
  relocated.renderedArtifacts[0].proofs.keyframes[0].sha256 = "6".repeat(64);
  relocated.renderedArtifacts[0].proofs.contactSheet.bytes = 666;
  relocated.renderedArtifacts[0].proofs.contactSheet.sha256 = "7".repeat(64);
  relocated.renderedArtifacts[1].bytes = 4_500;
  relocated.renderedArtifacts[1].sha256 = "8".repeat(64);
  relocated.renderedArtifacts[1].probe.bytes = 4_500;

  const normalized = normalizeDeterminismEvidence(evidence);
  assert.deepEqual(normalized, normalizeDeterminismEvidence(relocated));
  assert.equal(normalized.renderedArtifacts[0].probe.frameCount, 75);
  assert.equal(normalized.renderedArtifacts[0].proofs.keyframeCount, 1);
  assert.equal(normalized.renderedArtifacts[0].proofs.contactSheet, true);
  assert.equal(Object.hasOwn(normalized.renderedArtifacts[0], "bytes"), false);
  assert.equal(Object.hasOwn(normalized.renderedArtifacts[0], "sha256"), false);
  assert.equal(JSON.stringify(normalized).includes("/run-"), false);
  assert.equal(JSON.stringify(normalized).includes("1".repeat(64)), false);

  const deliveryMismatch = structuredClone(normalized);
  deliveryMismatch.renderedArtifacts[0].probe.frameCount = 74;
  assert.throws(
    () => assertDeterministicRuns(normalized, deliveryMismatch),
    /renderedArtifacts\[0\]\.probe\.frameCount/i,
  );

  const proofMismatch = structuredClone(normalized);
  proofMismatch.renderedArtifacts[0].proofs.keyframeCount = 0;
  assert.throws(
    () => assertDeterministicRuns(normalized, proofMismatch),
    /renderedArtifacts\[0\]\.proofs\.keyframeCount/i,
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
