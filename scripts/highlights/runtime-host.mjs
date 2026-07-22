import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  preflightCaptureIntegration,
  selectIntegrationPortOffset,
  verifyCaptureBuildProvenance,
  waitForIntegrationPortRelease,
} from "../../apps/web/e2e/highlights/run-capture-integration.mjs";
import {
  preflightHighlightRuntime,
  resolveHighlightRuntime,
} from "./runtime-catalog.mjs";
import { computeScenarioDigest, readScenario } from "./scenario.mjs";
import { isDisplayAvailable } from "./capture-runtime.mjs";
import {
  assertExternalArtifactRoot,
  verifySourceGate,
} from "./source-gate.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = path.resolve(MODULE_DIR, "../..");
const DEFAULT_WEB_ROOT = path.join(DEFAULT_REPOSITORY_ROOT, "apps", "web");
const REQUEST_KEYS = Object.freeze([
  "contract",
  "version",
  "runtimeId",
  "scenarioPath",
  "artifactRoot",
  "repositoryRoot",
  "buildManifestPath",
  "source",
  "runId",
  "pullRequest",
]);
const WORKER_RESULT_KEYS = Object.freeze([
  "contract",
  "version",
  "runtimeId",
  "runId",
  "applicationRuntime",
  "capture",
]);
const WORKER_REQUEST_KEYS = Object.freeze([
  "contract",
  "version",
  "runtimeId",
  "scenarioPath",
  "artifactRoot",
  "repositoryRoot",
  "buildManifestPath",
  "source",
  "runId",
  "pullRequest",
  "bundleRoot",
  "sourceProof",
  "build",
  "tools",
  "ports",
]);
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const CAPTURE_CONTENT_BOUNDS = Object.freeze({
  maxVisibleDomTextRecords: 512,
  maxVisibleDomTextBytes: 65_536,
  maxBrowserConsoleRecords: 128,
  maxBrowserConsoleTextBytes: 2_048,
});
const DEFAULT_PROCESS_DEADLINE_MS = 240_000;
const DEFAULT_LOG_LIMIT_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_CONTENT_EVIDENCE_BYTES = 512 * 1024;

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

function digestBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sourceCaptureDigest(request, sourceProof) {
  return digestBytes(
    canonicalJson({
      captureMode: request.source,
      sourceSha: sourceProof.selectedSha,
      ...(request.source === "pr_head"
        ? {
            prNumber: request.pullRequest.number,
            prBaseSha: request.pullRequest.baseSha,
            prHeadSha: sourceProof.selectedSha,
          }
        : { sourceRef: "origin/main" }),
    }),
  );
}

function compactSourceProof(proof) {
  return {
    contract: proof.contract,
    mode: proof.source,
    selectedSha: proof.selectedSha,
    headSha: proof.headSha,
    currentMainSha: proof.currentMainSha,
  };
}

function expectedCapturePaths(workerRequest, scenarioId) {
  const attemptRoot = path.join(
    workerRequest.artifactRoot,
    scenarioId,
    "runs",
    workerRequest.runId,
  );
  const captureRoot = path.join(attemptRoot, "capture");
  return {
    attemptRoot,
    captureRoot,
    phaseManifestPath: path.join(attemptRoot, "evidence", "capture.json"),
    captureManifestPath: path.join(captureRoot, "evidence", "capture.json"),
    rawMasterPath: path.join(captureRoot, "raw", `${scenarioId}.source.mp4`),
    captureEvidencePath: path.join(
      captureRoot,
      "evidence",
      "capture-content.json",
    ),
    runtimeReceiptPath: path.join(
      attemptRoot,
      "evidence",
      "application-runtime.json",
    ),
    captureProfileDir: path.join(captureRoot, "runtime", "browser-profile"),
    captureLockPath: path.join(captureRoot, "runtime", "capture.lock"),
  };
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function validatePullRequest(value, source) {
  if (source === "current_main") {
    if (value !== null)
      throw new Error("current_main pullRequest must be null");
    return null;
  }
  requireExactKeys(value, ["number", "baseSha"], "runtime host pullRequest");
  if (!Number.isInteger(value.number) || value.number <= 0) {
    throw new Error(
      "runtime host pullRequest number must be a positive integer",
    );
  }
  if (!/^[a-f0-9]{40}$/.test(value.baseSha ?? "")) {
    throw new Error(
      "runtime host pullRequest baseSha must be an exact 40-character SHA",
    );
  }
  return { number: value.number, baseSha: value.baseSha };
}

export function validateRuntimeHostRequest(value) {
  requireExactKeys(value, REQUEST_KEYS, "runtime host request");
  if (
    value.contract !== "kandev-highlight-runtime-host-request-v1" ||
    value.version !== 1
  ) {
    throw new Error(
      "runtime host request contract must be kandev-highlight-runtime-host-request-v1 version 1",
    );
  }
  resolveHighlightRuntime(value.runtimeId);
  if (!SAFE_RUN_ID.test(value.runId ?? "")) {
    throw new Error("runtime host runId must be a safe identifier");
  }
  if (!["pr_head", "current_main"].includes(value.source)) {
    throw new Error("runtime host source must be pr_head or current_main");
  }
  const repositoryRoot = requireAbsolute(
    value.repositoryRoot,
    "runtime host repositoryRoot",
  );
  const scenarioPath = requireAbsolute(
    value.scenarioPath,
    "runtime host scenarioPath",
  );
  const artifactRoot = assertExternalArtifactRoot({
    artifactRoot: requireAbsolute(
      value.artifactRoot,
      "runtime host artifactRoot",
    ),
    repoRoots: [repositoryRoot],
  });
  const buildManifestPath = requireAbsolute(
    value.buildManifestPath,
    "runtime host buildManifestPath",
  );
  if (
    !isInside(repositoryRoot, scenarioPath) ||
    scenarioPath === repositoryRoot
  ) {
    throw new Error("runtime host scenarioPath is outside repositoryRoot");
  }
  if (
    !isInside(artifactRoot, buildManifestPath) ||
    buildManifestPath === artifactRoot
  ) {
    throw new Error("runtime host buildManifestPath is outside artifactRoot");
  }
  return {
    contract: value.contract,
    version: value.version,
    runtimeId: value.runtimeId,
    scenarioPath,
    artifactRoot,
    repositoryRoot,
    buildManifestPath,
    source: value.source,
    runId: value.runId,
    pullRequest: validatePullRequest(value.pullRequest, value.source),
  };
}

async function requireCanonicalPath(filePath, { kind, label }) {
  const stat = await fs.lstat(filePath).catch((error) => {
    if (error.code === "ENOENT")
      throw new Error(`${label} does not exist: ${filePath}`);
    throw error;
  });
  if (
    stat.isSymbolicLink() ||
    (kind === "file" ? !stat.isFile() : !stat.isDirectory())
  ) {
    throw new Error(`${label} must be a non-symlink ${kind}: ${filePath}`);
  }
  if ((await fs.realpath(filePath)) !== path.resolve(filePath)) {
    throw new Error(`${label} cannot resolve through symlinks: ${filePath}`);
  }
  return stat;
}

async function rejectSymlinkComponents(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs
      .lstat(current)
      .catch((error) =>
        error.code === "ENOENT" ? null : Promise.reject(error),
      );
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(
        `runtime host path cannot contain symlink components: ${current}`,
      );
    }
  }
}

async function preflightRequestPaths(request, expectedRepositoryRoot) {
  await Promise.all([
    requireCanonicalPath(request.repositoryRoot, {
      kind: "directory",
      label: "repositoryRoot",
    }),
    requireCanonicalPath(request.scenarioPath, {
      kind: "file",
      label: "scenarioPath",
    }),
    requireCanonicalPath(request.artifactRoot, {
      kind: "directory",
      label: "artifactRoot",
    }),
    requireCanonicalPath(request.buildManifestPath, {
      kind: "file",
      label: "buildManifestPath",
    }),
    rejectSymlinkComponents(request.artifactRoot),
  ]);
  const canonicalExpected = await fs.realpath(expectedRepositoryRoot);
  if (request.repositoryRoot !== canonicalExpected) {
    throw new Error(
      `runtime host repositoryRoot must be the trusted checkout ${canonicalExpected}`,
    );
  }
}

