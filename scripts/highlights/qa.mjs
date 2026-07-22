import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  defaultSensitiveScanner,
  getTrustedSensitiveScannerCoverage,
  validateSensitiveScanResult,
} from "./sensitive-scan.mjs";

function ratio(value, label) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const match = /^(\d+)(?:\/(\d+))?$/.exec(String(value ?? ""));
  if (!match || Number(match[2] ?? 1) === 0) throw new Error(`${label} is not a valid ratio: ${value}`);
  return Number(match[1]) / Number(match[2] ?? 1);
}

function exactNumber(actual, expected, label) {
  if (expected !== undefined && actual !== expected) {
    throw new Error(`${label} expected ${expected}, received ${actual}`);
  }
}

export function validateMediaProbe(probe, expected = {}) {
  if (!probe || typeof probe !== "object") throw new Error("ffprobe JSON object is required");
  const videos = (probe.streams ?? []).filter((stream) => stream.codec_type === "video");
  const audios = (probe.streams ?? []).filter((stream) => stream.codec_type === "audio");
  if (videos.length !== 1) throw new Error(`expected exactly one video stream, received ${videos.length}`);
  const video = videos[0];
  const bytes = Number(probe.format?.size);
  const stillImage = expected.kind === "poster";
  exactNumber(video.width, expected.width, "media width");
  exactNumber(video.height, expected.height, "media height");
  exactNumber(video.codec_name, expected.codec, "media codec");
  exactNumber(bytes, expected.bytes, "media bytes");
  if (!Number.isInteger(bytes) || bytes <= 0) throw new Error("media bytes must be a positive integer");
  if (stillImage) {
    if (video.codec_name !== "webp") throw new Error(`poster codec expected webp, received ${video.codec_name}`);
    if (expected.fps !== null || expected.durationMs !== null) {
      throw new Error("poster expected fps and durationMs must both be null");
    }
    if (audios.length !== 0) throw new Error(`poster must contain no audio; received ${audios.length} stream(s)`);
    return {
      width: video.width,
      height: video.height,
      fps: null,
      averageFps: null,
      durationMs: null,
      frameCount: null,
      codec: video.codec_name,
      audioStreams: 0,
      pixelFormat: video.pix_fmt,
      bytes,
    };
  }
  const fps = ratio(video.r_frame_rate, "r_frame_rate");
  const averageFps = ratio(video.avg_frame_rate, "avg_frame_rate");
  const durationMs = Number(probe.format?.duration) * 1_000;
  const countedFrames = Number(video.nb_read_frames);
  const taggedFrames = Number(video.nb_frames);
  const inferredFrames = Math.round(durationMs * fps / 1_000);
  const frameCount = [countedFrames, taggedFrames, inferredFrames]
    .find((value) => Number.isInteger(value) && value > 0);
  if (expected.fps !== undefined && (fps !== expected.fps || averageFps !== expected.fps)) {
    throw new Error(`media fps expected exact ${expected.fps}, received r=${fps}, avg=${averageFps}`);
  }
  if (expected.durationMs !== undefined) {
    const tolerance = expected.durationToleranceMs ?? 0;
    if (!Number.isFinite(durationMs) || Math.abs(durationMs - expected.durationMs) > tolerance) {
      throw new Error(`media duration expected ${expected.durationMs}ms ±${tolerance}ms, received ${durationMs}ms`);
    }
  }
  if (expected.audio === false && audios.length !== 0) {
    throw new Error(`media must contain no audio; received ${audios.length} stream(s)`);
  }
  if (expected.audio === true && audios.length === 0) throw new Error("media expected an audio stream");
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("media duration must be positive");
  if (!Number.isInteger(frameCount) || frameCount <= 0) throw new Error("media frame count must be a positive integer");
  return {
    width: video.width,
    height: video.height,
    fps,
    averageFps,
    durationMs,
    frameCount,
    codec: video.codec_name,
    audioStreams: audios.length,
    pixelFormat: video.pix_fmt,
    bytes,
  };
}

export function inspectMp4Faststart(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new Error("MP4 faststart inspection needs bytes");
  }
  const buffer = Buffer.from(bytes);
  const moovOffset = buffer.indexOf(Buffer.from("moov", "ascii"));
  const mdatOffset = buffer.indexOf(Buffer.from("mdat", "ascii"));
  return {
    passed: moovOffset >= 0 && mdatOffset >= 0 && moovOffset < mdatOffset,
    moovOffset,
    mdatOffset,
  };
}

