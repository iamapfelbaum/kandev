import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveCaptureProfile } from "./camera-compiler.mjs";
import {
  defaultChromiumSandboxPolicy,
  validateChromiumSandboxCaptureBoundary,
} from "./chromium-sandbox-contract.mjs";
import { installCaptureOriginIsolation } from "./capture-origin-isolation.mjs";
import { createCursorController } from "./cursor.mjs";
import {
  bindCaptureNavigation,
  createTrustedInputAdapters,
  installCaptureOverlay,
  measurePointerGlyph,
  measureTargetGlyph,
} from "./capture-browser.mjs";
import { executePreparedScenario, prepareScenario } from "./executor.mjs";
import {
  allocateRuntimeCoordinates,
  planCaptureRuntime,
  startCaptureRuntime,
} from "./capture-runtime.mjs";
import { compileTimeline, computeScenarioDigest } from "./scenario.mjs";

export {
  bindCaptureNavigation,
  createTrustedInputAdapters,
  installCaptureOverlay,
  measurePointerGlyph,
  measureTargetGlyph,
  overlayBootstrap,
} from "./capture-browser.mjs";
export { installCaptureOriginIsolation } from "./capture-origin-isolation.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, "../..");
const WEB_ROOT = path.join(REPOSITORY_ROOT, "apps", "web");
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const TRUSTED_CAPTURE_BUILD_VERIFIERS = new WeakMap();
const CAPTURE_CONTENT_BOUNDS = Object.freeze({
  maxVisibleDomTextRecords: 512,
  maxVisibleDomTextBytes: 65_536,
  maxBrowserConsoleRecords: 128,
  maxBrowserConsoleTextBytes: 2_048,
});

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

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireExactKeys(value, keys, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of keys) {
    if (!Object.hasOwn(value, key))
      throw new Error(`${label} ${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label} ${key} is not allowed`);
  }
  return value;
}

export function playwrightChromiumFromModule(playwrightModule) {
  const chromium =
    playwrightModule?.chromium ?? playwrightModule?.default?.chromium;
  if (!chromium) throw new Error("Playwright module does not export chromium");
  return chromium;
}

function encoderContract(encoder) {
  if (encoder.name === "h264_nvenc") {
    return {
      args: [
        "-c:v",
        "h264_nvenc",
        "-preset",
        "losslesshp",
        "-tune",
        "lossless",
        "-rc",
        "constqp",
        "-qp",
        "0",
        "-profile:v",
        "high444p",
        "-rgb_mode",
        "yuv444",
        "-pix_fmt",
        "yuv444p",
      ],
      master: { lossless: true, pixelFormat: "yuv444p", profile: "high444p" },
    };
  }
  if (encoder.name === "libx264") {
    return {
      args: [
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-qp",
        "0",
        "-profile:v",
        "high444",
        "-pix_fmt",
        "yuv444p",
      ],
      master: { lossless: true, pixelFormat: "yuv444p", profile: "high444" },
    };
  }
  throw new Error(`unsupported capture encoder: ${encoder.name}`);
}

export function buildFfmpegCapturePlan({
  runtime,
  profile,
  encoder,
  ffmpegExecutable = "ffmpeg",
} = {}) {
  if (!runtime?.display || !runtime?.rawMasterPath || !runtime?.progressPath) {
    throw new Error("ffmpeg capture needs a planned runtime");
  }
  const captureProfile = resolveCaptureProfile({
    kind: profile?.kind,
    viewport: { width: profile?.cssWidth, height: profile?.cssHeight },
    deviceScaleFactor: profile?.dpr,
  });
  const encoding = encoderContract(encoder);
  const args = [
    "-hide_banner",
    "-loglevel",
    "info",
    "-f",
    "x11grab",
    "-draw_mouse",
    "0",
    "-framerate",
    String(captureProfile.fps),
    "-video_size",
    `${captureProfile.sourceWidth}x${captureProfile.sourceHeight}`,
    "-i",
    `${runtime.display}+0,0`,
    "-an",
    ...encoding.args,
    "-movflags",
    "+faststart",
    "-stats_period",
    (1 / captureProfile.fps).toFixed(3),
    "-progress",
    runtime.progressPath,
    "-nostats",
    "-n",
    runtime.rawMasterPath,
  ];
  return {
    contract: "kandev-highlight-ffmpeg-capture-v1",
    command: ffmpegExecutable,
    args,
    encoder: { ...encoder },
    master: encoding.master,
    output: runtime.rawMasterPath,
    progressPath: runtime.progressPath,
    logPath: runtime.ffmpegLogPath,
  };
}