function compactBuildProof(proof, sourceProof) {
  if (
    proof?.contract !== "kandev-highlight-build-provenance-v1" ||
    !DIGEST_PATTERN.test(proof.manifestDigest ?? "") ||
    proof.source?.selectedSha !== sourceProof.selectedSha
  ) {
    throw new Error(
      "runtime host build proof does not bind the selected source SHA",
    );
  }
  const outputs = {};
  for (const key of ["backend", "mockAgent", "webDist"]) {
    const output = proof.outputs?.[key];
    if (
      !DIGEST_PATTERN.test(output?.digest ?? "") ||
      !Number.isInteger(output?.bytes) ||
      output.bytes <= 0 ||
      (key === "webDist" &&
        (!Number.isInteger(output.fileCount) || output.fileCount <= 0))
    ) {
      throw new Error(`runtime host build proof has invalid ${key} identity`);
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
    sourceSha: sourceProof.selectedSha,
    outputs,
  };
}

function validateSourceProof(proof, request) {
  if (
    proof?.contract !== "kandev-highlight-source-v1" ||
    proof.source !== request.source ||
    proof.clean !== true ||
    proof.status !== "" ||
    !SHA_PATTERN.test(proof.selectedSha ?? "")
  ) {
    throw new Error(
      "runtime host source gate did not return an exact clean source proof",
    );
  }
  return structuredClone(proof);
}

function validateToolPreflight(tools) {
  const value = {};
  for (const key of [
    "ffmpeg",
    "xvfb",
    "chromium",
    "backend",
    "mockAgent",
    "webBuild",
  ]) {
    if (typeof tools?.[key] !== "string" || !path.isAbsolute(tools[key])) {
      throw new Error(`runtime host preflight needs absolute ${key} path`);
    }
    value[key] = path.resolve(tools[key]);
  }
  return value;
}

export function validateRuntimeWorkerRequest(value) {
  requireExactKeys(value, WORKER_REQUEST_KEYS, "runtime worker request");
  if (
    value.contract !== "kandev-highlight-runtime-worker-request-v1" ||
    value.version !== 1
  ) {
    throw new Error(
      "runtime worker request contract must be kandev-highlight-runtime-worker-request-v1 version 1",
    );
  }
  resolveHighlightRuntime(value.runtimeId);
  if (!SAFE_RUN_ID.test(value.runId ?? "")) {
    throw new Error("runtime worker request runId must be a safe identifier");
  }
  if (!["pr_head", "current_main"].includes(value.source)) {
    throw new Error(
      "runtime worker request source must be pr_head or current_main",
    );
  }
  const repositoryRoot = requireAbsolute(
    value.repositoryRoot,
    "runtime worker repositoryRoot",
  );
  const artifactRoot = requireAbsolute(
    value.artifactRoot,
    "runtime worker artifactRoot",
  );
  const scenarioPath = requireAbsolute(
    value.scenarioPath,
    "runtime worker scenarioPath",
  );
  const buildManifestPath = requireAbsolute(
    value.buildManifestPath,
    "runtime worker buildManifestPath",
  );
  const bundleRoot = requireAbsolute(
    value.bundleRoot,
    "runtime worker bundleRoot",
  );
  if (
    !isInside(repositoryRoot, scenarioPath) ||
    scenarioPath === repositoryRoot
  ) {
    throw new Error("runtime worker scenarioPath is outside repositoryRoot");
  }
  if (
    !isInside(artifactRoot, buildManifestPath) ||
    buildManifestPath === artifactRoot
  ) {
    throw new Error("runtime worker buildManifestPath is outside artifactRoot");
  }
  if (
    bundleRoot !== path.join(artifactRoot, "runtime-host", value.runId) ||
    !isInside(artifactRoot, bundleRoot)
  ) {
    throw new Error(
      "runtime worker bundleRoot must be the fixed runtime-host run directory",
    );
  }
  const sourceProof = requireExactKeys(
    value.sourceProof,
    [
      "contract",
      "source",
      "repoRoot",
      "selectedSha",
      "headSha",
      "currentMainSha",
      "clean",
      "status",
    ],
    "runtime worker sourceProof",
  );
  if (
    sourceProof.contract !== "kandev-highlight-source-v1" ||
    sourceProof.source !== value.source ||
    sourceProof.repoRoot !== repositoryRoot ||
    sourceProof.clean !== true ||
    sourceProof.status !== "" ||
    !SHA_PATTERN.test(sourceProof.selectedSha ?? "") ||
    !SHA_PATTERN.test(sourceProof.headSha ?? "") ||
    !SHA_PATTERN.test(sourceProof.currentMainSha ?? "")
  ) {
    throw new Error("runtime worker sourceProof is not exact and clean");
  }
  requireExactKeys(
    value.build,
    ["contract", "manifestDigest", "sourceSha", "outputs"],
    "runtime worker build",
  );
  requireExactKeys(
    value.build.outputs,
    ["backend", "mockAgent", "webDist"],
    "runtime worker build outputs",
  );
  if (
    value.build.contract !== "kandev-highlight-build-provenance-v1" ||
    !DIGEST_PATTERN.test(value.build.manifestDigest ?? "") ||
    value.build.sourceSha !== sourceProof.selectedSha
  ) {
    throw new Error("runtime worker build identity is invalid");
  }
  for (const key of ["backend", "mockAgent", "webDist"]) {
    const output = value.build.outputs[key];
    const expectedKeys =
      key === "webDist"
        ? ["digest", "bytes", "fileCount"]
        : ["digest", "bytes"];
    requireExactKeys(output, expectedKeys, `runtime worker build ${key}`);
    if (
      !DIGEST_PATTERN.test(output.digest ?? "") ||
      !Number.isInteger(output.bytes) ||
      output.bytes <= 0 ||
      (key === "webDist" &&
        (!Number.isInteger(output.fileCount) || output.fileCount <= 0))
    ) {
      throw new Error(`runtime worker build ${key} identity is invalid`);
    }
  }
  const tools = validateToolPreflight(
    requireExactKeys(
      value.tools,
      ["ffmpeg", "xvfb", "chromium", "backend", "mockAgent", "webBuild"],
      "runtime worker tools",
    ),
  );
  requireExactKeys(value.ports, ["offset", "backend"], "runtime worker ports");
  if (
    !Number.isInteger(value.ports.offset) ||
    value.ports.offset < 0 ||
    value.ports.offset > 29 ||
    value.ports.backend !== 18_080 + value.ports.offset
  ) {
    throw new Error(
      "runtime worker ports do not match the fixed E2E allocation",
    );
  }
  return {
    contract: value.contract,
    version: value.version,
    runtimeId: value.runtimeId,
    scenarioPath,
    artifactRoot,
    repositoryRoot,
    buildManifestPath,
    source: value.source,
    runId: value.runId,
    pullRequest: validatePullRequest(value.pullRequest, value.source),
    bundleRoot,
    sourceProof: structuredClone(sourceProof),
    build: structuredClone(value.build),
    tools,
    ports: structuredClone(value.ports),
  };
}

export function sanitizeRuntimeHostEnvironment(
  inheritedEnv = {},
  options = {},
) {
  requireExactKeys(
    options,
    [
      "homeRoot",
      "requestPath",
      "workerResultPath",
      "fixtureRoot",
      "portOffset",
      "playwrightBrowsersPath",
    ],
    "runtime host environment options",
  );
  const clean = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ"]) {
    if (typeof inheritedEnv[key] === "string" && inheritedEnv[key] !== "") {
      clean[key] = inheritedEnv[key];
    }
  }
  if (
    !Number.isInteger(options.portOffset) ||
    options.portOffset < 0 ||
    options.portOffset > 29
  ) {
    throw new Error("runtime host portOffset must be an integer 0-29");
  }
  return {
    ...clean,
    HOME: requireAbsolute(options.homeRoot, "runtime host HOME"),
    CI: "1",
    E2E_PORT_OFFSET: String(options.portOffset),
    PLAYWRIGHT_BROWSERS_PATH: requireAbsolute(
      options.playwrightBrowsersPath,
      "runtime host Playwright browsers root",
    ),
    KANDEV_HIGHLIGHT_RUNTIME_REQUEST: requireAbsolute(
      options.requestPath,
      "runtime host worker request",
    ),
    KANDEV_HIGHLIGHT_RUNTIME_WORKER_RESULT: requireAbsolute(
      options.workerResultPath,
      "runtime host worker result",
    ),
    KANDEV_HIGHLIGHT_FIXTURE_ROOT: requireAbsolute(
      options.fixtureRoot,
      "runtime host fixture root",
    ),
  };
}

