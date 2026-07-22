import {
  canonicalJson,
  digestValue,
  PIPELINE_ORDER,
  requireDigest,
} from "./pipeline-eval-shared.mjs";

const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const PREFIXED_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HEX_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const RUNTIME_ID = "kandev-isolated-e2e";
const DELIVERY_KINDS = Object.freeze(["webm", "mp4", "poster"]);
const VOLATILE_KEYS = new Set([
  "runId",
  "capturedAt",
  "completedAt",
  "createdAt",
  "builtAt",
  "generatedAt",
  "recordDigest",
  "phaseManifestDigest",
  "receiptDigest",
  "generatedIds",
  "ports",
  "absoluteMediaStartMs",
  "mediaTimeMs",
  "browserEpochMs",
  "captureEpochMs",
  "storyEpochMs",
  "recorderPid",
  "pid",
]);

function volatileKey(key, seed) {
  return (
    VOLATILE_KEYS.has(key) ||
    /(?:path|root)$/i.test(key) ||
    /^(?:startedAtMs|endedAtMs|preparedAtMs)$/.test(key) ||
    (seed && /Ids?$/.test(key))
  );
}

function stableObject(value, { seed = false } = {}) {
  if (Array.isArray(value)) return value.map((item) => stableObject(item, { seed }));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (!volatileKey(key, seed)) result[key] = stableObject(value[key], { seed });
  }
  return result;
}

function normalizeFrameTiming(frameTiming = {}) {
  const alignment = frameTiming.alignment ?? frameTiming.frameAlignment;
  const normalized = {
    fps: frameTiming.fps,
    storyDurationMs: frameTiming.storyDurationMs,
    relativeStartFrame: frameTiming.relativeStartFrame ?? 0,
  };
  if (Number.isInteger(frameTiming.storyFrameCount)) {
    normalized.storyFrameCount = frameTiming.storyFrameCount;
  }
  if (alignment) normalized.alignment = stableObject(alignment);
  if (Array.isArray(frameTiming.selectedStoryTimesMs)) {
    normalized.selectedStoryTimesMs = [...frameTiming.selectedStoryTimesMs];
  }
  return stableObject(normalized);
}

function normalizeMediaProbe(probe) {
  const normalized = stableObject(probe);
  if (normalized && typeof normalized === "object") delete normalized.bytes;
  return normalized;
}

function normalizeRenderedArtifacts(artifacts = []) {
  return [...artifacts]
    .sort((left, right) => String(left?.kind).localeCompare(String(right?.kind)))
    .map((artifact) => ({
      kind: artifact.kind,
      probe: normalizeMediaProbe(artifact.probe),
      cadence: stableObject(artifact.cadence),
      fullDecode: stableObject(artifact.fullDecode),
      faststart:
        artifact.faststart == null ? artifact.faststart : { passed: artifact.faststart.passed },
      proofs: artifact.proofs?.skipped
        ? {
            skipped: true,
            reason: artifact.proofs.reason,
          }
        : {
            keyframeCount: (artifact.proofs?.keyframes ?? []).length,
            contactSheet: Boolean(artifact.proofs?.contactSheet),
          },
    }));
}

export function normalizeDeterminismEvidence(evidence = {}) {
  const cameraPlan = structuredClone(evidence.camera?.plan ?? {});
  delete cameraPlan.pointerTrack;
  return {
    scenario: stableObject(evidence.scenario),
    timeline: stableObject(evidence.timeline),
    seed: {
      seedId: evidence.seed?.seedId,
      seedDigest: evidence.seed?.seedDigest,
      invariants: stableObject(evidence.seed?.invariants ?? {}, { seed: true }),
    },
    camera: {
      plan: stableObject(cameraPlan),
      track: stableObject(evidence.camera?.track),
    },
    pointer: stableObject(evidence.pointer),
    frameTiming: normalizeFrameTiming(evidence.frameTiming),
    selectedFrames: (evidence.selectedFrames ?? []).map((frame) => ({
      storyTimeMs: frame.storyTimeMs,
    })),
    renderedArtifacts: normalizeRenderedArtifacts(evidence.renderedArtifacts),
  };
}