export function buildEncoderProbePlan({
  encoder,
  profile,
  ffmpegExecutable = "ffmpeg",
} = {}) {
  const encoding = encoderContract(encoder);
  const sourceDurationMs = 1_000;
  const frameCount = profile.fps;
  return {
    command: ffmpegExecutable,
    args: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${profile.sourceWidth}x${profile.sourceHeight}:rate=${profile.fps}`,
      "-frames:v",
      String(frameCount),
      "-an",
      ...encoding.args,
      "-f",
      "null",
      "-",
    ],
    encoder: { ...encoder },
    master: encoding.master,
    sourceDurationMs,
    maximumElapsedMs: 1_500,
  };
}

export function selectCaptureEncoder(encodersOutput) {
  if (typeof encodersOutput !== "string")
    throw new Error("ffmpeg encoder probe output is required");
  if (/\bh264_nvenc\b/.test(encodersOutput))
    return { name: "h264_nvenc", source: "ffmpeg-encoder-probe" };
  if (/\blibx264\b/.test(encodersOutput))
    return { name: "libx264", source: "portable-fallback" };
  throw new Error("Highlight capture requires h264_nvenc or portable libx264");
}

export async function chooseReadyCaptureEncoder({
  encodersOutput,
  profile,
  probeEncoder,
} = {}) {
  if (typeof probeEncoder !== "function")
    throw new Error("probeEncoder must verify encoder capability");
  const advertised = selectCaptureEncoder(encodersOutput);
  const candidates =
    advertised.name === "h264_nvenc"
      ? [advertised, { name: "libx264", source: "portable-fallback" }]
      : [advertised];
  const attempts = [];
  for (const encoder of candidates) {
    if (encoder.name === "libx264" && !/\blibx264\b/.test(encodersOutput))
      continue;
    try {
      const proof = await probeEncoder(encoder, profile);
      attempts.push({ encoder: encoder.name, ready: true, ...proof });
      return { encoder, attempts };
    } catch (error) {
      attempts.push({
        encoder: encoder.name,
        ready: false,
        error: error.message,
      });
    }
  }
  throw new Error(
    `no capture encoder passed full-source readiness probe: ${attempts.map((entry) => `${entry.encoder}: ${entry.error}`).join("; ")}`,
  );
}

function lastProgressValues(contents) {
  let values = new Map();
  let lastComplete = null;
  for (const line of contents.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    values.set(key, line.slice(separator + 1).trim());
    if (key === "progress") {
      lastComplete = values;
      values = new Map();
    }
  }
  return lastComplete ?? new Map();
}

function progressNumber(values, key, { integer = false } = {}) {
  const raw = values.get(key);
  const value = integer ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  if (!Number.isFinite(value))
    throw new Error(`ffmpeg progress is missing numeric ${key}`);
  return value;
}

export function parseCaptureProgress(contents) {
  if (typeof contents !== "string" || contents.trim() === "")
    throw new Error("ffmpeg progress is empty");
  const values = lastProgressValues(contents);
  const mediaTimeUs = progressNumber(values, "out_time_us", {
    integer: true,
  });
  return {
    frameCount: progressNumber(values, "frame", { integer: true }),
    fps: progressNumber(values, "fps"),
    mediaTimeMs: mediaTimeUs / 1_000,
    duplicateFrames: progressNumber(values, "dup_frames", { integer: true }),
    droppedFrames: progressNumber(values, "drop_frames", { integer: true }),
    progress: values.get("progress") ?? null,
  };
}

export function assertCleanCaptureProgress(
  progress,
  { expectedMinimumFrames = 1 } = {},
) {
  if (progress.progress !== "end")
    throw new Error("ffmpeg capture did not report progress=end");
  if (progress.duplicateFrames !== 0)
    throw new Error(
      `ffmpeg capture duplicate frames: ${progress.duplicateFrames}`,
    );
  if (progress.droppedFrames !== 0)
    throw new Error(`ffmpeg capture dropped frames: ${progress.droppedFrames}`);
  if (progress.frameCount < expectedMinimumFrames) {
    throw new Error(
      `ffmpeg encoded ${progress.frameCount} frames; expected at least ${expectedMinimumFrames}`,
    );
  }
  return progress;
}

export function assertCaptureFrameAlignment({
  fps,
  storyDurationMs,
  storyStart,
  storyEnd,
  toleranceFrames = 1,
} = {}) {
  for (const [label, value] of Object.entries({
    fps,
    storyDurationMs,
    toleranceFrames,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`capture frame alignment needs non-negative ${label}`);
    }
  }
  if (!Number.isInteger(toleranceFrames)) {
    throw new Error(
      "capture frame alignment toleranceFrames must be an integer",
    );
  }
  if (fps === 0) {
    throw new Error("capture frame alignment fps must be greater than zero");
  }
  for (const [label, sample] of Object.entries({ storyStart, storyEnd })) {
    if (
      !isRecord(sample) ||
      !Number.isInteger(sample.frameCount) ||
      sample.frameCount < 0 ||
      !Number.isFinite(sample.mediaTimeMs) ||
      sample.mediaTimeMs < 0
    ) {
      throw new Error(
        `capture media frame alignment needs ${label} {frameCount, mediaTimeMs}`,
      );
    }
  }
  const expectedStoryFrames = Math.round((storyDurationMs * fps) / 1_000);
  const observedStoryFrames = storyEnd.frameCount - storyStart.frameCount;
  const observedMediaDurationMs = storyEnd.mediaTimeMs - storyStart.mediaTimeMs;
  if (observedStoryFrames < 0 || observedMediaDurationMs < 0) {
    throw new Error("capture media frame alignment samples must be monotonic");
  }
  const frameDelta = observedStoryFrames - expectedStoryFrames;
  const mediaDurationDeltaMs = observedMediaDurationMs - storyDurationMs;
  const frameDurationMs = 1_000 / fps;
  if (Math.abs(frameDelta) > toleranceFrames) {
    throw new Error(
      `capture media frame alignment failed: expected ${expectedStoryFrames} story frames (±${toleranceFrames}), observed ${observedStoryFrames}`,
    );
  }
  if (Math.abs(mediaDurationDeltaMs) > toleranceFrames * frameDurationMs) {
    throw new Error(
      `capture media clock alignment failed: expected ${storyDurationMs}ms (±${Math.round(toleranceFrames * frameDurationMs)}ms), observed ${observedMediaDurationMs}ms`,
    );
  }
  return {
    contract: "kandev-highlight-media-frame-alignment-v1",
    expectedStoryFrames,
    observedStoryFrames,
    expectedStoryDurationMs: storyDurationMs,
    observedMediaDurationMs,
    frameDelta,
    mediaDurationDeltaMs,
    toleranceFrames,
  };
}

export async function configureCaptureTarget({ page, cdp, profile } = {}) {
  if (!page || !cdp)
    throw new Error("capture target needs Playwright page and CDP session");
  const metrics = {
    width: profile.cssWidth,
    height: profile.cssHeight,
    deviceScaleFactor: profile.dpr,
    mobile: profile.nativeMobile,
    screenWidth: profile.cssWidth,
    screenHeight: profile.cssHeight,
    positionX: 0,
    positionY: 0,
    dontSetVisibleSize: false,
  };
  await cdp.send("Emulation.setDeviceMetricsOverride", metrics);
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: profile.nativeMobile,
    ...(profile.nativeMobile ? { maxTouchPoints: 1 } : {}),
  });
  const viewport = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  }));
  if (
    viewport.innerWidth !== profile.cssWidth ||
    viewport.innerHeight !== profile.cssHeight ||
    viewport.devicePixelRatio !== profile.dpr
  ) {
    throw new Error(
      `capture viewport mismatch: expected ${profile.cssWidth}x${profile.cssHeight}@${profile.dpr}, ` +
        `got ${viewport.innerWidth}x${viewport.innerHeight}@${viewport.devicePixelRatio}`,
    );
  }
  return {
    cssWidth: viewport.innerWidth,
    cssHeight: viewport.innerHeight,
    dpr: viewport.devicePixelRatio,
    sourceWidth: viewport.innerWidth * viewport.devicePixelRatio,
    sourceHeight: viewport.innerHeight * viewport.devicePixelRatio,
    nativeMobile: profile.nativeMobile,
  };
}

export function createCaptureCursor({ page, profile, adapters, now } = {}) {
  return createCursorController({
    page,
    viewport: { width: profile.cssWidth, height: profile.cssHeight },
    now,
    trustedInput: adapters.trustedCursor,
    measurePointerGlyph: () => measurePointerGlyph(page),
  });
}

function commandResult(command, args, { timeoutMs = 15_000, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    let bytes = 0;
    let timedOut = false;
    const capture = (chunk) => {
      bytes += chunk.length;
      if (bytes <= 2_000_000) output.push(chunk);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) =>
      reject(
        new Error(`cannot execute ${command}: ${error.message}`, {
          cause: error,
        }),
      ),
    );
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      const text = Buffer.concat(output).toString("utf8");
      if (timedOut)
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      else if (code !== 0)
        reject(
          new Error(`${command} exited ${code ?? signal}: ${text.trim()}`),
        );
      else resolve({ stdout: text, code });
    });
  });
}

async function resolveExecutable(command) {
  if (path.isAbsolute(command)) {
    await fs.access(command, fsSync.constants.X_OK);
    return await fs.realpath(command);
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      await fs.access(candidate, fsSync.constants.X_OK);
      return await fs.realpath(candidate);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
    }
  }
  throw new Error(`required capture tool '${command}' was not found on PATH`);
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return `sha256:${hash.digest("hex")}`;
}

async function toolIdentity(executable, versionArgs) {
  const resolved = await resolveExecutable(executable);
  let version;
  try {
    const result = await commandResult(resolved, versionArgs, {
      timeoutMs: 8_000,
    });
    version =
      result.stdout
        .split(/\r?\n/)
        .find((line) => line.trim())
        ?.trim() ?? "unknown";
  } catch (error) {
    version = `version probe failed: ${error.message}`;
  }
  return { executable: resolved, version, digest: await hashFile(resolved) };
}

export async function loadPlaywrightChromium(webRoot = WEB_ROOT) {
  const requireFromWeb = createRequire(path.join(webRoot, "package.json"));
  let modulePath;
  try {
    modulePath = requireFromWeb.resolve("playwright");
  } catch {
    modulePath = requireFromWeb.resolve("@playwright/test");
  }
  const playwright = await import(pathToFileURL(modulePath).href);
  try {
    return playwrightChromiumFromModule(playwright);
  } catch (error) {
    throw new Error(
      `Playwright module at ${modulePath} does not export chromium`,
      { cause: error },
    );
  }
}

export async function resolveCaptureTools({
  browserExecutable,
  ffmpegExecutable = "ffmpeg",
  xvfbExecutable = "Xvfb",
  webRoot,
} = {}) {
  const chromiumApi = await loadPlaywrightChromium(webRoot);
  const chromiumPath = browserExecutable ?? chromiumApi.executablePath();
  const [ffmpeg, chromium, xvfb] = await Promise.all([
    toolIdentity(ffmpegExecutable, ["-version"]),
    toolIdentity(chromiumPath, ["--version"]),
    toolIdentity(xvfbExecutable, ["-version"]),
  ]);
  const encoderProbe = await commandResult(ffmpeg.executable, [
    "-hide_banner",
    "-encoders",
  ]);
  return {
    tools: { ffmpeg, chromium, xvfb },
    encodersOutput: encoderProbe.stdout,
    chromiumApi,
  };
}

export async function probeCaptureEncoder(
  encoder,
  profile,
  { ffmpegExecutable = "ffmpeg" } = {},
) {
  const plan = buildEncoderProbePlan({ encoder, profile, ffmpegExecutable });
  const started = performance.now();
  await commandResult(plan.command, plan.args, { timeoutMs: 20_000 });
  const elapsedMs = performance.now() - started;
  if (elapsedMs > plan.maximumElapsedMs) {
    throw new Error(
      `${encoder.name} full-source probe took ${Math.round(elapsedMs)}ms for ${plan.sourceDurationMs}ms ` +
        `of video (limit ${plan.maximumElapsedMs}ms); recorder lacks bounded realtime headroom`,
    );
  }
  return {
    elapsedMs,
    command: [plan.command, ...plan.args],
    maximumElapsedMs: plan.maximumElapsedMs,
  };
}

function childSpawned(child, label) {
  return new Promise((resolve, reject) => {
    const onError = (error) =>
      reject(
        new Error(`cannot start ${label}: ${error.message}`, { cause: error }),
      );
    child.once("error", onError);
    child.once("spawn", () => {
      child.off("error", onError);
      resolve();
    });
  });
}

function childExited(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      child.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    child.once("close", onClose);
  });
}

async function requestRecorderQuit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      child.stdin.off("error", onError);
      if (error.code === "EPIPE") resolve();
      else reject(error);
    };
    child.stdin.once("error", onError);
    child.stdin.end("q\n", () => {
      child.stdin.off("error", onError);
      resolve();
    });
  });
}

async function waitForRecorderProgress(child, progressPath) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `ffmpeg exited before first frame (${child.exitCode ?? child.signalCode})`,
      );
    }
    try {
      const contents = await fs.readFile(progressPath, "utf8");
      if (/^frame=\d+/m.test(contents)) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(
    `ffmpeg did not report first frame within 8000ms; inspect ${progressPath}`,
  );
}

async function waitForRecorderMediaSample(
  child,
  progressPath,
  { minimumFrameCount = 0, minimumMediaTimeMs = 0, timeoutMs = 8_000 } = {},
) {
  for (const [label, value] of Object.entries({
    minimumFrameCount,
    minimumMediaTimeMs,
    timeoutMs,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`recorder media sample needs non-negative ${label}`);
    }
  }
  if (!Number.isInteger(minimumFrameCount)) {
    throw new Error(
      "recorder media sample minimumFrameCount must be an integer",
    );
  }
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `ffmpeg exited before requested media sample (${child.exitCode ?? child.signalCode})`,
      );
    }
    try {
      latest = parseCaptureProgress(await fs.readFile(progressPath, "utf8"));
      if (
        latest.frameCount >= minimumFrameCount &&
        latest.mediaTimeMs >= minimumMediaTimeMs
      ) {
        return {
          frameCount: latest.frameCount,
          mediaTimeMs: latest.mediaTimeMs,
        };
      }
    } catch (error) {
      if (
        error.code !== "ENOENT" &&
        !/ffmpeg progress is (?:empty|missing numeric)/.test(error.message)
      ) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `ffmpeg media clock did not reach frame ${minimumFrameCount} / ${minimumMediaTimeMs}ms within ${timeoutMs}ms; ` +
      `latest ${latest ? `frame ${latest.frameCount} / ${latest.mediaTimeMs}ms` : "sample unavailable"}; inspect ${progressPath}`,
  );
}

export async function startFfmpegRecorder({
  command,
  now = () => performance.now(),
  spawnProcess = spawn,
  waitForProgress = waitForRecorderProgress,
  waitForMediaSample = waitForRecorderMediaSample,
  waitForChildExit = childExited,
} = {}) {
  for (const destination of [
    command.output,
    command.progressPath,
    command.logPath,
  ]) {
    try {
      await fs.access(destination);
      throw new Error(`refusing to overwrite capture file: ${destination}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const log = fsSync.createWriteStream(command.logPath, { flags: "ax" });
  const child = spawnProcess(command.command, command.args, {
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stderr.pipe(log, { end: false });
  try {
    await childSpawned(child, "ffmpeg x11 capture");
    const captureEpochMs = now();
    await waitForProgress(child, command.progressPath);
    const sample = (options) =>
      waitForMediaSample(child, command.progressPath, options);
    let stopping = null;
    const stop = async () => {
      if (stopping) return stopping;
      stopping = (async () => {
        if (child.exitCode === null && child.signalCode === null) {
          await requestRecorderQuit(child);
          if (!(await waitForChildExit(child, 8_000))) {
            child.kill("SIGINT");
            if (!(await waitForChildExit(child, 3_000))) {
              child.kill("SIGKILL");
              if (!(await waitForChildExit(child, 2_000))) {
                throw new Error(`ffmpeg process ${child.pid} survived SIGKILL`);
              }
            }
          }
        }
        log.end();
        if (child.exitCode !== 0)
          throw new Error(
            `ffmpeg capture exited ${child.exitCode ?? child.signalCode}`,
          );
        return {
          exitCode: child.exitCode,
          signal: child.signalCode,
          processGone: true,
        };
      })();
      return stopping;
    };
    return { captureEpochMs, pid: child.pid, sample, stop };
  } catch (error) {
    let cleanupError;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      if (!(await waitForChildExit(child, 2_000))) {
        cleanupError = new Error(
          `ffmpeg process ${child.pid} survived SIGKILL`,
        );
      }
    }
    log.end();
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "ffmpeg recorder startup and cleanup failed",
      );
    }
    throw error;
  }
}

