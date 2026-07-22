import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { loadPlaywrightChromium } from "../../../../scripts/highlights/capture-source.mjs";
import { verifySourceGate } from "../../../../scripts/highlights/source-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_ROOT = path.resolve(HERE, "../..");
const DEFAULT_REPO_ROOT = path.resolve(DEFAULT_WEB_ROOT, "../..");

function activePnpmScript() {
  const script = process.env.npm_execpath;
  return script && /^pnpm(?:\.c?js)?$/i.test(path.basename(script)) ? script : null;
}

function packageManagerSpec({
  nodeExecutable = process.execPath,
  packageManagerScript = activePnpmScript(),
} = {}) {
  return packageManagerScript
    ? { command: nodeExecutable, args: [packageManagerScript] }
    : { command: "pnpm", args: [] };
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

function digestBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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

async function tcpPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false);
      else reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

export async function selectIntegrationPortOffset({
  preferredOffset = process.pid % 30,
  isPortFree = tcpPortAvailable,
} = {}) {
  if (!Number.isInteger(preferredOffset) || preferredOffset < 0 || preferredOffset > 29) {
    throw new Error("preferred E2E port offset must be an integer 0-29");
  }
  for (let step = 0; step < 30; step += 1) {
    const offset = (preferredOffset + step) % 30;
    const backendPort = 18_080 + offset;
    if (await isPortFree(backendPort)) return { offset, backendPort };
  }
  throw new Error("no isolated E2E backend port is available in 18080-18109");
}