function valueDifference(left, right, currentPath) {
  return { path: currentPath || "$", left, right };
}

function arrayDifference(left, right, currentPath) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return valueDifference(left, right, currentPath);
  }
  if (left.length !== right.length) {
    return valueDifference(left.length, right.length, `${currentPath}.length`);
  }
  for (let index = 0; index < left.length; index += 1) {
    const difference = firstDifference(left[index], right[index], `${currentPath}[${index}]`);
    if (difference) return difference;
  }
  return null;
}

function objectDifference(left, right, currentPath) {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const key of keys) {
    const nextPath = currentPath ? `${currentPath}.${key}` : key;
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
      return valueDifference(left[key], right[key], nextPath);
    }
    const difference = firstDifference(left[key], right[key], nextPath);
    if (difference) return difference;
  }
  return null;
}

function firstDifference(left, right, currentPath = "") {
  if (Object.is(left, right)) return null;
  if (typeof left !== typeof right || left === null || right === null) {
    return valueDifference(left, right, currentPath);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return arrayDifference(left, right, currentPath);
  }
  if (typeof left === "object") return objectDifference(left, right, currentPath);
  return valueDifference(left, right, currentPath);
}

export function assertDeterministicRuns(first, second) {
  const difference = firstDifference(first, second);
  if (difference) {
    throw new Error(
      `deterministic run mismatch at ${difference.path}: ${JSON.stringify(difference.left)} != ${JSON.stringify(difference.right)}`,
    );
  }
  return { passed: true, digest: digestValue(first) };
}

function assertNoRawReviewPayload(value, pointer = "review") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      /^(?:visibleDomText|browserConsole|runtimeLogs|rawDomText|stdout|stderr|logContents|rawLogs?)$/i.test(
        key,
      )
    ) {
      throw new Error(`${pointer}.${key} embeds forbidden raw DOM or log payload`);
    }
    assertNoRawReviewPayload(child, `${pointer}.${key}`);
  }
}

function assertFileProof(record, label) {
  const valid =
    record &&
    typeof record.path === "string" &&
    Number.isInteger(record.bytes) &&
    record.bytes > 0 &&
    HEX_DIGEST_PATTERN.test(record.sha256 ?? "");
  if (!valid) throw new Error(`${label} requires exact path, positive bytes, and SHA-256`);
}

function assertReviewHeader(review) {
  const valid =
    review?.contract === "kandev-highlight-review-stage-v2" &&
    review.schemaVersion === 2 &&
    review.promotable === false &&
    review.readyForReview === true;
  if (!valid) {
    throw new Error("review must use kandev-highlight-review-stage-v2 and remain non-promotable");
  }
  if (review.qa?.status !== "technical_pass" || review.qa?.passed !== true) {
    throw new Error("review QA must be technical_pass with passed=true");
  }
  requireDigest(review.stageDigest, "review stageDigest");
  requireDigest(review.qa.reportDigest, "review QA report digest");
  assertNoRawReviewPayload(review);
}

function assertReviewAssets(review) {
  const delivery = review.assets?.desktop;
  for (const [kind, codec] of [
    ["webm", "vp9"],
    ["mp4", "h264"],
    ["poster", "webp"],
  ]) {
    const record = delivery?.[kind];
    assertFileProof(record, `review desktop ${kind}`);
    const valid =
      record.codec === codec &&
      record.width === 1920 &&
      record.height === 1200 &&
      record.audio === false;
    if (!valid) throw new Error(`review desktop ${kind} media contract is invalid`);
  }
}