export async function connectCaptureBrowser({ chromiumApi, endpoint } = {}) {
  if (!chromiumApi) throw new Error("Playwright Chromium API is unavailable");
  const browser = await chromiumApi.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context)
    throw new Error("CDP Chromium exposed no default browser context");
  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);
  return {
    browser,
    context,
    page,
    cdp,
    async close() {
      await cdp.detach().catch(() => {});
      await browser.close();
    },
  };
}

export async function collectCaptureReceipt({
  scenarioDigest,
  sourceDigest,
  captureEpochMs,
  storyEpochMs,
  storyMedia,
  storyDurationMs,
  command,
  profile,
  rawMasterPath,
  progress,
  tools,
  encoderReadiness = [],
  seed,
  execution,
  runtime,
  source,
  navigation,
  trustedInputLedger = [],
  frameAlignment,
  build,
  buildVerification,
  applicationRuntime,
  captureEvidence,
} = {}) {
  const stat = await fs.stat(rawMasterPath);
  if (
    !isRecord(storyMedia) ||
    !isRecord(storyMedia.start) ||
    !isRecord(storyMedia.end) ||
    !Number.isFinite(storyMedia.start.mediaTimeMs) ||
    storyMedia.start.mediaTimeMs < 0
  ) {
    throw new Error(
      "capture receipt needs FFmpeg storyMedia start/end frame samples",
    );
  }
  const storyStartOffsetMs = storyMedia.start.mediaTimeMs;
  return {
    contract: "kandev-highlight-source-capture-v1",
    scenarioDigest,
    sourceDigest,
    source: source ? structuredClone(source) : null,
    build: build ? structuredClone(build) : null,
    buildVerification: buildVerification
      ? structuredClone(buildVerification)
      : null,
    navigation: navigation ? structuredClone(navigation) : null,
    captureEpochMs,
    storyEpochMs,
    storyStartOffsetMs,
    storyOffsetMs: storyStartOffsetMs,
    storyDurationMs,
    storyMedia: structuredClone(storyMedia),
    capture: {
      width: profile.sourceWidth,
      height: profile.sourceHeight,
      cssWidth: profile.cssWidth,
      cssHeight: profile.cssHeight,
      deviceScaleFactor: profile.dpr,
      fps: profile.fps,
      audio: false,
      frameCount: progress.frameCount,
      duplicateFrames: progress.duplicateFrames,
      droppedFrames: progress.droppedFrames,
      encoder: { ...command.encoder },
      lossless: command.master?.lossless === true,
      pixelFormat: command.master?.pixelFormat ?? null,
      profile: command.master?.profile ?? null,
      encoderReadiness: structuredClone(encoderReadiness),
      frameAlignment: frameAlignment ? structuredClone(frameAlignment) : null,
    },
    rawMaster: {
      path: path.resolve(rawMasterPath),
      bytes: stat.size,
      digest: await hashFile(rawMasterPath),
    },
    command: { executable: command.command, args: [...command.args] },
    tools: structuredClone(tools),
    seed: seed ? structuredClone(seed) : null,
    execution: execution ? structuredClone(execution) : null,
    trustedInputLedger: structuredClone(trustedInputLedger),
    runtime: runtime ? structuredClone(runtime) : null,
    applicationRuntime: applicationRuntime
      ? structuredClone(applicationRuntime)
      : null,
    captureEvidence: captureEvidence ? structuredClone(captureEvidence) : null,
  };
}

