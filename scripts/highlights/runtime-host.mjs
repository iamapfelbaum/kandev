import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
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
import { readScenario } from "./scenario.mjs";
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

async function defaultProcessRunner({ command, env, logPath }) {
  const log = await fs.open(logPath, "a");
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command.command, command.args, {
        cwd: command.cwd,
        env,
        stdio: ["ignore", log.fd, log.fd],
      });
      child.once("error", (error) =>
        reject(
          new Error(
            `cannot launch fixed Highlight Playwright host: ${error.message}`,
            { cause: error },
          ),
        ),
      );
      child.once("close", (code, signal) =>
        resolve({ exitCode: code, signal }),
      );
    });
  } finally {
    await log.close();
  }
}

async function fileIdentity(filePath, label) {
  const stat = await requireCanonicalPath(filePath, { kind: "file", label });
  const bytes = await fs.readFile(filePath);
  return {
    path: path.resolve(filePath),
    bytes: stat.size,
    digest: digestBytes(bytes),
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

async function readJsonRegular(filePath, label) {
  await requireCanonicalPath(filePath, { kind: "file", label });
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
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

async function verifyCaptureArtifacts(workerResult, workerRequest) {
  for (const [key, filePath] of Object.entries({
    phaseManifestPath: workerResult.capture.phaseManifestPath,
    captureManifestPath: workerResult.capture.captureManifestPath,
    rawMasterPath: workerResult.capture.rawMasterPath,
    captureEvidencePath: workerResult.capture.captureEvidence.path,
  })) {
    if (!isInside(workerRequest.artifactRoot, filePath)) {
      throw new Error(`runtime worker ${key} escapes artifactRoot`);
    }
  }
  const [phaseIdentity, captureIdentity, rawIdentity, evidenceIdentity] =
    await Promise.all([
      fileIdentity(
        workerResult.capture.phaseManifestPath,
        "capture phase manifest",
      ),
      fileIdentity(
        workerResult.capture.captureManifestPath,
        "source capture manifest",
      ),
      fileIdentity(workerResult.capture.rawMasterPath, "raw capture master"),
      fileIdentity(
        workerResult.capture.captureEvidence.path,
        "capture content evidence",
      ),
    ]);
  const [phase, receipt] = await Promise.all([
    readJsonRegular(phaseIdentity.path, "capture phase manifest"),
    readJsonRegular(captureIdentity.path, "source capture manifest"),
  ]);
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
    receipt.scenarioDigest !== workerResult.capture.scenarioDigest ||
    receipt.sourceDigest !== workerResult.capture.sourceDigest ||
    receipt.source?.selectedSha !== workerRequest.sourceProof.selectedSha ||
    receipt.build?.manifestDigest !== workerRequest.build.manifestDigest ||
    receipt.rawMaster?.digest !== rawIdentity.digest ||
    workerResult.capture.rawMasterDigest !== rawIdentity.digest ||
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
    evidenceIdentity.bytes !== workerResult.capture.captureEvidence.bytes ||
    evidenceIdentity.digest !== workerResult.capture.captureEvidence.digest
  ) {
    throw new Error("capture content evidence hash or byte count mismatch");
  }
  return {
    phaseManifestPath: phaseIdentity.path,
    phaseManifestDigest: phaseIdentity.digest,
    captureManifestPath: captureIdentity.path,
    captureManifestDigest: captureIdentity.digest,
    rawMasterPath: rawIdentity.path,
    rawMasterDigest: rawIdentity.digest,
    captureEvidence: workerResult.capture.captureEvidence,
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

function runtimeReceipt({
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
    request: requestIdentity,
    preTeardown: workerResult.applicationRuntime,
    source: {
      mode: workerResult.applicationRuntime.source.mode,
      selectedSha: workerResult.applicationRuntime.source.selectedSha,
    },
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
  const homeRoot = path.join(bundleRoot, "runner-home");
  await fs.mkdir(homeRoot);
  return {
    bundleRoot,
    homeRoot,
    requestPath: path.join(bundleRoot, "request.json"),
    workerResultPath: path.join(bundleRoot, "worker-result.json"),
    logPath: path.join(bundleRoot, "playwright.log"),
    resultPath: path.join(bundleRoot, "result.json"),
  };
}

function hostResult({
  status,
  request,
  paths,
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
    bundle: {
      path: paths.bundleRoot,
      requestPath: paths.requestPath,
      workerResultPath: paths.workerResultPath,
      logPath: paths.logPath,
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
  const scenario = await deps.readScenario(request.scenarioPath);
  deps.preflightHighlightRuntime({ runtimeId: request.runtimeId, scenario });
  const sourceProof = validateSourceProof(
    await deps.verifySourceGate({
      repoRoot: request.repositoryRoot,
      source: request.source,
    }),
    request,
  );
  const build = compactBuildProof(
    await deps.verifyBuildProvenance(request.buildManifestPath, {
      expectedSourceSha: sourceProof.selectedSha,
    }),
    sourceProof,
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
  const workerRequest = buildWorkerRequest({
    request,
    sourceProof,
    build,
    tools,
    port,
    bundleRoot: paths.bundleRoot,
  });
  await writeJsonExclusive(
    paths.requestPath,
    workerRequest,
    "runtime worker request",
  );
  await fs.writeFile(paths.logPath, "", { flag: "wx" });
  const requestIdentity = await fileIdentity(
    paths.requestPath,
    "runtime worker request",
  );
  const env = sanitizeRuntimeHostEnvironment(inheritedEnv, {
    homeRoot: paths.homeRoot,
    requestPath: paths.requestPath,
    workerResultPath: paths.workerResultPath,
    portOffset: port.offset,
    playwrightBrowsersPath: playwrightBrowsersRoot(tools.chromium),
  });
  const command = buildRuntimeHostCommand({
    webRoot: path.join(request.repositoryRoot, "apps", "web"),
  });

  let execution;
  let processFailure = null;
  try {
    execution = await deps.processRunner({
      command,
      env,
      logPath: paths.logPath,
    });
  } catch {
    execution = { exitCode: null, signal: null };
    processFailure = compactFailure("playwright-launch-failed");
  }
  if (
    !isRecord(execution) ||
    !(execution.exitCode === null || Number.isInteger(execution.exitCode)) ||
    !(execution.signal === null || typeof execution.signal === "string")
  ) {
    execution = { exitCode: null, signal: null };
    processFailure = compactFailure("playwright-result-invalid");
  } else if (execution.exitCode !== 0) {
    processFailure = compactFailure("playwright-exit-failed");
  }

  let portReleased = false;
  try {
    portReleased = (await deps.waitForPortRelease(port.backendPort)) === true;
  } catch {
    portReleased = false;
  }
  const logIdentity = await fileIdentity(paths.logPath, "runtime host log");
  let workerIdentity = null;
  let workerResult = null;
  let capture = null;
  let workerFailure = null;
  try {
    workerIdentity = await fileIdentity(
      paths.workerResultPath,
      "runtime worker result",
    );
    workerResult = validateRuntimeWorkerResult(
      await readJsonRegular(paths.workerResultPath, "runtime worker result"),
      workerRequest,
    );
    capture = await verifyCaptureArtifacts(workerResult, workerRequest);
  } catch {
    workerFailure = compactFailure("worker-result-invalid");
  }
  const fixtureTempRootRemoved = workerResult
    ? await pathRemoved(
        workerResult.applicationRuntime.isolation.fixtureTempRoot,
      )
    : false;
  const teardown = {
    playwrightExited: execution.exitCode === 0,
    backendPortReleased: portReleased,
    fixtureTempRootRemoved,
  };
  let failure = processFailure ?? workerFailure;
  if (!failure && (!portReleased || !fixtureTempRootRemoved)) {
    failure = compactFailure("runtime-teardown-incomplete");
  }
  const completedAt = deps.clock().toISOString();
  if (!Number.isFinite(Date.parse(completedAt)))
    throw new Error("runtime host clock returned invalid time");

  let applicationRuntime = null;
  if (workerResult && capture && workerIdentity) {
    const receipt = runtimeReceipt({
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
    const runtimeReceiptPath = path.join(
      path.dirname(capture.phaseManifestPath),
      "application-runtime.json",
    );
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
  const result = hostResult({
    status: failure ? "failed" : "succeeded",
    request,
    paths,
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
  await writeJsonExclusive(paths.resultPath, result, "runtime host result");
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
}