function assertQaArtifact(artifact, kind) {
  assertFileProof(artifact, `QA ${kind}`);
  if (kind === "poster") {
    if (artifact.proofs?.skipped !== true) {
      throw new Error("QA poster proof must be still-image skipped");
    }
    return;
  }
  if (artifact.fullDecode?.passed !== true) throw new Error(`QA ${kind} full decode did not pass`);
  if (!Array.isArray(artifact.proofs?.keyframes) || artifact.proofs.keyframes.length < 1) {
    throw new Error(`QA ${kind} requires keyframes`);
  }
  artifact.proofs.keyframes.forEach((proof, index) =>
    assertFileProof(proof, `QA ${kind} keyframe ${index}`),
  );
  assertFileProof(artifact.proofs.contactSheet, `QA ${kind} contact sheet`);
}

function assertQaReport(qaReport) {
  const valid =
    qaReport?.contract === "kandev-highlight-qa-v1" &&
    qaReport.status === "technical_pass" &&
    qaReport.passed === true;
  if (!valid) throw new Error("QA report must retain technical_pass");
  if (qaReport.browser?.passed !== true) throw new Error("QA browser playback did not pass");
  if (qaReport.sensitiveData?.passed !== true) {
    throw new Error("QA sensitive-data scan did not pass");
  }
  if (!Array.isArray(qaReport.artifacts) || qaReport.artifacts.length !== 3) {
    throw new Error("QA report must contain mp4, webm, and poster artifacts");
  }
  const byKind = new Map(qaReport.artifacts.map((artifact) => [artifact.kind, artifact]));
  for (const kind of DELIVERY_KINDS) assertQaArtifact(byKind.get(kind), kind);
}