export async function writeCaptureEvidence(destination, evidence) {
  const absolute = path.resolve(destination);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  try {
    await fs.writeFile(absolute, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: "wx",
    });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`refusing to overwrite capture evidence: ${absolute}`);
    throw error;
  }
  return absolute;
}

function runtimeEvidence(plan, teardown) {
  return {
    allocation: {
      display: plan.display,
      displayNumber: plan.displayNumber,
      cdpPort: plan.cdpPort,
      chromiumSandbox: structuredClone(plan.chromiumSandbox),
      artifactRoot: plan.artifactRoot,
      profileDir: plan.profileDir,
      lockPath: plan.lockPath,
      coordinateLockRoot: plan.coordinateLockRoot,
      coordinateLockPath: plan.coordinateLockPath,
    },
    teardown: teardown ?? null,
  };
}

function validateSeedProof(proof, recipe) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    throw new Error(
      `seed recipe '${recipe}' must return {seedId, seedDigest, invariants} evidence`,
    );
  }
  if (typeof proof.seedId !== "string" || proof.seedId.trim() === "") {
    throw new Error(`seed recipe '${recipe}' returned invalid seedId`);
  }
  if (!DIGEST_PATTERN.test(proof.seedDigest ?? "")) {
    throw new Error(`seed recipe '${recipe}' returned invalid seedDigest`);
  }
  if (
    !proof.invariants ||
    typeof proof.invariants !== "object" ||
    Array.isArray(proof.invariants)
  ) {
    throw new Error(`seed recipe '${recipe}' returned invalid invariants`);
  }
  return structuredClone(proof);
}

function validateSourceProof(proof) {
  if (
    !proof ||
    proof.contract !== "kandev-highlight-source-v1" ||
    proof.clean !== true ||
    proof.status !== "" ||
    !SOURCE_SHA_PATTERN.test(proof.selectedSha ?? "")
  ) {
    throw new Error(
      "captureScenario needs a clean kandev-highlight-source-v1 source gate proof with exact selectedSha",
    );
  }
  if (proof.headSha && !SOURCE_SHA_PATTERN.test(proof.headSha)) {
    throw new Error("captureScenario source gate proof has invalid headSha");
  }
  return structuredClone(proof);
}

function compactBuildProvenance(proof, sourceProof) {
  if (proof === undefined) {
    throw new Error(
      "captureScenario needs exact build provenance for the current source checkout",
    );
  }
  if (
    proof?.contract !== "kandev-highlight-build-provenance-v1" ||
    !DIGEST_PATTERN.test(proof.manifestDigest ?? "") ||
    proof.source?.selectedSha !== sourceProof.selectedSha
  ) {
    throw new Error(
      "capture build provenance must bind exact selected source SHA",
    );
  }
  const outputs = {};
  for (const key of ["backend", "mockAgent", "webDist"]) {
    const output = proof.outputs?.[key];
    if (
      !output ||
      !DIGEST_PATTERN.test(output.digest ?? "") ||
      !Number.isInteger(output.bytes) ||
      output.bytes <= 0 ||
      (key === "webDist" &&
        (!Number.isInteger(output.fileCount) || output.fileCount <= 0))
    ) {
      throw new Error(
        `capture build provenance has invalid ${key} output identity`,
      );
    }
    outputs[key] = {
      digest: output.digest,
      bytes: output.bytes,
      ...(key === "webDist" ? { fileCount: output.fileCount } : {}),
    };
  }
  return {
    contract: proof.contract,
    manifestDigest: proof.manifestDigest,
    sourceSha: proof.source.selectedSha,
    outputs,
  };
}