function normalizeCssRect(rect, width, height, label) {
  if (!rect || typeof rect !== "object") throw new Error(`${label} is required`);
  let left;
  let right;
  let top;
  let bottom;
  if (["left", "right", "top", "bottom"].every((key) => Number.isFinite(rect[key]))) {
    ({ left, right, top, bottom } = rect);
  } else if (["x", "y", "width", "height"].every((key) => Number.isFinite(rect[key]))) {
    left = rect.x;
    right = rect.x + rect.width;
    top = rect.y;
    bottom = rect.y + rect.height;
  } else {
    throw new Error(`${label} must contain CSS bounds`);
  }
  if (right > 1 || bottom > 1 || left > 1 || top > 1) {
    left /= width;
    right /= width;
    top /= height;
    bottom /= height;
  }
  if (left < 0 || top < 0 || right > 1 || bottom > 1 || right <= left || bottom <= top) {
    throw new Error(`${label} leaves capture viewport`);
  }
  return { left, right, top, bottom };
}

function unionGeometry(rects) {
  return rects.reduce((result, rect) => ({
    left: Math.min(result.left, rect.left),
    right: Math.max(result.right, rect.right),
    top: Math.min(result.top, rect.top),
    bottom: Math.max(result.bottom, rect.bottom),
  }));
}

export function normalizeExecutionGeometry({ execution, captureProfile, fps = 25 } = {}) {
  if (!execution || !Array.isArray(execution.cursorEvidence)) {
    throw new Error("execution cursorEvidence is required");
  }
  const width = captureProfile?.cssWidth;
  const height = captureProfile?.cssHeight;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error("captureProfile CSS dimensions are required for geometry normalization");
  }
  if (!Number.isFinite(captureProfile.dpr) || captureProfile.dpr <= 0) {
    throw new Error("captureProfile DPR is required for full-frame geometry normalization");
  }
  const pointerTrack = [];
  const targetIntervals = [];
  const epoch = execution.storyEpochMs ?? 0;
  for (const [movementIndex, movement] of execution.cursorEvidence.entries()) {
    const samples = movement.samples ?? [];
    for (const [sampleIndex, sample] of samples.entries()) {
      const tMs = Number.isFinite(sample.storyTMs) ? sample.storyTMs : sample.tMs - epoch;
      if (!Number.isFinite(tMs)) throw new Error(`movement ${movementIndex} sample ${sampleIndex} has no story time`);
      const glyphBounds = normalizeCssRect(
        sample.pointerGlyphBounds,
        width,
        height,
        `movement ${movementIndex} pointer glyph`,
      );
      pointerTrack.push({
        tMs,
        frame: tMs * fps / 1_000,
        x: sample.x > 1 ? sample.x / width : sample.x,
        y: sample.y > 1 ? sample.y / height : sample.y,
        glyphBounds,
        movementIndex,
      });
    }
    const targetSamples = samples.filter((sample) => sample.targetBounds && sample.targetGlyphBounds);
    if (targetSamples.length) {
      const bounds = unionGeometry(targetSamples.map((sample) => normalizeCssRect(
        sample.targetBounds,
        width,
        height,
        `movement ${movementIndex} target`,
      )));
      const glyphBounds = unionGeometry(targetSamples.map((sample) => normalizeCssRect(
        sample.targetGlyphBounds,
        width,
        height,
        `movement ${movementIndex} target glyph`,
      )));
      const visibilityStart = movement.visibility?.startMs ?? movement.startedAtMs;
      const visibilityEnd = movement.visibility?.endMs ?? movement.endedAtMs;
      const startMs = Number.isFinite(movement.storyVisibility?.startMs)
        ? movement.storyVisibility.startMs
        : visibilityStart - epoch;
      const endMs = Number.isFinite(movement.storyVisibility?.endMs)
        ? movement.storyVisibility.endMs
        : visibilityEnd - epoch;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
        throw new Error(`movement ${movementIndex} visibility interval is invalid`);
      }
      targetIntervals.push({
        label: movement.label ?? `movement ${movementIndex}`,
        startFrame: Math.floor(startMs * fps / 1_000),
        endFrame: Math.ceil(endMs * fps / 1_000),
        bounds,
        glyphBounds,
      });
    }
  }
  pointerTrack.sort((left, right) => left.frame - right.frame);
  const deduplicatedPointers = [];
  for (const point of pointerTrack) {
    if (deduplicatedPointers.at(-1)?.frame === point.frame) deduplicatedPointers[deduplicatedPointers.length - 1] = point;
    else deduplicatedPointers.push(point);
  }
  return {
    contract: "kandev-highlight-normalized-geometry-v1",
    coordinateSpace: "normalized-css-full-frame",
    cssViewport: { width, height },
    dpr: captureProfile.dpr,
    fps,
    pointerTrack: deduplicatedPointers,
    targetIntervals,
  };
}

