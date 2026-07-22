import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  parseCaptureProgress,
  playwrightChromiumFromModule,
  selectCaptureEncoder,
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

  assert.match(joined, /color=c=black:s=3840x2400:r=25/);
  assert.match(joined, /-frames:v 25/);
  assert.match(joined, /-qp 0/);
  assert.equal(plan.sourceDurationMs, 1_000);
  assert.equal(plan.maximumElapsedMs, 1_500);
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
    3,
    "travel, touch-down, and touch-up each update visible overlay",
  );
  assert.deepEqual(
    overlay.map((entry) => entry.kind),
    ["cursor", "touch", "cursor"],
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

  const result = await captureScenario({
    scenario,
    timeline,
    sourceDigest: `sha256:${"a".repeat(64)}`,
    frontendUrl: "http://127.0.0.1:18080",
    artifactRoot,
    repositoryRoots: [path.join(root, "repo")],
    runId: "r01",
    displayNumber: 261,
    cdpPort: 49_261,
    navigateRoute: async (route) => {
      events.push(`route:${route}`);
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
        page: {},
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

  await assert.rejects(
    () => captureScenario({ ...common, sourceDigest: "sha256:not-exact" }),
    /exact sourceDigest.*64 lowercase hex/i,
  );
  await assert.rejects(
    () =>
      captureScenario({ ...common, sourceDigest: `sha256:${"c".repeat(64)}` }),
    /requires an allowlisted navigateRoute adapter/,
  );
});
