import path from "node:path";

import {
  DEFAULT_SETUP_DEADLINE_MS,
  digestValue,
  runBoundedSubprocess,
  sha256,
} from "./pipeline-eval-shared.mjs";

const HEX_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const VISUAL_THRESHOLDS = Object.freeze({
  video: Object.freeze({
    mean: 0.999,
    minimum: 0.985,
    frameThreshold: 0.995,
    maximumFramesBelow: 4,
  }),
  selected: Object.freeze({
    mean: 0.99999,
    minimum: 0.99999,
    frameThreshold: 0.99999,
    maximumFramesBelow: 0,
  }),
  poster: Object.freeze({
    mean: 0.999,
    minimum: 0.999,
    frameThreshold: 0.999,
    maximumFramesBelow: 0,
  }),
});

function exactIdentity(record, label) {
  if (
    typeof record?.path !== "string" ||
    !path.isAbsolute(record.path) ||
    !Number.isInteger(record.bytes) ||
    record.bytes <= 0 ||
    !HEX_DIGEST_PATTERN.test(record.sha256 ?? "")
  ) {
    throw new Error(`${label} needs absolute path, positive bytes, and exact SHA-256`);
  }
  return { bytes: record.bytes, sha256: record.sha256 };
}

function parseSsimStats(output, expectedFrames, label) {
  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("n:"));
  if (lines.length !== expectedFrames) {
    throw new Error(
      `${label} needs ${expectedFrames} sequential SSIM frames; received ${lines.length}`,
    );
  }
  return lines.map((line, index) => {
    const sequence = /^n:(\d+)\b/.exec(line);
    const received = Number(sequence?.[1]);
    const expected = index + 1;
    if (!Number.isInteger(received) || received !== expected) {
      throw new Error(
        `${label} SSIM frame sequence expected ${expected}, received ${String(sequence?.[1])}`,
      );
    }
    const token = /\bAll:([^\s]+)/.exec(line)?.[1];
    const score = Number(token);
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error(`${label} SSIM frame ${expected} All must be finite between 0 and 1`);
    }
    return score;
  });
}

function assertSsim(scores, thresholds, label) {
  const rawMean = scores.reduce((total, score) => total + score, 0) / scores.length;
  const reportedMean = Number(rawMean.toFixed(9));
  const minimum = Math.min(...scores);
  const framesBelowThreshold = scores.filter((score) => score < thresholds.frameThreshold).length;
  if (rawMean < thresholds.mean) {
    throw new Error(`${label} mean SSIM ${rawMean} is below minimum ${thresholds.mean}`);
  }
  if (minimum < thresholds.minimum) {
    throw new Error(`${label} minimum SSIM ${minimum} is below minimum ${thresholds.minimum}`);
  }
  if (framesBelowThreshold > thresholds.maximumFramesBelow) {
    throw new Error(
      `${label} frames below ${thresholds.frameThreshold}: ${framesBelowThreshold}; maximum ${thresholds.maximumFramesBelow}`,
    );
  }
  return {
    meanSsim: reportedMean,
    minimumSsim: minimum,
    framesBelowThreshold,
  };
}

function requirePairMetadata(first, second, label, frameCount) {
  if (
    !Number.isInteger(first.width) ||
    !Number.isInteger(first.height) ||
    first.width <= 0 ||
    first.height <= 0 ||
    first.width !== second.width ||
    first.height !== second.height
  ) {
    throw new Error(`${label} dimensions must match exactly`);
  }
  if (first.fps !== second.fps) throw new Error(`${label} fps must match exactly`);
  const firstFrames = frameCount(first);
  const secondFrames = frameCount(second);
  if (!Number.isInteger(firstFrames) || firstFrames <= 0 || firstFrames !== secondFrames) {
    throw new Error(`${label} frame count must match exactly`);
  }
  return firstFrames;
}

function mediaByKind(run, kind) {
  const matches = (run.media ?? []).filter((artifact) => artifact.kind === kind);
  if (matches.length !== 1) {
    throw new Error(`visual comparison needs exactly one ${kind} artifact per run`);
  }
  return matches[0];
}