function cameraPoints(camera) {
  const fps = camera.fps ?? 25;
  if (!Array.isArray(camera.keyframes) || camera.keyframes.length < 2) {
    throw new Error("materialized camera track needs at least two keyframes");
  }
  const points = camera.keyframes.map((point, index) => {
    const frame = Number.isFinite(point.frame)
      ? point.frame
      : Number.isFinite(point.tMs)
        ? point.tMs * fps / 1_000
        : NaN;
    if (![frame, point.zoom, point.x, point.y].every(Number.isFinite)) {
      throw new Error(`camera keyframe ${index} needs frame or tMs plus zoom/x/y`);
    }
    return { frame, zoom: point.zoom, x: point.x, y: point.y };
  });
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].frame <= points[index - 1].frame) {
      throw new Error("camera keyframes must use strictly increasing time");
    }
  }
  return points;
}

function interpolate(points, frame, keys) {
  if (!Array.isArray(points) || points.length === 0) throw new Error("track needs at least one sample");
  if (frame <= points[0].frame) return points[0];
  if (frame >= points.at(-1).frame) return points.at(-1);
  const rightIndex = points.findIndex((point) => point.frame >= frame);
  const left = points[rightIndex - 1];
  const right = points[rightIndex];
  const progress = (frame - left.frame) / (right.frame - left.frame);
  return Object.fromEntries(keys.map((key) => [key, left[key] + (right[key] - left[key]) * progress]));
}

function rectKeys(rect) {
  if (!rect || typeof rect !== "object") throw new Error("geometry bounds are required");
  for (const key of ["left", "right", "top", "bottom"]) {
    if (!Number.isFinite(rect[key])) throw new Error(`geometry ${key} must be finite`);
  }
  return rect;
}

function cameraAt(camera, frame) {
  return interpolate(cameraPoints(camera), frame, ["zoom", "x", "y"]);
}

function viewFor(state) {
  const width = 1 / state.zoom;
  const height = 1 / state.zoom;
  const left = Math.max(0, Math.min(1 - width, state.x - width / 2));
  const top = Math.max(0, Math.min(1 - height, state.y - height / 2));
  return { left, right: left + width, top, bottom: top + height };
}

function assertRectInView(rect, cameraState, margin, label, frame) {
  rectKeys(rect);
  const view = viewFor(cameraState);
  const effectiveMargin = {
    left: Math.min(margin.left / cameraState.zoom, Math.max(0, rect.left)),
    right: Math.min(
      margin.right / cameraState.zoom,
      Math.max(0, 1 - rect.right),
    ),
    top: Math.min(margin.top / cameraState.zoom, Math.max(0, rect.top)),
    bottom: Math.min(
      margin.bottom / cameraState.zoom,
      Math.max(0, 1 - rect.bottom),
    ),
  };
  if (
    rect.left < view.left + effectiveMargin.left - 1e-6 ||
    rect.right > view.right - effectiveMargin.right + 1e-6 ||
    rect.top < view.top + effectiveMargin.top - 1e-6 ||
    rect.bottom > view.bottom - effectiveMargin.bottom + 1e-6
  ) {
    throw new Error(`${label} leaves camera frame at frame ${frame}`);
  }
}

function pointerSamples(points) {
  return points.map((point) => {
    const glyph = rectKeys(point.glyphBounds ?? point.pointerGlyphBounds);
    return {
      ...point,
      frame: Number.isFinite(point.frame) ? point.frame : point.tMs / 40,
      glyphLeft: glyph.left,
      glyphRight: glyph.right,
      glyphTop: glyph.top,
      glyphBottom: glyph.bottom,
    };
  }).sort((left, right) => left.frame - right.frame);
}