function playwrightBrowsersRoot(chromiumExecutable) {
  let current = path.dirname(
    requireAbsolute(chromiumExecutable, "Chromium executable"),
  );
  while (current !== path.dirname(current)) {
    if (/^chromium-\d+$/.test(path.basename(current))) {
      return path.dirname(current);
    }
    current = path.dirname(current);
  }
  throw new Error(
    "runtime host cannot derive the verified Playwright browsers root from Chromium",
  );
}

export function buildRuntimeHostCommand({
  webRoot = DEFAULT_WEB_ROOT,
  nodeExecutable = process.execPath,
} = {}) {
  return {
    command: path.resolve(nodeExecutable),
    args: [
      path.join(
        path.resolve(webRoot),
        "node_modules",
        "@playwright",
        "test",
        "cli.js",
      ),
      "test",
      "--config",
      "e2e/highlights/pipeline-playwright.config.ts",
    ],
    cwd: path.resolve(webRoot),
  };
}

function duration(value, fallback, label) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return selected;
}

function waitMilliseconds(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupGone(pid, killProcess = process.kill) {
  try {
    killProcess(-pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    if (error.code === "EPERM") return false;
    throw error;
  }
}

async function waitForProcessGroupGone(
  pid,
  timeoutMs,
  { killProcess = process.kill } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processGroupGone(pid, killProcess)) return true;
    await waitMilliseconds(20);
  }
  return processGroupGone(pid, killProcess);
}