export function assertTechnicalReview({ review, qaReport } = {}) {
  assertReviewHeader(review);
  assertReviewAssets(review);
  assertQaReport(qaReport);
  return true;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function assertRuntimeCommand(commandResult) {
  const valid =
    commandResult?.contract === "kandev-highlight-runtime-command-v1" &&
    commandResult.command === "run" &&
    commandResult.runtimeId === RUNTIME_ID &&
    sameJson(commandResult.order, PIPELINE_ORDER);
  if (!valid) {
    throw new Error(
      "runtime command order must be validate -> storyboard -> capture -> render -> qa -> stage",
    );
  }
}

function assertRuntimeIdentity(commandResult, hostResult, receipt) {
  if (hostResult?.runId !== commandResult.runId || receipt?.runtimeId !== RUNTIME_ID) {
    throw new Error("runtime host or receipt run identity mismatch");
  }
  requireDigest(commandResult.host?.resultDigest, "runtime result digest");
  requireDigest(commandResult.host?.receiptDigest, "runtime receipt digest");
}

function assertResultLinks(commandResult, hostResult, receipt, expected) {
  const valid =
    commandResult.host.resultPath === expected?.resultPath &&
    hostResult.bundle?.resultPath === expected?.resultPath &&
    commandResult.host.receiptPath === expected?.receiptPath &&
    hostResult.applicationRuntime?.receiptPath === expected?.receiptPath &&
    receipt.receiptDigest === commandResult.host.receiptDigest &&
    hostResult.resultDigest === commandResult.host.resultDigest;
  if (!valid) throw new Error("runtime result or receipt fixed path/digest link mismatch");
}

function sourceProofMatches(proof, sourceSha) {
  return (
    proof?.unchanged === true &&
    [proof.pre?.selectedSha, proof.post?.selectedSha].every((value) => value === sourceSha)
  );
}

function assertSourceContinuity(hostResult, receipt, capture) {
  const sourceSha = capture?.source?.selectedSha;
  const valid = [
    SHA_PATTERN.test(sourceSha ?? ""),
    capture?.sourceDigest !== undefined,
    sourceProofMatches(hostResult.source, sourceSha),
    sourceProofMatches(receipt.source, sourceSha),
  ].every(Boolean);
  if (!valid) throw new Error("runtime source continuity is invalid");
  return sourceSha;
}

function assertBuildLinks({ request, build, capture, receipt, expected, sourceSha }) {
  const buildManifestPath = request?.buildManifestPath ?? capture?.build?.manifestPath;
  const buildDigest = capture?.build?.manifestDigest;
  const valid = [
    buildManifestPath === expected?.buildManifestPath,
    !build || build.manifestDigest === buildDigest,
    receipt.build?.manifestDigest === buildDigest,
    receipt.build?.sourceSha === sourceSha,
    capture.build?.sourceSha === sourceSha,
  ].every(Boolean);
  if (!valid) throw new Error("runtime build path, digest, or source link mismatch");
}

function assertCaptureLinks(commandResult, hostResult, receipt, expected) {
  const valid =
    hostResult.capture?.attemptRoot === expected?.attempt &&
    hostResult.capture?.captureManifestPath === expected?.captureManifestPath &&
    receipt.capture?.captureManifestPath === expected?.captureManifestPath &&
    commandResult.phases?.capture?.captureManifestPath === expected?.captureManifestPath;
  if (!valid) throw new Error("runtime capture fixed attempt or manifest link mismatch");
}

function assertSeedAndFrames(capture) {
  const seedValid =
    capture.seed?.seedId === "kandev.highlight.quick-start" &&
    PREFIXED_DIGEST_PATTERN.test(capture.seed?.seedDigest ?? "");
  if (!seedValid) throw new Error("capture seed identity or digest mismatch");
  const alignment = capture.frameAlignment ?? capture.capture?.frameAlignment;
  const frameValid =
    alignment &&
    (alignment.fps === undefined || alignment.fps === 25) &&
    (alignment.contract === undefined ||
      alignment.contract === "kandev-highlight-media-frame-alignment-v1");
  if (!frameValid) throw new Error("capture frame alignment is invalid");
}

function assertCamera(camera) {
  if (camera?.contract !== "kandev-highlight-camera-evidence-v1") {
    throw new Error("camera evidence contract is invalid");
  }
  requireDigest(camera.recordDigest, "camera record digest");
  const keyframes = camera.track?.keyframes;
  if (!Array.isArray(keyframes) || keyframes.length < 2) {
    throw new Error("camera track needs settled keyframes");
  }
  if (keyframes.some((keyframe) => keyframe.zoom !== 1)) {
    throw new Error("quick-start camera must retain no-zoom identity camera");
  }
}

export function assertRuntimeEvidenceLinks(input = {}) {
  const { commandResult, hostResult, receipt, request, build, capture, camera, expected } = input;
  assertRuntimeCommand(commandResult);
  assertRuntimeIdentity(commandResult, hostResult, receipt);
  assertResultLinks(commandResult, hostResult, receipt, expected);
  const sourceSha = assertSourceContinuity(hostResult, receipt, capture);
  assertBuildLinks({ request, build, capture, receipt, expected, sourceSha });
  assertCaptureLinks(commandResult, hostResult, receipt, expected);
  assertSeedAndFrames(capture);
  assertCamera(camera);
  return true;
}

export function projectSemanticPointerEvidence(execution = {}) {
  return {
    storyDurationMs: execution.storyDurationMs,
    timingToleranceMs: execution.timingToleranceMs,
    steps: (execution.steps ?? []).map((step) => ({
      index: step.index,
      pointer: step.pointer,
      kind: step.kind,
      plannedStartMs: step.plannedStartMs,
      plannedEndMs: step.plannedEndMs,
    })),
    resyncs: (execution.cursorResyncEvidence ?? []).map((resync) => ({
      source: resync.source,
      label: resync.label,
      point: resync.point,
      pointerGlyphBounds: resync.pointerGlyphBounds,
    })),
    movements: (execution.cursorEvidence ?? []).map((movement) => ({
      label: movement.label,
      from: movement.from,
      to: movement.to,
      requestedDurationMs: movement.requestedDurationMs,
      samples: (movement.samples ?? []).map((sample) => ({
        offsetMs: sample.offsetMs,
        progress: sample.progress,
        x: sample.x,
        y: sample.y,
        pointerGlyphBounds: sample.pointerGlyphBounds,
        targetBounds: sample.targetBounds,
        targetGlyphBounds: sample.targetGlyphBounds,
      })),
    })),
  };
}
