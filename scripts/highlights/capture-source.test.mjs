import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { resolveCaptureProfile } from "./camera-compiler.mjs";
import {
  assertCleanCaptureProgress,
  buildEncoderProbePlan,
  buildFfmpegCapturePlan,
  captureScenario,
  chooseReadyCaptureEncoder,
  collectCaptureReceipt,
  configureCaptureTarget,
  createTrustedInputAdapters,
  measureTargetGlyph,
  parseCaptureProgress,
  playwrightChromiumFromModule,
  selectCaptureEncoder,
  startFfmpegRecorder,
  writeCaptureEvidence,
} from "./capture-source.mjs";
import { compileTimeline, computeScenarioDigest } from "./scenario.mjs";

const DESKTOP_SCENARIO_PROFILE = Object.freeze({
  kind: "desktop",
  viewport: { width: 1920, height: 1200 },
  deviceScaleFactor: 2,
});

const MOBILE_SCENARIO_PROFILE = Object.freeze({
  kind: "native-mobile",
  viewport: { width: 430, height: 932 },
  deviceScaleFactor: 3,
});

function buildProvenance(source) {
  return {
    contract: "kandev-highlight-build-provenance-v1",
    manifestDigest: `sha256:${"d".repeat(64)}`,
    source,
    outputs: {
      backend: { digest: `sha256:${"e".repeat(64)}`, bytes: 101 },
      mockAgent: { digest: `sha256:${"f".repeat(64)}`, bytes: 102 },
      webDist: {
        digest: `sha256:${"0".repeat(64)}`,
        bytes: 103,
        fileCount: 4,
      },
    },
  };
}

function runtime(profile, root = "/external/highlight-run") {
  return {
    display: ":261.0",
    artifactRoot: root,
    rawMasterPath: path.join(root, "raw", "quick-start.source.mp4"),
    progressPath: path.join(root, "logs", "ffmpeg.progress"),
    ffmpegLogPath: path.join(root, "logs", "ffmpeg.log"),
    evidenceDir: path.join(root, "evidence"),
    profile,
  };
}

test("builds silent no-overwrite 25fps native X11 capture commands", () => {
  for (const scenarioProfile of [
    DESKTOP_SCENARIO_PROFILE,
    MOBILE_SCENARIO_PROFILE,
  ]) {
    const profile = resolveCaptureProfile(scenarioProfile);
    const plan = buildFfmpegCapturePlan({
      runtime: runtime(profile),
      profile,
      encoder: { name: "libx264", source: "portable-fallback" },
    });
    const joined = plan.args.join(" ");

    assert.equal(plan.command, "ffmpeg");
    assert.match(joined, /-f x11grab/);
    assert.match(joined, /-draw_mouse 0/);
    assert.match(joined, /-framerate 25/);
    assert.match(
      joined,
      new RegExp(`-video_size ${profile.sourceWidth}x${profile.sourceHeight}`),
    );
    assert.match(joined, /-i :261\.0\+0,0/);
    assert.match(joined, /-an/);
    assert.match(joined, /-c:v libx264/);
    assert.match(joined, /-qp 0/);
    assert.match(joined, /-profile:v high444/);
    assert.match(joined, /-pix_fmt yuv444p/);
    assert.match(
      joined,
      /-progress \/external\/highlight-run\/logs\/ffmpeg\.progress/,
    );
    assert.equal(plan.master.lossless, true);
    assert.equal(plan.master.pixelFormat, "yuv444p");
    assert.equal(plan.master.profile, "high444");
    assert.ok(
      !plan.args.includes("-nostdin"),
      "recorder must accept q on stdin for clean finalization",
    );
    assert.ok(plan.args.includes("-n"));
    assert.ok(!plan.args.includes("-y"));
    assert.equal(plan.args.at(-1), runtime(profile).rawMasterPath);
  }
});

test("hardware master uses accepted lossless high-444 contract", () => {
  const profile = resolveCaptureProfile(DESKTOP_SCENARIO_PROFILE);
  const plan = buildFfmpegCapturePlan({
    runtime: runtime(profile),
    profile,
    encoder: { name: "h264_nvenc", source: "ffmpeg-encoder-probe" },
  });
  const joined = plan.args.join(" ");

  assert.match(joined, /-preset losslesshp/);
  assert.match(joined, /-tune lossless/);
  assert.match(joined, /-rc constqp/);
  assert.match(joined, /-qp 0/);
  assert.match(joined, /-profile:v high444p/);
  assert.match(joined, /-rgb_mode yuv444/);
  assert.equal(plan.master.lossless, true);
  assert.equal(plan.master.pixelFormat, "yuv444p");
  assert.equal(plan.master.profile, "high444p");
});

test("resolves Chromium from native ESM or Playwright CommonJS default interop", () => {
  const direct = {
    executablePath() {
      return "/direct/chrome";
    },
  };
  const commonJs = {
    executablePath() {
      return "/default/chrome";
    },
  };

  assert.equal(playwrightChromiumFromModule({ chromium: direct }), direct);
  assert.equal(
    playwrightChromiumFromModule({ default: { chromium: commonJs } }),
    commonJs,
  );
  assert.throws(
    () => playwrightChromiumFromModule({ default: {} }),
    /does not export chromium/,
  );
});