export async function runOwnedRuntimeProcess({
  command,
  env,
  logPath,
  deadlineMs = DEFAULT_PROCESS_DEADLINE_MS,
  termGraceMs = 5_000,
  killGraceMs = 2_000,
  logLimitBytes = DEFAULT_LOG_LIMIT_BYTES,
  signalSource = process,
  spawnProcess = spawn,
  killProcess = process.kill,
} = {}) {
  const trustedDeadline = duration(deadlineMs, null, "runtime deadlineMs");
  const trustedTermGrace = duration(termGraceMs, null, "runtime termGraceMs");
  const trustedKillGrace = duration(killGraceMs, null, "runtime killGraceMs");
  const trustedLogLimit = duration(
    logLimitBytes,
    null,
    "runtime logLimitBytes",
  );
  if (
    !isRecord(command) ||
    typeof command.command !== "string" ||
    !path.isAbsolute(command.command) ||
    !Array.isArray(command.args) ||
    typeof command.cwd !== "string" ||
    !path.isAbsolute(command.cwd)
  ) {
    throw new Error("owned runtime process requires an absolute fixed command");
  }
  const log = await fs.open(
    logPath,
    fsConstants.O_WRONLY |
      fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  let child;
  let logWrites = Promise.resolve();
  let capturedBytes = 0;
  let discardedBytes = 0;
  let termSent = false;
  let killSent = false;
  let timedOut = false;
  let parentSignal = null;
  let closeOutcome = null;
  let finishClose;
  const closed = new Promise((resolve) => {
    finishClose = resolve;
  });
  let finishStopStarted;
  const stopStarted = new Promise((resolve) => {
    finishStopStarted = resolve;
  });
  const consume = (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const available = Math.max(0, trustedLogLimit - capturedBytes);
    const retained = bytes.subarray(0, available);
    capturedBytes += retained.byteLength;
    discardedBytes += bytes.byteLength - retained.byteLength;
    if (retained.byteLength > 0) {
      logWrites = logWrites.then(() => log.write(retained));
    }
  };
  const sendGroupSignal = (signal) => {
    if (!child?.pid) return;
    try {
      killProcess(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  let stopping = null;
  const stop = () => {
    if (stopping) return stopping;
    finishStopStarted();
    stopping = (async () => {
      if (!child?.pid || processGroupGone(child.pid, killProcess)) return;
      termSent = true;
      sendGroupSignal("SIGTERM");
      if (
        await waitForProcessGroupGone(child.pid, trustedTermGrace, {
          killProcess,
        })
      ) {
        return;
      }
      killSent = true;
      sendGroupSignal("SIGKILL");
      await waitForProcessGroupGone(child.pid, trustedKillGrace, {
        killProcess,
      });
    })();
    return stopping;
  };
  const signalHandlers = new Map();
  let deadline;
  try {
    child = spawnProcess(command.command, command.args, {
      cwd: command.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("error", (error) => {
      if (!closeOutcome) {
        closeOutcome = { launchError: error, exitCode: null, signal: null };
        finishClose(closeOutcome);
      }
    });
    child.once("close", (exitCode, signal) => {
      if (!closeOutcome) {
        closeOutcome = { launchError: null, exitCode, signal };
        finishClose(closeOutcome);
      }
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        parentSignal ??= signal;
        void stop();
      };
      signalHandlers.set(signal, handler);
      signalSource.on(signal, handler);
    }
    deadline = setTimeout(() => {
      timedOut = true;
      void stop();
    }, trustedDeadline);
    deadline.unref?.();
    await Promise.race([
      closed,
      (async () => {
        await stopStarted;
        await stopping;
        if (!closeOutcome) {
          closeOutcome = {
            launchError: null,
            exitCode: null,
            signal: killSent ? "SIGKILL" : "SIGTERM",
          };
          finishClose(closeOutcome);
        }
      })(),
    ]);
    if (stopping) await stopping;
    let gone = child.pid ? processGroupGone(child.pid, killProcess) : true;
    if (!gone) {
      await stop();
      gone = processGroupGone(child.pid, killProcess);
    }
    await logWrites;
    if (closeOutcome.launchError) {
      throw new Error(
        `cannot launch fixed Highlight Playwright host: ${closeOutcome.launchError.message}`,
        { cause: closeOutcome.launchError },
      );
    }
    if (parentSignal && signalSource === process) {
      process.exitCode = parentSignal === "SIGINT" ? 130 : 143;
    }
    return {
      exitCode: parentSignal ? null : closeOutcome.exitCode,
      signal: parentSignal ?? closeOutcome.signal,
      timedOut,
      deadlineMs: trustedDeadline,
      processGroup: {
        pid: child.pid ?? null,
        termSent,
        killSent,
        exited: closeOutcome.exitCode !== null || closeOutcome.signal !== null,
        gone,
      },
      log: {
        limitBytes: trustedLogLimit,
        capturedBytes,
        discardedBytes,
        truncated: discardedBytes > 0,
      },
    };
  } finally {
    if (deadline) clearTimeout(deadline);
    for (const [signal, handler] of signalHandlers) {
      signalSource.off(signal, handler);
    }
    if (child?.pid && !processGroupGone(child.pid, killProcess)) {
      try {
        await stop();
      } catch {
        // The caller receives the primary launch/execution failure.
      }
    }
    await logWrites.catch(() => {});
    await log.close();
  }
}

async function defaultProcessRunner(options) {
  return runOwnedRuntimeProcess(options);
}

async function regularFileSnapshot(filePath, label, { maxBytes = null } = {}) {
  const pathStat = await requireCanonicalPath(filePath, {
    kind: "file",
    label,
  });
  let handle;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new Error(
      `cannot open ${label} without following symlinks: ${error.message}`,
    );
  }
  try {
    const before = await handle.stat();
    if (before.dev !== pathStat.dev || before.ino !== pathStat.ino) {
      throw new Error(`${label} changed while opening: ${filePath}`);
    }
    if (maxBytes !== null && before.size > maxBytes) {
      throw new Error(
        `${label} exceeds its ${maxBytes}-byte bound: ${before.size}`,
      );
    }
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      contents.byteLength !== before.size
    ) {
      throw new Error(`${label} changed while reading: ${filePath}`);
    }
    return {
      path: path.resolve(filePath),
      bytes: before.size,
      digest: digestBytes(contents),
      contents,
      stat: before,
    };
  } finally {
    await handle.close();
  }
}

async function fileIdentity(filePath, label) {
  const snapshot = await regularFileSnapshot(filePath, label);
  return {
    path: snapshot.path,
    bytes: snapshot.bytes,
    digest: snapshot.digest,
  };
}

async function writeJsonExclusive(filePath, value, label) {
  try {
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`refusing to overwrite ${label}: ${filePath}`);
    throw error;
  }
}

async function writeJsonAtomicExclusive(filePath, value, label) {
  const temporary = `${filePath}.tmp-${process.pid}-${createHash("sha256")
    .update(`${filePath}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 12)}`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.link(temporary, filePath);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`refusing to overwrite ${label}: ${filePath}`);
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function readJsonRegular(filePath, label) {
  const snapshot = await regularFileSnapshot(filePath, label);
  try {
    return JSON.parse(snapshot.contents.toString("utf8"));
  } catch (error) {
    throw new Error(`cannot parse ${label}: ${error.message}`);
  }
}

function validateApplicationRuntime(value, workerRequest) {
  requireExactKeys(
    value,
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
    value.contract !== "kandev-highlight-application-runtime-pre-teardown-v1" ||
    value.version !== 1 ||
    value.runtimeId !== workerRequest.runtimeId
  ) {
    throw new Error(
      "applicationRuntime contract, version, or runtimeId is invalid",
    );
  }
  requireExactKeys(
    value.ports,
    ["backend", "frontend"],
    "applicationRuntime ports",
  );
  let origin;
  try {
    origin = new URL(value.origin);
  } catch {
    throw new Error(
      "applicationRuntime origin must be an absolute loopback URL",
    );
  }
  if (
    value.ports.backend !== workerRequest.ports.backend ||
    value.ports.frontend !== workerRequest.ports.backend ||
    origin.origin !== value.origin ||
    origin.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(origin.hostname) ||
    Number(origin.port) !== workerRequest.ports.backend
  ) {
    throw new Error(
      "applicationRuntime origin and ports do not match allocated runtime",
    );
  }
  requireExactKeys(
    value.isolation,
    [
      "fixtureTempRoot",
      "homeRoot",
      "databasePath",
      "worktreeRoot",
      "repositoryCloneRoot",
    ],
    "applicationRuntime isolation",
  );
  for (const [key, nested] of Object.entries(value.isolation)) {
    requireAbsolute(nested, `applicationRuntime isolation ${key}`);
  }
  const tempRoot = path.resolve(value.isolation.fixtureTempRoot);
  const expectedTempRoot = path.join(workerRequest.bundleRoot, "fixture-root");
  if (tempRoot !== expectedTempRoot) {
    throw new Error(
      "applicationRuntime fixtureTempRoot must equal the host-owned fixture root",
    );
  }
  for (const key of [
    "homeRoot",
    "databasePath",
    "worktreeRoot",
    "repositoryCloneRoot",
  ]) {
    if (
      !isInside(tempRoot, value.isolation[key]) ||
      path.resolve(value.isolation[key]) === tempRoot
    ) {
      throw new Error(
        `applicationRuntime isolation ${key} must be inside fixtureTempRoot`,
      );
    }
  }
  requireExactKeys(
    value.providerRouting,
    [
      "profile",
      "mockAgent",
      "mockProviders",
      "liveCredentialsPresent",
      "environmentSanitized",
    ],
    "applicationRuntime providerRouting",
  );
  if (
    value.providerRouting.profile !== "e2e" ||
    value.providerRouting.mockAgent !== true ||
    value.providerRouting.mockProviders !== true ||
    value.providerRouting.liveCredentialsPresent !== false ||
    value.providerRouting.environmentSanitized !== true
  ) {
    throw new Error(
      "applicationRuntime provider routing must prove isolated mocks and no live credentials",
    );
  }
  requireExactKeys(
    value.source,
    ["contract", "mode", "selectedSha"],
    "applicationRuntime source",
  );
  if (
    value.source.contract !== workerRequest.sourceProof.contract ||
    value.source.mode !== workerRequest.sourceProof.source ||
    value.source.selectedSha !== workerRequest.sourceProof.selectedSha
  ) {
    throw new Error("applicationRuntime source identity mismatch");
  }
  requireExactKeys(
    value.build,
    ["contract", "manifestDigest", "sourceSha", "outputs"],
    "applicationRuntime build",
  );
  requireExactKeys(
    value.build.outputs,
    ["backend", "mockAgent", "webDist"],
    "applicationRuntime build outputs",
  );
  if (
    value.build.contract !== workerRequest.build.contract ||
    value.build.manifestDigest !== workerRequest.build.manifestDigest ||
    value.build.sourceSha !== workerRequest.sourceProof.selectedSha ||
    Object.entries(value.build.outputs).some(
      ([key, digest]) => digest !== workerRequest.build.outputs[key]?.digest,
    )
  ) {
    throw new Error("applicationRuntime build identity mismatch");
  }
  return structuredClone(value);
}

function validateCaptureEvidence(value) {
  requireExactKeys(
    value,
    [
      "contract",
      "version",
      "path",
      "bytes",
      "digest",
      "visibleDomText",
      "browserConsole",
    ],
    "captureEvidence",
  );
  if (
    value.contract !== "kandev-highlight-capture-evidence-v1" ||
    value.version !== 1 ||
    !path.isAbsolute(value.path ?? "") ||
    !Number.isInteger(value.bytes) ||
    value.bytes <= 0 ||
    !DIGEST_PATTERN.test(value.digest ?? "")
  ) {
    throw new Error("captureEvidence identity is invalid");
  }
  for (const key of ["visibleDomText", "browserConsole"]) {
    const section = value[key];
    requireExactKeys(
      section,
      ["records", "bytes", "digest", "truncated"],
      `captureEvidence ${key}`,
    );
    if (
      !Number.isInteger(section.records) ||
      section.records < 0 ||
      !Number.isInteger(section.bytes) ||
      section.bytes < 0 ||
      !DIGEST_PATTERN.test(section.digest ?? "") ||
      typeof section.truncated !== "boolean"
    ) {
      throw new Error(`captureEvidence ${key} summary is invalid`);
    }
  }
  return structuredClone(value);
}

function validateCaptureContent(value) {
  requireExactKeys(
    value,
    [
      "contract",
      "version",
      "bounds",
      "visibleDomText",
      "browserConsole",
      "truncated",
    ],
    "capture content",
  );
  if (
    value.contract !== "kandev-highlight-capture-content-v1" ||
    value.version !== 1
  ) {
    throw new Error("capture content contract must be version 1");
  }
  requireExactKeys(
    value.bounds,
    Object.keys(CAPTURE_CONTENT_BOUNDS),
    "capture content bounds",
  );
  for (const [key, expected] of Object.entries(CAPTURE_CONTENT_BOUNDS)) {
    if (value.bounds[key] !== expected) {
      throw new Error(`capture content ${key} must equal ${expected}`);
    }
  }
  requireExactKeys(
    value.truncated,
    ["visibleDomText", "browserConsole"],
    "capture content truncated",
  );
  if (
    typeof value.truncated.visibleDomText !== "boolean" ||
    typeof value.truncated.browserConsole !== "boolean"
  ) {
    throw new Error("capture content truncated flags must be boolean");
  }
  if (
    !Array.isArray(value.visibleDomText) ||
    value.visibleDomText.length >
      CAPTURE_CONTENT_BOUNDS.maxVisibleDomTextRecords ||
    value.visibleDomText.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("capture content visibleDomText exceeds its record bound");
  }
  const visibleBytes = value.visibleDomText.reduce(
    (total, entry) => total + Buffer.byteLength(entry),
    0,
  );
  if (visibleBytes > CAPTURE_CONTENT_BOUNDS.maxVisibleDomTextBytes) {
    throw new Error("capture content visibleDomText exceeds its byte bound");
  }
  if (
    !Array.isArray(value.browserConsole) ||
    value.browserConsole.length >
      CAPTURE_CONTENT_BOUNDS.maxBrowserConsoleRecords
  ) {
    throw new Error("capture content browserConsole exceeds its record bound");
  }
  let consoleBytes = 0;
  for (const [index, record] of value.browserConsole.entries()) {
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
        digestBytes(canonicalJson({ type: record.type, text: record.text }))
    ) {
      throw new Error(`capture content browserConsole ${index} is invalid`);
    }
    consoleBytes += Buffer.byteLength(record.text);
  }
  return {
    value: structuredClone(value),
    visibleDomText: {
      records: value.visibleDomText.length,
      bytes: visibleBytes,
      digest: digestBytes(canonicalJson(value.visibleDomText)),
      truncated: value.truncated.visibleDomText,
    },
    browserConsole: {
      records: value.browserConsole.length,
      bytes: consoleBytes,
      digest: digestBytes(canonicalJson(value.browserConsole)),
      truncated: value.truncated.browserConsole,
    },
  };
}

export function validateRuntimeWorkerResult(value, workerRequest) {
  const trustedRequest = validateRuntimeWorkerRequest(workerRequest);
  requireExactKeys(value, WORKER_RESULT_KEYS, "runtime worker result");
  if (
    value.contract !== "kandev-highlight-runtime-worker-result-v1" ||
    value.version !== 1 ||
    value.runtimeId !== trustedRequest.runtimeId ||
    value.runId !== trustedRequest.runId
  ) {
    throw new Error("runtime worker result contract or identity mismatch");
  }
  const applicationRuntime = validateApplicationRuntime(
    value.applicationRuntime,
    trustedRequest,
  );
  requireExactKeys(
    value.capture,
    [
      "phaseManifestPath",
      "captureManifestPath",
      "rawMasterPath",
      "scenarioDigest",
      "sourceDigest",
      "rawMasterDigest",
      "captureEvidence",
    ],
    "runtime worker capture",
  );
  for (const key of [
    "phaseManifestPath",
    "captureManifestPath",
    "rawMasterPath",
  ]) {
    if (!path.isAbsolute(value.capture[key] ?? "")) {
      throw new Error(`runtime worker capture ${key} must be absolute`);
    }
  }
  for (const key of ["scenarioDigest", "sourceDigest", "rawMasterDigest"]) {
    if (!DIGEST_PATTERN.test(value.capture[key] ?? "")) {
      throw new Error(`runtime worker capture ${key} must be SHA-256`);
    }
  }
  return {
    ...structuredClone(value),
    applicationRuntime,
    capture: {
      ...structuredClone(value.capture),
      captureEvidence: validateCaptureEvidence(value.capture.captureEvidence),
    },
  };
}

export async function writeRuntimeWorkerResult(
  destination,
  value,
  workerRequest,
) {
  const trustedRequest = validateRuntimeWorkerRequest(workerRequest);
  const absolute = requireAbsolute(
    destination,
    "runtime worker result destination",
  );
  if (
    absolute !== path.join(trustedRequest.bundleRoot, "worker-result.json") ||
    !isInside(trustedRequest.bundleRoot, absolute)
  ) {
    throw new Error(
      "runtime worker result destination must be fixed inside bundleRoot",
    );
  }
  const validated = validateRuntimeWorkerResult(value, trustedRequest);
  await writeJsonExclusive(absolute, validated, "runtime worker result");
  return validated;
}

async function verifyCaptureArtifacts(
  workerResult,
  workerRequest,
  { scenarioId, scenarioDigest, sourceDigest },
) {
  const expected = expectedCapturePaths(workerRequest, scenarioId);
  for (const [key, expectedPath] of Object.entries({
    phaseManifestPath: expected.phaseManifestPath,
    captureManifestPath: expected.captureManifestPath,
    rawMasterPath: expected.rawMasterPath,
    captureEvidencePath: expected.captureEvidencePath,
  })) {
    const actual =
      key === "captureEvidencePath"
        ? workerResult.capture.captureEvidence.path
        : workerResult.capture[key];
    if (path.resolve(actual) !== expectedPath) {
      throw new Error(
        `runtime worker ${key} must equal the fixed scenario/run capture path`,
      );
    }
  }
  const [phaseSnapshot, captureSnapshot, rawSnapshot, evidenceSnapshot] =
    await Promise.all([
      regularFileSnapshot(expected.phaseManifestPath, "capture phase manifest"),
      regularFileSnapshot(
        expected.captureManifestPath,
        "source capture manifest",
      ),
      regularFileSnapshot(expected.rawMasterPath, "raw capture master"),
      regularFileSnapshot(
        expected.captureEvidencePath,
        "capture content evidence",
        {
          maxBytes: MAX_CAPTURE_CONTENT_EVIDENCE_BYTES,
        },
      ),
    ]);
  let phase;
  let receipt;
  let captureContent;
  try {
    phase = JSON.parse(phaseSnapshot.contents.toString("utf8"));
    receipt = JSON.parse(captureSnapshot.contents.toString("utf8"));
    captureContent = validateCaptureContent(
      JSON.parse(evidenceSnapshot.contents.toString("utf8")),
    );
  } catch (error) {
    throw new Error(`cannot parse verified capture evidence: ${error.message}`);
  }
  const phaseDigestInput = structuredClone(phase);
  delete phaseDigestInput.recordDigest;
  if (
    phase.contract !== "kandev-highlight-capture-phase-v1" ||
    phase.phase !== "capture" ||
    phase.recordDigest !== digestBytes(canonicalJson(phaseDigestInput))
  ) {
    throw new Error(
      "capture phase manifest contract or record digest is invalid",
    );
  }
  if (canonicalJson(phase.value?.receipt) !== canonicalJson(receipt)) {
    throw new Error("capture phase and source capture receipt differ");
  }
  if (
    receipt.contract !== "kandev-highlight-source-capture-v1" ||
    receipt.scenarioDigest !== scenarioDigest ||
    workerResult.capture.scenarioDigest !== scenarioDigest ||
    receipt.sourceDigest !== sourceDigest ||
    workerResult.capture.sourceDigest !== sourceDigest ||
    receipt.source?.selectedSha !== workerRequest.sourceProof.selectedSha ||
    receipt.build?.manifestDigest !== workerRequest.build.manifestDigest ||
    phase.value?.rawMasterPath !== expected.rawMasterPath ||
    phase.value?.captureManifestPath !== expected.captureManifestPath ||
    receipt.rawMaster?.path !== expected.rawMasterPath ||
    receipt.rawMaster?.bytes !== rawSnapshot.bytes ||
    receipt.rawMaster?.digest !== rawSnapshot.digest ||
    workerResult.capture.rawMasterDigest !== rawSnapshot.digest ||
    canonicalJson(receipt.applicationRuntime) !==
      canonicalJson(workerResult.applicationRuntime) ||
    canonicalJson(receipt.captureEvidence) !==
      canonicalJson(workerResult.capture.captureEvidence)
  ) {
    throw new Error(
      "source capture receipt is not linked to runtime, source, build, or raw master",
    );
  }
  if (
    evidenceSnapshot.bytes !== workerResult.capture.captureEvidence.bytes ||
    evidenceSnapshot.digest !== workerResult.capture.captureEvidence.digest
  ) {
    throw new Error("capture content evidence hash or byte count mismatch");
  }
  for (const key of ["visibleDomText", "browserConsole"]) {
    if (
      canonicalJson(captureContent[key]) !==
      canonicalJson(workerResult.capture.captureEvidence[key])
    ) {
      throw new Error(`capture content ${key} summary mismatch`);
    }
  }
  return {
    attemptRoot: expected.attemptRoot,
    scenarioDigest,
    sourceDigest,
    phaseManifestPath: phaseSnapshot.path,
    phaseManifestDigest: phaseSnapshot.digest,
    captureManifestPath: captureSnapshot.path,
    captureManifestDigest: captureSnapshot.digest,
    rawMasterPath: rawSnapshot.path,
    rawMasterDigest: rawSnapshot.digest,
    rawMaster: {
      path: rawSnapshot.path,
      bytes: rawSnapshot.bytes,
      digest: rawSnapshot.digest,
    },
    captureEvidence: workerResult.capture.captureEvidence,
    receipt,
  };
}

async function verifyCaptureTeardown(capture, workerRequest, scenarioId, deps) {
  const runtime = capture.receipt?.runtime;
  requireExactKeys(runtime, ["allocation", "teardown"], "capture runtime");
  requireExactKeys(
    runtime.allocation,
    [
      "display",
      "displayNumber",
      "cdpPort",
      "artifactRoot",
      "profileDir",
      "lockPath",
    ],
    "capture runtime allocation",
  );
  const expected = expectedCapturePaths(workerRequest, scenarioId);
  if (
    !Number.isInteger(runtime.allocation.displayNumber) ||
    runtime.allocation.display !== `:${runtime.allocation.displayNumber}.0` ||
    !Number.isInteger(runtime.allocation.cdpPort) ||
    runtime.allocation.cdpPort < 1_024 ||
    runtime.allocation.cdpPort > 65_535 ||
    runtime.allocation.artifactRoot !== expected.captureRoot ||
    runtime.allocation.profileDir !== expected.captureProfileDir ||
    runtime.allocation.lockPath !== expected.captureLockPath
  ) {
    throw new Error(
      "capture runtime allocation does not match fixed attempt paths",
    );
  }
  requireExactKeys(
    runtime.teardown,
    [
      "processesGone",
      "coordinatesReleased",
      "profileRemoved",
      "lockRemoved",
      "display",
      "cdpPort",
      "processes",
      "recorder",
    ],
    "capture runtime teardown",
  );
  requireExactKeys(
    runtime.teardown.recorder,
    ["exitCode", "signal", "processGone"],
    "capture recorder teardown",
  );
  if (
    runtime.teardown.processesGone !== true ||
    runtime.teardown.coordinatesReleased !== true ||
    runtime.teardown.profileRemoved !== true ||
    runtime.teardown.lockRemoved !== true ||
    runtime.teardown.display !== runtime.allocation.display ||
    runtime.teardown.cdpPort !== runtime.allocation.cdpPort ||
    runtime.teardown.recorder.exitCode !== 0 ||
    runtime.teardown.recorder.signal !== null ||
    runtime.teardown.recorder.processGone !== true
  ) {
    throw new Error("capture runtime teardown declaration is incomplete");
  }
  if (
    !Array.isArray(runtime.teardown.processes) ||
    runtime.teardown.processes.length !== 2
  ) {
    throw new Error(
      "capture runtime teardown needs Xvfb and Chromium processes",
    );
  }
  const processes = new Map();
  for (const record of runtime.teardown.processes) {
    requireExactKeys(
      record,
      ["name", "pid", "gone"],
      "capture runtime process",
    );
    if (
      !["xvfb", "chromium"].includes(record.name) ||
      processes.has(record.name) ||
      !Number.isInteger(record.pid) ||
      record.pid <= 0 ||
      record.gone !== true
    ) {
      throw new Error("capture runtime process teardown is invalid");
    }
    processes.set(record.name, record);
  }
  if (!processes.has("xvfb") || !processes.has("chromium")) {
    throw new Error("capture runtime teardown omitted Xvfb or Chromium");
  }
  const coordinateLockPath = path.join(
    os.tmpdir(),
    `kandev-highlight-${runtime.allocation.displayNumber}-${runtime.allocation.cdpPort}.lock`,
  );
  const [
    cdpPortReleased,
    displayReleased,
    profileRemoved,
    captureLockRemoved,
    coordinateLockRemoved,
    ...processGoneChecks
  ] = await Promise.all([
    deps.waitForPortRelease(runtime.allocation.cdpPort),
    deps.isDisplayReleased(runtime.allocation.displayNumber),
    pathRemoved(expected.captureProfileDir),
    pathRemoved(expected.captureLockPath),
    pathRemoved(coordinateLockPath),
    ...[...processes.values()].map((record) => deps.isProcessGone(record.pid)),
  ]);
  return {
    declared: true,
    cdpPortReleased: cdpPortReleased === true,
    displayReleased: displayReleased === true,
    processesGone: processGoneChecks.every((gone) => gone === true),
    recorderGone: true,
    profileRemoved,
    locksRemoved: captureLockRemoved && coordinateLockRemoved,
  };
}

async function pathRemoved(filePath) {
  try {
    await fs.lstat(filePath);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

function isProcessGone(pid, killProcess = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killProcess(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    if (error.code === "EPERM") return false;
    throw error;
  }
}

function runtimeReceipt({
  scenario,
  source,
  requestIdentity,
  workerIdentity,
  logIdentity,
  workerResult,
  capture,
  build,
  execution,
  teardown,
  completedAt,
}) {
  const body = {
    contract: "kandev-highlight-application-runtime-v1",
    version: 1,
    runtimeId: workerResult.runtimeId,
    scenario,
    request: requestIdentity,
    preTeardown: workerResult.applicationRuntime,
    source,
    build: {
      manifestDigest: build.manifestDigest,
      sourceSha: build.sourceSha,
      outputs: {
        backend: build.outputs.backend.digest,
        mockAgent: build.outputs.mockAgent.digest,
        webDist: build.outputs.webDist.digest,
      },
    },
    capture: {
      phaseManifestPath: capture.phaseManifestPath,
      phaseManifestDigest: capture.phaseManifestDigest,
      captureManifestPath: capture.captureManifestPath,
      captureManifestDigest: capture.captureManifestDigest,
      attemptRoot: capture.attemptRoot,
      scenarioDigest: capture.scenarioDigest,
      sourceDigest: capture.sourceDigest,
      rawMaster: capture.rawMaster,
      rawMasterDigest: capture.rawMasterDigest,
      captureEvidenceDigest: capture.captureEvidence.digest,
    },
    execution,
    teardown,
    log: logIdentity,
    workerResult: workerIdentity,
    completedAt,
  };
  return { ...body, receiptDigest: digestBytes(canonicalJson(body)) };
}

function compactFailure(code) {
  return { code };
}

function retryGuidance() {
  return {
    nextRunIdRequired: true,
    reason: "immutable-run-id-reserved",
  };
}

function structuredFailure(code, phase) {
  return { code, phase, retry: retryGuidance() };
}

function runtimeFailureEvidence({ request, phase, code, completedAt }) {
  const body = {
    contract: "kandev-highlight-runtime-host-failure-v1",
    version: 1,
    runtimeId: request.runtimeId,
    runId: request.runId,
    phase,
    failure: structuredFailure(code, phase),
    completedAt,
  };
  return { ...body, failureDigest: digestBytes(canonicalJson(body)) };
}

function safeCompletedAt(clock) {
  try {
    const value = clock().toISOString();
    if (Number.isFinite(Date.parse(value))) return value;
  } catch {
    // A broken injected/system clock is itself failure evidence; use wall time.
  }
  return new Date().toISOString();
}

class RuntimeHostFailure extends Error {
  constructor(message, resultPath) {
    super(message);
    this.name = "RuntimeHostFailure";
    this.resultPath = resultPath;
  }
}

function dependenciesWithDefaults(dependencies) {
  return {
    readScenario,
    preflightHighlightRuntime,
    verifySourceGate,
    verifyBuildProvenance: verifyCaptureBuildProvenance,
    preflightCaptureIntegration,
    selectIntegrationPortOffset,
    processRunner: defaultProcessRunner,
    waitForPortRelease: waitForIntegrationPortRelease,
    isDisplayReleased: isDisplayAvailable,
    isProcessGone,
    clock: () => new Date(),
    ...dependencies,
  };
}

function buildWorkerRequest({
  request,
  sourceProof,
  build,
  tools,
  port,
  bundleRoot,
}) {
  return validateRuntimeWorkerRequest({
    contract: "kandev-highlight-runtime-worker-request-v1",
    version: 1,
    runtimeId: request.runtimeId,
    scenarioPath: request.scenarioPath,
    artifactRoot: request.artifactRoot,
    repositoryRoot: request.repositoryRoot,
    buildManifestPath: request.buildManifestPath,
    source: request.source,
    runId: request.runId,
    pullRequest: request.pullRequest,
    bundleRoot,
    sourceProof,
    build,
    tools,
    ports: { offset: port.offset, backend: port.backendPort },
  });
}

async function reserveBundle(request) {
  const parent = path.join(request.artifactRoot, "runtime-host");
  await fs.mkdir(parent, { recursive: true });
  const bundleRoot = path.join(parent, request.runId);
  try {
    await fs.mkdir(bundleRoot);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `refusing to overwrite runtime host bundle: ${bundleRoot}`,
      );
    }
    throw error;
  }
  return {
    bundleRoot,
    homeRoot: path.join(bundleRoot, "runner-home"),
    fixtureRoot: path.join(bundleRoot, "fixture-root"),
    requestPath: path.join(bundleRoot, "request.json"),
    workerResultPath: path.join(bundleRoot, "worker-result.json"),
    logPath: path.join(bundleRoot, "playwright.log"),
    failurePath: path.join(bundleRoot, "failure.json"),
    resultPath: path.join(bundleRoot, "result.json"),
  };
}

function hostResult({
  status,
  request,
  paths,
  scenario,
  source,
  requestIdentity,
  workerIdentity,
  logIdentity,
  applicationRuntime,
  capture,
  execution,
  teardown,
  failure,
  completedAt,
}) {
  const body = {
    contract: "kandev-highlight-runtime-host-result-v1",
    version: 1,
    status,
    runtimeId: request.runtimeId,
    runId: request.runId,
    scenario,
    source,
    bundle: {
      path: paths.bundleRoot,
      requestPath: paths.requestPath,
      workerResultPath: paths.workerResultPath,
      logPath: paths.logPath,
      failurePath: paths.failurePath,
      resultPath: paths.resultPath,
    },
    request: requestIdentity,
    workerResult: workerIdentity,
    log: logIdentity,
    applicationRuntime,
    capture,
    execution,
    teardown,
    failure,
    completedAt,
  };
  return { ...body, resultDigest: digestBytes(canonicalJson(body)) };
}

function normalizedExecution(value, deadlineMs = DEFAULT_PROCESS_DEADLINE_MS) {
  if (
    !isRecord(value) ||
    !(value.exitCode === null || Number.isInteger(value.exitCode)) ||
    !(value.signal === null || typeof value.signal === "string")
  ) {
    throw new Error("runtime process result is invalid");
  }
  const processGroup = isRecord(value.processGroup)
    ? structuredClone(value.processGroup)
    : {
        pid: null,
        termSent: false,
        killSent: false,
        exited: value.exitCode !== null || value.signal !== null,
        gone: value.exitCode !== null || value.signal !== null,
      };
  const log = isRecord(value.log)
    ? structuredClone(value.log)
    : {
        limitBytes: DEFAULT_LOG_LIMIT_BYTES,
        capturedBytes: null,
        discardedBytes: 0,
        truncated: false,
      };
  return {
    exitCode: value.exitCode,
    signal: value.signal,
    timedOut: value.timedOut === true,
    deadlineMs:
      Number.isInteger(value.deadlineMs) && value.deadlineMs > 0
        ? value.deadlineMs
        : deadlineMs,
    processGroup,
    log,
  };
}

async function maybeFileIdentity(filePath, label) {
  try {
    return await fileIdentity(filePath, label);
  } catch (error) {
    if (/does not exist/.test(error.message)) return null;
    return null;
  }
}

export async function runHighlightRuntimeHost({
  request: input,
  inheritedEnv = process.env,
  dependencies = {},
} = {}) {
  const request = validateRuntimeHostRequest(input);
  const deps = dependenciesWithDefaults(dependencies);
  const expectedRepositoryRoot =
    dependencies.expectedRepositoryRoot ?? DEFAULT_REPOSITORY_ROOT;
  await preflightRequestPaths(request, expectedRepositoryRoot);
  const scenarioFileBefore = await regularFileSnapshot(
    request.scenarioPath,
    "runtime scenario",
  );
  const scenario = await deps.readScenario(request.scenarioPath);
  const scenarioDigest = computeScenarioDigest(scenario);
  const scenarioEvidence = {
    id: scenario.id,
    path: request.scenarioPath,
    bytes: scenarioFileBefore.bytes,
    digest: scenarioDigest,
  };
  deps.preflightHighlightRuntime({ runtimeId: request.runtimeId, scenario });
  const sourceProofBefore = validateSourceProof(
    await deps.verifySourceGate({
      repoRoot: request.repositoryRoot,
      source: request.source,
    }),
    request,
  );
  const build = compactBuildProof(
    await deps.verifyBuildProvenance(request.buildManifestPath, {
      expectedSourceSha: sourceProofBefore.selectedSha,
      expectedRepositoryRoot: request.repositoryRoot,
    }),
    sourceProofBefore,
  );
  const tools = validateToolPreflight(
    await deps.preflightCaptureIntegration({
      webRoot: path.join(request.repositoryRoot, "apps", "web"),
    }),
  );
  const port = await deps.selectIntegrationPortOffset();
  if (
    !Number.isInteger(port?.offset) ||
    port.offset < 0 ||
    port.offset > 29 ||
    port.backendPort !== 18_080 + port.offset
  ) {
    throw new Error(
      "runtime host port allocator returned an invalid fixed E2E port",
    );
  }

  const paths = await reserveBundle(request);
  let phase = "bundle-setup";
  let requestIdentity = null;
  let workerIdentity = null;
  let logIdentity = null;
  let workerResult = null;
  let capture = null;
  let execution = null;
  let teardown = null;
  let applicationRuntime = null;
  let sourceAfter = null;
  const sourceEvidence = {
    pre: compactSourceProof(sourceProofBefore),
    post: null,
    unchanged: false,
  };
  try {
    await Promise.all([fs.mkdir(paths.homeRoot), fs.mkdir(paths.fixtureRoot)]);
    const fixtureIdentity = await requireCanonicalPath(paths.fixtureRoot, {
      kind: "directory",
      label: "host-owned fixture root",
    });
    if (!Number.isInteger(fixtureIdentity.ino) || fixtureIdentity.ino <= 0) {
      throw new Error("host-owned fixture root identity is invalid");
    }
    const workerRequest = buildWorkerRequest({
      request,
      sourceProof: sourceProofBefore,
      build,
      tools,
      port,
      bundleRoot: paths.bundleRoot,
    });
    phase = "request";
    await writeJsonExclusive(
      paths.requestPath,
      workerRequest,
      "runtime worker request",
    );
    await fs.writeFile(paths.logPath, "", { flag: "wx", mode: 0o600 });
    requestIdentity = await fileIdentity(
      paths.requestPath,
      "runtime worker request",
    );
    const env = sanitizeRuntimeHostEnvironment(inheritedEnv, {
      homeRoot: paths.homeRoot,
      fixtureRoot: paths.fixtureRoot,
      requestPath: paths.requestPath,
      workerResultPath: paths.workerResultPath,
      portOffset: port.offset,
      playwrightBrowsersPath: playwrightBrowsersRoot(tools.chromium),
    });
    const command = buildRuntimeHostCommand({
      webRoot: path.join(request.repositoryRoot, "apps", "web"),
    });

    phase = "playwright";
    let processFailure = null;
    try {
      execution = normalizedExecution(
        await deps.processRunner({
          command,
          env,
          logPath: paths.logPath,
          deadlineMs:
            dependencies.processDeadlineMs ?? DEFAULT_PROCESS_DEADLINE_MS,
        }),
        dependencies.processDeadlineMs ?? DEFAULT_PROCESS_DEADLINE_MS,
      );
    } catch {
      execution = normalizedExecution(
        { exitCode: null, signal: null },
        dependencies.processDeadlineMs ?? DEFAULT_PROCESS_DEADLINE_MS,
      );
      processFailure = structuredFailure(
        "playwright-launch-failed",
        "playwright",
      );
    }
    if (!processFailure && execution.exitCode !== 0) {
      processFailure = structuredFailure(
        execution.timedOut
          ? "playwright-deadline-exceeded"
          : "playwright-exit-failed",
        "playwright",
      );
    }

    phase = "postflight";
    let postflightFailure = null;
    try {
      sourceAfter = validateSourceProof(
        await deps.verifySourceGate({
          repoRoot: request.repositoryRoot,
          source: request.source,
        }),
        request,
      );
      if (canonicalJson(sourceAfter) !== canonicalJson(sourceProofBefore)) {
        throw new Error("source proof changed during runtime capture");
      }
      sourceEvidence.post = compactSourceProof(sourceAfter);
    } catch {
      postflightFailure = structuredFailure(
        "source-postflight-failed",
        "postflight",
      );
    }
    try {
      const [scenarioFileAfter, scenarioAfter] = await Promise.all([
        regularFileSnapshot(request.scenarioPath, "post-run runtime scenario"),
        deps.readScenario(request.scenarioPath),
      ]);
      if (
        scenarioFileAfter.bytes !== scenarioFileBefore.bytes ||
        scenarioFileAfter.digest !== scenarioFileBefore.digest ||
        computeScenarioDigest(scenarioAfter) !== scenarioDigest ||
        scenarioAfter.id !== scenario.id
      ) {
        throw new Error(
          "scenario bytes or canonical digest changed during capture",
        );
      }
    } catch {
      postflightFailure ??= structuredFailure(
        "scenario-postflight-failed",
        "postflight",
      );
    }
    sourceEvidence.unchanged =
      !postflightFailure && sourceEvidence.post !== null;

    phase = "teardown";
    let portReleased = false;
    try {
      portReleased = (await deps.waitForPortRelease(port.backendPort)) === true;
    } catch {
      portReleased = false;
    }
    logIdentity = await fileIdentity(paths.logPath, "runtime host log");
    execution.log.capturedBytes = logIdentity.bytes;

    phase = "worker-result";
    let workerFailure = null;
    let captureTeardown = null;
    try {
      workerIdentity = await fileIdentity(
        paths.workerResultPath,
        "runtime worker result",
      );
      workerResult = validateRuntimeWorkerResult(
        await readJsonRegular(paths.workerResultPath, "runtime worker result"),
        workerRequest,
      );
      capture = await verifyCaptureArtifacts(workerResult, workerRequest, {
        scenarioId: scenario.id,
        scenarioDigest,
        sourceDigest: sourceCaptureDigest(request, sourceProofBefore),
      });
      captureTeardown = await verifyCaptureTeardown(
        capture,
        workerRequest,
        scenario.id,
        deps,
      );
      const { receipt: _verifiedCaptureReceipt, ...compactCapture } = capture;
      capture = compactCapture;
    } catch {
      workerFailure = structuredFailure(
        "worker-result-invalid",
        "worker-result",
      );
    }
    const fixtureTempRootRemoved = await pathRemoved(paths.fixtureRoot);
    teardown = {
      playwrightExited:
        execution.exitCode === 0 &&
        execution.signal === null &&
        execution.timedOut === false,
      playwrightProcessGroupGone: execution.processGroup.gone === true,
      backendPortReleased: portReleased,
      frontendPortReleased: portReleased,
      fixtureTempRootOwned: true,
      fixtureTempRootRemoved,
      capture: captureTeardown,
    };
    let failure = processFailure ?? postflightFailure ?? workerFailure;
    if (
      !failure &&
      (!portReleased ||
        !fixtureTempRootRemoved ||
        !teardown.playwrightProcessGroupGone ||
        !captureTeardown ||
        Object.entries(captureTeardown).some(
          ([key, value]) => key !== "declared" && value !== true,
        ))
    ) {
      failure = structuredFailure("runtime-teardown-incomplete", "teardown");
    }
    phase = "finalize";
    const completedAt = deps.clock().toISOString();
    if (!Number.isFinite(Date.parse(completedAt))) {
      throw new Error("runtime host clock returned invalid time");
    }

    if (workerResult && capture && workerIdentity) {
      const receipt = runtimeReceipt({
        scenario: scenarioEvidence,
        source: sourceEvidence,
        requestIdentity,
        workerIdentity,
        logIdentity,
        workerResult,
        capture,
        build,
        execution,
        teardown,
        completedAt,
      });
      const runtimeReceiptPath = expectedCapturePaths(
        workerRequest,
        scenario.id,
      ).runtimeReceiptPath;
      await writeJsonExclusive(
        runtimeReceiptPath,
        receipt,
        "application runtime receipt",
      );
      applicationRuntime = {
        receiptPath: runtimeReceiptPath,
        digest: receipt.receiptDigest,
      };
    }
    if (failure) {
      const evidence = runtimeFailureEvidence({
        request,
        phase: failure.phase,
        code: failure.code,
        completedAt,
      });
      await writeJsonAtomicExclusive(
        paths.failurePath,
        evidence,
        "runtime host failure evidence",
      );
    }
    const result = hostResult({
      status: failure ? "failed" : "succeeded",
      request,
      paths,
      scenario: scenarioEvidence,
      source: sourceEvidence,
      requestIdentity,
      workerIdentity,
      logIdentity,
      applicationRuntime,
      capture,
      execution,
      teardown,
      failure,
      completedAt,
    });
    await writeJsonAtomicExclusive(
      paths.resultPath,
      result,
      "runtime host result",
    );
    if (failure) {
      const message =
        failure.code === "runtime-teardown-incomplete" && !portReleased
          ? `Highlight runtime backend port ${port.backendPort} was not released`
          : `Highlight runtime host failed closed: ${failure.code}`;
      throw new RuntimeHostFailure(
        `${message}; evidence preserved at ${paths.resultPath}`,
        paths.resultPath,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof RuntimeHostFailure) throw error;
    await fs
      .rm(paths.fixtureRoot, { recursive: true, force: true })
      .catch(() => {});
    logIdentity ??= await maybeFileIdentity(paths.logPath, "runtime host log");
    const completedAt = safeCompletedAt(deps.clock);
    const failure = structuredFailure("runtime-host-internal", phase);
    const evidence = runtimeFailureEvidence({
      request,
      phase,
      code: failure.code,
      completedAt,
    });
    let evidenceWriteError = null;
    try {
      await writeJsonAtomicExclusive(
        paths.failurePath,
        evidence,
        "runtime host failure evidence",
      );
    } catch (writeError) {
      evidenceWriteError = writeError;
    }
    const result = hostResult({
      status: "failed",
      request,
      paths,
      scenario: scenarioEvidence,
      source: sourceEvidence,
      requestIdentity,
      workerIdentity,
      logIdentity,
      applicationRuntime,
      capture,
      execution,
      teardown,
      failure,
      completedAt,
    });
    let resultWriteError = null;
    try {
      await writeJsonAtomicExclusive(
        paths.resultPath,
        result,
        "runtime host result",
      );
    } catch (writeError) {
      resultWriteError = writeError;
    }
    if (evidenceWriteError || resultWriteError) {
      throw new AggregateError(
        [error, evidenceWriteError, resultWriteError].filter(Boolean),
        `Highlight runtime host failed and could not preserve complete failure evidence in ${paths.bundleRoot}`,
      );
    }
    throw new RuntimeHostFailure(
      `Highlight runtime host failed closed during ${phase}; evidence preserved at ${paths.resultPath}`,
      paths.resultPath,
    );
  }
}
