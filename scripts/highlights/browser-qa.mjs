import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const VIDEO_KINDS = new Set(["mp4", "webm"]);

async function defaultLoadChromium({ webRoot }) {
  try {
    const requireFromWeb = createRequire(path.join(webRoot, "package.json"));
    return requireFromWeb("@playwright/test").chromium;
  } catch (error) {
    throw new Error(
      `Playwright Chromium is required for browser playback QA. Run pnpm install from ${path.dirname(webRoot)} and install the configured Chromium browser: ${error.message}`,
      { cause: error },
    );
  }
}

function assertArtifact(artifact, index) {
  if (!artifact || typeof artifact !== "object") throw new Error(`browser artifact ${index} must be an object`);
  if (![...VIDEO_KINDS, "poster"].includes(artifact.kind)) {
    throw new Error(`browser artifact ${index} kind must be mp4, webm, or poster`);
  }
  if (typeof artifact.path !== "string" || !path.isAbsolute(artifact.path)) {
    throw new Error(`browser artifact ${index} path must be absolute`);
  }
  if (!Number.isInteger(artifact.probe?.width) || !Number.isInteger(artifact.probe?.height)) {
    throw new Error(`browser artifact ${index} needs probed dimensions`);
  }
}

function assertCompleteArtifactSet(artifacts) {
  const counts = new Map(["mp4", "webm", "poster"].map((kind) => [kind, 0]));
  for (const artifact of artifacts) counts.set(artifact.kind, (counts.get(artifact.kind) ?? 0) + 1);
  if ([...counts.values()].some((count) => count !== 1) || artifacts.length !== 3) {
    throw new Error("browser playback QA requires exactly one MP4, one WebM, and one poster");
  }
}

function serveRange(request, response, filePath, stat, contentType) {
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-store");
  if (!range) {
    response.writeHead(200, { "Content-Length": stat.size });
    createReadStream(filePath).pipe(response);
    return;
  }
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= stat.size) {
    response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    response.end();
    return;
  }
  response.writeHead(206, {
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
  });
  createReadStream(filePath, { start, end }).pipe(response);
}

async function startMediaServer(artifacts) {
  const routes = new Map();
  artifacts.forEach((artifact, index) => {
    const extension = artifact.kind === "poster" ? "webp" : artifact.kind;
    routes.set(`/media/${index}.${extension}`, {
      ...artifact,
      contentType: artifact.kind === "mp4" ? "video/mp4" : artifact.kind === "webm" ? "video/webm" : "image/webp",
    });
  });
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/") {
      const body = "<!doctype html><meta charset=utf-8><title>Highlight browser QA</title><body></body>";
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
      response.end(body);
      return;
    }
    const artifact = routes.get(pathname);
    if (!artifact) {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const stat = await fs.stat(artifact.path);
      if (!stat.isFile()) throw new Error("not a regular file");
      serveRange(request, response, artifact.path, stat, artifact.contentType);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(`cannot serve QA media: ${error.message}`);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    urlFor(index) {
      return `${origin}${[...routes.keys()][index]}`;
    },
    close() {
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function mediaInspection(input) {
  const fail = (message) => ({ mediaError: message });
  if (input.kind === "poster") {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = async () => {
        try {
          if (typeof image.decode === "function") await image.decode();
          resolve({
            decoded: true,
            mediaError: null,
            width: image.naturalWidth,
            height: image.naturalHeight,
          });
        } catch (error) {
          resolve(fail(`poster decode failed: ${error.message}`));
        }
      };
      image.onerror = () => resolve(fail("poster load error"));
      image.src = input.url;
    });
  }
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.playbackRate = 1;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.remove();
      resolve(value);
    };
    const evidence = () => ({
      durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1_000) : null,
      ended: video.ended,
      height: video.videoHeight,
      mediaError: video.error ? `MEDIA_ERR_${video.error.code}: ${video.error.message || "browser media error"}` : null,
      playbackRate: video.playbackRate,
      width: video.videoWidth,
    });
    const timer = setTimeout(() => finish({ ...evidence(), mediaError: "browser playback timeout" }), input.timeoutMs);
    video.addEventListener("error", () => finish(evidence()), { once: true });
    video.addEventListener("ended", () => finish(evidence()), { once: true });
    video.addEventListener("loadedmetadata", async () => {
      try {
        video.playbackRate = 1;
        await video.play();
      } catch (error) {
        finish({ ...evidence(), mediaError: `play() failed: ${error.message}` });
      }
    }, { once: true });
    document.body.append(video);
    video.src = input.url;
    video.load();
  });
}