test("encoder readiness plan proves sustained full-source throughput before story", () => {
  const profile = resolveCaptureProfile(DESKTOP_SCENARIO_PROFILE);
  const plan = buildEncoderProbePlan({
    encoder: { name: "libx264", source: "portable-fallback" },
    profile,
    ffmpegExecutable: "/usr/bin/ffmpeg",
  });
  const joined = plan.args.join(" ");

  assert.match(joined, /testsrc2=.*3840x2400.*25/);
  assert.doesNotMatch(joined, /color=c=black/);
  assert.match(joined, /-frames:v 25/);
  assert.match(joined, /-qp 0/);
  assert.equal(plan.sourceDurationMs, 1_000);
  assert.equal(plan.maximumElapsedMs, 1_500);
});

test("raw frame count aligns with recorder lead plus planned story within one frame", async () => {
  const { assertCaptureFrameAlignment } = await import("./capture-source.mjs");
  const aligned = assertCaptureFrameAlignment({
    frameCount: 63,
    fps: 25,
    storyStartOffsetMs: 80,
    storyDurationMs: 2_440,
  });

  assert.equal(aligned.expectedFrameCount, 63);
  assert.equal(aligned.frameDelta, 0);
  assert.throws(
    () =>
      assertCaptureFrameAlignment({
        frameCount: 71,
        fps: 25,
        storyStartOffsetMs: 80,
        storyDurationMs: 2_440,
      }),
    /frame alignment.*expected 63.*got 71/i,
  );
});

test("prefers advertised hardware encoder and falls back portably", () => {
  assert.deepEqual(
    selectCaptureEncoder(
      " V..... h264_nvenc NVIDIA NVENC\n V..... libx264 H.264 ",
    ),
    {
      name: "h264_nvenc",
      source: "ffmpeg-encoder-probe",
    },
  );
  assert.deepEqual(selectCaptureEncoder(" V..... libx264 H.264 "), {
    name: "libx264",
    source: "portable-fallback",
  });
  assert.throws(
    () => selectCaptureEncoder(" V..... vp9 "),
    /requires h264_nvenc or portable libx264/,
  );
});

test("proves hardware usability before capture and selects portable fallback before story starts", async () => {
  const probes = [];
  const result = await chooseReadyCaptureEncoder({
    encodersOutput: " V..... h264_nvenc NVIDIA NVENC\n V..... libx264 H.264 ",
    profile: resolveCaptureProfile(DESKTOP_SCENARIO_PROFILE),
    probeEncoder: async (encoder) => {
      probes.push(encoder.name);
      if (encoder.name === "h264_nvenc") throw new Error("no NVIDIA device");
      return { elapsedMs: 81, command: ["ffmpeg", "probe", encoder.name] };
    },
  });

  assert.deepEqual(probes, ["h264_nvenc", "libx264"]);
  assert.deepEqual(result.encoder, {
    name: "libx264",
    source: "portable-fallback",
  });
  assert.equal(result.attempts[0].ready, false);
  assert.match(result.attempts[0].error, /no NVIDIA device/);
  assert.equal(result.attempts[1].ready, true);
});

test("parses final ffmpeg progress and rejects drops, duplicates, and incomplete output", () => {
  const clean = parseCaptureProgress(
    [
      "frame=75",
      "fps=25.0",
      "dup_frames=0",
      "drop_frames=0",
      "progress=end",
    ].join("\n"),
  );
  assert.deepEqual(clean, {
    frameCount: 75,
    fps: 25,
    duplicateFrames: 0,
    droppedFrames: 0,
    progress: "end",
  });
  assert.deepEqual(
    assertCleanCaptureProgress(clean, { expectedMinimumFrames: 60 }),
    clean,
  );

  assert.throws(
    () => assertCleanCaptureProgress({ ...clean, duplicateFrames: 1 }),
    /duplicate frames: 1/,
  );
  assert.throws(
    () => assertCleanCaptureProgress({ ...clean, droppedFrames: 2 }),
    /dropped frames: 2/,
  );
  assert.throws(
    () => assertCleanCaptureProgress({ ...clean, progress: "continue" }),
    /did not report progress=end/,
  );
  assert.throws(
    () =>
      assertCleanCaptureProgress(
        { ...clean, frameCount: 59 },
        { expectedMinimumFrames: 60 },
      ),
    /encoded 59 frames; expected at least 60/,
  );
});

