import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlaywrightChromium } from "../../../../scripts/highlights/capture-source.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_ROOT = path.resolve(HERE, "../..");
const DEFAULT_REPO_ROOT = path.resolve(DEFAULT_WEB_ROOT, "../..");

function activePnpmScript() {
  const script = process.env.npm_execpath;
  return script && /^pnpm(?:\.c?js)?$/i.test(path.basename(script)) ? script : null;
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function executableOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      await fs.access(candidate, fsSync.constants.X_OK);
      return await fs.realpath(candidate);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
    }
  }
  return null;
}

async function playwrightChromium(webRoot) {
  return (await loadPlaywrightChromium(webRoot)).executablePath();
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function buildIntegrationCommand({
  webRoot = DEFAULT_WEB_ROOT,
  nodeExecutable = process.execPath,
  packageManagerScript = activePnpmScript(),
} = {}) {
  const packageManager = packageManagerScript
    ? { command: nodeExecutable, args: [packageManagerScript] }
    : { command: "pnpm", args: [] };
  return {
    command: packageManager.command,
    args: [
      ...packageManager.args,
      "exec",
      "playwright",
      "test",
      "--config",
      "e2e/highlights/playwright.config.ts",
    ],
    cwd: path.resolve(webRoot),
  };
}

export async function resolveIntegrationArtifactRoot({
  parent = os.tmpdir(),
  repositoryRoots = [DEFAULT_REPO_ROOT],
} = {}) {
  const resolvedParent = path.resolve(parent);
  for (const repositoryRoot of repositoryRoots) {
    if (isInside(repositoryRoot, resolvedParent)) {
      throw new Error(
        `Highlight integration artifacts must stay outside repository ${path.resolve(repositoryRoot)}`,
      );
    }
  }
  await fs.mkdir(resolvedParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(resolvedParent, "kandev-highlight-integration-"));
  return root;
}

export async function preflightCaptureIntegration({
  webRoot = DEFAULT_WEB_ROOT,
  findExecutable = executableOnPath,
  resolveChromium = () => playwrightChromium(webRoot),
  exists = pathExists,
} = {}) {
  const repoRoot = path.resolve(webRoot, "../..");
  const [ffmpeg, xvfb, chromium] = await Promise.all([
    findExecutable("ffmpeg"),
    findExecutable("Xvfb"),
    resolveChromium().catch(() => null),
  ]);
  const requiredFiles = {
    backend: path.join(repoRoot, "apps", "backend", "bin", "kandev"),
    mockAgent: path.join(repoRoot, "apps", "backend", "bin", "mock-agent"),
    webBuild: path.join(webRoot, "dist", "index.html"),
  };
  const [backendReady, mockAgentReady, webReady, chromiumReady] = await Promise.all([
    exists(requiredFiles.backend),
    exists(requiredFiles.mockAgent),
    exists(requiredFiles.webBuild),
    chromium ? exists(chromium) : false,
  ]);
  const failures = [];
  if (!ffmpeg) failures.push("FFmpeg missing: install ffmpeg with x11grab + libx264 support.");
  if (!xvfb) failures.push("Xvfb missing: install the X virtual framebuffer package.");
  if (!chromium || !chromiumReady) {
    failures.push(
      "Playwright Chromium missing: run `pnpm exec playwright install chromium` from apps/web.",
    );
  }
  if (!backendReady || !mockAgentReady) {
    failures.push("Kandev E2E binaries missing: run `make -C apps/backend build`.");
  }
  if (!webReady)
    failures.push("Kandev web build missing: run `pnpm --filter @kandev/web build` from apps.");
  if (failures.length)
    throw new Error(`Highlight capture integration preflight failed:\n- ${failures.join("\n- ")}`);
  return { ffmpeg, xvfb, chromium, ...requiredFiles };
}

function run(command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env,
      stdio: "inherit",
    });
    child.once("error", (error) =>
      reject(new Error(`cannot launch ${command.command}: ${error.message}`, { cause: error })),
    );
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Highlight capture integration exited ${code ?? signal}`));
    });
  });
}

export async function runCaptureIntegration() {
  await preflightCaptureIntegration();
  const artifactRoot = await resolveIntegrationArtifactRoot({
    parent: process.env.KANDEV_HIGHLIGHT_ARTIFACT_PARENT ?? os.tmpdir(),
  });
  process.stdout.write(`Highlight integration artifacts: ${artifactRoot}\n`);
  await run(buildIntegrationCommand(), {
    ...process.env,
    KANDEV_HIGHLIGHT_ARTIFACT_ROOT: artifactRoot,
  });
  process.stdout.write(`Highlight integration passed. Artifacts preserved: ${artifactRoot}\n`);
  return artifactRoot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCaptureIntegration().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
