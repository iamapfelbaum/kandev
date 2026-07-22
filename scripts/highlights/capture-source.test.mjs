import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { resolveCaptureProfile } from "./camera-compiler.mjs";
import { chromiumNetworkIsolationPolicy } from "./capture-runtime.mjs";
import {
  assertCleanCaptureProgress,
  assertStableCaptureBuildVerification,
  buildEncoderProbePlan,
  buildFfmpegCapturePlan,
  captureScenario,
  chooseReadyCaptureEncoder,
  closeCaptureBrowserWithIsolation,
  collectCaptureReceipt,
  configureCaptureTarget,
  createTrustedCaptureBuildVerifier,
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

function chromiumNetworkPlan(executable) {
  const policy = chromiumNetworkIsolationPolicy();
  return {
    policy,
    command: {
      name: "chromium",
      command: executable,
      args: [
        `--disable-features=${policy.disabledFeatures.join(",")}`,
        ...policy.switches,
      ],
      env: {},
      logPath: "/tmp/chromium.log",
    },
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestValue(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

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

function trustedBuildVerifier(
  proof,
  {
    manifestPath = "/tmp/highlight-build-provenance.json",
    repositoryRoot = "/tmp/highlight-repository",
    onVerify,
  } = {},
) {
  return createTrustedCaptureBuildVerifier({
    manifestPath,
    repositoryRoot,
    verify: async (...args) => {
      onVerify?.(...args);
      return structuredClone(proof);
    },
  });
}

function applicationRuntimeProof({
  port = 18_080,
  tempRoot = "/tmp/kandev-highlight-app-runtime",
  sourceSha = "1".repeat(40),
  sourceMode = "pr_head",
} = {}) {
  return {
    contract: "kandev-highlight-application-runtime-pre-teardown-v1",
    version: 1,
    runtimeId: "kandev-isolated-e2e",
    origin: `http://127.0.0.1:${port}`,
    ports: { backend: port, frontend: port },
    isolation: {
      fixtureTempRoot: tempRoot,
      homeRoot: path.join(tempRoot, ".kandev"),
      databasePath: path.join(tempRoot, "kandev.db"),
      worktreeRoot: path.join(tempRoot, "worktrees"),
      repositoryCloneRoot: path.join(tempRoot, "repos"),
    },
    providerRouting: {
      profile: "e2e",
      mockAgent: true,
      mockProviders: true,
      liveCredentialsPresent: false,
      environmentSanitized: true,
    },
    source: {
      contract: "kandev-highlight-source-v1",
      mode: sourceMode,
      selectedSha: sourceSha,
    },
    build: {
      contract: "kandev-highlight-build-provenance-v1",
      manifestDigest: `sha256:${"d".repeat(64)}`,
      sourceSha,
      outputs: {
        backend: `sha256:${"e".repeat(64)}`,
        mockAgent: `sha256:${"f".repeat(64)}`,
        webDist: `sha256:${"0".repeat(64)}`,
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
    const inputQueueIndex = plan.args.indexOf("-thread_queue_size");
    assert.notEqual(inputQueueIndex, -1, "X11 capture needs a bounded input queue");
    assert.deepEqual(plan.args.slice(inputQueueIndex, inputQueueIndex + 3), [
      "-thread_queue_size",
      "16",
      "-i",
    ]);
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
    assert.match(joined, /-stats_period 0\.040/);
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

test("encoder readiness plan amortizes cold startup while proving sustained full-source throughput", () => {
  const profile = resolveCaptureProfile(DESKTOP_SCENARIO_PROFILE);
  const plan = buildEncoderProbePlan({
    encoder: { name: "libx264", source: "portable-fallback" },
    profile,
    ffmpegExecutable: "/usr/bin/ffmpeg",
  });
  const joined = plan.args.join(" ");

  assert.match(joined, /testsrc2=.*3840x2400.*25/);
  assert.doesNotMatch(joined, /color=c=black/);
  assert.match(joined, /-frames:v 75/);
  assert.match(joined, /-qp 0/);
  assert.equal(plan.sourceDurationMs, 3_000);
  assert.equal(plan.startupAllowanceMs, 750);
  assert.equal(plan.maximumElapsedMs, 3_750);
});

test("story frame alignment uses FFmpeg media samples instead of recorder wall time", async () => {
  const { assertCaptureFrameAlignment } = await import("./capture-source.mjs");
  const aligned = assertCaptureFrameAlignment({
    fps: 25,
    storyDurationMs: 2_440,
    storyStart: { frameCount: 3, mediaTimeMs: 80 },
    storyEnd: { frameCount: 64, mediaTimeMs: 2_520 },
  });

  assert.equal(aligned.contract, "kandev-highlight-media-frame-alignment-v1");
  assert.equal(aligned.expectedStoryFrames, 61);
  assert.equal(aligned.observedStoryFrames, 61);
  assert.equal(aligned.observedMediaDurationMs, 2_440);
  assert.equal(aligned.frameDelta, 0);
  assert.throws(
    () =>
      assertCaptureFrameAlignment({
        fps: 25,
        storyDurationMs: 2_440,
        storyStart: { frameCount: 3, mediaTimeMs: 80 },
        storyEnd: { frameCount: 72, mediaTimeMs: 2_520 },
      }),
    /media frame alignment.*expected 61.*observed 69/i,
  );
  assert.throws(
    () =>
      assertCaptureFrameAlignment({
        fps: 25,
        storyDurationMs: 2_440,
        storyStart: { frameCount: 3, mediaTimeMs: 80 },
        storyEnd: { frameCount: 64, mediaTimeMs: 3_000 },
      }),
    /media clock alignment.*expected 2440ms.*observed 2920ms/i,
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
      "out_time_us=3000000",
      "dup_frames=0",
      "drop_frames=0",
      "progress=end",
    ].join("\n"),
  );
  assert.deepEqual(clean, {
    frameCount: 75,
    fps: 25,
    mediaTimeMs: 3_000,
    duplicateFrames: 0,
    droppedFrames: 0,
    progress: "end",
  });
  assert.deepEqual(
    assertCleanCaptureProgress(clean, { expectedMinimumFrames: 60 }),
    clean,
  );
  assert.deepEqual(
    parseCaptureProgress(
      [
        "frame=75",
        "fps=25.0",
        "out_time_us=3000000",
        "dup_frames=0",
        "drop_frames=0",
        "progress=continue",
        "frame=99",
      ].join("\n"),
    ),
    { ...clean, progress: "continue" },
    "an in-progress partial FFmpeg block cannot mix a new frame with an old media clock",
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
      expectedMobile
        ? { enabled: true, maxTouchPoints: 1 }
        : { enabled: false },
    ]);
    assert.deepEqual(measured, {
      cssWidth: profile.cssWidth,
      cssHeight: profile.cssHeight,
      dpr: profile.dpr,
      sourceWidth: profile.sourceWidth,
      sourceHeight: profile.sourceHeight,
      nativeMobile: expectedMobile,
    });
    if (expectedMobile) {
      assert.deepEqual(
        {
          cssSurface: [measured.cssWidth, measured.cssHeight],
          dpr: measured.dpr,
          captureSurface: [measured.sourceWidth, measured.sourceHeight],
          mobile: calls[0][1].mobile,
          touchEnabled: calls[1][1].enabled,
          maxTouchPoints: calls[1][1].maxTouchPoints,
        },
        {
          cssSurface: [430, 932],
          dpr: 3,
          captureSurface: [1_290, 2_796],
          mobile: true,
          touchEnabled: true,
          maxTouchPoints: 1,
        },
      );
    }
  }
});

test("native-mobile passive choreography is overlay-only and activation uses CDP touch", async () => {
  const calls = [];
  const overlay = [];
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
  assert.deepEqual(
    adapters.ledger.map(
      ({ sequence, authority, operation, type, coordinates, touchPoints }) => ({
        sequence,
        authority,
        operation,
        type,
        coordinates,
        touchPoints,
      }),
    ),
    [
      {
        sequence: 1,
        authority: "host-cdp",
        operation: "activation-start",
        type: "touchStart",
        coordinates: { x: 120, y: 240 },
        touchPoints: [
          { x: 120, y: 240, radiusX: 8, radiusY: 8, force: 1, id: 1 },
        ],
      },
      {
        sequence: 2,
        authority: "host-cdp",
        operation: "activation-end",
        type: "touchEnd",
        coordinates: { x: 120, y: 240 },
        touchPoints: [],
      },
    ],
  );
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
  assert.deepEqual(
    adapters.ledger.map(({ sequence, operation, type, coordinates }) => ({
      sequence,
      operation,
      type,
      coordinates,
    })),
    [
      {
        sequence: 1,
        operation: "gesture-start",
        type: "touchStart",
        coordinates: { x: 10, y: 20 },
      },
      {
        sequence: 2,
        operation: "gesture-move",
        type: "touchMove",
        coordinates: { x: 30, y: 40 },
      },
      {
        sequence: 3,
        operation: "gesture-end",
        type: "touchEnd",
        coordinates: { x: 30, y: 40 },
      },
    ],
  );
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
  assert.deepEqual(
    adapters.ledger.map(
      ({
        sequence,
        authority,
        operation,
        type,
        coordinates,
        button,
        clickCount,
      }) => ({
        sequence,
        authority,
        operation,
        type,
        coordinates,
        button,
        clickCount,
      }),
    ),
    [
      {
        sequence: 1,
        authority: "host-cdp",
        operation: "activation-start",
        type: "mousePressed",
        coordinates: { x: 10, y: 20 },
        button: "right",
        clickCount: 2,
      },
      {
        sequence: 2,
        authority: "host-cdp",
        operation: "activation-end",
        type: "mouseReleased",
        coordinates: { x: 10, y: 20 },
        button: "right",
        clickCount: 2,
      },
    ],
  );
});

test("overlay labels main-world browser-event records as observational only", async (t) => {
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
    delete globalThis.__kandevHighlightObservedInputLedger;
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
    globalThis.__kandevHighlightObservedInputLedger.map(
      ({
        sequence,
        authority,
        observationalOnly,
        eventType,
        x,
        y,
        inputKind,
      }) => ({
        sequence,
        authority,
        observationalOnly,
        eventType,
        x,
        y,
        inputKind,
      }),
    ),
    [
      {
        sequence: 1,
        authority: "dom-observation",
        observationalOnly: true,
        eventType: "pointermove",
        x: 31,
        y: 47,
        inputKind: "desktop",
      },
      {
        sequence: 2,
        authority: "dom-observation",
        observationalOnly: true,
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

function navigationHarness(initialUrl = "about:blank") {
  let current = initialUrl;
  const page = new EventEmitter();
  const context = new EventEmitter();
  const pages = [page];
  const frame = { url: () => current };
  page.url = () => current;
  page.mainFrame = () => frame;
  page.goto = async (url, options) => {
    current = `${url}/`;
    page.emit("framenavigated", frame);
    return options;
  };
  context.pages = () => [...pages];
  const isolationEvidence = {
    contract: "kandev-highlight-origin-isolation-v1",
    version: 1,
    allowedOrigin: "http://127.0.0.1:18080",
    controls: {
      httpRoute: true,
      webSocketRoute: true,
      popupGuard: true,
      subframeGuard: true,
      serviceWorkerBypass: true,
      serviceWorkerRegistrationBlocked: true,
      directTransportConstructorsBlocked: true,
    },
    traffic: {
      httpAllowed: 1,
      httpBlocked: 0,
      webSocketAllowed: 0,
      webSocketBlocked: 0,
    },
    violations: [],
  };
  return {
    page,
    context,
    frame,
    pages,
    originIsolation: {
      assertClean() {
        return isolationEvidence;
      },
      snapshot() {
        return isolationEvidence;
      },
    },
    setUrl(url) {
      current = url;
      page.emit("framenavigated", frame);
    },
  };
}

test("origin guard records the complete primary-page lifecycle", async () => {
  const { bindCaptureNavigation } = await import("./capture-source.mjs");
  const calls = [];
  const harness = navigationHarness();
  const originalGoto = harness.page.goto;
  harness.page.goto = async (url, options) => {
    calls.push([url, options]);
    return originalGoto(url, options);
  };
  const noRoute = bindCaptureNavigation({
    page: harness.page,
    context: harness.context,
    frontendUrl: "http://127.0.0.1:18080",
    originIsolation: harness.originIsolation,
  });
  await noRoute.navigateDefault();
  noRoute.checkpoint("story start");
  noRoute.checkpoint("story end");
  assert.deepEqual(calls, [
    ["http://127.0.0.1:18080", { waitUntil: "domcontentloaded" }],
  ]);
  const evidence = noRoute.evidence();
  assert.equal(evidence.contract, "kandev-highlight-navigation-evidence-v1");
  assert.equal(evidence.finalOrigin, "http://127.0.0.1:18080");
  assert.deepEqual(
    evidence.checkpoints.map((checkpoint) => checkpoint.label),
    ["default navigation", "story start", "story end", "record boundary"],
  );
  assert.equal(evidence.events.length, 1);
  assert.deepEqual(evidence.violations, []);
  assert.deepEqual(evidence.isolation, harness.originIsolation.snapshot());
});

test("origin guard fails closed on popups and cross-origin top-level navigation", async () => {
  const { bindCaptureNavigation } = await import("./capture-source.mjs");
  const popupHarness = navigationHarness("http://127.0.0.1:18080/board");
  const popupGuard = bindCaptureNavigation({
    page: popupHarness.page,
    context: popupHarness.context,
    frontendUrl: "http://127.0.0.1:18080",
    originIsolation: popupHarness.originIsolation,
  });
  const popup = new EventEmitter();
  popup.url = () => "about:blank";
  popup.mainFrame = () => ({ url: () => popup.url() });
  popupHarness.pages.push(popup);
  popupHarness.context.emit("page", popup);
  assert.throws(
    () => popupGuard.checkpoint("step 0"),
    /extra top-level page.*step 0/i,
  );
  const popupEvidence = popupGuard.snapshot();
  assert.equal(popupEvidence.violations[0].kind, "extra-top-level-page");
  assert.equal(
    popupEvidence.events.some(
      (event) => event.kind === "top-level-page-opened",
    ),
    true,
  );

  const routeHarness = navigationHarness("http://127.0.0.1:18080/board");
  const routed = bindCaptureNavigation({
    page: routeHarness.page,
    context: routeHarness.context,
    frontendUrl: "http://127.0.0.1:18080",
    originIsolation: routeHarness.originIsolation,
    navigateRoute: async () => {
      routeHarness.setUrl("https://attacker.invalid/phish");
    },
  });
  await assert.rejects(
    () => routed.navigateRoute("workspace.board", { page: routeHarness.page }),
    /allowed frontend origin/i,
  );
});

test("browser teardown rejects a request attempted during close while isolation stays installed", async () => {
  const events = [];
  const violations = [];
  const navigation = {
    evidence() {
      events.push("navigation:evidence");
      return { isolation: { violations: [] } };
    },
    dispose() {
      events.push("navigation:dispose");
    },
  };
  const originIsolation = {
    assertClean(label) {
      events.push(`origin:check:${label}`);
      if (violations.length > 0) {
        throw new Error("close-time cross-origin-request");
      }
      return { violations: [] };
    },
    dispose() {
      events.push("origin:dispose");
    },
  };

  await assert.rejects(
    () =>
      closeCaptureBrowserWithIsolation({
        browserConnection: {
          async close() {
            events.push("browser:close");
            violations.push("cross-origin-request");
          },
        },
        navigation,
        originIsolation,
      }),
    /close-time cross-origin-request/i,
  );
  assert.deepEqual(events, [
    "navigation:evidence",
    "browser:close",
    "origin:check:browser teardown",
  ]);
});

test("build verification rejects any story-end output identity change", () => {
  const before = {
    contract: "kandev-highlight-build-boundary-v1",
    manifestDigest: `sha256:${"a".repeat(64)}`,
    sourceSha: "1".repeat(40),
    outputs: {
      backend: `sha256:${"b".repeat(64)}`,
      mockAgent: `sha256:${"c".repeat(64)}`,
      webDist: `sha256:${"d".repeat(64)}`,
    },
  };
  assert.deepEqual(
    assertStableCaptureBuildVerification({
      beforeStory: before,
      afterStory: before,
    }),
    {
      contract: "kandev-highlight-build-verification-v1",
      stable: true,
      beforeStory: before,
      afterStory: before,
    },
  );
  assert.throws(
    () =>
      assertStableCaptureBuildVerification({
        beforeStory: before,
        afterStory: {
          ...before,
          outputs: { ...before.outputs, webDist: `sha256:${"e".repeat(64)}` },
        },
      }),
    /build outputs changed during recorded story.*webDist/i,
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
    storyMedia: {
      start: { frameCount: 3, mediaTimeMs: 80 },
      end: { frameCount: 78, mediaTimeMs: 3_080 },
    },
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
  assert.equal(receipt.storyOffsetMs, 80);
  assert.equal(receipt.storyStartOffsetMs, 80);
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
  const network = chromiumNetworkPlan("/opt/chromium");
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
    coordinateLockRoot: path.join(root, "worker-tmp"),
    coordinateLockIdentity: null,
    coordinateLockPath: path.join(
      root,
      "worker-tmp",
      "kandev-highlight-261-49261.lock",
    ),
    chromiumNetworkPolicy: network.policy,
    chromium: network.command,
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
    source: "current_main",
    selectedSha: "1".repeat(40),
    headSha: "1".repeat(40),
    currentMainSha: "1".repeat(40),
    clean: true,
    status: "",
  };
  const buildProof = buildProvenance(sourceProof);
  const appRuntime = applicationRuntimeProof({
    tempRoot: path.join(root, "fixture-temp"),
    sourceSha: sourceProof.selectedSha,
    sourceMode: sourceProof.source,
  });
  const buildVerifications = [];
  const buildVerifier = trustedBuildVerifier(buildProof, {
    manifestPath: path.join(root, "build-provenance.json"),
    repositoryRoot: path.join(root, "repo"),
    onVerify: (...args) => buildVerifications.push(args),
  });
  const chromiumSandbox = {
    contract: "kandev-highlight-chromium-sandbox-policy-v1",
    version: 1,
    mode: "disabled",
    proof: { status: "unavailable", reason: "AppArmor restriction" },
    authorization: {
      contract: "kandev-highlight-disabled-sandbox-authorization-v1",
      sourceMode: "current_main",
      sourceSha: sourceProof.selectedSha,
      allowedOrigin: "http://127.0.0.1:18080",
      guardContract: "kandev-highlight-origin-isolation-v1",
    },
  };
  const originIsolationEvidence = {
    contract: "kandev-highlight-origin-isolation-v1",
    version: 1,
    allowedOrigin: "http://127.0.0.1:18080",
    controls: {
      httpRoute: true,
      webSocketRoute: true,
      popupGuard: true,
      subframeGuard: true,
      serviceWorkerBypass: true,
      serviceWorkerRegistrationBlocked: true,
      directTransportConstructorsBlocked: true,
    },
    traffic: {
      httpAllowed: 3,
      httpBlocked: 0,
      webSocketAllowed: 1,
      webSocketBlocked: 0,
    },
    violations: [],
  };
  let plannedRuntimeOptions;
  let currentUrl = "about:blank";
  const page = new EventEmitter();
  const context = new EventEmitter();
  const mainFrame = { url: () => currentUrl };
  page.url = () => currentUrl;
  page.mainFrame = () => mainFrame;
  page.goto = async (url) => {
    currentUrl = url;
    page.emit("framenavigated", mainFrame);
    events.push(`goto:${url}`);
  };
  context.pages = () => [page];

  const result = await captureScenario({
    scenario,
    timeline,
    source: sourceProof,
    buildProvenance: buildProof,
    applicationRuntime: appRuntime,
    collectCaptureEvidence: async () => {
      events.push("capture:evidence");
      return {
        contract: "kandev-highlight-capture-content-v1",
        version: 1,
        bounds: {
          maxVisibleDomTextRecords: 512,
          maxVisibleDomTextBytes: 65_536,
          maxBrowserConsoleRecords: 128,
          maxBrowserConsoleTextBytes: 2_048,
        },
        visibleDomText: ["Quick start", "Review API"],
        browserConsole: [
          {
            type: "info",
            text: "board ready",
            digest: digestValue(
              canonicalJson({ type: "info", text: "board ready" }),
            ),
          },
        ],
        truncated: { visibleDomText: false, browserConsole: false },
      };
    },
    sourceDigest: `sha256:${"a".repeat(64)}`,
    frontendUrl: "http://127.0.0.1:18080",
    buildVerifier,
    artifactRoot,
    repositoryRoots: [path.join(root, "repo")],
    runId: "r01",
    displayNumber: 261,
    cdpPort: 49_261,
    coordinateLockRoot: path.join(root, "worker-tmp"),
    chromiumSandbox,
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
      planCaptureRuntime: (options) => {
        plannedRuntimeOptions = options;
        return { ...plan, chromiumSandbox: options.chromiumSandbox };
      },
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
        context,
        page,
        cdp: {},
        async close() {
          events.push("browser:close");
        },
      }),
      installCaptureOriginIsolation: async ({ allowedOrigin }) => {
        assert.equal(allowedOrigin, "http://127.0.0.1:18080");
        events.push("origin:install");
        return {
          assertClean(label) {
            if (label === "browser teardown") {
              events.push("origin:check:browser teardown");
            }
            return originIsolationEvidence;
          },
          snapshot() {
            return originIsolationEvidence;
          },
          dispose() {
            events.push("origin:dispose");
          },
        };
      },
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
          "frame=30\nfps=25\nout_time_us=1200000\ndup_frames=0\ndrop_frames=0\nprogress=end\n",
        );
        const samples = [
          { frameCount: 3, mediaTimeMs: 80 },
          { frameCount: 28, mediaTimeMs: 1_080 },
        ];
        return {
          captureEpochMs: 1_000,
          async sample() {
            return samples.shift();
          },
          async stop() {
            events.push("recorder:stop");
            return { exitCode: 0, signal: null, processGone: true };
          },
        };
      },
      executePreparedScenario: async ({
        onRecordingStart,
        onStep,
        onRecordingEnd,
      }) => {
        events.push("scenario:execute");
        await onRecordingStart();
        await onStep(execution.steps[0]);
        await onRecordingEnd(execution);
        return execution;
      },
    },
  });

  assert.deepEqual(events, [
    "runtime:start",
    "origin:install",
    "target:configure",
    "overlay:install",
    "route:workspace.board",
    "scenario:prepare",
    "target:configure",
    "recorder:start:libx264",
    "scenario:execute",
    "recorder:stop",
    "capture:evidence",
    "browser:close",
    "origin:check:browser teardown",
    "origin:dispose",
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
  assert.equal(
    result.receipt.navigation.contract,
    "kandev-highlight-navigation-evidence-v1",
  );
  assert.equal(
    result.receipt.navigation.finalUrl,
    "http://127.0.0.1:18080/board",
  );
  assert.deepEqual(result.receipt.navigation.violations, []);
  assert.deepEqual(
    result.receipt.navigation.isolation,
    originIsolationEvidence,
  );
  assert.deepEqual(
    result.receipt.navigation.checkpoints.map(({ label }) => label),
    [
      "route 'workspace.board'",
      "prepare complete",
      "story start",
      "step 0",
      "story end",
      "record boundary",
    ],
  );
  assert.deepEqual(result.receipt.trustedInputLedger, []);
  assert.deepEqual(result.receipt.capture.frameAlignment, {
    contract: "kandev-highlight-media-frame-alignment-v1",
    expectedStoryFrames: 25,
    observedStoryFrames: 25,
    expectedStoryDurationMs: 1_000,
    observedMediaDurationMs: 1_000,
    frameDelta: 0,
    mediaDurationDeltaMs: 0,
    toleranceFrames: 1,
  });
  assert.equal(result.receipt.storyStartOffsetMs, 80);
  assert.deepEqual(result.receipt.storyMedia, {
    start: { frameCount: 3, mediaTimeMs: 80 },
    end: { frameCount: 28, mediaTimeMs: 1_080 },
  });
  assert.equal(buildVerifications.length, 2);
  assert.equal(result.receipt.buildVerification.stable, true);
  assert.equal(result.receipt.runtime.teardown.processesGone, true);
  assert.equal(result.receipt.runtime.teardown.coordinatesReleased, true);
  assert.deepEqual(plannedRuntimeOptions.chromiumSandbox, chromiumSandbox);
  assert.equal(
    plannedRuntimeOptions.coordinateLockRoot,
    path.join(root, "worker-tmp"),
  );
  assert.deepEqual(
    result.receipt.runtime.allocation.chromiumSandbox,
    chromiumSandbox,
  );
  assert.deepEqual(result.receipt.runtime.teardown.recorder, {
    exitCode: 0,
    signal: null,
    processGone: true,
  });
  assert.deepEqual(result.receipt.seed, seedProof);
  assert.deepEqual(result.receipt.applicationRuntime, appRuntime);
  assert.equal(
    result.receipt.captureEvidence.path,
    path.join(paths.evidenceDir, "capture-content.json"),
  );
  assert.match(result.receipt.captureEvidence.digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.receipt.captureEvidence.visibleDomText, {
    records: 2,
    bytes: Buffer.byteLength("Quick startReview API"),
    digest: result.receipt.captureEvidence.visibleDomText.digest,
    truncated: false,
  });
  assert.equal(result.receipt.captureEvidence.browserConsole.records, 1);
  assert.doesNotMatch(
    JSON.stringify(result.receipt.captureEvidence),
    /Quick start|Review API|board ready/,
  );
  const rawCaptureEvidence = JSON.parse(
    await fs.readFile(result.receipt.captureEvidence.path, "utf8"),
  );
  assert.deepEqual(rawCaptureEvidence.visibleDomText, [
    "Quick start",
    "Review API",
  ]);
  assert.equal(rawCaptureEvidence.browserConsole[0].text, "board ready");
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
  const network = chromiumNetworkPlan("/opt/chromium");
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
    coordinateLockIdentity: null,
    chromiumNetworkPolicy: network.policy,
    chromium: network.command,
  };
  let currentUrl = "about:blank";
  const page = new EventEmitter();
  const context = new EventEmitter();
  const mainFrame = { url: () => currentUrl };
  page.url = () => currentUrl;
  page.mainFrame = () => mainFrame;
  page.goto = async (url) => {
    currentUrl = url;
    page.emit("framenavigated", mainFrame);
  };
  context.pages = () => [page];
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
        buildVerifier: trustedBuildVerifier(buildProvenance(cleanupSource), {
          manifestPath: path.join(root, "cleanup-build.json"),
          repositoryRoot: path.join(root, "repo"),
        }),
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
            context,
            cdp: {},
            async close() {
              cleanupOrder.push("browser");
              throw new Error("browser cleanup failed");
            },
          }),
          installCaptureOriginIsolation: async () => ({
            assertClean() {},
            snapshot() {
              return {
                contract: "kandev-highlight-origin-isolation-v1",
                version: 1,
                allowedOrigin: "http://127.0.0.1:18080",
                controls: {
                  httpRoute: true,
                  webSocketRoute: true,
                  popupGuard: true,
                  subframeGuard: true,
                  serviceWorkerBypass: true,
                  serviceWorkerRegistrationBlocked: true,
                  directTransportConstructorsBlocked: true,
                },
                traffic: {
                  httpAllowed: 0,
                  httpBlocked: 0,
                  webSocketAllowed: 0,
                  webSocketBlocked: 0,
                },
                violations: [],
              };
            },
            dispose() {
              cleanupOrder.push("origin-isolation");
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
            async sample() {
              return { frameCount: 1, mediaTimeMs: 40 };
            },
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
  await assert.rejects(
    () =>
      captureScenario({
        ...common,
        navigateRoute: async () => {},
        sourceDigest: `sha256:${"c".repeat(64)}`,
        applicationRuntime: {
          ...applicationRuntimeProof(),
          providerRouting: {
            ...applicationRuntimeProof().providerRouting,
            liveCredentialsPresent: true,
          },
        },
      }),
    /applicationRuntime.*live credentials|provider routing/i,
  );
  await assert.rejects(
    () =>
      captureScenario({
        ...common,
        navigateRoute: async () => {},
        sourceDigest: `sha256:${"c".repeat(64)}`,
        buildVerifier: {
          contract: "kandev-highlight-trusted-build-verifier-v1",
        },
      }),
    /opaque trusted build verifier/i,
  );
});