function verifyResult(artifact, result) {
  const label = artifact.path;
  if (!result || typeof result !== "object") throw new Error(`${label} browser returned no playback evidence`);
  if (result.mediaError) throw new Error(`${label} browser media error: ${result.mediaError}`);
  if (result.width !== artifact.probe.width || result.height !== artifact.probe.height) {
    throw new Error(
      `${label} browser dimensions expected ${artifact.probe.width}x${artifact.probe.height}, received ${result.width}x${result.height}`,
    );
  }
  if (artifact.kind === "poster") {
    if (!result.decoded) throw new Error(`${label} poster did not decode`);
  } else {
    if (!result.ended) throw new Error(`${label} did not play to completion`);
    if (result.playbackRate !== 1) throw new Error(`${label} playback rate must remain 1x`);
    const toleranceMs = Math.max(120, Math.ceil(2_000 / 25));
    if (!Number.isFinite(result.durationMs) || Math.abs(result.durationMs - artifact.probe.durationMs) > toleranceMs) {
      throw new Error(`${label} browser duration does not match ffprobe duration ${artifact.probe.durationMs}ms`);
    }
  }
  return {
    kind: artifact.kind,
    path: artifact.path,
    passed: true,
    ...result,
  };
}

export async function runBrowserPlaybackQa({
  artifacts,
  chromium,
  loadChromium = defaultLoadChromium,
  webRoot = path.resolve("apps/web"),
  executablePath,
  timeoutPaddingMs = 5_000,
} = {}) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("browser playback QA needs MP4, WebM, and poster artifacts");
  }
  artifacts.forEach(assertArtifact);
  assertCompleteArtifactSet(artifacts);
  let browser;
  let mediaServer;
  try {
    mediaServer = await startMediaServer(artifacts);
    const browserApi = chromium ?? await loadChromium({ webRoot });
    if (!browserApi || typeof browserApi.launch !== "function") {
      throw new Error("Playwright Chromium launch API is unavailable");
    }
    browser = await browserApi.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
    const page = await browser.newPage();
    await page.goto(mediaServer.origin, { waitUntil: "domcontentloaded" });
    const reports = [];
    for (const artifact of artifacts) {
      const duration = VIDEO_KINDS.has(artifact.kind) ? artifact.probe.durationMs : 0;
      const result = await page.evaluate(mediaInspection, {
        kind: artifact.kind,
        url: mediaServer.urlFor(artifacts.indexOf(artifact)),
        timeoutMs: Math.max(10_000, (Number.isFinite(duration) ? duration : 0) + timeoutPaddingMs),
      });
      reports.push(verifyResult(artifact, result));
    }
    return {
      contract: "kandev-highlight-browser-qa-v1",
      passed: true,
      normalSpeed: true,
      reducedMotionTested: false,
      artifacts: reports,
    };
  } catch (error) {
    if (!chromium && /(?:Cannot find|Playwright Chromium|launch API)/i.test(error.message)) {
      throw new Error(`Playwright Chromium browser playback is unavailable: ${error.message}`, { cause: error });
    }
    throw error;
  } finally {
    await browser?.close?.();
    await mediaServer?.close?.();
  }
}
