import fs from "node:fs/promises";
import path from "node:path";

import {
  assertRuntimeEvidenceLinks,
  assertTechnicalReview,
  normalizeDeterminismEvidence,
  projectSemanticPointerEvidence,
} from "./pipeline-eval-evidence.mjs";
import {
  DEFAULT_SETUP_DEADLINE_MS,
  digestBytes,
  digestValue,
  requireAbsolute,
  runBoundedSubprocess,
  sha256,
} from "./pipeline-eval-shared.mjs";

const QUICK_START_ID = "quick-start";

async function readJsonIdentity(filePath, label) {
  const absolute = requireAbsolute(filePath, label);
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || (await fs.realpath(absolute)) !== absolute) {
    throw new Error(`${label} must be a canonical regular file: ${absolute}`);
  }
  const bytes = await fs.readFile(absolute);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
  return { path: absolute, bytes: bytes.length, digest: digestBytes(bytes), value };
}

export function parseLastJsonDocument(output, label) {
  const source = String(output).trim();
  for (
    let index = source.lastIndexOf("{");
    index >= 0;
    index = source.lastIndexOf("{", index - 1)
  ) {
    try {
      return JSON.parse(source.slice(index));
    } catch {
      // Build/test output may precede the production CLI final JSON document.
    }
  }
  throw new Error(`${label} produced no final JSON document`);
}

function settledStoryTimes(timeline) {
  const duration = timeline.totalDurationMs;
  const opening = timeline.events?.find((event) => event.kind === "openingSettle");
  const ending = [...(timeline.events ?? [])]
    .reverse()
    .find((event) => event.kind === "endingSettle");
  const first = Math.max(0, Math.min(duration - 1, Math.round((opening?.endMs ?? 400) / 2)));
  const last = Math.max(
    first,
    Math.min(duration - 1, Math.round(((ending?.startMs ?? duration - 400) + duration) / 2)),
  );
  return [...new Set([first, last])];
}

async function decodeFrame({
  rawMasterPath,
  storyStartOffsetMs,
  storyTimeMs,
  outputPath,
  outputRoot,
  phase,
  logRoot,
  env,
}) {
  const mediaSeconds = ((storyStartOffsetMs + storyTimeMs) / 1_000).toFixed(6);
  await runBoundedSubprocess({
    command: "ffmpeg",
    args: [
      "-v",
      "error",
      "-i",
      rawMasterPath,
      "-ss",
      mediaSeconds,
      "-frames:v",
      "1",
      "-c:v",
      "png",
      "-n",
      outputPath,
    ],
    cwd: outputRoot,
    env,
    phase,
    logRoot,
    deadlineMs: DEFAULT_SETUP_DEADLINE_MS,
  });
  const bytes = await fs.readFile(outputPath);
  if (bytes.length === 0) throw new Error(`decoded frame is empty: ${outputPath}`);
  return { storyTimeMs, path: outputPath, bytes: bytes.length, sha256: sha256(bytes) };
}

async function decodeSelectedFrames(input) {
  const targetRoot = path.join(input.outputRoot, input.runId);
  await fs.mkdir(targetRoot, { recursive: true });
  const selected = [];
  for (const [index, storyTimeMs] of settledStoryTimes(input.timeline).entries()) {
    const outputPath = path.join(targetRoot, `story-${String(index + 1).padStart(2, "0")}.png`);
    selected.push(
      await decodeFrame({
        ...input,
        storyTimeMs,
        outputPath,
        phase: `${input.runId}-decode-${index + 1}`,
      }),
    );
  }
  return selected;
}

function expectedRuntimePaths(artifactRoot, runId) {
  const attempt = path.join(artifactRoot, QUICK_START_ID, "runs", runId);
  const hostRoot = path.join(artifactRoot, "runtime-host", runId);
  const buildRoot = path.join(artifactRoot, "runtime-builds", runId);
  return {
    attempt,
    hostRoot,
    buildRoot,
    resultPath: path.join(hostRoot, "result.json"),
    receiptPath: path.join(attempt, "evidence", "application-runtime.json"),
    captureManifestPath: path.join(attempt, "capture", "evidence", "capture.json"),
    cameraPath: path.join(attempt, "evidence", "camera.json"),
    buildManifestPath: path.join(buildRoot, "evidence", "build-provenance.json"),
  };
}