export function auditContainment({ camera, pointerTrack = [], targetIntervals = [] } = {}) {
  if (!camera || !Array.isArray(camera.keyframes) || camera.keyframes.length < 2) {
    throw new Error("containment audit needs materialized camera keyframes");
  }
  const margin = camera.safeMargin ?? camera.pointerSafeMargin ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const pointers = pointerSamples(pointerTrack);
  let pointerFrames = 0;
  if (pointers.length) {
    const first = Math.ceil(pointers[0].frame);
    const last = Math.floor(pointers.at(-1).frame);
    for (let frame = first; frame <= last; frame += 1) {
      const pointer = interpolate(
        pointers,
        frame,
        ["x", "y", "glyphLeft", "glyphRight", "glyphTop", "glyphBottom"],
      );
      assertRectInView({
        left: pointer.glyphLeft,
        right: pointer.glyphRight,
        top: pointer.glyphTop,
        bottom: pointer.glyphBottom,
      }, cameraAt(camera, frame), margin, "pointer glyph", frame);
      pointerFrames += 1;
    }
  }
  let targetFrames = 0;
  for (const [index, interval] of targetIntervals.entries()) {
    const label = interval.label ?? `target ${index}`;
    const bounds = rectKeys(interval.bounds);
    const glyph = rectKeys(interval.glyphBounds);
    if (!Number.isInteger(interval.startFrame) || !Number.isInteger(interval.endFrame) || interval.endFrame < interval.startFrame) {
      throw new Error(`${label} visibility interval is invalid`);
    }
    for (let frame = interval.startFrame; frame <= interval.endFrame; frame += 1) {
      const state = cameraAt(camera, frame);
      assertRectInView(bounds, state, margin, `${label} target`, frame);
      assertRectInView(glyph, state, margin, `${label} target glyph`, frame);
      targetFrames += 1;
    }
  }
  return { passed: true, pointerFrames, targetFrames, targetIntervals: targetIntervals.length };
}

function rounded(value) {
  return Number(value.toFixed(9));
}

function stableRange(camera, start, end) {
  const reference = cameraAt(camera, start);
  for (let frame = start + 1; frame <= end; frame += 1) {
    const state = cameraAt(camera, frame);
    if (["zoom", "x", "y"].some((key) => Math.abs(state[key] - reference[key]) > 1e-7)) return false;
  }
  return true;
}