test("configures exact desktop and native-mobile CDP metrics without crop", async () => {
  for (const [scenarioProfile, expectedMobile] of [
    [DESKTOP_SCENARIO_PROFILE, false],
    [MOBILE_SCENARIO_PROFILE, true],
  ]) {
    const profile = resolveCaptureProfile(scenarioProfile);
    const calls = [];
    const cdp = {
      async send(method, params) {
        calls.push([method, params]);
      },
    };
    const page = {
      async evaluate() {
        return {
          innerWidth: profile.cssWidth,
          innerHeight: profile.cssHeight,
          devicePixelRatio: profile.dpr,
        };
      },
    };

    const measured = await configureCaptureTarget({ page, cdp, profile });

    assert.deepEqual(calls[0], [
      "Emulation.setDeviceMetricsOverride",
      {
        width: profile.cssWidth,
        height: profile.cssHeight,
        deviceScaleFactor: profile.dpr,
        mobile: expectedMobile,
        screenWidth: profile.cssWidth,
        screenHeight: profile.cssHeight,
        positionX: 0,
        positionY: 0,
        dontSetVisibleSize: false,
      },
    ]);
    assert.deepEqual(calls[1], [
      "Emulation.setTouchEmulationEnabled",
      {
        enabled: expectedMobile,
        maxTouchPoints: expectedMobile ? 1 : 0,
      },
    ]);
    assert.deepEqual(measured, {
      cssWidth: profile.cssWidth,
      cssHeight: profile.cssHeight,
      dpr: profile.dpr,
      sourceWidth: profile.sourceWidth,
      sourceHeight: profile.sourceHeight,
      nativeMobile: expectedMobile,
    });
  }
});

test("native-mobile passive choreography is overlay-only and activation uses CDP touch", async () => {
  const calls = [];
  const overlay = [];
  const order = [];
  const cdp = {
    async send(method, params) {
      calls.push([method, params]);
    },
  };
  const page = {
    async evaluate(_fn, value) {
      overlay.push(value);
    },
  };
  const adapters = createTrustedInputAdapters({
    page,
    cdp,
    inputKind: "native-mobile",
    trustedEventBarrier: {
      async arm(expected) {
        order.push(`arm:${expected.eventTypes.join("|")}`);
        return async () => {
          order.push("observed");
          return {
            sequence: order.length,
            eventType: expected.eventTypes[0],
            ...expected,
            isTrusted: true,
          };
        };
      },
    },
  });

  await adapters.trustedCursor({
    x: 120,
    y: 240,
    phase: "travel",
    label: "create task",
  });
  await adapters.trustedActivation({
    x: 120,
    y: 240,
    inputKind: "native-mobile",
    clickCount: 1,
  });

  assert.deepEqual(calls, [
    [
      "Input.dispatchTouchEvent",
      {
        type: "touchStart",
        touchPoints: [
          { x: 120, y: 240, radiusX: 8, radiusY: 8, force: 1, id: 1 },
        ],
      },
    ],
    ["Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }],
  ]);
  assert.equal(
    overlay.length,
    1,
    "only passive finger choreography mutates overlay directly",
  );
  assert.deepEqual(
    overlay.map((entry) => entry.kind),
    ["cursor"],
  );
  assert.deepEqual(order, [
    "arm:touchstart",
    "observed",
    "arm:touchend",
    "observed",
  ]);
  assert.equal(adapters.ledger.length, 2);
});

test("native-mobile drag gesture emits trusted touch start, move, and end", async () => {
  const calls = [];
  const cdp = {
    async send(method, params) {
      calls.push([method, params]);
    },
  };
  const page = { async evaluate() {} };
  const adapters = createTrustedInputAdapters({
    page,
    cdp,
    inputKind: "native-mobile",
    trustedEventBarrier: {
      async arm(expected) {
        return async () => ({
          sequence: calls.length,
          eventType: expected.eventTypes[0],
          ...expected,
          isTrusted: true,
        });
      },
    },
  });

  await adapters.trustedGesture.start({ x: 10, y: 20 });
  await adapters.trustedGesture.move({ x: 30, y: 40 });
  await adapters.trustedGesture.end({ x: 30, y: 40 });

  assert.deepEqual(
    calls.map((entry) => entry[1].type),
    ["touchStart", "touchMove", "touchEnd"],
  );
  assert.deepEqual(calls[1][1].touchPoints, [
    { x: 30, y: 40, radiusX: 8, radiusY: 8, force: 1, id: 1 },
  ]);
  assert.deepEqual(calls[2][1].touchPoints, []);
});

test("desktop activation remains trusted CDP mouse input", async () => {
  const calls = [];
  const cdp = {
    async send(method, params) {
      calls.push([method, params]);
    },
  };
  const page = { async evaluate() {} };
  const adapters = createTrustedInputAdapters({
    page,
    cdp,
    inputKind: "desktop",
    trustedEventBarrier: {
      async arm(expected) {
        return async () => ({
          sequence: calls.length,
          eventType: expected.eventTypes[0],
          ...expected,
          isTrusted: true,
        });
      },
    },
  });

  await adapters.trustedActivation({
    x: 10,
    y: 20,
    button: "right",
    clickCount: 2,
  });

  assert.deepEqual(calls, [
    [
      "Input.dispatchMouseEvent",
      {
        type: "mousePressed",
        x: 10,
        y: 20,
        button: "right",
        buttons: 2,
        clickCount: 2,
      },
    ],
    [
      "Input.dispatchMouseEvent",
      {
        type: "mouseReleased",
        x: 10,
        y: 20,
        button: "right",
        buttons: 0,
        clickCount: 2,
      },
    ],
  ]);
  assert.equal(adapters.ledger.length, 2);
});

test("overlay applies trusted browser events atomically and records an exact ledger", async (t) => {
  const { overlayBootstrap } = await import("./capture-source.mjs");
  const listeners = new Map();
  const overlay = {
    style: {},
    setAttribute() {},
  };
  const documentFixture = {
    getElementById: () => overlay,
    createElement: () => overlay,
    documentElement: { append() {} },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
  const previousDocument = globalThis.document;
  globalThis.document = documentFixture;
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    delete globalThis.__kandevHighlightOverlay;
    delete globalThis.__kandevHighlightInputLedger;
    delete globalThis.__kandevHighlightInputListenersInstalled;
  });

  overlayBootstrap();
  listeners.get("pointermove")({
    isTrusted: true,
    pointerType: "mouse",
    clientX: 31,
    clientY: 47,
    buttons: 0,
    type: "pointermove",
  });
  listeners.get("touchstart")({
    isTrusted: true,
    touches: [{ clientX: 80, clientY: 90 }],
    changedTouches: [],
    type: "touchstart",
  });
  listeners.get("pointermove")({
    isTrusted: false,
    pointerType: "mouse",
    clientX: 999,
    clientY: 999,
    buttons: 0,
    type: "pointermove",
  });

  assert.deepEqual(
    globalThis.__kandevHighlightInputLedger.map(
      ({ sequence, eventType, x, y, inputKind }) => ({
        sequence,
        eventType,
        x,
        y,
        inputKind,
      }),
    ),
    [
      {
        sequence: 1,
        eventType: "pointermove",
        x: 31,
        y: 47,
        inputKind: "desktop",
      },
      {
        sequence: 2,
        eventType: "touchstart",
        x: 80,
        y: 90,
        inputKind: "native-mobile",
      },
    ],
  );
  assert.equal(overlay.style.left, "80px");
  assert.equal(overlay.style.top, "90px");
});

