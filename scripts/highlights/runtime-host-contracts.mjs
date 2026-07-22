import { createHash } from "node:crypto";
import path from "node:path";

import { validateChromiumSandboxCaptureBoundary } from "./chromium-sandbox-contract.mjs";
import { resolveHighlightRuntime } from "./runtime-catalog.mjs";
import { assertExternalArtifactRoot } from "./source-gate.mjs";
import { validateRuntimeTempLease } from "./runtime-temp.mjs";

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
  "runtimeTempNamespaceRoot",
  "coordinateLockRoot",
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
  "runtimeTempNamespaceRoot",
  "coordinateLockRoot",
  "bundleRoot",
  "runtimeTemp",
  "sourceProof",
  "build",
  "tools",
  "chromiumSandbox",
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
export function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function requireExactKeys(value, keys, label) {
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

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function requireAbsolute(value, label) {
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
  const runtimeTempNamespaceRoot = requireAbsolute(
    value.runtimeTempNamespaceRoot,
    "runtime host runtimeTempNamespaceRoot",
  );
  const coordinateLockRoot = requireAbsolute(
    value.coordinateLockRoot,
    "runtime host coordinateLockRoot",
  );
  if (coordinateLockRoot !== "/tmp") {
    throw new Error(
      "runtime host coordinateLockRoot must be the host-global /tmp resource namespace",
    );
  }
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
  if (
    isInside(repositoryRoot, runtimeTempNamespaceRoot) ||
    isInside(artifactRoot, runtimeTempNamespaceRoot) ||
    isInside(runtimeTempNamespaceRoot, artifactRoot)
  ) {
    throw new Error(
      "runtime host runtimeTempNamespaceRoot must be external and separate from repository/artifacts",
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
    runtimeTempNamespaceRoot,
    coordinateLockRoot,
  };
}

export function compactRuntimeBuildProof(proof, sourceProof) {
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

export function validateRuntimeSourceProof(proof, request) {
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

export function validateRuntimeToolPreflight(tools) {
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
  const runtimeTempNamespaceRoot = requireAbsolute(
    value.runtimeTempNamespaceRoot,
    "runtime worker runtimeTempNamespaceRoot",
  );
  const coordinateLockRoot = requireAbsolute(
    value.coordinateLockRoot,
    "runtime worker coordinateLockRoot",
  );
  const runtimeTemp = validateRuntimeTempLease(value.runtimeTemp);
  if (
    !isInside(repositoryRoot, scenarioPath) ||
    scenarioPath === repositoryRoot
  ) {
    throw new Error("runtime worker scenarioPath is outside repositoryRoot");
  }
  if (
    runtimeTemp.namespaceRoot !== runtimeTempNamespaceRoot ||
    coordinateLockRoot !== "/tmp" ||
    runtimeTemp.coordinateLockRoot !== coordinateLockRoot ||
    runtimeTemp.runId !== value.runId ||
    runtimeTemp.artifactRoot !== artifactRoot
  ) {
    throw new Error(
      "runtime worker runtimeTemp must bind its exact namespace, run, and artifact root",
    );
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
  const tools = validateRuntimeToolPreflight(
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
  const chromiumSandbox = validateChromiumSandboxCaptureBoundary(
    value.chromiumSandbox,
    {
      sourceProof,
      allowedOrigin: `http://localhost:${value.ports.backend}`,
    },
  );
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
    runtimeTempNamespaceRoot,
    coordinateLockRoot,
    bundleRoot,
    runtimeTemp,
    sourceProof: structuredClone(sourceProof),
    build: structuredClone(value.build),
    tools,
    chromiumSandbox,
    ports: structuredClone(value.ports),
  };
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

export function validateCaptureContent(value) {
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