export function auditCameraMotion({ camera, limits = {}, landingAudit } = {}) {
  if (!camera || !Array.isArray(camera.keyframes) || camera.keyframes.length < 2) {
    throw new Error("camera motion audit needs materialized keyframes");
  }
  const fps = camera.fps ?? 25;
  const points = cameraPoints(camera);
  const durationFrame = Number.isFinite(camera.durationMs) ? camera.durationMs * fps / 1_000 : points.at(-1).frame;
  const lastFrame = Math.round(durationFrame);
  if (Math.abs(points.at(-1).frame - durationFrame) > 1e-6) {
    throw new Error("camera keyframes must span materialized duration");
  }
  const states = Array.from({ length: lastFrame + 1 }, (_, frame) => cameraAt(camera, frame));
  let maxPanVelocity = 0;
  let maxPanAcceleration = 0;
  let maxPanJerk = 0;
  let maxZoomRate = 0;
  let priorVelocity = { x: 0, y: 0 };
  let priorAcceleration = { x: 0, y: 0 };
  let priorDepthSign = 0;
  let depthReversals = 0;
  for (let frame = 1; frame < states.length; frame += 1) {
    const current = states[frame];
    const prior = states[frame - 1];
    const velocity = { x: (current.x - prior.x) * fps, y: (current.y - prior.y) * fps };
    const acceleration = {
      x: (velocity.x - priorVelocity.x) * fps,
      y: (velocity.y - priorVelocity.y) * fps,
    };
    const jerk = {
      x: (acceleration.x - priorAcceleration.x) * fps,
      y: (acceleration.y - priorAcceleration.y) * fps,
    };
    maxPanVelocity = Math.max(maxPanVelocity, Math.hypot(velocity.x, velocity.y));
    maxPanAcceleration = Math.max(maxPanAcceleration, Math.hypot(acceleration.x, acceleration.y));
    maxPanJerk = Math.max(maxPanJerk, Math.hypot(jerk.x, jerk.y));
    const depthDelta = current.zoom - prior.zoom;
    maxZoomRate = Math.max(maxZoomRate, Math.abs(depthDelta) * fps);
    const sign = Math.abs(depthDelta) > 1e-7 ? Math.sign(depthDelta) : 0;
    if (sign && priorDepthSign && sign !== priorDepthSign) depthReversals += 1;
    if (sign) priorDepthSign = sign;
    priorVelocity = velocity;
    priorAcceleration = acceleration;
  }
  const observed = {
    maxPanVelocity: rounded(maxPanVelocity),
    maxPanAcceleration: rounded(maxPanAcceleration),
    maxPanJerk: rounded(maxPanJerk),
    maxZoomRate: rounded(maxZoomRate),
    depthReversals,
  };
  const configured = {
    maxPanVelocity: limits.maxPanVelocity ?? 0.75,
    maxPanAcceleration: limits.maxPanAcceleration ?? 20,
    maxPanJerk: limits.maxPanJerk ?? 750,
    maxZoomRate: limits.maxZoomRate ?? 0.8,
    maxDepthReversals: limits.maxDepthReversals ?? 2,
  };
  for (const [metric, limitName] of [
    ["maxPanVelocity", "maxPanVelocity"],
    ["maxPanAcceleration", "maxPanAcceleration"],
    ["maxPanJerk", "maxPanJerk"],
    ["maxZoomRate", "maxZoomRate"],
  ]) {
    if (observed[metric] > configured[limitName] + 1e-9) {
      const label = metric.replace(/^max/, "").replaceAll(/([A-Z])/g, " $1").trim().toLowerCase();
      throw new Error(`camera ${label} ${observed[metric]} exceeds limit ${configured[limitName]}`);
    }
  }
  if (depthReversals > configured.maxDepthReversals) {
    throw new Error(`camera depth reversal count ${depthReversals} exceeds limit ${configured.maxDepthReversals}`);
  }
  const openingMs = camera.openingSettleMs ?? 400;
  const endingMs = camera.endingSettleMs ?? 400;
  const openingFrames = Math.ceil(openingMs * fps / 1_000);
  const endingFrames = Math.ceil(endingMs * fps / 1_000);
  if (!stableRange(camera, 0, Math.min(lastFrame, openingFrames))) {
    throw new Error(`camera opening is not settled for ${openingMs}ms`);
  }
  if (!stableRange(camera, Math.max(0, lastFrame - endingFrames), lastFrame)) {
    throw new Error(`camera ending is not settled for ${endingMs}ms`);
  }
  const upstream = landingAudit ?? camera.motionAudit;
  if (upstream && upstream.ok === false) {
    throw new Error(`landing camera motion audit failed: ${(upstream.violations ?? []).join(", ")}`);
  }
  return {
    passed: true,
    ...observed,
    limits: configured,
    openingSettled: true,
    endingSettled: true,
    landingAudit: upstream ?? null,
  };
}

function cadenceAudit(text, probe, expected) {
  const rows = String(text ?? "").trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(","));
  if (rows.length !== expected.frameCount) {
    throw new Error(`cadence frame count expected ${expected.frameCount}, received ${rows.length}`);
  }
  const stream = probe.streams.find((candidate) => candidate.codec_type === "video");
  const timeBase = String(stream.time_base ?? "").split("/").map(Number);
  const ticksPerFrame = timeBase.length === 2 && timeBase[0] > 0
    ? timeBase[1] / timeBase[0] / expected.fps
    : null;
  let priorTicks = null;
  let priorSeconds = null;
  for (const [index, row] of rows.entries()) {
    const ticks = Number(row[0]);
    const seconds = Number(row[1]);
    if (!Number.isFinite(ticks) || !Number.isFinite(seconds)) throw new Error(`cadence row ${index} is invalid`);
    if (priorTicks !== null && Math.abs((ticks - priorTicks) - ticksPerFrame) > 1) {
      throw new Error(`cadence integer timestamp gap at frame ${index}`);
    }
    if (priorSeconds !== null && Math.abs((seconds - priorSeconds) - 1 / expected.fps) > 0.001) {
      throw new Error(`cadence seconds gap at frame ${index}`);
    }
    priorTicks = ticks;
    priorSeconds = seconds;
  }
  return { passed: true, frameCount: rows.length, integerTicksPerFrame: ticksPerFrame };
}