test("target glyph measurement unions every visible icon and text rect clipped to target", async (t) => {
  const previousDocument = globalThis.document;
  const previousNodeFilter = globalThis.NodeFilter;
  const textNodes = [{ textContent: "Create" }, { textContent: " task" }];
  let selectedText;
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.document = {
    createTreeWalker() {
      let index = -1;
      return {
        currentNode: null,
        nextNode() {
          index += 1;
          this.currentNode = textNodes[index];
          return index < textNodes.length;
        },
      };
    },
    createRange() {
      return {
        selectNodeContents(node) {
          selectedText = node;
        },
        getClientRects() {
          return selectedText === textNodes[0]
            ? [
                {
                  x: 40,
                  y: 20,
                  left: 40,
                  top: 20,
                  right: 88,
                  bottom: 38,
                  width: 48,
                  height: 18,
                },
              ]
            : [
                {
                  x: 88,
                  y: 20,
                  left: 88,
                  top: 20,
                  right: 128,
                  bottom: 38,
                  width: 40,
                  height: 18,
                },
              ];
        },
      };
    },
  };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousNodeFilter === undefined) delete globalThis.NodeFilter;
    else globalThis.NodeFilter = previousNodeFilter;
  });
  const icon = {
    checkVisibility: () => true,
    getBoundingClientRect: () => ({
      x: 18,
      y: 18,
      left: 18,
      top: 18,
      right: 34,
      bottom: 34,
      width: 16,
      height: 16,
    }),
  };
  const root = {
    matches: () => false,
    querySelectorAll: () => [icon],
    checkVisibility: () => true,
    getBoundingClientRect: () => ({
      x: 10,
      y: 10,
      left: 10,
      top: 10,
      right: 130,
      bottom: 50,
      width: 120,
      height: 40,
    }),
  };
  const measured = await measureTargetGlyph({
    evaluate: async (callback) => callback(root),
  });

  assert.deepEqual(measured, { x: 18, y: 18, width: 110, height: 20 });
});

test("origin-bound navigation defaults to frontend and rejects cross-origin routes", async () => {
  const { bindCaptureNavigation } = await import("./capture-source.mjs");
  let current = "about:blank";
  const calls = [];
  const page = {
    url: () => current,
    async goto(url, options) {
      calls.push([url, options]);
      current = `${url}/`;
    },
  };
  const noRoute = bindCaptureNavigation({
    page,
    frontendUrl: "http://127.0.0.1:18080",
  });
  await noRoute.navigateDefault();
  assert.deepEqual(calls, [
    ["http://127.0.0.1:18080", { waitUntil: "domcontentloaded" }],
  ]);
  assert.equal(noRoute.evidence().finalOrigin, "http://127.0.0.1:18080");

  const routed = bindCaptureNavigation({
    page,
    frontendUrl: "http://127.0.0.1:18080",
    navigateRoute: async () => {
      current = "https://attacker.invalid/phish";
    },
  });
  await assert.rejects(
    () => routed.navigateRoute("workspace.board", { page }),
    /allowed frontend origin/i,
  );
});