export function createTrustedCaptureBuildVerifier({
  manifestPath,
  repositoryRoot,
  verify,
} = {}) {
  if (typeof manifestPath !== "string" || !path.isAbsolute(manifestPath)) {
    throw new Error(
      "trusted capture build verifier needs an absolute manifestPath",
    );
  }
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) {
    throw new Error(
      "trusted capture build verifier needs an absolute repositoryRoot",
    );
  }
  if (typeof verify !== "function") {
    throw new Error("trusted capture build verifier needs verify function");
  }
  const token = Object.freeze({
    contract: "kandev-highlight-trusted-build-verifier-v1",
  });
  TRUSTED_CAPTURE_BUILD_VERIFIERS.set(token, (expectedSourceSha) =>
    verify(path.resolve(manifestPath), {
      expectedSourceSha,
      expectedRepositoryRoot: path.resolve(repositoryRoot),
    }),
  );
  return token;
}

function captureBuildBoundary(proof, sourceProof, expectedBuild) {
  const compact = compactBuildProvenance(proof, sourceProof);
  for (const [label, actual, expected] of [
    ["manifest", compact.manifestDigest, expectedBuild.manifestDigest],
    ["source", compact.sourceSha, expectedBuild.sourceSha],
    ...["backend", "mockAgent", "webDist"].map((key) => [
      key,
      compact.outputs[key].digest,
      expectedBuild.outputs[key].digest,
    ]),
  ]) {
    if (actual !== expected) {
      throw new Error(
        `capture build verification ${label} identity does not match the served application build`,
      );
    }
  }
  return {
    contract: "kandev-highlight-build-boundary-v1",
    manifestDigest: compact.manifestDigest,
    sourceSha: compact.sourceSha,
    outputs: Object.fromEntries(
      ["backend", "mockAgent", "webDist"].map((key) => [
        key,
        compact.outputs[key].digest,
      ]),
    ),
  };
}

async function verifyCaptureBuildBoundary(
  verifierToken,
  sourceProof,
  expectedBuild,
) {
  const verify = TRUSTED_CAPTURE_BUILD_VERIFIERS.get(verifierToken);
  if (!verify) {
    throw new Error(
      "captureScenario needs an opaque trusted build verifier from createTrustedCaptureBuildVerifier",
    );
  }
  return captureBuildBoundary(
    await verify(sourceProof.selectedSha),
    sourceProof,
    expectedBuild,
  );
}

function validateCaptureBuildBoundary(boundary, label) {
  if (
    !isRecord(boundary) ||
    boundary.contract !== "kandev-highlight-build-boundary-v1" ||
    !DIGEST_PATTERN.test(boundary.manifestDigest ?? "") ||
    !SOURCE_SHA_PATTERN.test(boundary.sourceSha ?? "")
  ) {
    throw new Error(`${label} capture build boundary is invalid`);
  }
  for (const key of ["backend", "mockAgent", "webDist"]) {
    if (!DIGEST_PATTERN.test(boundary.outputs?.[key] ?? "")) {
      throw new Error(`${label} capture build boundary ${key} is invalid`);
    }
  }
  return boundary;
}

export function assertStableCaptureBuildVerification({
  beforeStory,
  afterStory,
} = {}) {
  validateCaptureBuildBoundary(beforeStory, "before-story");
  validateCaptureBuildBoundary(afterStory, "after-story");
  if (beforeStory.sourceSha !== afterStory.sourceSha) {
    throw new Error("capture source identity changed during recorded story");
  }
  for (const key of ["backend", "mockAgent", "webDist"]) {
    if (beforeStory.outputs[key] !== afterStory.outputs[key]) {
      throw new Error(
        `capture build outputs changed during recorded story: ${key}`,
      );
    }
  }
  if (beforeStory.manifestDigest !== afterStory.manifestDigest) {
    throw new Error("capture build manifest changed during recorded story");
  }
  return {
    contract: "kandev-highlight-build-verification-v1",
    stable: true,
    beforeStory: structuredClone(beforeStory),
    afterStory: structuredClone(afterStory),
  };
}

function pathWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function validateApplicationRuntime(
  proof,
  { sourceProof, buildProof, frontendUrl },
) {
  if (proof === undefined) return null;
  requireExactKeys(
    proof,
    [
      "contract",
      "version",
      "runtimeId",
      "origin",
      "ports",
      "isolation",
      "providerRouting",
      "source",
      "build",
    ],
    "applicationRuntime",
  );
  if (
    proof.contract !== "kandev-highlight-application-runtime-pre-teardown-v1" ||
    proof.version !== 1 ||
    proof.runtimeId !== "kandev-isolated-e2e"
  ) {
    throw new Error(
      "applicationRuntime contract, version, or runtimeId is invalid",
    );
  }
  let configuredOrigin;
  let proofOrigin;
  try {
    configuredOrigin = new URL(frontendUrl).origin;
    proofOrigin = new URL(proof.origin).origin;
  } catch {
    throw new Error("applicationRuntime origin must be an absolute HTTP URL");
  }
  if (proofOrigin !== proof.origin || proofOrigin !== configuredOrigin) {
    throw new Error(
      "applicationRuntime origin must match the configured frontend origin",
    );
  }
  requireExactKeys(
    proof.ports,
    ["backend", "frontend"],
    "applicationRuntime ports",
  );
  const originPort = Number(new URL(proof.origin).port || 80);
  if (
    !Number.isInteger(proof.ports.backend) ||
    proof.ports.backend < 1_024 ||
    proof.ports.backend > 65_535 ||
    proof.ports.frontend !== proof.ports.backend ||
    originPort !== proof.ports.backend
  ) {
    throw new Error("applicationRuntime ports must match the frontend origin");
  }
  requireExactKeys(
    proof.isolation,
    [
      "fixtureTempRoot",
      "homeRoot",
      "databasePath",
      "worktreeRoot",
      "repositoryCloneRoot",
    ],
    "applicationRuntime isolation",
  );
  const tempRoot = proof.isolation.fixtureTempRoot;
  if (typeof tempRoot !== "string" || !path.isAbsolute(tempRoot)) {
    throw new Error("applicationRuntime fixtureTempRoot must be absolute");
  }
  for (const key of [
    "homeRoot",
    "databasePath",
    "worktreeRoot",
    "repositoryCloneRoot",
  ]) {
    const value = proof.isolation[key];
    if (
      typeof value !== "string" ||
      !path.isAbsolute(value) ||
      !pathWithin(tempRoot, value) ||
      path.resolve(value) === path.resolve(tempRoot)
    ) {
      throw new Error(
        `applicationRuntime isolation ${key} must be inside fixtureTempRoot`,
      );
    }
  }
  requireExactKeys(
    proof.providerRouting,
    [
      "profile",
      "mockAgent",
      "mockProviders",
      "liveCredentialsPresent",
      "environmentSanitized",
    ],
    "applicationRuntime provider routing",
  );
  if (
    proof.providerRouting.profile !== "e2e" ||
    proof.providerRouting.mockAgent !== true ||
    proof.providerRouting.mockProviders !== true ||
    proof.providerRouting.liveCredentialsPresent !== false ||
    proof.providerRouting.environmentSanitized !== true
  ) {
    throw new Error(
      "applicationRuntime provider routing must prove mocks with no live credentials",
    );
  }
  requireExactKeys(
    proof.source,
    ["contract", "mode", "selectedSha"],
    "applicationRuntime source",
  );
  if (
    proof.source.contract !== sourceProof.contract ||
    proof.source.mode !== sourceProof.source ||
    proof.source.selectedSha !== sourceProof.selectedSha
  ) {
    throw new Error("applicationRuntime source identity mismatch");
  }
  requireExactKeys(
    proof.build,
    ["contract", "manifestDigest", "sourceSha", "outputs"],
    "applicationRuntime build",
  );
  requireExactKeys(
    proof.build.outputs,
    ["backend", "mockAgent", "webDist"],
    "applicationRuntime build outputs",
  );
  if (
    proof.build.contract !== buildProof.contract ||
    proof.build.manifestDigest !== buildProof.manifestDigest ||
    proof.build.sourceSha !== sourceProof.selectedSha ||
    Object.entries(proof.build.outputs).some(
      ([key, digest]) => digest !== buildProof.outputs[key]?.digest,
    )
  ) {
    throw new Error("applicationRuntime build identity mismatch");
  }
  return structuredClone(proof);
}

