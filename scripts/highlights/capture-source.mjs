import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveCaptureProfile } from "./camera-compiler.mjs";
import { createCursorController } from "./cursor.mjs";
import { executePreparedScenario, prepareScenario } from "./executor.mjs";
import {
  allocateRuntimeCoordinates,
  planCaptureRuntime,
  startCaptureRuntime,
} from "./capture-runtime.mjs";
import { compileTimeline, computeScenarioDigest } from "./scenario.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(MODULE_DIR, "../..");
const WEB_ROOT = path.join(REPOSITORY_ROOT, "apps", "web");
const OVERLAY_ID = "kandev-highlight-pointer-overlay";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

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
      `color=c=black:s=${profile.sourceWidth}x${profile.sourceHeight}:r=${profile.fps}`,
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
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0)
      values.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return values;
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
  return {
    frameCount: progressNumber(values, "frame", { integer: true }),
    fps: progressNumber(values, "fps"),
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
    maxTouchPoints: profile.nativeMobile ? 1 : 0,
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

function overlayBootstrap() {
  const id = "kandev-highlight-pointer-overlay";
  const ensure = () => {
    let overlay = document.getElementById(id);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = id;
      overlay.setAttribute("aria-hidden", "true");
      Object.assign(overlay.style, {
        position: "fixed",
        zIndex: "2147483647",
        width: "20px",
        height: "20px",
        left: "0",
        top: "0",
        border: "2px solid rgba(255,255,255,.96)",
        borderRadius: "9999px",
        background: "rgba(20,20,24,.78)",
        boxShadow: "0 1px 4px rgba(0,0,0,.45)",
        pointerEvents: "none",
        transform: "translate(-50%,-50%)",
        opacity: "0",
        transition:
          "width 80ms linear,height 80ms linear,background 80ms linear",
      });
      document.documentElement.append(overlay);
    }
    return overlay;
  };
  globalThis.__kandevHighlightOverlay = (state) => {
    const overlay = ensure();
    overlay.style.left = `${state.x}px`;
    overlay.style.top = `${state.y}px`;
    overlay.style.opacity = state.visible === false ? "0" : "1";
    const touching = state.kind === "touch";
    overlay.style.width = touching ? "32px" : "20px";
    overlay.style.height = touching ? "32px" : "20px";
    overlay.style.background = touching
      ? "rgba(69,126,255,.35)"
      : "rgba(20,20,24,.78)";
  };
  if (document.documentElement) ensure();
  else document.addEventListener("DOMContentLoaded", ensure, { once: true });
}

export async function installCaptureOverlay({ context, page } = {}) {
  if (typeof context?.addInitScript === "function")
    await context.addInitScript(overlayBootstrap);
  if (typeof page?.evaluate !== "function")
    throw new Error("capture overlay needs a Playwright page");
  await page.evaluate(overlayBootstrap);
}

async function updateOverlay(page, state) {
  await page.evaluate((next) => {
    if (typeof globalThis.__kandevHighlightOverlay !== "function") {
      throw new Error("Highlight pointer overlay is not installed");
    }
    globalThis.__kandevHighlightOverlay(next);
  }, state);
}

function touchPoint(x, y) {
  return { x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 };
}

function mouseButtons(button) {
  return button === "right" ? 2 : button === "middle" ? 4 : 1;
}

export function createTrustedInputAdapters({ page, cdp, inputKind } = {}) {
  if (!page || !cdp)
    throw new Error("trusted input needs page and CDP session");
  if (!new Set(["desktop", "native-mobile"]).has(inputKind))
    throw new Error("inputKind must be desktop or native-mobile");
  const trustedCursor = async ({ x, y }) => {
    if (inputKind === "desktop") {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "none",
        buttons: 0,
      });
    }
    await updateOverlay(page, { kind: "cursor", x, y, visible: true });
  };
  const trustedActivation = async ({
    x,
    y,
    button = "left",
    clickCount = 1,
  }) => {
    if (inputKind === "native-mobile") {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [touchPoint(x, y)],
      });
      await updateOverlay(page, { kind: "touch", x, y, visible: true });
      if (typeof page.waitForTimeout === "function")
        await page.waitForTimeout(48);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await updateOverlay(page, { kind: "cursor", x, y, visible: true });
      return;
    }
    const buttons = mouseButtons(button);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons,
      clickCount,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount,
    });
  };
  const trustedGesture = {
    async start({ x, y }) {
      if (inputKind === "native-mobile") {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [touchPoint(x, y)],
        });
      } else {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
      }
      await updateOverlay(page, {
        kind: inputKind === "native-mobile" ? "touch" : "cursor",
        x,
        y,
        visible: true,
      });
    },
    async move({ x, y }) {
      if (inputKind === "native-mobile") {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [touchPoint(x, y)],
        });
      } else {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x,
          y,
          button: "left",
          buttons: 1,
        });
      }
      await updateOverlay(page, {
        kind: inputKind === "native-mobile" ? "touch" : "cursor",
        x,
        y,
        visible: true,
      });
    },
    async end({ x, y }) {
      if (inputKind === "native-mobile") {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchEnd",
          touchPoints: [],
        });
      } else {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          buttons: 0,
          clickCount: 1,
        });
      }
      await updateOverlay(page, { kind: "cursor", x, y, visible: true });
    },
  };
  return { trustedCursor, trustedActivation, trustedGesture };
}

export async function measurePointerGlyph(page) {
  return page.evaluate((id) => {
    const rect = document.getElementById(id)?.getBoundingClientRect();
    return rect
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      : null;
  }, OVERLAY_ID);
}