test("receipt records exact command, tool identities, source geometry, epochs, hashes, and frames", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "highlight-source-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = resolveCaptureProfile(DESKTOP_SCENARIO_PROFILE);
  const paths = runtime(profile, root);
  await fs.mkdir(path.dirname(paths.rawMasterPath), { recursive: true });
  await fs.writeFile(paths.rawMasterPath, "deterministic raw fixture");
  const command = buildFfmpegCapturePlan({
    runtime: paths,
    profile,
    encoder: { name: "libx264", source: "portable-fallback" },
  });

  const receipt = await collectCaptureReceipt({
    scenarioDigest: "sha256:scenario",
    sourceDigest: `sha256:${"a".repeat(64)}`,
    captureEpochMs: 10_000,
    storyEpochMs: 10_240,
    storyDurationMs: 3_000,
    command,
    profile,
    rawMasterPath: paths.rawMasterPath,
    progress: {
      frameCount: 81,
      fps: 25,
      duplicateFrames: 0,
      droppedFrames: 0,
      progress: "end",
    },
    tools: {
      ffmpeg: {
        version: "ffmpeg 7.1",
        executable: "/usr/bin/ffmpeg",
        digest: "sha256:ffmpeg",
      },
      chromium: {
        version: "Chromium 140",
        executable: "/opt/chromium",
        digest: "sha256:chromium",
      },
      xvfb: {
        version: "Xvfb 21",
        executable: "/usr/bin/Xvfb",
        digest: "sha256:xvfb",
      },
    },
  });

  assert.equal(receipt.contract, "kandev-highlight-source-capture-v1");
  assert.equal(receipt.storyOffsetMs, 240);
  assert.equal(receipt.storyStartOffsetMs, 240);
  assert.equal(receipt.capture.frameCount, 81);
  assert.equal(receipt.capture.width, 3840);
  assert.equal(receipt.capture.height, 2400);
  assert.equal(receipt.capture.fps, 25);
  assert.equal(receipt.capture.audio, false);
  assert.equal(receipt.rawMaster.bytes, 25);
  assert.match(receipt.rawMaster.digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(receipt.command, {
    executable: "ffmpeg",
    args: command.args,
  });
  assert.deepEqual(receipt.tools.chromium, {
    version: "Chromium 140",
    executable: "/opt/chromium",
    digest: "sha256:chromium",
  });
});

test("capture evidence uses immutable creation and refuses overwrite", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "highlight-evidence-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "evidence", "capture.json");
  const evidence = {
    contract: "kandev-highlight-source-capture-v1",
    rawMaster: { digest: "sha256:x" },
  };

  await writeCaptureEvidence(destination, evidence);
  assert.deepEqual(
    JSON.parse(await fs.readFile(destination, "utf8")),
    evidence,
  );
  await assert.rejects(
    () => writeCaptureEvidence(destination, evidence),
    /refusing to overwrite capture evidence/,
  );
});

test("recorder startup failure SIGKILL is awaited and cleanup failure aggregates", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "highlight-recorder-start-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.pid = 7_551;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => signals.push(signal);
  const signals = [];
  const waits = [];
  const command = {
    command: "/fixture/ffmpeg",
    args: [],
    output: path.join(root, "raw.mp4"),
    progressPath: path.join(root, "progress"),
    logPath: path.join(root, "ffmpeg.log"),
  };

  await assert.rejects(
    () =>
      startFfmpegRecorder({
        command,
        spawnProcess: () => {
          queueMicrotask(() => child.emit("spawn"));
          return child;
        },
        waitForProgress: async () => {
          throw new Error("first frame proof failed");
        },
        waitForChildExit: async (_child, timeoutMs) => {
          waits.push(timeoutMs);
          return false;
        },
      }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.deepEqual(
        error.errors.map((entry) => entry.message),
        ["first frame proof failed", "ffmpeg process 7551 survived SIGKILL"],
      );
      return true;
    },
  );
  assert.deepEqual(signals, ["SIGKILL"]);
  assert.deepEqual(waits, [2_000]);
});