function validateCaptureContent(evidence) {
  requireExactKeys(
    evidence,
    [
      "contract",
      "version",
      "bounds",
      "visibleDomText",
      "browserConsole",
      "truncated",
    ],
    "capture content evidence",
  );
  if (
    evidence.contract !== "kandev-highlight-capture-content-v1" ||
    evidence.version !== 1
  ) {
    throw new Error("capture content evidence contract must be version 1");
  }
  requireExactKeys(
    evidence.bounds,
    Object.keys(CAPTURE_CONTENT_BOUNDS),
    "capture content evidence bounds",
  );
  for (const [key, value] of Object.entries(CAPTURE_CONTENT_BOUNDS)) {
    if (evidence.bounds[key] !== value) {
      throw new Error(`capture content evidence ${key} must equal ${value}`);
    }
  }
  requireExactKeys(
    evidence.truncated,
    ["visibleDomText", "browserConsole"],
    "capture content evidence truncated",
  );
  if (
    typeof evidence.truncated.visibleDomText !== "boolean" ||
    typeof evidence.truncated.browserConsole !== "boolean"
  ) {
    throw new Error("capture content evidence truncated flags must be boolean");
  }
  if (
    !Array.isArray(evidence.visibleDomText) ||
    evidence.visibleDomText.length >
      CAPTURE_CONTENT_BOUNDS.maxVisibleDomTextRecords ||
    evidence.visibleDomText.some((text) => typeof text !== "string")
  ) {
    throw new Error("capture content visibleDomText exceeds its record bound");
  }
  const visibleBytes = evidence.visibleDomText.reduce(
    (total, text) => total + Buffer.byteLength(text),
    0,
  );
  if (visibleBytes > CAPTURE_CONTENT_BOUNDS.maxVisibleDomTextBytes) {
    throw new Error("capture content visibleDomText exceeds its byte bound");
  }
  if (
    !Array.isArray(evidence.browserConsole) ||
    evidence.browserConsole.length >
      CAPTURE_CONTENT_BOUNDS.maxBrowserConsoleRecords
  ) {
    throw new Error("capture content browserConsole exceeds its record bound");
  }
  let consoleBytes = 0;
  for (const [index, record] of evidence.browserConsole.entries()) {
    requireExactKeys(
      record,
      ["type", "text", "digest"],
      `capture content browserConsole ${index}`,
    );
    if (
      typeof record.type !== "string" ||
      !/^[a-z][a-zA-Z-]{0,31}$/.test(record.type) ||
      typeof record.text !== "string" ||
      Buffer.byteLength(record.text) >
        CAPTURE_CONTENT_BOUNDS.maxBrowserConsoleTextBytes ||
      record.digest !==
        digestValue(canonicalJson({ type: record.type, text: record.text }))
    ) {
      throw new Error(`capture content browserConsole ${index} is invalid`);
    }
    consoleBytes += Buffer.byteLength(record.text);
  }
  return { evidence: structuredClone(evidence), visibleBytes, consoleBytes };
}

async function persistCaptureContent(plan, rawEvidence) {
  const validated = validateCaptureContent(rawEvidence);
  const destination = path.join(plan.evidenceDir, "capture-content.json");
  await writeCaptureEvidence(destination, validated.evidence);
  const identity = await fs.stat(destination);
  return {
    contract: "kandev-highlight-capture-evidence-v1",
    version: 1,
    path: destination,
    bytes: identity.size,
    digest: await hashFile(destination),
    visibleDomText: {
      records: validated.evidence.visibleDomText.length,
      bytes: validated.visibleBytes,
      digest: digestValue(canonicalJson(validated.evidence.visibleDomText)),
      truncated: validated.evidence.truncated.visibleDomText,
    },
    browserConsole: {
      records: validated.evidence.browserConsole.length,
      bytes: validated.consoleBytes,
      digest: digestValue(canonicalJson(validated.evidence.browserConsole)),
      truncated: validated.evidence.truncated.browserConsole,
    },
  };
}

function evidenceSeedRegistry(seedRegistry, recipe, onProof) {
  const seed =
    Object.hasOwn(seedRegistry, recipe) &&
    typeof seedRegistry[recipe] === "function"
      ? seedRegistry[recipe]
      : null;
  if (!seed) return seedRegistry;
  return {
    ...seedRegistry,
    [recipe]: async (input) => {
      const proof = validateSeedProof(await seed(input), recipe);
      onProof(proof);
      return proof;
    },
  };
}

async function writeFailureEvidence(plan, phase, error, teardown, navigation) {
  if (!plan?.evidenceDir) return;
  const destination = path.join(plan.evidenceDir, "capture.failure.json");
  const evidence = {
    contract: "kandev-highlight-capture-failure-v1",
    phase,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    teardown: teardown ? structuredClone(teardown) : null,
    runtime: runtimeEvidence(plan, teardown ?? null),
    navigation: navigation ? structuredClone(navigation) : null,
  };
  await writeCaptureEvidence(destination, evidence);
}

async function cleanupCaptureResources({
  recorder,
  browserConnection,
  liveRuntime,
} = {}) {
  const components = [];
  const errors = [];
  for (const [component, cleanup] of [
    ["recorder", recorder?.stop?.bind(recorder)],
    ["browser", browserConnection?.close?.bind(browserConnection)],
    ["runtime", liveRuntime?.stop?.bind(liveRuntime)],
  ]) {
    if (typeof cleanup !== "function") continue;
    try {
      const result = await cleanup();
      components.push({ component, ok: true, result: result ?? null });
    } catch (error) {
      components.push({ component, ok: false, error: error.message });
      errors.push(error);
    }
  }
  return { complete: errors.length === 0, components, errors };
}