function probeCommand(inputPath) {
  return [
    "ffprobe",
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "stream=index,codec_name,codec_type,width,height,r_frame_rate,avg_frame_rate,time_base,pix_fmt,nb_frames,nb_read_frames:format=duration,size,format_name",
    "-of",
    "json",
    inputPath,
  ];
}

function proofFrameIndices(frameCount) {
  if (!Number.isInteger(frameCount) || frameCount <= 0) {
    throw new Error("QA proof frameCount must be a positive integer");
  }
  const lastFrame = frameCount - 1;
  return [...new Set([0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]
    .map((fraction) => Math.min(lastFrame, Math.floor(frameCount * fraction))))]
    .sort((left, right) => left - right);
}

export function buildQaCommands({ inputPath, qaOutputDir, fps = 25, frameCount } = {}) {
  const base = path.basename(inputPath, path.extname(inputPath));
  const mediaKind = path.extname(inputPath).slice(1).toLowerCase();
  const proofBase = mediaKind ? `${base}-${mediaKind}` : base;
  const keyframePattern = path.join(qaOutputDir, `${proofBase}-keyframe-%02d.png`);
  const contactSheet = path.join(qaOutputDir, `${proofBase}-contact-sheet.png`);
  const frameIndices = proofFrameIndices(frameCount);
  const keyframeFiles = frameIndices.map((_, index) => path.join(
    qaOutputDir,
    `${proofBase}-keyframe-${String(index + 1).padStart(2, "0")}.png`,
  ));
  const select = `select='${frameIndices.map((frame) => `eq(n,${frame})`).join("+")}'`;
  return {
    probe: probeCommand(inputPath),
    cadence: ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp,best_effort_timestamp_time", "-of", "csv=p=0", inputPath],
    decode: ["ffmpeg", "-v", "error", "-i", inputPath, "-map", "0:v:0", "-f", "null", "-"],
    keyframes: ["ffmpeg", "-v", "error", "-n", "-i", inputPath, "-vf", select, "-fps_mode", "vfr", keyframePattern],
    contactSheet: ["ffmpeg", "-v", "error", "-n", "-i", inputPath, "-vf", `${select},scale=480:-1,tile=${frameIndices.length}x1`, "-frames:v", "1", contactSheet],
    outputs: { keyframePattern, keyframeFiles, contactSheet, frameIndices },
  };
}

async function runCommand(runner, command) {
  const [executable, ...args] = command;
  const result = await runner(executable, args);
  if (result?.exitCode !== undefined && result.exitCode !== 0) {
    throw new Error(`${executable} exited ${result.exitCode}: ${result.stderr ?? ""}`);
  }
  return result ?? { stdout: "", stderr: "", exitCode: 0 };
}