test("captureScenario owns preparation, recording, execution, teardown, and immutable manifest", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "highlight-driver-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, "capture-r01");
  const profile = resolveCaptureProfile(DESKTOP_SCENARIO_PROFILE);
  const scenario = {
    schemaVersion: 1,
    id: "quick-start",
    title: "Quick start",
    profile: DESKTOP_SCENARIO_PROFILE,
    seed: { recipe: "kandev.highlight.quick-start", parameters: {} },
    setup: { route: "workspace.board", primitives: [] },
    story: {
      recipe: "kandev.short-feature",
      openingSettleMs: 400,
      actions: [{ kind: "pause", durationMs: 200, label: "show board" }],
      endingSettleMs: 400,
    },
  };
  const timeline = compileTimeline(scenario);
  const paths = runtime(profile, artifactRoot);
  const events = [];
  const plan = {
    ...paths,
    contract: "kandev-highlight-capture-runtime-v1",
    scenarioId: scenario.id,
    runId: "r01",
    displayNumber: 261,
    cdpPort: 49_261,
    cdpEndpoint: "http://127.0.0.1:49261",
    profileDir: path.join(artifactRoot, "runtime", "browser-profile"),
    lockPath: path.join(artifactRoot, "runtime", "capture.lock"),
  };
  const tools = {
    ffmpeg: {
      version: "ffmpeg 7.1",
      executable: "/usr/bin/ffmpeg",
      digest: "sha256:ffmpeg",
    },
    chromium: {
      version: "Chromium 140",
      executable: "/opt/chromium",
      digest: "sha256:chromium",
    },
    xvfb: {
      version: "Xvfb 21",
      executable: "/usr/bin/Xvfb",
      digest: "sha256:xvfb",
    },
  };
  const execution = {
    contract: "kandev-highlight-execution-v1",
    scenarioId: scenario.id,
    storyEpochMs: 1_240,
    storyDurationMs: timeline.totalDurationMs,
    timelineDigest: timeline.scenarioDigest,
    steps: [
      {
        index: 0,
        pointer: "/story/actions/0",
        kind: "pause",
        startedAtMs: 400,
        endedAtMs: 600,
      },
    ],
    cursorEvidence: [],
  };
  const seedProof = {
    seedId: "task-seed-1",
    seedDigest: `sha256:${"b".repeat(64)}`,
    invariants: {
      title: "Declarative Highlight fixture",
      workflowStepId: "step-start",
      taskCount: 1,
    },
  };
  const sourceProof = {
    contract: "kandev-highlight-source-v1",
    source: "pr_head",
    selectedSha: "1".repeat(40),
    headSha: "1".repeat(40),
    currentMainSha: "2".repeat(40),
    clean: true,
    status: "",
  };
  const buildProof = buildProvenance(sourceProof);
  let currentUrl = "about:blank";
  const page = {
    url: () => currentUrl,
    async goto(url) {
      currentUrl = url;
      events.push(`goto:${url}`);
    },
  };

  const result = await captureScenario({
    scenario,
    timeline,
    source: sourceProof,
    buildProvenance: buildProof,
    sourceDigest: `sha256:${"a".repeat(64)}`,
    frontendUrl: "http://127.0.0.1:18080",
    artifactRoot,
    repositoryRoots: [path.join(root, "repo")],
    runId: "r01",
    displayNumber: 261,
    cdpPort: 49_261,
    navigateRoute: async (route) => {
      events.push(`route:${route}`);
      currentUrl = "http://127.0.0.1:18080/board";
    },
    seedRegistry: {
      "kandev.highlight.quick-start": async () => seedProof,
    },
    dependencies: {
      resolveCaptureTools: async () => tools,
      chooseReadyCaptureEncoder: async () => ({
        encoder: { name: "libx264", source: "portable-fallback" },
        attempts: [{ encoder: "libx264", ready: true, elapsedMs: 81 }],
      }),
      planCaptureRuntime: () => plan,
      startCaptureRuntime: async () => {
        await Promise.all([
          fs.mkdir(path.dirname(paths.rawMasterPath), { recursive: true }),
          fs.mkdir(paths.evidenceDir, { recursive: true }),
          fs.mkdir(path.dirname(paths.progressPath), { recursive: true }),
        ]);
        events.push("runtime:start");
        return {
          async stop() {
            events.push("runtime:stop");
            return { processesGone: true, coordinatesReleased: true };
          },
        };
      },
      connectCaptureBrowser: async () => ({
        browser: {},
        context: {},
        page,
        cdp: {},
        async close() {
          events.push("browser:close");
        },
      }),
      configureCaptureTarget: async () => {
        events.push("target:configure");
      },
      installCaptureOverlay: async () => {
        events.push("overlay:install");
      },
      createCaptureCursor: () => ({ movements: [], resyncs: [] }),
      prepareScenario: async ({ seedRegistry, navigateRoute }) => {
        await seedRegistry[scenario.seed.recipe]({
          page: {},
          parameters: {},
          scenario,
        });
        await navigateRoute(scenario.setup.route, { page: {} });
        events.push("scenario:prepare");
        return { contract: "prepared" };
      },
      startFfmpegRecorder: async ({ command }) => {
        events.push(`recorder:start:${command.encoder.name}`);
        await fs.writeFile(paths.rawMasterPath, "capture bytes");
        await fs.writeFile(
          paths.progressPath,
          "frame=30\nfps=25\ndup_frames=0\ndrop_frames=0\nprogress=end\n",
        );
        return {
          captureEpochMs: 1_000,
          async stop() {
            events.push("recorder:stop");
            return { exitCode: 0, signal: null, processGone: true };
          },
        };
      },
      executePreparedScenario: async () => {
        events.push("scenario:execute");
        return execution;
      },
    },
  });

  assert.deepEqual(events, [
    "runtime:start",
    "target:configure",
    "overlay:install",
    "route:workspace.board",
    "scenario:prepare",
    "target:configure",
    "recorder:start:libx264",
    "scenario:execute",
    "recorder:stop",
    "browser:close",
    "runtime:stop",
  ]);
  assert.equal(result.contract, "kandev-highlight-capture-result-v1");
  assert.equal(result.rawMasterPath, paths.rawMasterPath);
  assert.equal(
    result.captureManifestPath,
    path.join(paths.evidenceDir, "capture.json"),
  );
  assert.equal(result.receipt.scenarioDigest, computeScenarioDigest(scenario));
  assert.deepEqual(result.receipt.source, sourceProof);
  assert.deepEqual(result.receipt.build, {
    contract: buildProof.contract,
    manifestDigest: buildProof.manifestDigest,
    sourceSha: sourceProof.selectedSha,
    outputs: buildProof.outputs,
  });
  assert.deepEqual(result.receipt.navigation, {
    configuredUrl: "http://127.0.0.1:18080",
    allowedOrigin: "http://127.0.0.1:18080",
    finalUrl: "http://127.0.0.1:18080/board",
    finalOrigin: "http://127.0.0.1:18080",
  });
  assert.deepEqual(result.receipt.trustedInputLedger, []);
  assert.deepEqual(result.receipt.capture.frameAlignment, {
    expectedFrameCount: 31,
    frameDelta: -1,
    toleranceFrames: 1,
  });
  assert.equal(result.receipt.storyStartOffsetMs, 240);
  assert.equal(result.receipt.runtime.teardown.processesGone, true);
  assert.equal(result.receipt.runtime.teardown.coordinatesReleased, true);
  assert.deepEqual(result.receipt.runtime.teardown.recorder, {
    exitCode: 0,
    signal: null,
    processGone: true,
  });
  assert.deepEqual(result.receipt.seed, seedProof);
  assert.deepEqual(
    JSON.parse(await fs.readFile(result.captureManifestPath, "utf8")),
    result.receipt,
  );
});