function isolationBoundaryConfirmed(components) {
  return components.some(
    ({ component, ok }) =>
      ok && (component === "browser" || component === "runtime"),
  );
}

function disposeFailedCaptureIsolation(originIsolation, cleanup) {
  if (!originIsolation || !isolationBoundaryConfirmed(cleanup.components)) {
    return;
  }
  try {
    originIsolation.dispose();
    cleanup.components.push({
      component: "origin-isolation",
      ok: true,
      result: null,
    });
  } catch (error) {
    cleanup.components.push({
      component: "origin-isolation",
      ok: false,
      error: error.message,
    });
    cleanup.errors.push(error);
    cleanup.complete = false;
  }
}

export async function closeCaptureBrowserWithIsolation({
  browserConnection,
  navigation,
  originIsolation,
} = {}) {
  if (
    typeof browserConnection?.close !== "function" ||
    typeof navigation?.evidence !== "function" ||
    typeof navigation?.dispose !== "function" ||
    typeof originIsolation?.assertClean !== "function" ||
    typeof originIsolation?.dispose !== "function"
  ) {
    throw new Error(
      "browser teardown needs the live browser, navigation, and origin isolation owners",
    );
  }
  const navigationEvidence = navigation.evidence();
  await browserConnection.close();
  const finalIsolation = originIsolation.assertClean("browser teardown");
  navigation.dispose();
  originIsolation.dispose();
  return { ...navigationEvidence, isolation: finalIsolation };
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  resolveCaptureTools,
  chooseReadyCaptureEncoder,
  planCaptureRuntime,
  startCaptureRuntime,
  connectCaptureBrowser,
  configureCaptureTarget,
  installCaptureOriginIsolation,
  installCaptureOverlay,
  createCaptureCursor,
  prepareScenario,
  startFfmpegRecorder,
  executePreparedScenario,
});

