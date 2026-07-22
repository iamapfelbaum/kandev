import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveHighlightRuntime } from "./runtime-catalog.mjs";
import { validateRuntimeWorkerRequest, validateRuntimeWorkerResult } from "./runtime-host.mjs";
import { computeScenarioDigest, readScenario } from "./scenario.mjs";
import { SENSITIVE_SCAN_CONTRACT } from "./sensitive-scan.mjs";
import { validateRuntimeProvenance } from "./runtime-provenance.mjs";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_LOG_BYTES = 1024 * 1024;
const MAX_RUNTIME_LOG_RECORDS = 4_096;
const MAX_RUNTIME_LOG_RECORD_BYTES = 8_192;
const CAPTURE_CONTENT_BOUNDS = Object.freeze({
  maxVisibleDomTextRecords: 512,
  maxVisibleDomTextBytes: 65_536,
  maxBrowserConsoleRecords: 128,
  maxBrowserConsoleTextBytes: 2_048,
});

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireExactKeys(value, expected, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} ${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) throw new Error(`${label} ${key} is not allowed`);
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
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function requireSafeSegment(value, label) {
  if (!SAFE_SEGMENT.test(value ?? "") || value === "." || value === "..") {
    throw new Error(`${label} must be a safe path segment`);
  }
  return value;
}

function requireDigest(value, label) {
  if (!DIGEST_PATTERN.test(value ?? "")) throw new Error(`${label} must be SHA-256`);
  return value;
}

async function readRegularBytes(
  filePath,
  { root, exactPath, label, maximumBytes = MAX_JSON_BYTES } = {},
) {
  const absolute = path.resolve(filePath);
  if (exactPath && absolute !== path.resolve(exactPath)) {
    throw new Error(`${label} must use fixed path ${path.resolve(exactPath)}`);
  }
  if (root && (!isInside(root, absolute) || absolute === path.resolve(root))) {
    throw new Error(`${label} is outside expected external root`);
  }
  const pathStat = await fs.lstat(absolute).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`${label} does not exist: ${absolute}`);
    throw error;
  });
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if ((await fs.realpath(absolute)) !== absolute) {
    throw new Error(`${label} must have a canonical non-symlink path`);
  }
  if (pathStat.size > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} byte bound`);
  }
  let handle;
  try {
    handle = await fs.open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} cannot be opened without following symlinks: ${error.message}`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new Error(`${label} changed while opening`);
    }
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw new Error(`${label} changed while reading`);
    return {
      path: absolute,
      bytes,
      identity: {
        path: absolute,
        bytes: bytes.length,
        digest: digestBytes(bytes),
      },
    };
  } finally {
    await handle.close();
  }
}

function validateIdentity(value, label) {
  requireExactKeys(value, ["path", "bytes", "digest"], `${label} identity`);
  if (
    typeof value.path !== "string" ||
    !path.isAbsolute(value.path) ||
    !Number.isInteger(value.bytes) ||
    value.bytes < 0
  ) {
    throw new Error(`${label} identity path or bytes is invalid`);
  }
  requireDigest(value.digest, `${label} identity digest`);
  return value;
}

function assertIdentity(actual, expected, label) {
  validateIdentity(expected, label);
  if (
    actual.path !== path.resolve(expected.path) ||
    actual.bytes !== expected.bytes ||
    actual.digest !== expected.digest
  ) {
    throw new Error(`${label} hash, bytes, or path mismatch`);
  }
}

async function readJson(filePath, options) {
  const record = await readRegularBytes(filePath, options);
  try {
    return { ...record, value: JSON.parse(record.bytes.toString("utf8")) };
  } catch (error) {
    throw new Error(`${options.label} is invalid JSON: ${error.message}`);
  }
}

async function readJsonIdentity(identity, options) {
  validateIdentity(identity, options.label);
  const record = await readRegularBytes(identity.path, options);
  assertIdentity(record.identity, identity, options.label);
  try {
    return { ...record, value: JSON.parse(record.bytes.toString("utf8")) };
  } catch (error) {
    throw new Error(`${options.label} is invalid JSON: ${error.message}`);
  }
}

function validateCaptureSummary(summary, label) {
  requireExactKeys(summary, ["records", "bytes", "digest", "truncated"], `${label} summary`);
  if (
    !Number.isInteger(summary.records) ||
    summary.records < 0 ||
    !Number.isInteger(summary.bytes) ||
    summary.bytes < 0 ||
    typeof summary.truncated !== "boolean"
  ) {
    throw new Error(`${label} summary counts are invalid`);
  }
  requireDigest(summary.digest, `${label} summary digest`);
  return summary;
}