test("capture failure aggregates every cleanup error and persists structured teardown evidence", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "highlight-cleanup-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, "capture-failure");
  const profile = resolveCaptureProfile(DESKTOP_SCENARIO_PROFILE);
  const paths = runtime(profile, artifactRoot);
  const scenario = {
    schemaVersion: 1,
    id: "cleanup-failure",
    title: "Cleanup failure",
    profile: DESKTOP_SCENARIO_PROFILE,
    seed: { recipe: "cleanup.seed", parameters: {} },
    setup: { route: "workspace.board", primitives: [] },
    story: {
      openingSettleMs: 400,
      actions: [{ kind: "pause", durationMs: 100 }],
      endingSettleMs: 400,
    },
  };
  const timeline = compileTimeline(scenario);
  const plan = {
    ...paths,
    contract: "kandev-highlight-capture-runtime-v1",
    scenarioId: scenario.id,
    runId: "cleanup-r01",
    displayNumber: 262,
    cdpPort: 49_262,
    cdpEndpoint: "http://127.0.0.1:49262",
    profileDir: path.join(artifactRoot, "runtime", "browser-profile"),
    lockPath: path.join(artifactRoot, "runtime", "capture.lock"),
  };
  let currentUrl = "about:blank";
  const page = {
    url: () => currentUrl,
    async goto(url) {
      currentUrl = url;
    },
  };
  const cleanupOrder = [];
  const cleanupSource = {
    contract: "kandev-highlight-source-v1",
    source: "pr_head",
    selectedSha: "1".repeat(40),
    headSha: "1".repeat(40),
    clean: true,
    status: "",
  };

  await assert.rejects(
    () =>
      captureScenario({
        scenario,
        timeline,
        source: cleanupSource,
        buildProvenance: buildProvenance(cleanupSource),
        sourceDigest: `sha256:${"a".repeat(64)}`,
        frontendUrl: "http://127.0.0.1:18080",
        artifactRoot,
        repositoryRoots: [path.join(root, "repo")],
        runId: "cleanup-r01",
        displayNumber: 262,
        cdpPort: 49_262,
        navigateRoute: async () => {
          currentUrl = "http://127.0.0.1:18080/board";
        },
        seedRegistry: {
          "cleanup.seed": async () => ({
            seedId: "cleanup.seed",
            seedDigest: `sha256:${"b".repeat(64)}`,
            invariants: {},
          }),
        },
        dependencies: {
          resolveCaptureTools: async () => ({
            ffmpeg: { executable: "/usr/bin/ffmpeg" },
            chromium: { executable: "/opt/chromium" },
            xvfb: { executable: "/usr/bin/Xvfb" },
          }),
          chooseReadyCaptureEncoder: async () => ({
            encoder: { name: "libx264", source: "portable-fallback" },
            attempts: [],
          }),
          planCaptureRuntime: () => plan,
          startCaptureRuntime: async () => {
            await Promise.all([
              fs.mkdir(path.dirname(paths.rawMasterPath), { recursive: true }),
              fs.mkdir(paths.evidenceDir, { recursive: true }),
              fs.mkdir(path.dirname(paths.progressPath), { recursive: true }),
            ]);
            return {
              async stop() {
                cleanupOrder.push("runtime");
                throw new Error("runtime cleanup failed");
              },
            };
          },
          connectCaptureBrowser: async () => ({
            page,
            context: {},
            cdp: {},
            async close() {
              cleanupOrder.push("browser");
              throw new Error("browser cleanup failed");
            },
          }),
          configureCaptureTarget: async () => {},
          installCaptureOverlay: async () => {},
          createCaptureCursor: () => ({ movements: [], resyncs: [] }),
          prepareScenario: async ({ seedRegistry, navigateRoute }) => {
            await seedRegistry[scenario.seed.recipe]({});
            await navigateRoute(scenario.setup.route, { page });
            return { contract: "prepared" };
          },
          startFfmpegRecorder: async () => ({
            captureEpochMs: 1_000,
            async stop() {
              cleanupOrder.push("recorder");
              throw new Error("recorder cleanup failed");
            },
          }),
          executePreparedScenario: async () => {
            throw new Error("story execution failed");
          },
        },
      }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(error.message, /execute.*cleanup/i);
      assert.deepEqual(
        error.errors.map((entry) => entry.message),
        [
          "story execution failed",
          "recorder cleanup failed",
          "browser cleanup failed",
          "runtime cleanup failed",
        ],
      );
      return true;
    },
  );

  assert.deepEqual(cleanupOrder, ["recorder", "browser", "runtime"]);
  const failure = JSON.parse(
    await fs.readFile(
      path.join(paths.evidenceDir, "capture.failure.json"),
      "utf8",
    ),
  );
  assert.equal(failure.phase, "execute");
  assert.equal(failure.teardown.complete, false);
  assert.deepEqual(
    failure.teardown.components.map(({ component, ok }) => ({ component, ok })),
    [
      { component: "recorder", ok: false },
      { component: "browser", ok: false },
      { component: "runtime", ok: false },
    ],
  );
});

