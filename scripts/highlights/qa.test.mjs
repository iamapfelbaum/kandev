import assert from "node:assert/strict";
import { readFile as readDiskFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import * as sensitiveScan from "./sensitive-scan.mjs";

import {
  auditCameraMotion,
  auditContainment,
  buildQaCommands,
  inspectMp4Faststart,
  normalizeExecutionGeometry,
  runQualityAssurance,
  validateMediaProbe,
} from "./qa.mjs";

const fixturePath = path.join(import.meta.dirname, "test-fixtures/ffprobe-mp4.json");
const probe = JSON.parse(await readDiskFile(fixturePath, "utf8"));

const expected = {
  kind: "mp4",
  width: 1920,
  height: 1200,
  fps: 25,
  durationMs: 4_000,
  durationToleranceMs: 20,
  codec: "h264",
  audio: false,
  bytes: 4096,
  faststart: true,
};

test("media probe validates exact dimensions, cadence, duration, audio, codec, and bytes", () => {
  const summary = validateMediaProbe(probe, expected);
  assert.deepEqual(summary, {
    width: 1920,
    height: 1200,
    fps: 25,
    averageFps: 25,
    durationMs: 4000,
    frameCount: 100,
    codec: "h264",
    audioStreams: 0,
    pixelFormat: "yuv420p",
    bytes: 4096,
  });
  assert.throws(() => validateMediaProbe(probe, { ...expected, width: 1919 }), /width.*1919.*1920/i);
  assert.throws(() => validateMediaProbe(probe, { ...expected, audio: true }), /audio/i);
});

test("media probe derives deterministic frame count when WebM reports nb_frames N/A", () => {
  const webmProbe = structuredClone(probe);
  webmProbe.streams[0].codec_name = "vp9";
  webmProbe.streams[0].nb_frames = "N/A";
  const summary = validateMediaProbe(webmProbe, {
    ...expected,
    kind: "webm",
    codec: "vp9",
    faststart: undefined,
  });
  assert.equal(summary.frameCount, 100);
});

test("MP4 faststart evidence requires moov before mdat", () => {
  assert.deepEqual(inspectMp4Faststart(Buffer.from("0000ftyp0000moov0000mdat")), {
    passed: true,
    moovOffset: 12,
    mdatOffset: 20,
  });
  assert.equal(inspectMp4Faststart(Buffer.from("ftyp....mdat....moov")).passed, false);
});

test("proof commands use explicit known frame indices instead of unsupported total-frame N", () => {
  const commands = buildQaCommands({
    inputPath: "/stage/demo.webm",
    qaOutputDir: "/stage/qa",
    fps: 25,
    frameCount: 100,
  });
  const keyframeFilter = commands.keyframes[commands.keyframes.indexOf("-vf") + 1];
  const contactFilter = commands.contactSheet[commands.contactSheet.indexOf("-vf") + 1];
  assert.doesNotMatch(keyframeFilter, /\bN\b/);
  assert.doesNotMatch(contactFilter, /\bN\b/);
  assert.match(keyframeFilter, /eq\(n,99\)/);
  assert.match(contactFilter, /tile=/);
  assert.ok(commands.probe.includes("-count_frames"));
});

test("containment audits pointer glyph and target glyph over visibility intervals", () => {
  const camera = {
    fps: 25,
    durationMs: 1000,
    safeMargin: { top: 0.02, right: 0.02, bottom: 0.02, left: 0.02 },
    keyframes: [
      { frame: 0, zoom: 1.5, x: 0.5, y: 0.5 },
      { frame: 25, zoom: 1.5, x: 0.5, y: 0.5 },
    ],
  };
  const pointerTrack = [
    { frame: 0, x: 0.5, y: 0.5, glyphBounds: { left: 0.49, right: 0.52, top: 0.49, bottom: 0.53 } },
    { frame: 25, x: 0.55, y: 0.55, glyphBounds: { left: 0.54, right: 0.57, top: 0.54, bottom: 0.58 } },
  ];
  const targetIntervals = [{
    label: "Save",
    startFrame: 2,
    endFrame: 20,
    bounds: { left: 0.4, right: 0.6, top: 0.4, bottom: 0.6 },
    glyphBounds: { left: 0.45, right: 0.55, top: 0.46, bottom: 0.54 },
  }];
  assert.equal(auditContainment({ camera, pointerTrack, targetIntervals }).passed, true);
  const clipped = pointerTrack.map((point, index) => index ? {
    ...point,
    x: 0.99,
    glyphBounds: { left: 0.98, right: 1, top: 0.54, bottom: 0.58 },
  } : point);
  assert.throws(
    () => auditContainment({ camera, pointerTrack: clipped, targetIntervals }),
    /pointer glyph.*frame/i,
  );
});

test("camera motion audit measures limits, settle, and depth reversals", () => {
  const identity = {
    fps: 25,
    durationMs: 1000,
    openingSettleMs: 400,
    endingSettleMs: 400,
    keyframes: [
      { frame: 0, zoom: 1, x: 0.5, y: 0.5 },
      { frame: 25, zoom: 1, x: 0.5, y: 0.5 },
    ],
  };
  const result = auditCameraMotion({ camera: identity });
  assert.equal(result.passed, true);
  assert.equal(result.maxPanVelocity, 0);
  assert.equal(result.depthReversals, 0);

  assert.throws(() => auditCameraMotion({
    camera: {
      ...identity,
      keyframes: [
        { frame: 0, zoom: 1, x: 0.5, y: 0.5 },
        { frame: 1, zoom: 2, x: 0.9, y: 0.5 },
        { frame: 25, zoom: 1, x: 0.5, y: 0.5 },
      ],
    },
  }), /camera (?:pan velocity|zoom rate|acceleration|jerk).*limit/i);
});

test("QA consumes landing tMs keyframes and normalizes CSS execution glyph evidence", () => {
  const camera = {
    fps: 25,
    durationMs: 1_000,
    openingSettleMs: 400,
    endingSettleMs: 400,
    pointerSafeMargin: { top: 0.02, right: 0.02, bottom: 0.02, left: 0.02 },
    keyframes: [
      { tMs: 0, zoom: 1, x: 0.5, y: 0.5 },
      { tMs: 1_000, zoom: 1, x: 0.5, y: 0.5 },
    ],
  };
  const execution = {
    storyEpochMs: 1_000,
    cursorEvidence: [{
      label: "Save",
      startedAtMs: 1_400,
      endedAtMs: 1_800,
      visibility: { startMs: 1_400, endMs: 1_800 },
      samples: [
        {
          storyTMs: 400,
          x: 960,
          y: 600,
          targetBounds: { x: 900, y: 560, width: 180, height: 80 },
          targetGlyphBounds: { x: 930, y: 580, width: 120, height: 30 },
          pointerGlyphBounds: { x: 960, y: 600, width: 24, height: 30 },
        },
        {
          storyTMs: 800,
          x: 1_000,
          y: 620,
          targetBounds: { x: 900, y: 560, width: 180, height: 80 },
          targetGlyphBounds: { x: 930, y: 580, width: 120, height: 30 },
          pointerGlyphBounds: { x: 1_000, y: 620, width: 24, height: 30 },
        },
      ],
    }],
  };
  const geometry = normalizeExecutionGeometry({
    execution,
    captureProfile: { cssWidth: 1920, cssHeight: 1200, dpr: 2 },
    fps: 25,
  });

  assert.equal(geometry.pointerTrack[0].frame, 10);
  assert.equal(geometry.pointerTrack[0].x, 0.5);
  assert.deepEqual(geometry.pointerTrack[0].glyphBounds, {
    left: 0.5,
    right: 0.5125,
    top: 0.5,
    bottom: 0.525,
  });
  assert.equal(geometry.targetIntervals[0].startFrame, 10);
  assert.equal(geometry.targetIntervals[0].endFrame, 20);
  assert.equal(auditCameraMotion({ camera }).passed, true);
  assert.equal(auditContainment({
    camera,
    pointerTrack: geometry.pointerTrack,
    targetIntervals: geometry.targetIntervals,
  }).passed, true);
});

test("automatic QA runs probe, full decode, cadence, proofs, hooks, hashes, and deterministic report", async () => {
  const calls = [];
  const mediaBytes = Buffer.concat([
    Buffer.from("0000ftyp0000moov0000mdat"),
    Buffer.alloc(4072),
  ]);
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "ffprobe" && args.includes("-show_entries") && args.some((value) => String(value).includes("stream=index"))) {
      return { stdout: JSON.stringify(probe), stderr: "", exitCode: 0 };
    }
    if (command === "ffprobe") {
      return {
        stdout: Array.from({ length: 100 }, (_, index) => `${index * 512},${(index / 25).toFixed(2)}`).join("\n"),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  let browserCalls = 0;
  let scannerCalls = 0;
  let scannerInput;
  const sensitiveScanner = typeof sensitiveScan.createTrustedSensitiveScanner === "function"
    ? sensitiveScan.createTrustedSensitiveScanner({
      scan: async (hookInput) => {
        scannerCalls += 1;
        scannerInput = hookInput;
        return [];
      },
    })
    : null;
  const input = {
    scenario: { schemaVersion: 1, id: "qa-story", title: "Safe story", story: { actions: [] } },
    artifacts: [{ path: "/stage/qa-story.mp4", expected }],
    camera: {
      fps: 25,
      durationMs: 4000,
      openingSettleMs: 400,
      endingSettleMs: 400,
      safeMargin: { top: 0.02, right: 0.02, bottom: 0.02, left: 0.02 },
      keyframes: [
        { tMs: 0, zoom: 1, x: 0.5, y: 0.5 },
        { tMs: 4000, zoom: 1, x: 0.5, y: 0.5 },
      ],
    },
    pointerTrack: [
      { frame: 0, x: 0.5, y: 0.5, glyphBounds: { left: 0.49, right: 0.52, top: 0.49, bottom: 0.53 } },
      { frame: 100, x: 0.5, y: 0.5, glyphBounds: { left: 0.49, right: 0.52, top: 0.49, bottom: 0.53 } },
    ],
    targetIntervals: [],
    runner,
    readFile: async () => mediaBytes,
    browserPlayback: async ({ artifacts }) => { browserCalls += 1; return { passed: artifacts.length === 1 }; },
    sensitiveScanner,
    captureEvidence: { visibleDomText: ["Safe story"], browserConsole: [] },
    runtimeEvidence: { logs: [] },
  };
  assert.equal(typeof sensitiveScanner, "function");
  const first = await runQualityAssurance(input);
  const second = await runQualityAssurance(input);

  assert.equal(first.passed, true);
  assert.deepEqual(first, second);
  assert.equal(first.artifacts[0].bytes, 4096);
  assert.match(first.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.artifacts[0].faststart.passed, true);
  assert.equal(browserCalls, 2);
  assert.equal(scannerCalls, 2);
  assert.deepEqual(scannerInput.captureEvidence, input.captureEvidence);
  assert.deepEqual(scannerInput.runtimeEvidence, input.runtimeEvidence);
  assert.equal(scannerInput.generatedProofEvidence[0].keyframes.length, 7);
  assert.match(scannerInput.generatedProofEvidence[0].contactSheet.sha256, /^[a-f0-9]{64}$/);
  assert.ok(calls.some((call) => call[0] === "ffmpeg" && call.includes("-f") && call.includes("null")));
  assert.ok(calls.some((call) => call[0] === "ffmpeg" && call.some((arg) => String(arg).includes("select="))));
  assert.ok(calls.some((call) => call[0] === "ffmpeg" && call.some((arg) => String(arg).includes("tile="))));
  assert.ok(calls.some((call) => call[0] === "ffprobe" && call.some((arg) => String(arg).includes("frame="))));
});

function settledCamera(durationMs = 4_000) {
  return {
    fps: 25,
    durationMs,
    openingSettleMs: 400,
    endingSettleMs: 400,
    safeMargin: { top: 0.02, right: 0.02, bottom: 0.02, left: 0.02 },
    keyframes: [
      { tMs: 0, zoom: 1, x: 0.5, y: 0.5 },
      { tMs: durationMs, zoom: 1, x: 0.5, y: 0.5 },
    ],
  };
}

test("QA validates MP4, WebM, and still WebP together while hashing real proof outputs", async () => {
  const mp4Path = "/stage/demo.mp4";
  const webmPath = "/stage/demo.webm";
  const posterPath = "/stage/demo.webp";
  const webmProbe = structuredClone(probe);
  webmProbe.streams[0].codec_name = "vp9";
  webmProbe.streams[0].nb_frames = "N/A";
  webmProbe.streams[0].nb_read_frames = "100";
  webmProbe.format.size = "2048";
  webmProbe.format.format_name = "matroska,webm";
  const posterProbe = {
    streams: [{
      index: 0,
      codec_name: "webp",
      codec_type: "video",
      width: 1920,
      height: 1200,
      pix_fmt: "yuv420p",
      r_frame_rate: "25/1",
      avg_frame_rate: "0/0",
      nb_frames: "N/A",
      nb_read_frames: "1",
    }],
    format: { duration: "N/A", size: "512", format_name: "webp_pipe" },
  };
  const probes = new Map([
    [mp4Path, probe],
    [webmPath, webmProbe],
    [posterPath, posterProbe],
  ]);
  const media = new Map([
    [mp4Path, Buffer.concat([Buffer.from("0000ftyp0000moov0000mdat"), Buffer.alloc(4072)])],
    [webmPath, Buffer.alloc(2048, 1)],
    [posterPath, Buffer.alloc(512, 2)],
  ]);
  const calls = [];
  const proofOutputs = new Set();
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    const inputPath = args.findLast((value) => probes.has(value));
    if (command === "ffprobe" && args.some((value) => String(value).includes("stream=index"))) {
      return { stdout: JSON.stringify(probes.get(inputPath)), stderr: "", exitCode: 0 };
    }
    if (command === "ffprobe") {
      return {
        stdout: Array.from({ length: 100 }, (_, index) => `${index * 512},${(index / 25).toFixed(2)}`).join("\n"),
        stderr: "",
        exitCode: 0,
      };
    }
    if (command === "ffmpeg" && args.includes("-n")) {
      const output = args.at(-1);
      if (proofOutputs.has(output)) {
        return { stdout: "", stderr: `refusing proof overwrite: ${output}`, exitCode: 1 };
      }
      proofOutputs.add(output);
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const report = await runQualityAssurance({
    scenario: { schemaVersion: 1, id: "three-deliveries", title: "Three deliveries", story: { actions: [] } },
    artifacts: [
      { path: mp4Path, expected },
      {
        path: webmPath,
        expected: { ...expected, kind: "webm", codec: "vp9", bytes: 2048, faststart: undefined },
      },
      {
        path: posterPath,
        expected: {
          kind: "poster",
          width: 1920,
          height: 1200,
          fps: null,
          durationMs: null,
          codec: "webp",
          audio: false,
          bytes: 512,
        },
      },
    ],
    camera: settledCamera(),
    runner,
    readFile: async (filePath) => {
      if (media.has(filePath)) return media.get(filePath);
      if (filePath.includes("/qa/") && filePath.endsWith(".png")) {
        return Buffer.from(`proof:${path.basename(filePath)}`);
      }
      throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
    },
    browserPlayback: async () => ({ passed: true }),
  });

  assert.deepEqual(report.artifacts.map(({ kind }) => kind), ["mp4", "webm", "poster"]);
  const [mp4Report, webmReport, posterReport] = report.artifacts;
  for (const videoReport of [mp4Report, webmReport]) {
    assert.equal(videoReport.proofs.keyframes.length, 7);
    assert.equal(videoReport.proofs.keyframes[0].frame, 0);
    assert.ok(videoReport.proofs.keyframes[0].bytes > 0);
    assert.match(videoReport.proofs.keyframes[0].sha256, /^[a-f0-9]{64}$/);
    assert.ok(videoReport.proofs.contactSheet.bytes > 0);
    assert.match(videoReport.proofs.contactSheet.sha256, /^[a-f0-9]{64}$/);
  }
  assert.notEqual(mp4Report.proofs.contactSheet.path, webmReport.proofs.contactSheet.path);
  assert.deepEqual(posterReport.probe, {
    width: 1920,
    height: 1200,
    fps: null,
    averageFps: null,
    durationMs: null,
    frameCount: null,
    codec: "webp",
    audioStreams: 0,
    pixelFormat: "yuv420p",
    bytes: 512,
  });
  assert.deepEqual(posterReport.cadence, { skipped: true, reason: "still-image" });
  assert.deepEqual(posterReport.fullDecode, { skipped: true, reason: "still-image" });
  assert.deepEqual(posterReport.proofs, { skipped: true, reason: "still-image" });
  assert.equal(calls.some((call) => call[0] === "ffmpeg" && call.includes(posterPath)), false);
});

test("QA rejects successful FFmpeg commands when a proof output is missing", async () => {
  const mediaPath = "/stage/missing-proof.mp4";
  const mediaBytes = Buffer.concat([
    Buffer.from("0000ftyp0000moov0000mdat"),
    Buffer.alloc(4072),
  ]);
  const runner = async (command, args) => {
    if (command === "ffprobe" && args.some((value) => String(value).includes("stream=index"))) {
      return { stdout: JSON.stringify(probe), stderr: "", exitCode: 0 };
    }
    if (command === "ffprobe") {
      return {
        stdout: Array.from({ length: 100 }, (_, index) => `${index * 512},${(index / 25).toFixed(2)}`).join("\n"),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  await assert.rejects(runQualityAssurance({
    scenario: { schemaVersion: 1, id: "missing-proof", title: "Missing proof", story: { actions: [] } },
    artifacts: [{ path: mediaPath, expected }],
    camera: settledCamera(),
    runner,
    readFile: async (filePath) => {
      if (filePath === mediaPath) return mediaBytes;
      throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
    },
    browserPlayback: async () => ({ passed: true }),
  }), /proof output.*missing/i);
});

test("QA rejects a scanner outside the trusted coverage builder", async () => {
  const mediaPath = "/stage/overclaimed.mp4";
  const mediaBytes = Buffer.concat([
    Buffer.from("0000ftyp0000moov0000mdat"),
    Buffer.alloc(4072),
  ]);
  const runner = async (command, args) => {
    if (command === "ffprobe" && args.some((value) => String(value).includes("stream=index"))) {
      return { stdout: JSON.stringify(probe), stderr: "", exitCode: 0 };
    }
    if (command === "ffprobe") {
      return {
        stdout: Array.from({ length: 100 }, (_, index) => `${index * 512},${(index / 25).toFixed(2)}`).join("\n"),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  let scannerInput;

  await assert.rejects(runQualityAssurance({
    scenario: { schemaVersion: 1, id: "overclaim", title: "Overclaim", story: { actions: [] } },
    artifacts: [{ path: mediaPath, expected }],
    camera: settledCamera(),
    runner,
    readFile: async (filePath) => {
      if (filePath === mediaPath) return mediaBytes;
      if (filePath.includes("/qa/") && filePath.endsWith(".png")) return Buffer.from(`proof:${path.basename(filePath)}`);
      throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
    },
    browserPlayback: async () => ({ passed: true }),
    sensitiveScanner: async (input) => {
      scannerInput = input;
      return {
        contract: "kandev-highlight-sensitive-scan-v1",
        passed: true,
        coverage: {
          metadata: true,
          visibleDomText: false,
          browserConsole: false,
          runtimeLogs: false,
          renderedPixelOcr: true,
        },
        findings: [],
      };
    },
  }), /trusted sensitive-scanner builder/i);

  assert.equal(scannerInput, undefined);
});
