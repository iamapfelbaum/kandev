import assert from "node:assert/strict";
import test from "node:test";

import * as visual from "./pipeline-eval-visual.mjs";

const FRAME_COUNT = 121;
const EVAL_ROOT = "/external/eval";
const LOG_ROOT = "/external/logs";
const CODECS = Object.freeze({ mp4: "h264", webm: "vp9", poster: "webp" });

function digest(character) {
  return character.repeat(64);
}

function stats(values, indices = values.map((_, index) => index + 1)) {
  return values
    .map(
      (value, index) =>
        `n:${indices[index]} Y:${value} U:${value} V:${value} All:${value} (99.000000)`,
    )
    .join("\n");
}

function media(kind, run, frameCount = FRAME_COUNT) {
  const still = kind === "poster";
  const extension = still ? "webp" : kind;
  return {
    kind,
    path: `/external/run-${run}/desktop.${extension}`,
    bytes: 10_000 + run,
    sha256: digest(String(run)),
    probe: {
      codec: CODECS[kind],
      width: 1920,
      height: 1200,
      fps: still ? null : 25,
      durationMs: still ? null : 4_840,
      frameCount: still ? 1 : frameCount,
      audioStreams: 0,
      pixelFormat: "yuv420p",
      bytes: 10_000 + run,
    },
    proofs: still
      ? { skipped: true, reason: "still-image" }
      : {
          keyframes: [
            {
              frame: 0,
              path: `/external/run-${run}/${kind}-frame.png`,
              bytes: 500 + run,
              sha256: digest(String(run + 2)),
            },
          ],
          contactSheet: {
            path: `/external/run-${run}/${kind}-sheet.png`,
            bytes: 700 + run,
            sha256: digest(String(run + 4)),
          },
        },
  };
}

function runEvidence(run) {
  return {
    rawMaster: {
      path: `/external/run-${run}/quick-start.source.mp4`,
      bytes: 1_000_000 + run,
      sha256: digest(String(run + 6)),
      width: 3840,
      height: 2400,
      fps: 25,
      storyStartFrame: 1,
      storyEndFrame: 122,
      storyFrameCount: FRAME_COUNT,
    },
    selectedFrames: [
      {
        storyTimeMs: 300,
        path: `/external/run-${run}/opening.png`,
        bytes: 2_000 + run,
        sha256: digest(String(run + 1)),
      },
      {
        storyTimeMs: 4_470,
        path: `/external/run-${run}/ending.png`,
        bytes: 2_100 + run,
        sha256: digest(String(run + 2)),
      },
    ],
    media: [media("mp4", run), media("webm", run), media("poster", run)],
  };
}

function passingOutputs() {
  const boundedStream = [
    ...Array.from({ length: FRAME_COUNT - 4 }, () => 1),
    0.994,
    0.994,
    0.994,
    0.994,
  ];
  return {
    "visual-raw": stats(boundedStream),
    "visual-mp4": stats(boundedStream),
    "visual-webm": stats(boundedStream),
    "visual-selected-1": stats([0.999995]),
    "visual-selected-2": stats([1]),
    "visual-poster": stats([0.9995]),
  };
}

function fakeRunner(outputs, calls = []) {
  return async (input) => {
    calls.push(input);
    return { stdout: outputs[input.phase] ?? "", stderr: "", exitCode: 0 };
  };
}