export async function waitForIntegrationPortRelease(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpPortAvailable(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export function buildIntegrationCommand({
  webRoot = DEFAULT_WEB_ROOT,
  nodeExecutable = process.execPath,
  packageManagerScript = activePnpmScript(),
} = {}) {
  const packageManager = packageManagerSpec({
    nodeExecutable,
    packageManagerScript,
  });
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
  const canonicalParent = await fs.realpath(resolvedParent);
  for (const repositoryRoot of repositoryRoots) {
    let canonicalRepository;
    try {
      canonicalRepository = await fs.realpath(repositoryRoot);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (isInside(canonicalRepository, canonicalParent)) {
      throw new Error(
        `Highlight integration artifacts must stay outside repository ${canonicalRepository} after symlink resolution`,
      );
    }
  }
  const root = await fs.mkdtemp(path.join(canonicalParent, "kandev-highlight-integration-"));
  return root;
}

async function regularFileIdentity(filePath, label) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${filePath}`);
  }
  const bytes = await fs.readFile(filePath);
  return {
    path: path.resolve(filePath),
    bytes: stat.size,
    digest: digestBytes(bytes),
  };
}

async function collectWebDist(root) {
  const resolvedRoot = path.resolve(root);
  const files = [];
  const visit = async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`web dist cannot contain symlinks: ${absolute}`);
      }
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const identity = await regularFileIdentity(absolute, "web dist output");
        files.push({
          path: path.relative(resolvedRoot, absolute).split(path.sep).join("/"),
          bytes: identity.bytes,
          digest: identity.digest,
        });
      } else {
        throw new Error(`web dist contains unsupported filesystem entry: ${absolute}`);
      }
    }
  };
  await visit(resolvedRoot);
  if (files.length === 0) throw new Error(`web dist is empty: ${resolvedRoot}`);
  return {
    path: resolvedRoot,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    fileCount: files.length,
    digest: digestBytes(canonicalJson(files)),
    files,
  };
}

function buildOutputPaths(repoRoot, webRoot) {
  return {
    backend: path.join(repoRoot, "apps", "backend", "bin", "kandev"),
    mockAgent: path.join(repoRoot, "apps", "backend", "bin", "mock-agent"),
    webDist: path.join(webRoot, "dist"),
  };
}

export async function verifyCaptureBuildProvenance(manifestPath, { expectedSourceSha } = {}) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (
    manifest.contract !== "kandev-highlight-build-provenance-v1" ||
    manifest.source?.selectedSha !== expectedSourceSha
  ) {
    throw new Error("build provenance does not match selected source SHA");
  }
  const digestInput = structuredClone(manifest);
  delete digestInput.manifestDigest;
  if (manifest.manifestDigest !== digestBytes(canonicalJson(digestInput))) {
    throw new Error("build provenance manifest digest is invalid");
  }
  const [backend, mockAgent, webDist] = await Promise.all([
    regularFileIdentity(manifest.outputs.backend.path, "backend build output"),
    regularFileIdentity(manifest.outputs.mockAgent.path, "mock-agent build output"),
    collectWebDist(manifest.outputs.webDist.path),
  ]);
  for (const [label, actual] of Object.entries({ backend, mockAgent, webDist })) {
    const expected = manifest.outputs[label];
    if (
      actual.digest !== expected.digest ||
      actual.bytes !== expected.bytes ||
      (label === "webDist" && actual.fileCount !== expected.fileCount)
    ) {
      throw new Error(`build output changed after attestation: ${label} digest mismatch`);
    }
  }
  return manifest;
}

export async function buildCaptureCheckout({
  repoRoot = DEFAULT_REPO_ROOT,
  webRoot = DEFAULT_WEB_ROOT,
  artifactRoot,
  source = "pr_head",
  verifySource = verifySourceGate,
  runCommand = run,
  packageManager = packageManagerSpec(),
  now = () => new Date(),
} = {}) {
  const resolvedRepository = path.resolve(repoRoot);
  const before = await verifySource({ repoRoot: resolvedRepository, source });
  if (before?.clean !== true || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(before.selectedSha ?? "")) {
    throw new Error("capture build needs an exact clean source gate before build");
  }
  const commands = [
    {
      command: "make",
      args: ["-C", "apps/backend", "build"],
      cwd: resolvedRepository,
    },
    {
      command: packageManager.command,
      args: [...packageManager.args, "--filter", "@kandev/web", "build"],
      cwd: path.join(resolvedRepository, "apps"),
    },
  ];
  for (const command of commands) await runCommand(command, process.env);
  const after = await verifySource({ repoRoot: resolvedRepository, source });
  if (after?.clean !== true || after.selectedSha !== before.selectedSha) {
    throw new Error("source checkout changed while producing capture build");
  }
  const outputPaths = buildOutputPaths(resolvedRepository, path.resolve(webRoot));
  const [backend, mockAgent, webDist] = await Promise.all([
    regularFileIdentity(outputPaths.backend, "backend build output"),
    regularFileIdentity(outputPaths.mockAgent, "mock-agent build output"),
    collectWebDist(outputPaths.webDist),
  ]);
  const base = {
    contract: "kandev-highlight-build-provenance-v1",
    builtAt: now().toISOString(),
    source: structuredClone(after),
    commands: commands.map(({ command, args, cwd }) => ({ command, args, cwd })),
    outputs: { backend, mockAgent, webDist },
  };
  const manifest = {
    ...base,
    manifestDigest: digestBytes(canonicalJson(base)),
  };
  const manifestPath = path.join(path.resolve(artifactRoot), "evidence", "build-provenance.json");
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  await verifyCaptureBuildProvenance(manifestPath, {
    expectedSourceSha: after.selectedSha,
  });
  return { manifestPath, manifest };
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
      if (code === 0) resolve({ exitCode: code, signal });
      else reject(new Error(`Highlight capture integration exited ${code ?? signal}`));
    });
  });
}

export async function runCaptureIntegration() {
  const artifactRoot = await resolveIntegrationArtifactRoot({
    parent: process.env.KANDEV_HIGHLIGHT_ARTIFACT_PARENT ?? os.tmpdir(),
  });
  process.stdout.write(`Highlight integration artifacts: ${artifactRoot}\n`);
  const build = await buildCaptureCheckout({ artifactRoot });
  await preflightCaptureIntegration();
  await verifyCaptureBuildProvenance(build.manifestPath, {
    expectedSourceSha: build.manifest.source.selectedSha,
  });
  const port = await selectIntegrationPortOffset();
  const command = buildIntegrationCommand();
  let execution;
  let executionError;
  try {
    execution = await run(command, {
      ...process.env,
      E2E_PORT_OFFSET: String(port.offset),
      KANDEV_HIGHLIGHT_ARTIFACT_ROOT: artifactRoot,
      KANDEV_HIGHLIGHT_BUILD_PROOF: build.manifestPath,
    });
  } catch (error) {
    executionError = error;
  }
  const portReleased = await waitForIntegrationPortRelease(port.backendPort);
  const appReceipt = {
    contract: "kandev-highlight-integration-runtime-v1",
    buildManifestDigest: build.manifest.manifestDigest,
    sourceSha: build.manifest.source.selectedSha,
    isolation: {
      e2ePortOffset: port.offset,
      backendPort: port.backendPort,
      frontendOrigin: `http://localhost:${port.backendPort}`,
    },
    command,
    execution: execution ?? { exitCode: null, error: executionError?.message ?? null },
    teardown: {
      playwrightExited: execution?.exitCode === 0,
      backendPortReleased: portReleased,
    },
    completedAt: new Date().toISOString(),
  };
  const appReceiptPath = path.join(artifactRoot, "evidence", "app-runtime.json");
  await fs.writeFile(appReceiptPath, `${JSON.stringify(appReceipt, null, 2)}\n`, {
    flag: "wx",
  });
  if (executionError || !portReleased) {
    const errors = [
      ...(executionError ? [executionError] : []),
      ...(!portReleased
        ? [new Error(`isolated backend port ${port.backendPort} survived Playwright teardown`)]
        : []),
    ];
    throw errors.length > 1
      ? new AggregateError(errors, "Highlight integration execution and teardown failed")
      : errors[0];
  }
  process.stdout.write(`Highlight integration passed. Artifacts preserved: ${artifactRoot}\n`);
  return artifactRoot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCaptureIntegration().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