function buildComparisonSpecs(first, second) {
  const rawFrames = requirePairMetadata(
    first.rawMaster,
    second.rawMaster,
    "raw",
    (record) => record.storyFrameCount,
  );
  for (const [index, raw] of [first.rawMaster, second.rawMaster].entries()) {
    if (
      !Number.isInteger(raw.storyStartFrame) ||
      !Number.isInteger(raw.storyEndFrame) ||
      raw.storyEndFrame - raw.storyStartFrame !== raw.storyFrameCount
    ) {
      throw new Error(`raw ${index + 1} story frame count is invalid`);
    }
  }
  const specs = [
    {
      label: "raw",
      phase: "visual-raw",
      first: first.rawMaster,
      second: second.rawMaster,
      frameCount: rawFrames,
      thresholds: VISUAL_THRESHOLDS.video,
      trim: true,
    },
  ];
  for (const kind of ["mp4", "webm"]) {
    const left = mediaByKind(first, kind);
    const right = mediaByKind(second, kind);
    const frameCount = requirePairMetadata(
      { ...left.probe, ...left },
      { ...right.probe, ...right },
      kind,
      (record) => record.probe.frameCount,
    );
    specs.push({
      label: kind,
      phase: `visual-${kind}`,
      first: left,
      second: right,
      frameCount,
      thresholds: VISUAL_THRESHOLDS.video,
    });
  }
  if (
    first.selectedFrames?.length !== second.selectedFrames?.length ||
    !first.selectedFrames?.length
  ) {
    throw new Error("selected frame count must match exactly");
  }
  for (let index = 0; index < first.selectedFrames.length; index += 1) {
    const left = first.selectedFrames[index];
    const right = second.selectedFrames[index];
    if (left.storyTimeMs !== right.storyTimeMs) {
      throw new Error(`selected frame ${index + 1} story time must match exactly`);
    }
    specs.push({
      label: `selected frame ${index + 1}`,
      phase: `visual-selected-${index + 1}`,
      first: left,
      second: right,
      width: first.rawMaster.width,
      height: first.rawMaster.height,
      fps: null,
      frameCount: 1,
      thresholds: VISUAL_THRESHOLDS.selected,
    });
  }
  const posterLeft = mediaByKind(first, "poster");
  const posterRight = mediaByKind(second, "poster");
  requirePairMetadata(
    { ...posterLeft.probe, ...posterLeft },
    { ...posterRight.probe, ...posterRight },
    "poster",
    () => 1,
  );
  specs.push({
    label: "poster",
    phase: "visual-poster",
    first: posterLeft,
    second: posterRight,
    frameCount: 1,
    thresholds: VISUAL_THRESHOLDS.poster,
  });
  return specs;
}

function ssimFilter(spec) {
  const prepare = (index, name, input) =>
    spec.trim
      ? `[${index}:v]trim=start_frame=${input.storyStartFrame}:end_frame=${input.storyEndFrame},setpts=PTS-STARTPTS[${name}]`
      : `[${index}:v]setpts=PTS-STARTPTS[${name}]`;
  return [
    prepare(0, "first", spec.first),
    prepare(1, "second", spec.second),
    "[first][second]ssim=stats_file=-:shortest=1:repeatlast=0",
  ].join(";");
}

async function compareSpec(spec, input) {
  const firstIdentity = exactIdentity(spec.first, `${spec.label} first input`);
  const secondIdentity = exactIdentity(spec.second, `${spec.label} second input`);
  const result = await input.runner({
    command: "ffmpeg",
    args: [
      "-hide_banner",
      "-nostats",
      "-v",
      "error",
      "-i",
      spec.first.path,
      "-i",
      spec.second.path,
      "-filter_complex",
      ssimFilter(spec),
      "-frames:v",
      String(spec.frameCount),
      "-f",
      "null",
      "-",
    ],
    cwd: input.cwd,
    env: input.env,
    phase: spec.phase,
    logRoot: input.logRoot,
    deadlineMs: DEFAULT_SETUP_DEADLINE_MS,
  });
  const statsBytes = Buffer.from(result.stdoutBytes ?? result.stdout);
  const scores = parseSsimStats(statsBytes.toString("utf8"), spec.frameCount, spec.label);
  return {
    label: spec.label,
    frameCount: spec.frameCount,
    width: spec.width ?? spec.first.width ?? spec.first.probe?.width,
    height: spec.height ?? spec.first.height ?? spec.first.probe?.height,
    fps: spec.fps ?? spec.first.fps ?? spec.first.probe?.fps ?? null,
    inputs: { first: firstIdentity, second: secondIdentity },
    stats: { bytes: statsBytes.length, sha256: sha256(statsBytes) },
    ...assertSsim(scores, spec.thresholds, spec.label),
  };
}

export async function compareRunVisuals(input = {}) {
  const runner = input.runner ?? runBoundedSubprocess;
  if (typeof runner !== "function") throw new Error("visual comparator runner is required");
  const comparisons = [];
  for (const spec of buildComparisonSpecs(input.first ?? {}, input.second ?? {})) {
    comparisons.push(await compareSpec(spec, { ...input, runner }));
  }
  const body = {
    contract: "kandev-highlight-visual-determinism-v1",
    version: 1,
    passed: true,
    thresholds: VISUAL_THRESHOLDS,
    comparisons,
  };
  return { ...body, resultDigest: digestValue(body) };
}