export async function measureTargetGlyph(locator) {
  return locator.evaluate((element) => {
    const preferred = element.matches(
      "[data-highlight-glyph],svg,img,[role=img]",
    )
      ? element
      : element.querySelector("[data-highlight-glyph],svg,img,[role=img]");
    if (preferred) {
      const rect = preferred.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0)
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0)
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
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
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once("close", () => {
      clearTimeout(timeout);
      resolve(true);
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

export async function startFfmpegRecorder({
  command,
  now = () => performance.now(),
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
  const child = spawn(command.command, command.args, {
    stdio: ["pipe", "ignore", "pipe"],
  });
  child.stderr.pipe(log, { end: false });
  try {
    await childSpawned(child, "ffmpeg x11 capture");
    const captureEpochMs = now();
    await waitForRecorderProgress(child, command.progressPath);
    let stopping = null;
    const stop = async () => {
      if (stopping) return stopping;
      stopping = (async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.stdin.write("q\n");
          child.stdin.end();
          if (!(await childExited(child, 8_000))) {
            child.kill("SIGINT");
            if (!(await childExited(child, 3_000))) child.kill("SIGKILL");
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
    return { captureEpochMs, pid: child.pid, stop };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    log.end();
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
} = {}) {
  const stat = await fs.stat(rawMasterPath);
  const storyStartOffsetMs = storyEpochMs - captureEpochMs;
  return {
    contract: "kandev-highlight-source-capture-v1",
    scenarioDigest,
    sourceDigest,
    captureEpochMs,
    storyEpochMs,
    storyStartOffsetMs,
    storyOffsetMs: storyStartOffsetMs,
    storyDurationMs,
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
    runtime: runtime ? structuredClone(runtime) : null,
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
      artifactRoot: plan.artifactRoot,
      profileDir: plan.profileDir,
      lockPath: plan.lockPath,
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

async function writeFailureEvidence(plan, phase, error) {
  if (!plan?.evidenceDir) return;
  const destination = path.join(plan.evidenceDir, "capture.failure.json");
  const evidence = {
    contract: "kandev-highlight-capture-failure-v1",
    phase,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    runtime: runtimeEvidence(plan, null),
  };
  await writeCaptureEvidence(destination, evidence).catch(() => {});
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  resolveCaptureTools,
  chooseReadyCaptureEncoder,
  planCaptureRuntime,
  startCaptureRuntime,
  connectCaptureBrowser,
  configureCaptureTarget,
  installCaptureOverlay,
  createCaptureCursor,
  prepareScenario,
  startFfmpegRecorder,
  executePreparedScenario,
});

export async function captureScenario({
  scenario,
  timeline: suppliedTimeline,
  sourceDigest,
  frontendUrl,
  artifactRoot,
  repositoryRoots = [REPOSITORY_ROOT],
  runId,
  displayNumber,
  cdpPort,
  browserExecutable,
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
  if (!/^https?:\/\//.test(frontendUrl ?? ""))
    throw new Error("captureScenario needs frontendUrl");
  if (scenario.setup?.route && typeof navigateRoute !== "function") {
    throw new Error(
      "captureScenario requires an allowlisted navigateRoute adapter for scenario.setup.route",
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
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const coordinates =
    displayNumber && cdpPort
      ? { displayNumber, cdpPort }
      : await allocateRuntimeCoordinates();
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
    ...coordinates,
    browserExecutable: tools.chromium.executable,
    xvfbExecutable: tools.xvfb.executable,
  });
  let phase = "runtime";
  let liveRuntime;
  let browserConnection;
  let recorder;
  let recorderEvidence;
  let seedProof;
  try {
    liveRuntime = await deps.startCaptureRuntime(plan);
    phase = "browser";
    browserConnection = await deps.connectCaptureBrowser({
      chromiumApi: resolution.chromiumApi,
      endpoint: plan.cdpEndpoint,
    });
    const { page, context, cdp } = browserConnection;
    await deps.configureCaptureTarget({ page, cdp, profile });
    await deps.installCaptureOverlay({ context, page });
    if (typeof preparePage === "function")
      await preparePage({ page, context, cdp, profile, plan });
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
      navigateRoute,
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
    await deps.configureCaptureTarget({ page, cdp, profile });
    const command = buildFfmpegCapturePlan({
      runtime: plan,
      profile,
      encoder: encoderReadiness.encoder,
      ffmpegExecutable: tools.ffmpeg.executable,
    });
    phase = "record";
    recorder = await deps.startFfmpegRecorder({ command, now });
    phase = "execute";
    const execution = await deps.executePreparedScenario({
      prepared,
      timeline,
      now,
    });
    phase = "recorder-teardown";
    recorderEvidence = await recorder.stop();
    const progress = parseCaptureProgress(
      await fs.readFile(command.progressPath, "utf8"),
    );
    const expectedMinimumFrames = Math.max(
      1,
      Math.floor((timeline.totalDurationMs * profile.fps) / 1_000) - 1,
    );
    assertCleanCaptureProgress(progress, { expectedMinimumFrames });
    phase = "browser-teardown";
    await browserConnection.close();
    browserConnection = null;
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
      captureEpochMs: recorder.captureEpochMs,
      storyEpochMs: execution.storyEpochMs,
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
    await recorder?.stop?.().catch(() => {});
    await browserConnection?.close?.().catch(() => {});
    await liveRuntime?.stop?.().catch(() => {});
    await writeFailureEvidence(plan, phase, error);
    throw new Error(
      `Highlight capture failed during ${phase}: ${error.message}`,
      { cause: error },
    );
  }
}