function validateCaptureEvidenceIdentity(value, expectedPath) {
  requireExactKeys(
    value,
    ["contract", "version", "path", "bytes", "digest", "visibleDomText", "browserConsole"],
    "capture evidence identity",
  );
  if (
    value.contract !== "kandev-highlight-capture-evidence-v1" ||
    value.version !== 1 ||
    path.resolve(value.path ?? "") !== path.resolve(expectedPath) ||
    !Number.isInteger(value.bytes) ||
    value.bytes <= 0
  ) {
    throw new Error("capture evidence identity contract or fixed path is invalid");
  }
  requireDigest(value.digest, "capture evidence digest");
  validateCaptureSummary(value.visibleDomText, "visibleDomText");
  validateCaptureSummary(value.browserConsole, "browserConsole");
  return value;
}

function validateCaptureContent(value, summary) {
  requireExactKeys(
    value,
    ["contract", "version", "bounds", "visibleDomText", "browserConsole", "truncated"],
    "capture content evidence",
  );
  if (value.contract !== "kandev-highlight-capture-content-v1" || value.version !== 1) {
    throw new Error("capture content evidence contract must be version 1");
  }
  requireExactKeys(value.bounds, Object.keys(CAPTURE_CONTENT_BOUNDS), "capture content bounds");
  for (const [key, expected] of Object.entries(CAPTURE_CONTENT_BOUNDS)) {
    if (value.bounds[key] !== expected) {
      throw new Error(`capture content bound ${key} must equal ${expected}`);
    }
  }
  requireExactKeys(
    value.truncated,
    ["visibleDomText", "browserConsole"],
    "capture content truncation",
  );
  if (
    typeof value.truncated.visibleDomText !== "boolean" ||
    typeof value.truncated.browserConsole !== "boolean"
  ) {
    throw new Error("capture content truncation flags must be boolean");
  }
  if (
    !Array.isArray(value.visibleDomText) ||
    value.visibleDomText.length === 0 ||
    value.visibleDomText.length > CAPTURE_CONTENT_BOUNDS.maxVisibleDomTextRecords ||
    value.visibleDomText.some((text) => typeof text !== "string" || !text.trim())
  ) {
    throw new Error("visible DOM evidence must contain nonempty bounded text records");
  }
  const visibleBytes = value.visibleDomText.reduce(
    (total, text) => total + Buffer.byteLength(text),
    0,
  );
  if (visibleBytes > CAPTURE_CONTENT_BOUNDS.maxVisibleDomTextBytes) {
    throw new Error("visibleDomText exceeds its byte bound");
  }
  if (
    !Array.isArray(value.browserConsole) ||
    value.browserConsole.length > CAPTURE_CONTENT_BOUNDS.maxBrowserConsoleRecords
  ) {
    throw new Error("browserConsole exceeds its record bound");
  }
  let consoleBytes = 0;
  for (const [index, record] of value.browserConsole.entries()) {
    requireExactKeys(record, ["type", "text", "digest"], `browserConsole ${index}`);
    if (
      typeof record.type !== "string" ||
      !/^[a-z][a-zA-Z-]{0,31}$/.test(record.type) ||
      typeof record.text !== "string" ||
      Buffer.byteLength(record.text) > CAPTURE_CONTENT_BOUNDS.maxBrowserConsoleTextBytes ||
      record.digest !== digestBytes(canonicalJson({ type: record.type, text: record.text }))
    ) {
      throw new Error(`browserConsole ${index} is invalid`);
    }
    consoleBytes += Buffer.byteLength(record.text);
  }
  if (value.browserConsole.length === 0 && value.truncated.browserConsole) {
    throw new Error("empty browserConsole needs an untruncated collection attestation");
  }
  const actual = {
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
  for (const key of ["visibleDomText", "browserConsole"]) {
    if (canonicalJson(actual[key]) !== canonicalJson(summary[key])) {
      throw new Error(
        `${key} summary does not match recomputed records, bytes, digest, or truncation`,
      );
    }
  }
  return {
    visibleDomText: structuredClone(value.visibleDomText),
    browserConsole: structuredClone(value.browserConsole),
  };
}

function validatePhaseRecord(value, captureReceipt) {
  requireExactKeys(
    value,
    ["contract", "phase", "completedAt", "value", "recordDigest"],
    "capture phase manifest",
  );
  const body = structuredClone(value);
  delete body.recordDigest;
  if (
    value.contract !== "kandev-highlight-capture-phase-v1" ||
    value.phase !== "capture" ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    value.recordDigest !== digestBytes(canonicalJson(body)) ||
    canonicalJson(value.value?.receipt) !== canonicalJson(captureReceipt)
  ) {
    throw new Error("capture phase manifest contract, digest, or receipt link is invalid");
  }
}

function validateHostSourceProof(value, label) {
  requireExactKeys(value, ["contract", "mode", "selectedSha", "headSha", "currentMainSha"], label);
  if (
    value.contract !== "kandev-highlight-source-v1" ||
    !["pr_head", "current_main"].includes(value.mode) ||
    !/^[a-f0-9]{40}$/.test(value.selectedSha ?? "") ||
    !/^[a-f0-9]{40}$/.test(value.headSha ?? "") ||
    !/^[a-f0-9]{40}$/.test(value.currentMainSha ?? "")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function validateHostSource(value) {
  requireExactKeys(value, ["pre", "post", "unchanged"], "runtime host source");
  validateHostSourceProof(value.pre, "runtime host pre-source proof");
  validateHostSourceProof(value.post, "runtime host post-source proof");
  if (value.unchanged !== true || canonicalJson(value.pre) !== canonicalJson(value.post)) {
    throw new Error("runtime host source changed during capture");
  }
  return value;
}

function validateHostExecution(value) {
  requireExactKeys(
    value,
    ["exitCode", "signal", "timedOut", "deadlineMs", "processGroup", "log"],
    "runtime host execution",
  );
  requireExactKeys(
    value.processGroup,
    ["pid", "termSent", "killSent", "exited", "gone"],
    "runtime host process group",
  );
  requireExactKeys(
    value.log,
    ["limitBytes", "capturedBytes", "discardedBytes", "truncated"],
    "runtime host execution log",
  );
  if (
    value.exitCode !== 0 ||
    value.signal !== null ||
    value.timedOut !== false ||
    !Number.isInteger(value.deadlineMs) ||
    value.deadlineMs <= 0 ||
    !Number.isInteger(value.processGroup.pid) ||
    value.processGroup.pid <= 0 ||
    typeof value.processGroup.termSent !== "boolean" ||
    typeof value.processGroup.killSent !== "boolean" ||
    value.processGroup.exited !== true ||
    value.processGroup.gone !== true ||
    !Number.isInteger(value.log.limitBytes) ||
    value.log.limitBytes <= 0 ||
    !Number.isInteger(value.log.capturedBytes) ||
    value.log.capturedBytes < 0 ||
    value.log.discardedBytes !== 0 ||
    value.log.truncated !== false
  ) {
    throw new Error("runtime host execution did not exit cleanly within bounds");
  }
  return value;
}

function validateHostTeardown(value) {
  requireExactKeys(
    value,
    [
      "playwrightExited",
      "playwrightProcessGroupGone",
      "backendPortReleased",
      "frontendPortReleased",
      "fixtureTempRootOwned",
      "fixtureTempRootRemoved",
      "capture",
    ],
    "runtime host teardown",
  );
  requireExactKeys(
    value.capture,
    [
      "declared",
      "cdpPortReleased",
      "displayReleased",
      "processesGone",
      "recorderGone",
      "profileRemoved",
      "locksRemoved",
    ],
    "runtime host capture teardown",
  );
  if (
    Object.entries(value).some(([key, nested]) => key !== "capture" && nested !== true) ||
    Object.values(value.capture).some((nested) => nested !== true)
  ) {
    throw new Error("runtime host teardown is incomplete");
  }
  return value;
}

function validateHostResult(value) {
  requireExactKeys(
    value,
    [
      "contract",
      "version",
      "status",
      "runtimeId",
      "runId",
      "scenario",
      "source",
      "bundle",
      "request",
      "workerResult",
      "log",
      "applicationRuntime",
      "capture",
      "execution",
      "teardown",
      "failure",
      "completedAt",
      "resultDigest",
    ],
    "runtime host result",
  );
  const body = structuredClone(value);
  delete body.resultDigest;
  if (
    value.contract !== "kandev-highlight-runtime-host-result-v1" ||
    value.version !== 1 ||
    value.status !== "succeeded" ||
    value.failure !== null ||
    value.execution?.exitCode !== 0 ||
    value.execution?.signal !== null ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    value.resultDigest !== digestBytes(canonicalJson(body))
  ) {
    throw new Error("runtime host result digest, success state, or teardown proof is invalid");
  }
  validateHostSource(value.source);
  validateHostExecution(value.execution);
  validateHostTeardown(value.teardown);
  return value;
}

function validateRuntimeReceipt(value) {
  requireExactKeys(
    value,
    [
      "contract",
      "version",
      "runtimeId",
      "scenario",
      "request",
      "preTeardown",
      "source",
      "build",
      "capture",
      "execution",
      "teardown",
      "log",
      "workerResult",
      "completedAt",
      "receiptDigest",
    ],
    "application runtime receipt",
  );
  const body = structuredClone(value);
  delete body.receiptDigest;
  if (
    value.contract !== "kandev-highlight-application-runtime-v1" ||
    value.version !== 1 ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    value.receiptDigest !== digestBytes(canonicalJson(body))
  ) {
    throw new Error("application runtime receipt contract or digest is invalid");
  }
  return value;
}

function validateBuildBoundary(value, label) {
  requireExactKeys(value, ["contract", "manifestDigest", "sourceSha", "outputs"], label);
  requireExactKeys(value.outputs, ["backend", "mockAgent", "webDist"], `${label} outputs`);
  if (
    value.contract !== "kandev-highlight-build-boundary-v1" ||
    !DIGEST_PATTERN.test(value.manifestDigest ?? "") ||
    !/^[a-f0-9]{40}$/.test(value.sourceSha ?? "") ||
    Object.values(value.outputs).some((digest) => !DIGEST_PATTERN.test(digest ?? ""))
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function validateCaptureReceiptAttestations(receipt) {
  requireExactKeys(
    receipt.buildVerification,
    ["contract", "stable", "beforeStory", "afterStory"],
    "capture build verification",
  );
  const before = validateBuildBoundary(
    receipt.buildVerification.beforeStory,
    "before-story build boundary",
  );
  const after = validateBuildBoundary(
    receipt.buildVerification.afterStory,
    "after-story build boundary",
  );
  if (
    receipt.buildVerification.contract !== "kandev-highlight-build-verification-v1" ||
    receipt.buildVerification.stable !== true ||
    canonicalJson(before) !== canonicalJson(after) ||
    before.manifestDigest !== receipt.build?.manifestDigest ||
    before.sourceSha !== receipt.build?.sourceSha
  ) {
    throw new Error("capture build verification is not stable or linked");
  }
  requireExactKeys(receipt.storyMedia, ["start", "end"], "capture story media");
  for (const [label, sample] of Object.entries(receipt.storyMedia)) {
    requireExactKeys(sample, ["frameCount", "mediaTimeMs"], `capture story media ${label}`);
    if (
      !Number.isInteger(sample.frameCount) ||
      sample.frameCount < 0 ||
      !Number.isFinite(sample.mediaTimeMs) ||
      sample.mediaTimeMs < 0
    ) {
      throw new Error(`capture story media ${label} is invalid`);
    }
  }
  if (
    receipt.storyStartOffsetMs !== receipt.storyMedia.start.mediaTimeMs ||
    receipt.storyOffsetMs !== receipt.storyStartOffsetMs ||
    receipt.storyMedia.end.frameCount < receipt.storyMedia.start.frameCount ||
    receipt.storyMedia.end.mediaTimeMs < receipt.storyMedia.start.mediaTimeMs
  ) {
    throw new Error("capture story media offsets are inconsistent");
  }
  const alignment = receipt.capture?.frameAlignment;
  requireExactKeys(
    alignment,
    [
      "contract",
      "expectedStoryFrames",
      "observedStoryFrames",
      "expectedStoryDurationMs",
      "observedMediaDurationMs",
      "frameDelta",
      "mediaDurationDeltaMs",
      "toleranceFrames",
    ],
    "capture frame alignment",
  );
  if (
    alignment.contract !== "kandev-highlight-media-frame-alignment-v1" ||
    !Number.isInteger(alignment.expectedStoryFrames) ||
    alignment.expectedStoryFrames <= 0 ||
    !Number.isInteger(alignment.observedStoryFrames) ||
    alignment.observedStoryFrames <= 0 ||
    !Number.isInteger(alignment.toleranceFrames) ||
    alignment.toleranceFrames < 0 ||
    Math.abs(alignment.frameDelta) > alignment.toleranceFrames ||
    alignment.expectedStoryDurationMs !== receipt.storyDurationMs
  ) {
    throw new Error("capture frame alignment exceeds its declared tolerance");
  }
  requireExactKeys(
    receipt.navigation,
    [
      "contract",
      "version",
      "configuredUrl",
      "allowedOrigin",
      "finalUrl",
      "finalOrigin",
      "events",
      "checkpoints",
      "violations",
    ],
    "capture navigation evidence",
  );
  if (
    receipt.navigation.contract !== "kandev-highlight-navigation-evidence-v1" ||
    receipt.navigation.version !== 1 ||
    receipt.navigation.finalOrigin !== receipt.navigation.allowedOrigin ||
    !Array.isArray(receipt.navigation.events) ||
    !Array.isArray(receipt.navigation.checkpoints) ||
    receipt.navigation.checkpoints.length === 0 ||
    !Array.isArray(receipt.navigation.violations) ||
    receipt.navigation.violations.length !== 0
  ) {
    throw new Error("capture navigation evidence did not remain in origin");
  }
  if (!Array.isArray(receipt.trustedInputLedger)) {
    throw new Error("capture trusted input ledger must be an array");
  }
  const trustedInputKeys = [
    "contract",
    "sequence",
    "authority",
    "dispatchSucceeded",
    "operation",
    "cdpMethod",
    "type",
    "inputKind",
    "coordinates",
    "key",
    "code",
    "text",
    "button",
    "buttons",
    "clickCount",
    "touchPoints",
  ];
  for (const [index, entry] of receipt.trustedInputLedger.entries()) {
    requireExactKeys(entry, trustedInputKeys, `capture trusted input ledger ${index}`);
    requireExactKeys(
      entry.coordinates,
      ["x", "y"],
      `capture trusted input ledger ${index} coordinates`,
    );
    if (
      entry.contract !== "kandev-highlight-host-input-dispatch-v1" ||
      entry.sequence !== index + 1 ||
      entry.authority !== "host-cdp" ||
      entry.dispatchSucceeded !== true ||
      typeof entry.operation !== "string" ||
      !entry.operation ||
      !["Input.dispatchMouseEvent", "Input.dispatchTouchEvent", "Input.dispatchKeyEvent"].includes(
        entry.cdpMethod,
      ) ||
      typeof entry.type !== "string" ||
      !["desktop", "native-mobile"].includes(entry.inputKind) ||
      !Number.isFinite(entry.coordinates.x) ||
      !Number.isFinite(entry.coordinates.y) ||
      ![entry.key, entry.code, entry.text, entry.button].every(
        (value) => value === null || typeof value === "string",
      ) ||
      ![entry.buttons, entry.clickCount].every(
        (value) => value === null || Number.isInteger(value),
      ) ||
      !Array.isArray(entry.touchPoints)
    ) {
      throw new Error(`capture trusted input ledger ${index} is invalid`);
    }
    for (const [pointIndex, point] of entry.touchPoints.entries()) {
      if (!isRecord(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new Error(
          `capture trusted input ledger ${index} touch point ${pointIndex} is invalid`,
        );
      }
    }
  }
  return receipt;
}

function validateRuntimeLog(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`runtime log is not valid UTF-8: ${error.message}`);
  }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0 || lines.every((line) => line.length === 0)) {
    throw new Error("runtime log evidence must contain nonempty typed records");
  }
  if (lines.length > MAX_RUNTIME_LOG_RECORDS) {
    throw new Error(`runtime log exceeds ${MAX_RUNTIME_LOG_RECORDS} record bound`);
  }
  return lines.map((line, index) => {
    if (line.includes("\0") || Buffer.byteLength(line) > MAX_RUNTIME_LOG_RECORD_BYTES) {
      throw new Error(`runtime log record ${index} exceeds its typed text bound`);
    }
    return { index, text: line, digest: digestBytes(line) };
  });
}

export async function loadVerifiedRuntimeEvidence({
  artifactRoot,
  attemptRoot,
  scenarioId,
  scenarioPath,
  scenarioDigest,
  runId,
  captureReceipt,
} = {}) {
  requireSafeSegment(scenarioId, "scenarioId");
  requireSafeSegment(runId, "runId");
  requireDigest(scenarioDigest, "scenarioDigest");
  const externalRoot = path.resolve(artifactRoot ?? "");
  const expectedAttempt = path.join(externalRoot, scenarioId, "runs", runId);
  if (path.resolve(attemptRoot ?? "") !== expectedAttempt) {
    throw new Error("runtime evidence attemptRoot must use the fixed scenario/run path");
  }
  const attemptStat = await fs.lstat(expectedAttempt).catch(() => null);
  if (
    !attemptStat?.isDirectory() ||
    attemptStat.isSymbolicLink() ||
    (await fs.realpath(expectedAttempt)) !== expectedAttempt
  ) {
    throw new Error("runtime evidence attemptRoot must be a canonical non-symlink directory");
  }
  if (
    !isRecord(captureReceipt) ||
    captureReceipt.contract !== "kandev-highlight-source-capture-v1" ||
    captureReceipt.scenarioDigest !== scenarioDigest
  ) {
    throw new Error("capture receipt does not bind the canonical scenario digest");
  }
  const hostRoot = path.join(externalRoot, "runtime-host", runId);
  const resultPath = path.join(hostRoot, "result.json");
  const resultRecord = await readJson(resultPath, {
    root: hostRoot,
    exactPath: resultPath,
    label: "runtime host result",
  });
  const result = validateHostResult(resultRecord.value);
  const runtime = resolveHighlightRuntime(result.runtimeId);
  if (result.runId !== runId) {
    throw new Error("runtime host result runtime or run identity mismatch");
  }
  const expectedScenarioPath = path.resolve(scenarioPath ?? "");
  const scenarioRecord = await readRegularBytes(expectedScenarioPath, {
    exactPath: expectedScenarioPath,
    label: "runtime scenario",
  });
  const scenario = await readScenario(expectedScenarioPath, {
    allowedExtensionIds: runtime.primitiveIds,
  });
  requireExactKeys(result.scenario, ["id", "path", "bytes", "digest"], "runtime host scenario");
  if (
    scenario.id !== scenarioId ||
    result.scenario.id !== scenarioId ||
    path.resolve(result.scenario.path ?? "") !== expectedScenarioPath ||
    result.scenario.bytes !== scenarioRecord.identity.bytes ||
    result.scenario.digest !== scenarioDigest ||
    computeScenarioDigest(scenario, {
      allowedExtensionIds: runtime.primitiveIds,
    }) !== scenarioDigest
  ) {
    throw new Error("runtime host scenario bytes or canonical digest mismatch");
  }
  requireExactKeys(
    result.bundle,
    ["path", "requestPath", "workerResultPath", "logPath", "failurePath", "resultPath"],
    "runtime host bundle",
  );
  const expectedBundle = {
    path: hostRoot,
    requestPath: path.join(hostRoot, "request.json"),
    workerResultPath: path.join(hostRoot, "worker-result.json"),
    logPath: path.join(hostRoot, "playwright.log"),
    failurePath: path.join(hostRoot, "failure.json"),
    resultPath,
  };
  if (canonicalJson(result.bundle) !== canonicalJson(expectedBundle)) {
    throw new Error("runtime host bundle paths are not fixed to the selected run");
  }
  const requestRecord = await readJsonIdentity(result.request, {
    root: hostRoot,
    exactPath: expectedBundle.requestPath,
    label: "runtime worker request",
  });
  const request = validateRuntimeWorkerRequest(requestRecord.value);
  const expectedBuildManifest = path.join(
    externalRoot,
    "runtime-builds",
    runId,
    "evidence",
    "build-provenance.json",
  );
  if (
    request.artifactRoot !== externalRoot ||
    request.bundleRoot !== hostRoot ||
    request.runId !== runId ||
    request.runtimeId !== result.runtimeId ||
    request.buildManifestPath !== expectedBuildManifest ||
    request.sourceProof.selectedSha !== captureReceipt.source?.selectedSha ||
    canonicalJson(request.sourceProof) !== canonicalJson(captureReceipt.source) ||
    request.build.manifestDigest !== captureReceipt.build?.manifestDigest ||
    request.build.sourceSha !== captureReceipt.build?.sourceSha
  ) {
    throw new Error("runtime request does not bind source, build, run, or fixed build path");
  }
  if (
    result.source.pre.mode !== request.source ||
    result.source.pre.selectedSha !== request.sourceProof.selectedSha ||
    result.source.pre.contract !== request.sourceProof.contract
  ) {
    throw new Error("runtime host source evidence does not match worker request");
  }
  const workerRecord = await readJsonIdentity(result.workerResult, {
    root: hostRoot,
    exactPath: expectedBundle.workerResultPath,
    label: "runtime worker result",
  });
  const worker = validateRuntimeWorkerResult(workerRecord.value, request);
  if (
    worker.capture.scenarioDigest !== scenarioDigest ||
    worker.capture.sourceDigest !== captureReceipt.sourceDigest ||
    canonicalJson(worker.applicationRuntime) !== canonicalJson(captureReceipt.applicationRuntime)
  ) {
    throw new Error("runtime worker result does not bind scenario, source, or application runtime");
  }

  const expectedPhasePath = path.join(expectedAttempt, "evidence", "capture.json");
  const expectedCapturePath = path.join(expectedAttempt, "capture", "evidence", "capture.json");
  const expectedRawPath = path.join(expectedAttempt, "capture", "raw", `${scenarioId}.source.mp4`);
  const expectedContentPath = path.join(
    expectedAttempt,
    "capture",
    "evidence",
    "capture-content.json",
  );
  const captureEvidenceIdentity = validateCaptureEvidenceIdentity(
    captureReceipt.captureEvidence,
    expectedContentPath,
  );
  if (
    worker.capture.phaseManifestPath !== expectedPhasePath ||
    worker.capture.captureManifestPath !== expectedCapturePath ||
    worker.capture.rawMasterPath !== expectedRawPath ||
    path.resolve(captureReceipt.rawMaster?.path ?? "") !== expectedRawPath ||
    canonicalJson(worker.capture.captureEvidence) !== canonicalJson(captureEvidenceIdentity) ||
    canonicalJson(result.capture?.captureEvidence) !== canonicalJson(captureEvidenceIdentity) ||
    result.capture?.phaseManifestPath !== expectedPhasePath ||
    result.capture?.captureManifestPath !== expectedCapturePath ||
    result.capture?.rawMasterPath !== expectedRawPath
  ) {
    throw new Error(
      "runtime capture paths or capture evidence links do not match fixed attempt paths",
    );
  }
  requireExactKeys(
    result.capture,
    [
      "attemptRoot",
      "scenarioDigest",
      "sourceDigest",
      "phaseManifestPath",
      "phaseManifestDigest",
      "captureManifestPath",
      "captureManifestDigest",
      "rawMasterPath",
      "rawMasterDigest",
      "rawMaster",
      "captureEvidence",
    ],
    "runtime host capture",
  );
  if (
    result.capture.attemptRoot !== expectedAttempt ||
    result.capture.scenarioDigest !== scenarioDigest ||
    result.capture.sourceDigest !== captureReceipt.sourceDigest
  ) {
    throw new Error("runtime host capture identity does not match selected attempt");
  }
  const [phaseRecord, captureRecord, rawRecord, contentRecord] = await Promise.all([
    readJson(expectedPhasePath, {
      root: expectedAttempt,
      exactPath: expectedPhasePath,
      label: "capture phase manifest",
    }),
    readJson(expectedCapturePath, {
      root: expectedAttempt,
      exactPath: expectedCapturePath,
      label: "source capture manifest",
    }),
    readRegularBytes(expectedRawPath, {
      root: expectedAttempt,
      exactPath: expectedRawPath,
      label: "raw capture master",
      maximumBytes: Number.MAX_SAFE_INTEGER,
    }),
    readJsonIdentity(
      {
        path: captureEvidenceIdentity.path,
        bytes: captureEvidenceIdentity.bytes,
        digest: captureEvidenceIdentity.digest,
      },
      {
        root: expectedAttempt,
        exactPath: expectedContentPath,
        label: "capture content evidence",
      },
    ),
  ]);
  validatePhaseRecord(phaseRecord.value, captureReceipt);
  if (canonicalJson(captureRecord.value) !== canonicalJson(captureReceipt)) {
    throw new Error("source capture manifest differs from recovered capture receipt");
  }
  validateCaptureReceiptAttestations(captureReceipt);
  if (
    rawRecord.identity.bytes !== captureReceipt.rawMaster.bytes ||
    rawRecord.identity.digest !== captureReceipt.rawMaster.digest ||
    worker.capture.rawMasterDigest !== rawRecord.identity.digest ||
    result.capture.rawMasterDigest !== rawRecord.identity.digest ||
    result.capture.phaseManifestDigest !== phaseRecord.identity.digest ||
    result.capture.captureManifestDigest !== captureRecord.identity.digest
  ) {
    throw new Error("runtime capture raw or manifest digest link is invalid");
  }
  assertIdentity(rawRecord.identity, result.capture.rawMaster, "runtime host raw master");
  const captureEvidence = validateCaptureContent(contentRecord.value, captureEvidenceIdentity);

  requireExactKeys(result.applicationRuntime, ["receiptPath", "digest"], "runtime receipt link");
  const expectedReceiptPath = path.join(expectedAttempt, "evidence", "application-runtime.json");
  if (path.resolve(result.applicationRuntime.receiptPath ?? "") !== expectedReceiptPath) {
    throw new Error("application runtime receipt must use its fixed attempt path");
  }
  const receiptRecord = await readJson(expectedReceiptPath, {
    root: expectedAttempt,
    exactPath: expectedReceiptPath,
    label: "application runtime receipt",
  });
  const receipt = validateRuntimeReceipt(receiptRecord.value);
  if (
    receipt.receiptDigest !== result.applicationRuntime.digest ||
    receipt.runtimeId !== result.runtimeId ||
    canonicalJson(receipt.scenario) !== canonicalJson(result.scenario) ||
    canonicalJson(receipt.request) !== canonicalJson(result.request) ||
    canonicalJson(receipt.workerResult) !== canonicalJson(result.workerResult) ||
    canonicalJson(receipt.log) !== canonicalJson(result.log) ||
    canonicalJson(receipt.preTeardown) !== canonicalJson(worker.applicationRuntime) ||
    canonicalJson(receipt.source) !== canonicalJson(result.source) ||
    receipt.build?.manifestDigest !== request.build.manifestDigest ||
    receipt.build?.sourceSha !== request.sourceProof.selectedSha ||
    receipt.capture?.phaseManifestPath !== expectedPhasePath ||
    receipt.capture?.phaseManifestDigest !== phaseRecord.identity.digest ||
    receipt.capture?.captureManifestPath !== expectedCapturePath ||
    receipt.capture?.captureManifestDigest !== captureRecord.identity.digest ||
    receipt.capture?.attemptRoot !== expectedAttempt ||
    receipt.capture?.scenarioDigest !== scenarioDigest ||
    receipt.capture?.sourceDigest !== captureReceipt.sourceDigest ||
    canonicalJson(receipt.capture?.rawMaster) !== canonicalJson(rawRecord.identity) ||
    receipt.capture?.rawMasterDigest !== rawRecord.identity.digest ||
    receipt.capture?.captureEvidenceDigest !== contentRecord.identity.digest ||
    canonicalJson(receipt.execution) !== canonicalJson(result.execution) ||
    canonicalJson(receipt.teardown) !== canonicalJson(result.teardown)
  ) {
    throw new Error(
      "application runtime receipt does not bind request, source, build, capture, or teardown",
    );
  }
  const logRecord = await readRegularBytes(expectedBundle.logPath, {
    root: hostRoot,
    exactPath: expectedBundle.logPath,
    label: "runtime log",
    maximumBytes: MAX_RUNTIME_LOG_BYTES,
  });
  assertIdentity(logRecord.identity, result.log, "runtime log");
  if (
    result.execution.log.capturedBytes !== logRecord.identity.bytes ||
    result.execution.log.limitBytes < logRecord.identity.bytes
  ) {
    throw new Error("runtime execution log counters do not match log bytes");
  }
  validateRuntimeLog(logRecord.bytes);
  const provenance = {
    contract: "kandev-highlight-runtime-provenance-v1",
    runtimeId: runtime.id,
    receiptDigest: receipt.receiptDigest,
    buildManifestDigest: receipt.build.manifestDigest,
    captureEvidenceDigest: contentRecord.identity.digest,
    runtimeLogDigest: logRecord.identity.digest,
    source: {
      mode: receipt.source.pre.mode,
      selectedSha: receipt.source.pre.selectedSha,
    },
    scanner: {
      contract: SENSITIVE_SCAN_CONTRACT,
      coverage: structuredClone(runtime.scannerCoverage),
    },
  };
  validateRuntimeProvenance(provenance, {
    sourceMode: request.source,
    sourceSha: request.sourceProof.selectedSha,
    buildManifestDigest: request.build.manifestDigest,
  });
  return {
    contract: "kandev-highlight-runtime-evidence-v1",
    captureEvidence,
    // The host log proves bounded execution, but is infrastructure output rather
    // than application evidence and must never be relabelled for sensitive scan.
    runtimeEvidence: { logs: [] },
    provenance,
  };
}