async function proofFileEvidence(filePath, readFile, label) {
  let bytes;
  try {
    bytes = Buffer.from(await readFile(filePath));
  } catch (error) {
    throw new Error(`proof output missing for ${label}: ${filePath} (${error.message})`);
  }
  if (bytes.length === 0) throw new Error(`proof output missing bytes for ${label}: ${filePath}`);
  return {
    path: filePath,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function collectProofEvidence(outputs, readFile) {
  const keyframes = [];
  for (const [index, filePath] of outputs.keyframeFiles.entries()) {
    keyframes.push({
      frame: outputs.frameIndices[index],
      ...await proofFileEvidence(filePath, readFile, `keyframe ${index + 1}`),
    });
  }
  return {
    keyframes,
    contactSheet: await proofFileEvidence(outputs.contactSheet, readFile, "contact sheet"),
  };
}

export async function runQualityAssurance({
  scenario,
  artifacts,
  camera,
  pointerTrack = [],
  targetIntervals = [],
  runner,
  readFile,
  browserPlayback,
  sensitiveScanner = defaultSensitiveScanner,
  cameraAuditor,
  qaOutputDir,
  captureEvidence,
  runtimeEvidence,
} = {}) {
  if (!scenario || typeof scenario !== "object") throw new Error("QA needs scenario");
  if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error("QA needs delivery artifacts");
  if (typeof runner !== "function") throw new Error("QA needs an external tool runner");
  if (typeof readFile !== "function") throw new Error("QA needs artifact byte reader");
  if (typeof browserPlayback !== "function") throw new Error("QA needs injected browser playback hook");
  if (typeof sensitiveScanner !== "function") throw new Error("QA sensitive scanner must be a function");
  const declaredSensitiveCoverage = getTrustedSensitiveScannerCoverage(sensitiveScanner);
  if (!declaredSensitiveCoverage) {
    throw new Error("QA sensitive scanner must come from the trusted sensitive-scanner builder");
  }
  const resolvedQaDir = path.resolve(qaOutputDir ?? path.join(path.dirname(artifacts[0].path), "qa"));
  if (qaOutputDir) await mkdir(resolvedQaDir, { recursive: true });
  const artifactReports = [];
  const commandEvidence = [];
  for (const artifact of artifacts) {
    const probe = probeCommand(artifact.path);
    const probeResult = await runCommand(runner, probe);
    commandEvidence.push(probe);
    let probeJson;
    try {
      probeJson = JSON.parse(probeResult.stdout);
    } catch (error) {
      throw new Error(`ffprobe returned invalid JSON for ${artifact.path}: ${error.message}`);
    }
    const summary = validateMediaProbe(probeJson, artifact.expected);
    const bytes = Buffer.from(await readFile(artifact.path));
    if (bytes.length !== summary.bytes) {
      throw new Error(`artifact bytes expected ${summary.bytes}, read ${bytes.length}`);
    }
    const stillImage = artifact.expected?.kind === "poster";
    let cadence = { skipped: true, reason: "still-image" };
    let fullDecode = { skipped: true, reason: "still-image" };
    let proofs = { skipped: true, reason: "still-image" };
    if (!stillImage) {
      const commands = buildQaCommands({
        inputPath: artifact.path,
        qaOutputDir: resolvedQaDir,
        fps: summary.fps,
        frameCount: summary.frameCount,
      });
      const cadenceResult = await runCommand(runner, commands.cadence);
      cadence = cadenceAudit(cadenceResult.stdout, probeJson, summary);
      await runCommand(runner, commands.decode);
      await runCommand(runner, commands.keyframes);
      await runCommand(runner, commands.contactSheet);
      proofs = await collectProofEvidence(commands.outputs, readFile);
      fullDecode = { passed: true };
      commandEvidence.push(...[commands.cadence, commands.decode, commands.keyframes, commands.contactSheet]);
    }
    const faststart = artifact.expected?.kind === "mp4" || path.extname(artifact.path).toLowerCase() === ".mp4"
      ? inspectMp4Faststart(bytes)
      : null;
    if (artifact.expected?.faststart && !faststart?.passed) throw new Error(`${artifact.path} MP4 is not faststart`);
    artifactReports.push({
      kind: artifact.expected?.kind ?? path.extname(artifact.path).slice(1),
      path: artifact.path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      probe: summary,
      cadence,
      fullDecode,
      faststart,
      proofs,
    });
  }
  const landingAudit = typeof cameraAuditor === "function" ? cameraAuditor(camera) : camera?.motionAudit;
  const motion = auditCameraMotion({ camera, landingAudit });
  const containment = auditContainment({ camera, pointerTrack, targetIntervals });
  const generatedProofEvidence = artifactReports.flatMap((artifact) => (
    artifact.proofs?.skipped
      ? []
      : [{
        artifactPath: artifact.path,
        kind: artifact.kind,
        keyframes: artifact.proofs.keyframes,
        contactSheet: artifact.proofs.contactSheet,
      }]
  ));
  const sensitiveData = validateSensitiveScanResult(
    await sensitiveScanner({
      scenario,
      camera,
      artifacts: artifactReports,
      generatedProofEvidence,
      captureEvidence,
      runtimeEvidence,
    }),
    { expectedCoverage: declaredSensitiveCoverage },
  );
  if (!sensitiveData?.passed) throw new Error(`sensitive-data scan failed: ${JSON.stringify(sensitiveData.findings ?? [])}`);
  const browser = await browserPlayback({ scenario, artifacts: artifactReports });
  if (!browser?.passed) throw new Error("browser playback QA failed");
  return {
    contract: "kandev-highlight-qa-v1",
    scenarioId: scenario.id ?? null,
    passed: true,
    artifacts: artifactReports,
    camera: motion,
    containment,
    sensitiveData,
    browser,
    commands: commandEvidence,
  };
}