async function readRunFiles({ commandResult, scenarioPath, artifactRoot }) {
  const runId = commandResult.runId;
  const expected = expectedRuntimePaths(artifactRoot, runId);
  const [host, receipt, capture, camera, build, storyboard, scenario] = await Promise.all([
    readJsonIdentity(expected.resultPath, `${runId} runtime host result`),
    readJsonIdentity(expected.receiptPath, `${runId} runtime receipt`),
    readJsonIdentity(expected.captureManifestPath, `${runId} capture receipt`),
    readJsonIdentity(expected.cameraPath, `${runId} camera evidence`),
    readJsonIdentity(expected.buildManifestPath, `${runId} build manifest`),
    readJsonIdentity(
      path.join(expected.attempt, "evidence", "storyboard.json"),
      `${runId} storyboard evidence`,
    ),
    readJsonIdentity(scenarioPath, `${runId} scenario`),
  ]);
  const request = await readJsonIdentity(
    host.value.bundle?.requestPath,
    `${runId} runtime request`,
  );
  const review = await readJsonIdentity(
    commandResult.phases?.stage?.manifestPath,
    `${runId} review manifest`,
  );
  const qa = await readJsonIdentity(
    path.join(path.dirname(review.path), review.value.qa?.reportPath ?? ""),
    `${runId} staged QA report`,
  );
  return {
    runId,
    expected,
    host,
    receipt,
    capture,
    camera,
    request,
    build,
    storyboard,
    review,
    qa,
    scenario,
  };
}

function withoutKey(value, omitted) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== omitted));
}

function validateExactDigests(files, commandResult) {
  const { runId, host, receipt, build, camera, review, qa } = files;
  if (host.digest !== commandResult.host.resultDigest) {
    throw new Error(`${runId} runtime result exact bytes do not match command digest`);
  }
  if (receipt.digest !== commandResult.host.receiptDigest) {
    throw new Error(`${runId} runtime receipt exact bytes do not match command digest`);
  }
  if (build.value.manifestDigest !== digestValue(withoutKey(build.value, "manifestDigest"))) {
    throw new Error(`${runId} build manifest self digest is invalid`);
  }
  if (camera.value.recordDigest !== digestValue(withoutKey(camera.value, "recordDigest"))) {
    throw new Error(`${runId} camera evidence self digest is invalid`);
  }
  if (qa.digest !== review.value.qa.reportDigest) {
    throw new Error(`${runId} staged QA exact bytes do not match review digest`);
  }
}

function validateLinkedEvidence(files, commandResult) {
  assertRuntimeEvidenceLinks({
    commandResult,
    hostResult: files.host.value,
    receipt: files.receipt.value,
    request: files.request.value,
    build: files.build.value,
    capture: files.capture.value,
    camera: files.camera.value,
    expected: files.expected,
  });
  assertTechnicalReview({ review: files.review.value, qaReport: files.qa.value });
  const timeline = files.storyboard.value.value?.timeline;
  if (!timeline || timeline.scenarioId !== QUICK_START_ID) {
    throw new Error(`${files.runId} storyboard phase has no quick-start timeline`);
  }
  return timeline;
}

function normalizedRun(files, timeline, selectedFrames) {
  const capture = files.capture.value;
  const frameAlignment = capture.capture?.frameAlignment;
  return normalizeDeterminismEvidence({
    scenario: {
      id: files.scenario.value.id,
      digest: capture.scenarioDigest,
      value: files.scenario.value,
    },
    timeline,
    seed: capture.seed,
    camera: files.camera.value,
    pointer: projectSemanticPointerEvidence(capture.execution),
    frameTiming: {
      fps: capture.capture?.fps,
      storyDurationMs: capture.storyDurationMs,
      relativeStartFrame: 0,
      storyFrameCount: frameAlignment?.observedStoryFrames,
      alignment: frameAlignment,
      selectedStoryTimesMs: selectedFrames.map((frame) => frame.storyTimeMs),
    },
    selectedFrames,
  });
}

function summarizeRun(files, selectedFrames, normalized) {
  const { runId, expected, host, receipt, capture, build, camera, review, qa } = files;
  return {
    runId,
    reviewPath: review.path,
    qaReportPath: qa.path,
    rawMasterPath: capture.value.rawMaster?.path,
    paths: expected,
    digests: {
      runtimeResult: host.digest,
      runtimeReceipt: receipt.digest,
      capture: capture.digest,
      build: build.value.manifestDigest,
      camera: camera.value.recordDigest,
      review: review.value.stageDigest,
      qa: qa.digest,
    },
    media: qa.value.artifacts.map((artifact) => ({
      kind: artifact.kind,
      path: artifact.path,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      keyframes: artifact.proofs?.keyframes?.length ?? 0,
      contactSheet: artifact.proofs?.contactSheet ?? null,
    })),
    browser: qa.value.browser,
    selectedFrames,
    normalized,
    normalizedDigest: digestValue(normalized),
  };
}

export async function collectRunEvidence(input) {
  const files = await readRunFiles(input);
  validateExactDigests(files, input.commandResult);
  const timeline = validateLinkedEvidence(files, input.commandResult);
  const selectedFrames = await decodeSelectedFrames({
    rawMasterPath: files.capture.value.rawMaster?.path,
    storyStartOffsetMs: files.capture.value.storyStartOffsetMs,
    timeline,
    outputRoot: path.join(input.evalRoot, "decoded-frames"),
    runId: files.runId,
    logRoot: input.logRoot,
    env: input.env,
  });
  return summarizeRun(files, selectedFrames, normalizedRun(files, timeline, selectedFrames));
}