test("visual comparator accepts bounded decoded variance and reports exact inputs", async () => {
  assert.equal(typeof visual.compareRunVisuals, "function", "compareRunVisuals must be exported");
  const calls = [];
  const comparison = await visual.compareRunVisuals({
    first: runEvidence(1),
    second: runEvidence(2),
    runner: fakeRunner(passingOutputs(), calls),
    cwd: EVAL_ROOT,
    logRoot: LOG_ROOT,
    env: { PATH: "/usr/bin" },
  });

  assert.equal(comparison.contract, "kandev-highlight-visual-determinism-v1");
  assert.equal(comparison.version, 1);
  assert.equal(comparison.passed, true);
  assert.match(comparison.resultDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(comparison.comparisons.length, 6);
  assert.equal(comparison.comparisons[0].frameCount, FRAME_COUNT);
  assert.equal(comparison.comparisons[0].framesBelowThreshold, 4);
  assert.ok(comparison.comparisons[0].stats.bytes > 0);
  assert.match(comparison.comparisons[0].stats.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(comparison.comparisons[0].inputs.first, {
    bytes: 1_000_001,
    sha256: digest("7"),
  });
  assert.deepEqual(comparison.comparisons[0].inputs.second, {
    bytes: 1_000_002,
    sha256: digest("8"),
  });
  assert.equal(calls.length, 6);
  assert.ok(calls.every((call) => call.command === "ffmpeg"));
  assert.match(calls[0].args.join(" "), /trim=start_frame=1:end_frame=122/);
  assert.match(calls[0].args.join(" "), /ssim=stats_file=-/);
  assert.doesNotMatch(calls[0].args.join(" "), /stats_file=\/external/);
});

test("visual comparator rejects sustained drift and invalid SSIM evidence", async (t) => {
  assert.equal(typeof visual.compareRunVisuals, "function");
  const cases = [
    {
      name: "too many low frames",
      output: stats([
        ...Array.from({ length: FRAME_COUNT - 5 }, () => 1),
        0.994,
        0.994,
        0.994,
        0.994,
        0.994,
      ]),
      message: /frames below 0\.995.*5.*maximum 4/i,
    },
    {
      name: "low mean",
      output: stats(Array.from({ length: FRAME_COUNT }, () => 0.998)),
      message: /mean SSIM.*0\.998.*minimum 0\.999/i,
    },
    {
      name: "mean just below threshold cannot round up",
      output: stats(Array.from({ length: FRAME_COUNT }, () => 0.9989999996)),
      message: /mean SSIM.*minimum 0\.999/i,
    },
    {
      name: "low minimum",
      output: stats([0.98, ...Array.from({ length: FRAME_COUNT - 1 }, () => 1)]),
      message: /minimum SSIM.*0\.98.*minimum 0\.985/i,
    },
    {
      name: "truncated stats",
      output: stats(Array.from({ length: FRAME_COUNT - 1 }, () => 1)),
      message: /121 sequential SSIM frames.*received 120/i,
    },
    {
      name: "duplicate sequence",
      output: stats(
        Array.from({ length: FRAME_COUNT }, () => 1),
        Array.from({ length: FRAME_COUNT }, (_, index) => (index === 2 ? 2 : index + 1)),
      ),
      message: /SSIM frame sequence.*expected 3.*received 2/i,
    },
    {
      name: "nonfinite score",
      output: [
        "n:1 Y:1 U:1 V:1 All:nan (nan)",
        ...Array.from(
          { length: FRAME_COUNT - 1 },
          (_, index) => `n:${index + 2} Y:1 U:1 V:1 All:1 (inf)`,
        ),
      ].join("\n"),
      message: /SSIM frame 1.*finite.*0.*1/i,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const outputs = passingOutputs();
      outputs["visual-raw"] = item.output;
      await assert.rejects(
        visual.compareRunVisuals({
          first: runEvidence(1),
          second: runEvidence(2),
          runner: fakeRunner(outputs),
          cwd: EVAL_ROOT,
          logRoot: LOG_ROOT,
          env: {},
        }),
        item.message,
      );
    });
  }
});

test("visual comparator rejects pair metadata drift before FFmpeg", async (t) => {
  assert.equal(typeof visual.compareRunVisuals, "function");
  const cases = [
    {
      name: "dimensions",
      mutate(second) {
        second.rawMaster.width = 3839;
      },
      message: /raw.*dimensions.*match/i,
    },
    {
      name: "frame count",
      mutate(second) {
        second.rawMaster.storyEndFrame = 121;
        second.rawMaster.storyFrameCount = 120;
      },
      message: /raw.*frame count.*match/i,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const second = runEvidence(2);
      item.mutate(second);
      const calls = [];
      await assert.rejects(
        visual.compareRunVisuals({
          first: runEvidence(1),
          second,
          runner: fakeRunner(passingOutputs(), calls),
          cwd: EVAL_ROOT,
          logRoot: LOG_ROOT,
          env: {},
        }),
        item.message,
      );
      assert.equal(calls.length, 0);
    });
  }
});

test("visual comparator propagates FFmpeg failure", async () => {
  assert.equal(typeof visual.compareRunVisuals, "function");
  await assert.rejects(
    visual.compareRunVisuals({
      first: runEvidence(1),
      second: runEvidence(2),
      runner: async () => {
        throw new Error("ffmpeg visual comparison failed");
      },
      cwd: EVAL_ROOT,
      logRoot: LOG_ROOT,
      env: {},
    }),
    /ffmpeg visual comparison failed/i,
  );
});

test("visual comparator parses and hashes the same exact SSIM stdout bytes", async () => {
  await assert.rejects(
    visual.compareRunVisuals({
      first: runEvidence(1),
      second: runEvidence(2),
      runner: async (input) => ({
        stdout: passingOutputs()[input.phase],
        stdoutBytes: Buffer.from("not SSIM evidence\n"),
      }),
      cwd: EVAL_ROOT,
      logRoot: LOG_ROOT,
      env: {},
    }),
    /needs 121 sequential SSIM frames; received 0/i,
  );
});
