import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  canonicalJson,
  digestBytes,
  isInside,
  requireAbsolute,
  requireExactKeys,
  validateCaptureContent,
  validateRuntimeWorkerRequest,
  validateRuntimeWorkerResult,
} from "./runtime-host-contracts.mjs";

const MAX_CAPTURE_CONTENT_EVIDENCE_BYTES = 512 * 1024;

export function computeRuntimeSourceCaptureDigest(request, sourceProof) {
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

export function compactRuntimeSourceProof(proof) {
  return {
    contract: proof.contract,
    mode: proof.source,
    selectedSha: proof.selectedSha,
    headSha: proof.headSha,
    currentMainSha: proof.currentMainSha,
  };
}

export function expectedRuntimeCapturePaths(workerRequest, scenarioId) {
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

export async function preflightRuntimeHostPaths(
  request,
  expectedRepositoryRoot,
) {
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

export async function snapshotRuntimeFile(
  filePath,
  label,
  { maxBytes = null } = {},
) {
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

export async function runtimeFileIdentity(filePath, label) {
  const snapshot = await snapshotRuntimeFile(filePath, label);
  return {
    path: snapshot.path,
    bytes: snapshot.bytes,
    digest: snapshot.digest,
  };
}

export async function writeRuntimeJsonExclusive(filePath, value, label) {
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

export async function writeRuntimeJsonAtomicExclusive(filePath, value, label) {
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

export async function readRuntimeJsonRegular(filePath, label) {
  const snapshot = await snapshotRuntimeFile(filePath, label);
  try {
    return JSON.parse(snapshot.contents.toString("utf8"));
  } catch (error) {
    throw new Error(`cannot parse ${label}: ${error.message}`);
  }
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
  await writeRuntimeJsonExclusive(absolute, validated, "runtime worker result");
  return validated;
}

export async function verifyRuntimeCaptureArtifacts(
  workerResult,
  workerRequest,
  { scenarioId, scenarioDigest, sourceDigest },
) {
  const expected = expectedRuntimeCapturePaths(workerRequest, scenarioId);
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
      snapshotRuntimeFile(expected.phaseManifestPath, "capture phase manifest"),
      snapshotRuntimeFile(
        expected.captureManifestPath,
        "source capture manifest",
      ),
      snapshotRuntimeFile(expected.rawMasterPath, "raw capture master"),
      snapshotRuntimeFile(
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

export async function verifyRuntimeCaptureTeardown(
  capture,
  workerRequest,
  scenarioId,
  deps,
) {
  const runtime = capture.receipt?.runtime;
  requireExactKeys(runtime, ["allocation", "teardown"], "capture runtime");
  requireExactKeys(
    runtime.allocation,
    [
      "display",
      "displayNumber",
      "cdpPort",
      "chromiumSandbox",
      "artifactRoot",
      "profileDir",
      "lockPath",
    ],
    "capture runtime allocation",
  );
  const expected = expectedRuntimeCapturePaths(workerRequest, scenarioId);
  if (
    !Number.isInteger(runtime.allocation.displayNumber) ||
    runtime.allocation.display !== `:${runtime.allocation.displayNumber}.0` ||
    !Number.isInteger(runtime.allocation.cdpPort) ||
    runtime.allocation.cdpPort < 1_024 ||
    runtime.allocation.cdpPort > 65_535 ||
    canonicalJson(runtime.allocation.chromiumSandbox) !==
      canonicalJson(workerRequest.chromiumSandbox) ||
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
    runtimePathRemoved(expected.captureProfileDir),
    runtimePathRemoved(expected.captureLockPath),
    runtimePathRemoved(coordinateLockPath),
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

export async function runtimePathRemoved(filePath) {
  try {
    await fs.lstat(filePath);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

export function buildRuntimeApplicationReceipt({
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

function runtimeRetryGuidance() {
  return {
    nextRunIdRequired: true,
    reason: "immutable-run-id-reserved",
  };
}

export function structuredRuntimeFailure(code, phase) {
  return { code, phase, retry: runtimeRetryGuidance() };
}

export function buildRuntimeFailureEvidence({
  request,
  phase,
  code,
  completedAt,
}) {
  const body = {
    contract: "kandev-highlight-runtime-host-failure-v1",
    version: 1,
    runtimeId: request.runtimeId,
    runId: request.runId,
    phase,
    failure: structuredRuntimeFailure(code, phase),
    completedAt,
  };
  return { ...body, failureDigest: digestBytes(canonicalJson(body)) };
}

export async function reserveRuntimeHostBundle(request) {
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

export async function prepareRuntimeHostBundle(paths) {
  await Promise.all([fs.mkdir(paths.homeRoot), fs.mkdir(paths.fixtureRoot)]);
  const fixtureIdentity = await requireCanonicalPath(paths.fixtureRoot, {
    kind: "directory",
    label: "host-owned fixture root",
  });
  if (!Number.isInteger(fixtureIdentity.ino) || fixtureIdentity.ino <= 0) {
    throw new Error("host-owned fixture root identity is invalid");
  }
}

export async function initializeRuntimeHostBundle(paths, workerRequest) {
  await writeRuntimeJsonExclusive(
    paths.requestPath,
    workerRequest,
    "runtime worker request",
  );
  await fs.writeFile(paths.logPath, "", { flag: "wx", mode: 0o600 });
  return runtimeFileIdentity(paths.requestPath, "runtime worker request");
}

export async function cleanupRuntimeHostFixture(paths) {
  await fs
    .rm(paths.fixtureRoot, { recursive: true, force: true })
    .catch(() => {});
}

export function buildRuntimeHostResult({
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

export async function maybeRuntimeFileIdentity(filePath, label) {
  try {
    return await runtimeFileIdentity(filePath, label);
  } catch (error) {
    if (/does not exist/.test(error.message)) return null;
    return null;
  }
}

export async function writeRuntimeApplicationReceipt({
  workerRequest,
  scenarioId,
  ...receiptInput
}) {
  const receipt = buildRuntimeApplicationReceipt(receiptInput);
  const receiptPath = expectedRuntimeCapturePaths(
    workerRequest,
    scenarioId,
  ).runtimeReceiptPath;
  await writeRuntimeJsonExclusive(
    receiptPath,
    receipt,
    "application runtime receipt",
  );
  return { receiptPath, digest: receipt.receiptDigest };
}

export async function writeRuntimeHostOutcome(input) {
  const result = buildRuntimeHostResult(input);
  await writeRuntimeJsonAtomicExclusive(
    input.paths.resultPath,
    result,
    "runtime host result",
  );
  return result;
}