test("captureScenario rejects non-exact digests and missing allowlisted navigation before tools launch", async () => {
  const scenario = {
    schemaVersion: 1,
    id: "navigation-gate",
    title: "Navigation gate",
    profile: DESKTOP_SCENARIO_PROFILE,
    seed: { recipe: "kandev.highlight.quick-start", parameters: {} },
    setup: { route: "workspace.board", primitives: [] },
    story: {
      openingSettleMs: 400,
      actions: [{ kind: "pause", durationMs: 100 }],
      endingSettleMs: 400,
    },
  };
  const common = {
    scenario,
    timeline: compileTimeline(scenario),
    source: {
      contract: "kandev-highlight-source-v1",
      source: "pr_head",
      selectedSha: "1".repeat(40),
      headSha: "1".repeat(40),
      clean: true,
      status: "",
    },
    frontendUrl: "http://127.0.0.1:18080",
    artifactRoot: "/external/navigation-gate",
    runId: "r01",
    displayNumber: 261,
    cdpPort: 49_261,
    dependencies: {
      resolveCaptureTools: async () => {
        throw new Error("tools must not launch");
      },
    },
  };
  common.buildProvenance = buildProvenance(common.source);

  await assert.rejects(
    () => captureScenario({ ...common, sourceDigest: "sha256:not-exact" }),
    /exact sourceDigest.*64 lowercase hex/i,
  );
  await assert.rejects(
    () =>
      captureScenario({ ...common, sourceDigest: `sha256:${"c".repeat(64)}` }),
    /requires an allowlisted navigateRoute adapter/,
  );
  await assert.rejects(
    () =>
      captureScenario({
        ...common,
        source: undefined,
        navigateRoute: async () => {},
        sourceDigest: `sha256:${"c".repeat(64)}`,
      }),
    /clean kandev-highlight-source-v1 source gate proof/i,
  );
  await assert.rejects(
    () =>
      captureScenario({
        ...common,
        navigateRoute: async () => {},
        sourceDigest: `sha256:${"c".repeat(64)}`,
        buildProvenance: {
          contract: "kandev-highlight-build-provenance-v1",
          manifestDigest: `sha256:${"d".repeat(64)}`,
          source: { selectedSha: "9".repeat(40) },
          outputs: {},
        },
      }),
    /build provenance.*exact selected source SHA/i,
  );
  await assert.rejects(
    () =>
      captureScenario({
        ...common,
        buildProvenance: undefined,
        navigateRoute: async () => {},
        sourceDigest: `sha256:${"c".repeat(64)}`,
      }),
    /needs exact build provenance/i,
  );
});