export async function captureScenario({
  scenario,
  timeline: suppliedTimeline,
  source,
  sourceDigest,
  buildProvenance,
  buildVerifier,
  applicationRuntime,
  collectCaptureEvidence,
  frontendUrl,
  artifactRoot,
  repositoryRoots = [REPOSITORY_ROOT],
  runId,
  displayNumber,
  cdpPort,
  coordinateLockRoot,
  browserExecutable,
  chromiumSandbox = defaultChromiumSandboxPolicy(),
  ffmpegExecutable = "ffmpeg",
  xvfbExecutable = "Xvfb",
  seedRegistry = {},
  primitiveRegistry = {},
  navigateRoute,
  preparePage,
  initialCursor,
  onCameraDirective,
  now = () => performance.now(),
  dependencies = {},
} = {}) {
  if (!scenario || typeof scenario !== "object")
    throw new Error("captureScenario needs a validated scenario");
  if (!DIGEST_PATTERN.test(sourceDigest ?? "")) {
    throw new Error(
      "captureScenario needs exact sourceDigest as sha256 plus 64 lowercase hex characters",
    );
  }
  const sourceProof = validateSourceProof(source);
  const buildProof = compactBuildProvenance(buildProvenance, sourceProof);
  if (!/^https?:\/\//.test(frontendUrl ?? ""))
    throw new Error("captureScenario needs frontendUrl");
  const applicationRuntimeProof = validateApplicationRuntime(
    applicationRuntime,
    { sourceProof, buildProof, frontendUrl },
  );
  if (
    collectCaptureEvidence !== undefined &&
    typeof collectCaptureEvidence !== "function"
  ) {
    throw new Error(
      "captureScenario collectCaptureEvidence must be a function",
    );
  }
  if (scenario.setup?.route && typeof navigateRoute !== "function") {
    throw new Error(
      "captureScenario requires an allowlisted navigateRoute adapter for scenario.setup.route",
    );
  }
  if (!TRUSTED_CAPTURE_BUILD_VERIFIERS.has(buildVerifier)) {
    throw new Error(
      "captureScenario needs an opaque trusted build verifier from createTrustedCaptureBuildVerifier",
    );
  }
  const timeline = suppliedTimeline ?? compileTimeline(scenario);
  const scenarioDigest = computeScenarioDigest(scenario);
  if (
    timeline.scenarioId !== scenario.id ||
    timeline.scenarioDigest !== scenarioDigest
  ) {
    throw new Error(
      "captureScenario timeline does not match canonical scenario digest",
    );
  }
  const profile = resolveCaptureProfile(scenario.profile);
  const frontendOrigin = new URL(frontendUrl).origin;
  const sandboxPolicy = validateChromiumSandboxCaptureBoundary(
    chromiumSandbox,
    { sourceProof, allowedOrigin: frontendOrigin },
  );
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const coordinates =
    displayNumber && cdpPort
      ? { displayNumber, cdpPort }
      : await allocateRuntimeCoordinates({ coordinateLockRoot });
  const resolution = await deps.resolveCaptureTools({
    browserExecutable,
    ffmpegExecutable,
    xvfbExecutable,
  });
  const tools = resolution.tools ?? resolution;
  const encoderReadiness = await deps.chooseReadyCaptureEncoder({
    encodersOutput: resolution.encodersOutput ?? "",
    profile,
    probeEncoder: (encoder, captureProfile) =>
      probeCaptureEncoder(encoder, captureProfile, {
        ffmpegExecutable: tools.ffmpeg.executable,
      }),
  });
  const plan = deps.planCaptureRuntime({
    scenarioId: scenario.id,
    profile,
    artifactRoot,
    repositoryRoots,
    runId,
    coordinateLockRoot,
    ...coordinates,
    browserExecutable: tools.chromium.executable,
    chromiumSandbox: sandboxPolicy,
    xvfbExecutable: tools.xvfb.executable,
  });
  let phase = "runtime";
  let liveRuntime;
  let browserConnection;
  let originIsolation;
  let recorder;
  let recorderEvidence;
  let captureEpochMs;
  let seedProof;
  let navigation;
  let navigationEvidence;
  let captureEvidence;
  let beforeStoryBuild;
  let afterStoryBuild;
  let buildVerification;
  let storyMediaStart;
  let storyMediaEnd;
  try {
    liveRuntime = await deps.startCaptureRuntime(plan);
    phase = "browser";
    browserConnection = await deps.connectCaptureBrowser({
      chromiumApi: resolution.chromiumApi,
      endpoint: plan.cdpEndpoint,
    });
    const { page, context, cdp } = browserConnection;
    originIsolation = await deps.installCaptureOriginIsolation({
      page,
      context,
      cdp,
      allowedOrigin: frontendOrigin,
    });
    await deps.configureCaptureTarget({ page, cdp, profile });
    await deps.installCaptureOverlay({ context, page });
    navigation = bindCaptureNavigation({
      page,
      context,
      frontendUrl,
      navigateRoute,
      originIsolation,
    });
    if (typeof preparePage === "function")
      await preparePage({ page, context, cdp, profile, plan });
    if (!scenario.setup?.route) await navigation.navigateDefault();
    const adapters = createTrustedInputAdapters({
      page,
      cdp,
      inputKind: scenario.profile.kind,
    });
    const cursor = deps.createCaptureCursor({ page, profile, adapters, now });
    phase = "prepare";
    const captureSeedRegistry = evidenceSeedRegistry(
      seedRegistry,
      scenario.seed.recipe,
      (proof) => {
        seedProof = proof;
      },
    );
    const prepared = await deps.prepareScenario({
      scenario,
      page,
      cursor,
      seedRegistry: captureSeedRegistry,
      primitiveRegistry,
      navigateRoute: scenario.setup?.route
        ? navigation.navigateRoute
        : undefined,
      initialCursor,
      measureTargetGlyph,
      onCameraDirective,
      inputKind: scenario.profile.kind,
      trustedActivation: adapters.trustedActivation,
      trustedGesture: adapters.trustedGesture,
      now,
    });
    if (!seedProof) {
      throw new Error(
        `seed recipe '${scenario.seed.recipe}' completed without exact seed evidence`,
      );
    }
    navigation.checkpoint("prepare complete");
    await deps.configureCaptureTarget({ page, cdp, profile });
    phase = "build-before-story";
    beforeStoryBuild = await verifyCaptureBuildBoundary(
      buildVerifier,
      sourceProof,
      buildProof,
    );
    const command = buildFfmpegCapturePlan({
      runtime: plan,
      profile,
      encoder: encoderReadiness.encoder,
      ffmpegExecutable: tools.ffmpeg.executable,
    });
    phase = "record";
    adapters.ledger.length = 0;
    recorder = await deps.startFfmpegRecorder({ command, now });
    captureEpochMs = recorder.captureEpochMs;
    if (typeof recorder.sample !== "function") {
      throw new Error(
        "capture recorder must expose FFmpeg media-clock sample()",
      );
    }
    phase = "execute";
    const execution = await deps.executePreparedScenario({
      prepared,
      timeline,
      now,
      onRecordingStart: async () => {
        navigation.checkpoint("story start");
        storyMediaStart = await recorder.sample();
      },
      onStep: async (step) => {
        navigation.checkpoint(`step ${step.index}`);
      },
      onRecordingEnd: async (result) => {
        navigation.checkpoint("story end");
        const expectedStoryFrames = Math.round(
          (result.storyDurationMs * profile.fps) / 1_000,
        );
        storyMediaEnd = await recorder.sample({
          minimumFrameCount:
            storyMediaStart.frameCount + Math.max(0, expectedStoryFrames - 1),
          minimumMediaTimeMs:
            storyMediaStart.mediaTimeMs +
            Math.max(0, result.storyDurationMs - 1_000 / profile.fps),
        });
        afterStoryBuild = await verifyCaptureBuildBoundary(
          buildVerifier,
          sourceProof,
          buildProof,
        );
      },
    });
    if (!storyMediaStart || !storyMediaEnd || !afterStoryBuild) {
      throw new Error(
        "prepared scenario executor did not run capture boundary callbacks",
      );
    }
    buildVerification = assertStableCaptureBuildVerification({
      beforeStory: beforeStoryBuild,
      afterStory: afterStoryBuild,
    });
    phase = "recorder-teardown";
    recorderEvidence = await recorder.stop();
    recorder = null;
    if (typeof collectCaptureEvidence === "function") {
      phase = "capture-evidence";
      captureEvidence = await persistCaptureContent(
        plan,
        await collectCaptureEvidence({
          page,
          context,
          profile,
          plan,
          execution,
        }),
      );
    }
    const progress = parseCaptureProgress(
      await fs.readFile(command.progressPath, "utf8"),
    );
    const expectedMinimumFrames = Math.max(
      1,
      Math.floor((timeline.totalDurationMs * profile.fps) / 1_000) - 1,
    );
    assertCleanCaptureProgress(progress, { expectedMinimumFrames });
    const frameAlignment = assertCaptureFrameAlignment({
      fps: profile.fps,
      storyDurationMs: execution.storyDurationMs,
      storyStart: storyMediaStart,
      storyEnd: storyMediaEnd,
    });
    phase = "browser-teardown";
    navigationEvidence = await closeCaptureBrowserWithIsolation({
      browserConnection,
      navigation,
      originIsolation,
    });
    navigation = null;
    browserConnection = null;
    originIsolation = null;
    phase = "runtime-teardown";
    const teardown = await liveRuntime.stop();
    liveRuntime = null;
    const teardownEvidence = teardown ?? {
      processesGone: true,
      coordinatesReleased: true,
      profileRemoved: true,
      lockRemoved: true,
    };
    phase = "receipt";
    const receipt = await collectCaptureReceipt({
      scenarioDigest,
      sourceDigest,
      source: sourceProof,
      captureEpochMs,
      storyEpochMs: execution.storyEpochMs,
      storyMedia: { start: storyMediaStart, end: storyMediaEnd },
      storyDurationMs: execution.storyDurationMs,
      command,
      profile,
      rawMasterPath: plan.rawMasterPath,
      progress,
      tools,
      encoderReadiness: encoderReadiness.attempts,
      seed: seedProof,
      execution,
      runtime: runtimeEvidence(plan, {
        ...teardownEvidence,
        recorder: recorderEvidence,
      }),
      navigation: navigationEvidence,
      trustedInputLedger: adapters.ledger,
      frameAlignment,
      build: buildProof,
      buildVerification,
      applicationRuntime: applicationRuntimeProof,
      captureEvidence,
    });
    const captureManifestPath = path.join(plan.evidenceDir, "capture.json");
    await writeCaptureEvidence(captureManifestPath, receipt);
    return {
      contract: "kandev-highlight-capture-result-v1",
      rawMasterPath: plan.rawMasterPath,
      captureManifestPath,
      receipt,
      execution,
      timeline,
    };
  } catch (error) {
    const failureNavigation = navigation?.snapshot();
    navigation?.dispose();
    const cleanup = await cleanupCaptureResources({
      recorder,
      browserConnection,
      liveRuntime,
    });
    disposeFailedCaptureIsolation(originIsolation, cleanup);
    const evidenceTeardown = {
      complete: cleanup.complete,
      components: cleanup.components,
    };
    let evidenceError;
    try {
      await writeFailureEvidence(
        plan,
        phase,
        error,
        evidenceTeardown,
        failureNavigation,
      );
    } catch (failureEvidenceError) {
      evidenceError = new Error(
        `cannot persist capture failure evidence: ${failureEvidenceError.message}`,
        { cause: failureEvidenceError },
      );
    }
    const errors = [
      error,
      ...cleanup.errors,
      ...(evidenceError ? [evidenceError] : []),
    ];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `Highlight capture failed during ${phase}; cleanup also failed`,
      );
    }
    throw new Error(
      `Highlight capture failed during ${phase}: ${error.message}`,
      {
        cause: error,
      },
    );
  }
}
