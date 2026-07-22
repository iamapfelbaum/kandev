import { constants as fsConstants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  compileCamera as defaultCompileCamera,
  resolveCaptureProfile,
} from "./camera-compiler.mjs";
import { loadLandingAdapter as defaultLoadLandingAdapter } from "./landing-adapter.mjs";
import {
  normalizeExecutionGeometry,
  runQualityAssurance as defaultRunQualityAssurance,
} from "./qa.mjs";
import { renderHighlight as defaultRenderHighlight } from "./render.mjs";
import { runHighlightPipeline } from "./runner.mjs";
import { loadVerifiedRuntimeEvidence as defaultLoadRuntimeEvidence } from "./runtime-evidence.mjs";
import { validateRuntimeProvenance } from "./runtime-provenance.mjs";
import * as scenarioContract from "./scenario.mjs";
import {
  createTrustedSensitiveScanner,
  getTrustedSensitiveScannerCoverage,
  validateSensitiveScanResult,
} from "./sensitive-scan.mjs";
import {
  computeStageManifestDigest,
  REVIEW_STAGE_CONTRACT,
  REVIEW_STAGE_VERSION,
} from "./stage.mjs";
import {
  assertExternalArtifactRoot,
  computeSourceCaptureDigest,
  verifySourceGate as defaultVerifySourceGate,
} from "./source-gate.mjs";
import { runBrowserPlaybackQa } from "./browser-qa.mjs";

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REQUIRED_DELIVERY_KINDS = Object.freeze(["mp4", "poster", "webm"]);

export const HIGHLIGHT_PIPELINE_VERSION = "1.0.0";

async function defaultCommandRunner(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return { ...result, exitCode: 0 };
}

async function defaultCaptureScenario(input) {
  let capture;
  try {
    capture = await import("./capture-source.mjs");
  } catch (error) {
    throw new Error(
      `permanent Highlight capture harness is unavailable: ${error.message}`,
      { cause: error },
    );
  }
  if (typeof capture.captureScenario !== "function") {
    throw new Error(
      "permanent Highlight capture harness must export captureScenario",
    );
  }
  return capture.captureScenario(input);
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function persistedJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

async function hashFile(filePath) {
  return sha256(await fs.readFile(filePath));
}

function requireSafeSegment(value, label) {
  if (
    typeof value !== "string" ||
    !SAFE_SEGMENT.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`${label} must be a safe path segment`);
  }
  return value;
}

function dependenciesWithDefaults(dependencies) {
  return {
    readScenario: scenarioContract.readScenario,
    compileTimeline: scenarioContract.compileTimeline,
    computeScenarioDigest: scenarioContract.computeScenarioDigest,
    requireDeliveryMetadata: scenarioContract.requireDeliveryMetadata,
    verifySourceGate: defaultVerifySourceGate,
    loadLandingAdapter: defaultLoadLandingAdapter,
    compileCamera: defaultCompileCamera,
    captureScenario: defaultCaptureScenario,
    renderHighlight: defaultRenderHighlight,
    runQualityAssurance: defaultRunQualityAssurance,
    browserPlayback: runBrowserPlaybackQa,
    loadRuntimeEvidence: defaultLoadRuntimeEvidence,
    createSensitiveScanner: createTrustedSensitiveScanner,
    commandRunner: defaultCommandRunner,
    readFile: fs.readFile,
    clock: () => new Date(),
    runIdNonce: () => randomBytes(4).toString("hex"),
    ...dependencies,
  };
}

function requireDelivery(deps, scenario) {
  if (typeof deps.requireDeliveryMetadata !== "function") {
    throw new Error(
      "scenario delivery metadata contract is unavailable; update scripts/highlights/scenario.mjs",
    );
  }
  return deps.requireDeliveryMetadata(scenario);
}

function requiredPrimitiveIds(scenario) {
  return [
    ...(scenario.setup?.primitives ?? []).map(
      (primitive) => primitive.primitiveId,
    ),
    ...(scenario.story?.actions ?? [])
      .filter((action) => action.kind === "extension")
      .map((action) => action.primitiveId),
  ];
}

function validateCaptureBindings({ scenario, bindings, allowedExtensionIds }) {
  if (!bindings || typeof bindings !== "object") {
    throw new Error(
      "capture requires checked-in app bindings with seedRegistry, primitiveRegistry, and navigateRoute",
    );
  }
  if (typeof bindings.seedRegistry?.[scenario.seed.recipe] !== "function") {
    throw new Error(
      `capture seed recipe '${scenario.seed.recipe}' has no checked-in binding`,
    );
  }
  if (scenario.setup?.route && typeof bindings.navigateRoute !== "function") {
    throw new Error(
      `capture route '${scenario.setup.route}' has no allowlisted navigateRoute binding`,
    );
  }
  if (
    bindings.buildProvenance?.contract !==
    "kandev-highlight-build-provenance-v1"
  ) {
    throw new Error(
      "capture bindings need exact current-checkout buildProvenance",
    );
  }
  const allowed = new Set(allowedExtensionIds);
  for (const primitiveId of requiredPrimitiveIds(scenario)) {
    if (!allowed.has(primitiveId))
      throw new Error(
        `primitive '${primitiveId}' is not present in --allow-extension`,
      );
    if (typeof bindings.primitiveRegistry?.[primitiveId] !== "function") {
      throw new Error(
        `primitive '${primitiveId}' has no checked-in binding function`,
      );
    }
  }
  return bindings;
}

function defaultRunId(scenarioDigest, capturedAt, nonce) {
  if (!/^[a-z0-9]{8,20}$/.test(nonce ?? "")) {
    throw new Error(
      "default run ID uniqueness token must be 8-20 lowercase letters or digits",
    );
  }
  const timestamp = capturedAt.replace(/[-:.]/g, "");
  return `run-${scenarioDigest.slice(
    "sha256:".length,
    "sha256:".length + 12,
  )}-${timestamp}-${nonce}`;
}

function pipelinePaths({ artifactRoot, scenarioId, runId }) {
  const runsRoot = path.join(artifactRoot, scenarioId, "runs");
  const attemptRoot = path.join(runsRoot, runId);
  return {
    artifactRoot,
    runsRoot,
    attemptRoot,
    evidenceRoot: path.join(attemptRoot, "evidence"),
    captureRoot: path.join(attemptRoot, "capture"),
    renderRoot: path.join(attemptRoot, "render"),
    qaRoot: path.join(attemptRoot, "qa"),
    stageRoot: path.join(artifactRoot, scenarioId, "stages"),
  };
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
    if (stat.isSymbolicLink())
      throw new Error(
        `artifact path cannot contain symlink components: ${current}`,
      );
  }
}

async function reserveAttempt(paths) {
  await rejectSymlinkComponents(paths.artifactRoot);
  await fs.mkdir(paths.runsRoot, { recursive: true });
  try {
    await fs.mkdir(paths.attemptRoot);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `refusing to overwrite existing Highlight run ${paths.attemptRoot}`,
      );
    throw error;
  }
  await fs.mkdir(paths.evidenceRoot);
}

async function writeJsonExclusive(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`refusing to overwrite immutable manifest: ${filePath}`);
    throw error;
  }
  return filePath;
}

async function writePhaseRecord(paths, phase, value, deps) {
  const source = persistedJsonValue({
    contract: `kandev-highlight-${phase}-phase-v1`,
    phase,
    completedAt: deps.clock().toISOString(),
    value,
  });
  const record = {
    ...source,
    recordDigest: `sha256:${sha256(canonicalJson(source))}`,
  };
  const manifestPath = await writeJsonExclusive(
    path.join(paths.evidenceRoot, `${phase}.json`),
    record,
  );
  return { ...value, phaseManifestPath: manifestPath };
}

async function writeCameraEvidence(paths, plan, track, landing) {
  const source = persistedJsonValue({
    contract: "kandev-highlight-camera-evidence-v1",
    plan,
    track,
    landing,
  });
  const record = {
    ...source,
    recordDigest: `sha256:${sha256(canonicalJson(source))}`,
  };
  const destination = path.join(paths.evidenceRoot, "camera.json");
  try {
    return await writeJsonExclusive(destination, record);
  } catch (error) {
    if (!/refusing to overwrite immutable manifest/.test(error.message)) {
      throw error;
    }
    const existing = await readJsonRegular(destination, "camera evidence");
    if (canonicalJson(existing) !== canonicalJson(record)) {
      throw new Error(
        `existing camera evidence does not match deterministic render recovery: ${destination}`,
      );
    }
    return destination;
  }
}

function rebasePublishedPaths(value, fromRoot, toRoot) {
  if (Array.isArray(value)) {
    return value.map((entry) => rebasePublishedPaths(entry, fromRoot, toRoot));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        rebasePublishedPaths(entry, fromRoot, toRoot),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  const source = path.resolve(fromRoot);
  if (value === source) return path.resolve(toRoot);
  if (!value.startsWith(`${source}${path.sep}`)) return value;
  return path.join(path.resolve(toRoot), path.relative(source, value));
}

function qaProofEntries(report) {
  const entries = [];
  for (const [artifactIndex, artifact] of (report?.artifacts ?? []).entries()) {
    const proofs = artifact?.proofs;
    if (!proofs || proofs.skipped === true) continue;
    if (!Array.isArray(proofs.keyframes) || !proofs.contactSheet) {
      throw new Error(
        `QA artifact ${artifactIndex} proof evidence is incomplete`,
      );
    }
    for (const [proofIndex, proof] of proofs.keyframes.entries()) {
      entries.push({
        ...proof,
        label: `QA artifact ${artifactIndex} keyframe ${proofIndex + 1}`,
      });
    }
    entries.push({
      ...proofs.contactSheet,
      label: `QA artifact ${artifactIndex} contact sheet`,
    });
  }
  return entries;
}

async function validateQaPublication(
  report,
  { publishedRoot, physicalRoot = publishedRoot } = {},
) {
  const expectedNames = new Set(["report.json"]);
  for (const proof of qaProofEntries(report)) {
    const publishedPath = path.resolve(proof.path ?? "");
    const relative = path.relative(path.resolve(publishedRoot), publishedPath);
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      path.dirname(relative) !== "."
    ) {
      throw new Error(`${proof.label} path escapes the published QA directory`);
    }
    if (expectedNames.has(relative)) {
      throw new Error(
        `${proof.label} duplicates published QA output ${relative}`,
      );
    }
    expectedNames.add(relative);
    const physicalPath = path.join(path.resolve(physicalRoot), relative);
    const stat = await fs.lstat(physicalPath).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${proof.label} is missing or is not a regular file`);
    }
    if ((await fs.realpath(physicalPath)) !== physicalPath) {
      throw new Error(`${proof.label} cannot resolve through symlinks`);
    }
    if (
      !Number.isInteger(proof.bytes) ||
      proof.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(proof.sha256 ?? "") ||
      stat.size !== proof.bytes ||
      (await hashFile(physicalPath)) !== proof.sha256
    ) {
      throw new Error(`${proof.label} digest or byte count does not match`);
    }
  }
  const reportPath = path.join(path.resolve(physicalRoot), "report.json");
  const persisted = await readJsonRegular(reportPath, "QA report");
  if (canonicalJson(persisted) !== canonicalJson(report)) {
    throw new Error("published QA report changed before publication");
  }
  const entries = await fs.readdir(physicalRoot, { withFileTypes: true });
  const actualNames = new Set(entries.map((entry) => entry.name));
  if (
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    actualNames.size !== expectedNames.size ||
    [...expectedNames].some((name) => !actualNames.has(name))
  ) {
    throw new Error(
      "published QA directory must contain exactly its regular report and proof files",
    );
  }
  return report;
}

async function publishedDirectoryExists(directory, label) {
  const stat = await fs.lstat(directory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} exists but is not a regular directory`);
  }
  if ((await fs.realpath(directory)) !== path.resolve(directory)) {
    throw new Error(`${label} cannot resolve through symlinks`);
  }
  return true;
}

async function requireOwnedQaBuild(buildDir, ownership) {
  const current = await fs.lstat(buildDir).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (
    !current?.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== ownership.dev ||
    current.ino !== ownership.ino
  ) {
    throw new Error(`refusing to use replaced QA build directory: ${buildDir}`);
  }
}

async function cleanupQaBuild(buildDir, ownership, primaryError) {
  if (!buildDir) throw primaryError;
  try {
    const current = await fs.lstat(buildDir).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!current) throw primaryError;
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== ownership.dev ||
      current.ino !== ownership.ino
    ) {
      throw new Error(
        `refusing to clean replaced QA build directory: ${buildDir}`,
      );
    }
    await fs.rm(buildDir, { recursive: true, force: true });
  } catch (cleanupError) {
    if (cleanupError === primaryError) throw primaryError;
    throw new AggregateError(
      [primaryError, cleanupError],
      "QA transaction failed and its private build directory could not be cleaned",
    );
  }
  throw primaryError;
}

async function recoverPublishedQa(context, render) {
  const reportPath = path.join(context.paths.qaRoot, "report.json");
  const report = await readJsonRegular(reportPath, "published QA report");
  const candidate = {
    ...report,
    reportPath,
    reportDigest: `sha256:${await hashFile(reportPath)}`,
  };
  await validateRecoveredQa(context, render, candidate);
  return candidate;
}

async function readJsonRegular(filePath, label) {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink())
    throw new Error(
      `${label} is missing or is not a regular file: ${filePath}`,
    );
  if ((await fs.realpath(filePath)) !== path.resolve(filePath))
    throw new Error(`${label} cannot resolve through symlinks: ${filePath}`);
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label} ${filePath}: ${error.message}`);
  }
}

function shellArgument(value) {
  return JSON.stringify(String(value));
}

function recoveryNextCommand(context, phase, { newAttempt = false } = {}) {
  const base = `node scripts/highlights.mjs ${phase} ${shellArgument(
    context.scenarioPath,
  )} --artifact-root ${shellArgument(context.paths.artifactRoot)}`;
  if (phase === "capture") {
    const source =
      context.sourceProvenance?.captureMode ?? context.source ?? "pr_head";
    return `${base} --source ${source}`;
  }
  if (!newAttempt && context.runId) {
    return `${base} --run-id ${shellArgument(context.runId)}`;
  }
  return base;
}

function recoveryError(context, message, nextPhase, options) {
  return new Error(
    `cannot recover ${context.command}: ${message}. Next command: ${recoveryNextCommand(
      context,
      nextPhase,
      options,
    )}`,
  );
}

async function readPhaseRecord(paths, phase, context, nextPhase) {
  let record;
  try {
    record = await readJsonRegular(
      path.join(paths.evidenceRoot, `${phase}.json`),
      `${phase} phase manifest`,
    );
  } catch (error) {
    throw recoveryError(context, error.message, nextPhase);
  }
  const expectedDigest = `sha256:${sha256(
    canonicalJson({
      contract: record.contract,
      phase: record.phase,
      completedAt: record.completedAt,
      value: record.value,
    }),
  )}`;
  if (
    record.contract !== `kandev-highlight-${phase}-phase-v1` ||
    record.phase !== phase ||
    !Number.isFinite(Date.parse(record.completedAt)) ||
    record.recordDigest !== expectedDigest
  ) {
    throw recoveryError(
      context,
      `${phase} phase manifest digest or contract is invalid`,
      nextPhase,
      { newAttempt: nextPhase === "capture" },
    );
  }
  return record;
}

async function readCameraEvidence(paths, context) {
  let record;
  try {
    record = await readJsonRegular(
      path.join(paths.evidenceRoot, "camera.json"),
      "camera evidence",
    );
  } catch (error) {
    throw recoveryError(context, error.message, "render");
  }
  const source = {
    contract: record.contract,
    plan: record.plan,
    track: record.track,
    landing: record.landing,
  };
  if (
    record.contract !== "kandev-highlight-camera-evidence-v1" ||
    record.recordDigest !== `sha256:${sha256(canonicalJson(source))}`
  ) {
    throw recoveryError(
      context,
      "camera evidence digest or contract is invalid",
      "render",
    );
  }
  return record;
}

function compactBuildProof(build) {
  const outputs = {};
  for (const key of ["backend", "mockAgent", "webDist"]) {
    const output = build?.outputs?.[key];
    outputs[key] = {
      digest: output?.digest,
      bytes: output?.bytes,
      ...(key === "webDist" ? { fileCount: output?.fileCount } : {}),
    };
  }
  return {
    contract: build?.contract,
    manifestDigest: build?.manifestDigest,
    sourceSha: build?.source?.selectedSha,
    outputs,
  };
}

async function verifyRegularDigest({
  filePath,
  allowedRoot,
  expectedDigest,
  expectedBytes,
  label,
}) {
  const absolute = path.resolve(filePath ?? "");
  const relative = path.relative(path.resolve(allowedRoot), absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} path escapes its immutable attempt directory`);
  }
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `${label} is missing or is not a regular file: ${absolute}`,
    );
  }
  if ((await fs.realpath(absolute)) !== absolute) {
    throw new Error(`${label} cannot resolve through symlinks: ${absolute}`);
  }
  if (
    !DIGEST_PATTERN.test(expectedDigest ?? "") ||
    (expectedBytes !== undefined && stat.size !== expectedBytes) ||
    `sha256:${await hashFile(absolute)}` !== expectedDigest
  ) {
    throw new Error(`${label} digest or byte count does not match evidence`);
  }
  return absolute;
}

async function validateRecoveredCapture(context, validate, capture) {
  const fail = (message) => {
    throw recoveryError(context, message, "capture", { newAttempt: true });
  };
  const source = validate?.source;
  const receipt = capture?.receipt;
  if (
    validate?.scenarioId !== context.scenario.id ||
    validate?.scenarioPath !== context.scenarioPath ||
    validate?.scenarioDigest !== context.scenarioDigest ||
    canonicalJson(validate?.profile) !== canonicalJson(context.profile)
  ) {
    fail("validate phase does not match the canonical scenario and profile");
  }
  if (
    !source ||
    !["pr_head", "current_main"].includes(source.captureMode) ||
    !SHA_PATTERN.test(source.sourceSha ?? "") ||
    source.gate?.contract !== "kandev-highlight-source-v1" ||
    source.gate?.selectedSha !== source.sourceSha ||
    source.gate?.clean !== true ||
    source.gate?.status !== ""
  ) {
    fail("validate source provenance is incomplete or invalid");
  }
  const sourceDigest = computeSourceCaptureDigest(source);
  if (
    capture?.contract !== "kandev-highlight-capture-result-v1" ||
    receipt?.contract !== "kandev-highlight-source-capture-v1" ||
    receipt.scenarioDigest !== context.scenarioDigest ||
    receipt.sourceDigest !== sourceDigest ||
    canonicalJson(receipt.source) !== canonicalJson(source.gate)
  ) {
    fail("capture source continuity does not match validate source evidence");
  }
  const build = validate.build;
  if (
    build?.contract !== "kandev-highlight-build-provenance-v1" ||
    !DIGEST_PATTERN.test(build.manifestDigest ?? "") ||
    build.source?.selectedSha !== source.sourceSha ||
    canonicalJson(receipt.build) !== canonicalJson(compactBuildProof(build))
  ) {
    fail("capture build manifest does not match validate build continuity");
  }
  for (const key of ["backend", "mockAgent", "webDist"]) {
    const output = receipt.build?.outputs?.[key];
    if (
      !DIGEST_PATTERN.test(output?.digest ?? "") ||
      !Number.isInteger(output?.bytes) ||
      output.bytes <= 0 ||
      (key === "webDist" &&
        (!Number.isInteger(output.fileCount) || output.fileCount <= 0))
    ) {
      fail(`capture build output ${key} is invalid`);
    }
  }
  if (
    capture.rawMasterPath &&
    path.resolve(capture.rawMasterPath) !==
      path.resolve(receipt.rawMaster?.path ?? "")
  ) {
    fail("raw master result path does not match capture receipt");
  }
  try {
    await verifyRegularDigest({
      filePath: receipt.rawMaster?.path,
      allowedRoot: context.paths.captureRoot,
      expectedDigest: receipt.rawMaster?.digest,
      expectedBytes: receipt.rawMaster?.bytes,
      label: "raw master",
    });
  } catch (error) {
    fail(error.message);
  }
  if (
    receipt.seed?.seedId !== context.scenario.seed.recipe ||
    !DIGEST_PATTERN.test(receipt.seed?.seedDigest ?? "")
  ) {
    fail("capture seed evidence does not match the canonical scenario");
  }
  return { source, sourceDigest };
}

async function collectRenderArtifactEvidence(render, renderRoot) {
  const stageDir = path.resolve(render?.stageDir ?? "");
  const stageRelative = path.relative(path.resolve(renderRoot), stageDir);
  if (
    !stageRelative ||
    stageRelative.startsWith("..") ||
    path.isAbsolute(stageRelative)
  ) {
    throw new Error("render stage directory escapes the immutable run");
  }
  return Promise.all(
    absoluteRenderArtifacts(render).map(async ({ kind, path: filePath }) => {
      const stat = await fs.lstat(filePath).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        throw new Error(`render ${kind} is missing or is not a regular file`);
      }
      if ((await fs.realpath(filePath)) !== path.resolve(filePath)) {
        throw new Error(`render ${kind} cannot resolve through symlinks`);
      }
      return {
        kind,
        path: filePath,
        bytes: stat.size,
        digest: `sha256:${await hashFile(filePath)}`,
      };
    }),
  );
}

async function validateRecoveredRender(context, camera, render) {
  const fail = (message) => {
    throw recoveryError(context, message, "render");
  };
  let recordedLanding;
  try {
    recordedLanding = landingEvidence({
      provenance: { sha: render?.landing?.sourceSha },
      contracts: {
        camera: { version: render?.landing?.contractVersion },
      },
    });
  } catch (error) {
    fail(`render landing identity is invalid: ${error.message}`);
  }
  if (
    canonicalJson(camera?.landing) !== canonicalJson(render?.landing) ||
    canonicalJson(recordedLanding.sourceSha) !==
      canonicalJson(render.landing.sourceSha)
  ) {
    fail("render landing identity does not match independent camera evidence");
  }
  if (
    context.landing &&
    canonicalJson(render.landing) !==
      canonicalJson(landingEvidence(context.landing))
  ) {
    fail("render landing identity does not match the loaded landing adapter");
  }
  if (canonicalJson(camera.track) !== canonicalJson(render.cameraTrack)) {
    fail("render camera track does not match camera evidence");
  }
  if (
    render?.manifest?.contract !== "kandev-highlight-render-v1" ||
    render.manifest.profile !== context.scenario.profile.kind
  ) {
    fail("render manifest does not match the canonical scenario profile");
  }
  let actual;
  try {
    actual = await collectRenderArtifactEvidence(
      render,
      context.paths.renderRoot,
    );
  } catch (error) {
    fail(error.message);
  }
  if (canonicalJson(actual) !== canonicalJson(render.artifactEvidence)) {
    fail(
      "rendered delivery artifact hashes/digests do not match render evidence",
    );
  }
  return render;
}

async function loadRuntimeQaEvidence(context, capture) {
  if (typeof context.deps.loadRuntimeEvidence !== "function") {
    throw new Error("QA requires the verified runtime evidence loader");
  }
  const loaded = await context.deps.loadRuntimeEvidence({
    artifactRoot: context.paths.artifactRoot,
    attemptRoot: context.paths.attemptRoot,
    scenarioId: context.scenario.id,
    scenarioPath: context.scenarioPath,
    scenarioDigest: context.scenarioDigest,
    runId: context.runId,
    captureReceipt: capture.receipt,
  });
  if (
    loaded?.contract !== "kandev-highlight-runtime-evidence-v1" ||
    !Array.isArray(loaded.captureEvidence?.visibleDomText) ||
    !Array.isArray(loaded.captureEvidence?.browserConsole) ||
    !Array.isArray(loaded.runtimeEvidence?.logs)
  ) {
    throw new Error(
      "verified runtime evidence loader returned incomplete typed evidence",
    );
  }
  validateRuntimeProvenance(loaded.provenance, {
    sourceMode: context.sourceProvenance?.captureMode,
    sourceSha: context.sourceProvenance?.sourceSha,
    buildManifestDigest: capture.receipt?.build?.manifestDigest,
  });
  if (
    loaded.provenance.scanner.coverage.runtimeLogs === false &&
    loaded.runtimeEvidence.logs.length !== 0
  ) {
    throw new Error(
      "verified runtime evidence cannot expose logs when runtimeLogs coverage is false",
    );
  }
  return loaded;
}

function sensitiveScannerForRuntime(context, provenance) {
  const expectedCoverage = provenance.scanner.coverage;
  const injected =
    context.deps.sensitiveScanner ?? context.captureBindings?.sensitiveScanner;
  if (injected !== undefined) {
    if (typeof injected !== "function") {
      throw new Error(
        "custom sensitive scanner must be a trusted scanner function",
      );
    }
    const declared = getTrustedSensitiveScannerCoverage(injected);
    if (
      !declared ||
      canonicalJson(declared) !== canonicalJson(expectedCoverage)
    ) {
      throw new Error(
        "custom sensitive scanner coverage must exactly match catalog runtime coverage",
      );
    }
    return injected;
  }
  const requiredCoverage = Object.entries(expectedCoverage)
    .filter(([, covered]) => covered)
    .map(([key]) => key);
  return context.deps.createSensitiveScanner({ requiredCoverage });
}

async function validateRecoveredQa(context, render, qa) {
  const fail = (message) => {
    throw recoveryError(context, message, "qa");
  };
  if (
    qa?.contract !== "kandev-highlight-qa-v1" ||
    qa.scenarioId !== context.scenario.id ||
    qa.passed !== true ||
    qa.status !== "technical_pass" ||
    !Number.isFinite(Date.parse(qa.completedAt)) ||
    qa.browser?.passed !== true
  ) {
    fail(
      "QA evidence must retain passed=true, status=technical_pass, and trusted scan/browser results",
    );
  }
  try {
    const loaded = await loadRuntimeQaEvidence(context, context.capture);
    if (canonicalJson(qa.runtime) !== canonicalJson(loaded.provenance)) {
      fail(
        "QA runtime provenance does not match verified external runtime evidence",
      );
    }
    validateSensitiveScanResult(qa.sensitiveData, {
      expectedCoverage: loaded.provenance.scanner.coverage,
    });
    if (qa.sensitiveData.passed !== true) {
      fail("QA sensitive-data evidence did not pass");
    }
    await verifyRegularDigest({
      filePath: qa.reportPath,
      allowedRoot: context.paths.qaRoot,
      expectedDigest: qa.reportDigest,
      label: "QA report",
    });
  } catch (error) {
    fail(error.message);
  }
  let report;
  try {
    report = await readJsonRegular(qa.reportPath, "QA report");
  } catch (error) {
    fail(error.message);
  }
  const phaseReport = persistedJsonValue(qa);
  delete phaseReport.reportPath;
  delete phaseReport.reportDigest;
  if (canonicalJson(report) !== canonicalJson(phaseReport)) {
    fail("QA report content does not match the QA phase evidence");
  }
  try {
    await validateQaPublication(report, {
      publishedRoot: context.paths.qaRoot,
    });
  } catch (error) {
    fail(error.message);
  }
  const rendered = new Map(
    (render.artifactEvidence ?? []).map((artifact) => [
      artifact.kind,
      artifact,
    ]),
  );
  const reported = reportArtifacts(qa);
  for (const kind of REQUIRED_DELIVERY_KINDS) {
    const expected = rendered.get(kind);
    const actual = reported.get(kind);
    if (
      !expected ||
      path.resolve(actual.path) !== path.resolve(expected.path) ||
      actual.bytes !== expected.bytes ||
      `sha256:${actual.sha256}` !== expected.digest
    ) {
      fail(`QA ${kind} artifact hash does not match render evidence`);
    }
  }
  return qa;
}

export async function resolveAttemptDirectory({
  artifactRoot,
  scenarioId,
  runId,
} = {}) {
  requireSafeSegment(scenarioId, "scenarioId");
  const root = path.join(path.resolve(artifactRoot), scenarioId, "runs");
  if (runId) {
    requireSafeSegment(runId, "runId");
    const selected = path.join(root, runId);
    const stat = await fs.lstat(selected).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Highlight run '${runId}' does not exist: ${selected}`);
    if ((await fs.realpath(selected)) !== path.resolve(selected))
      throw new Error(`Highlight run '${runId}' resolves through a symlink`);
    return selected;
  }
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch((error) => {
      if (error.code === "ENOENT")
        throw new Error(`no recoverable Highlight runs found under ${root}`);
      throw error;
    });
  const runs = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  if (runs.length === 0)
    throw new Error(`no recoverable Highlight runs found under ${root}`);
  if (runs.length > 1) {
    const error = new Error(
      `multiple Highlight runs found (${runs.join(", ")}); select one with --run-id`,
    );
    error.runIds = runs;
    throw error;
  }
  return path.join(root, runs[0]);
}

function parsePositiveInteger(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

async function defaultResolvePrMetadata({
  repoRoot,
  sourceSha,
  prNumber,
  prBaseSha,
  env,
  runner,
}) {
  const explicitNumber = parsePositiveInteger(
    prNumber ?? env.KANDEV_HIGHLIGHT_PR_NUMBER,
  );
  const explicitBase = prBaseSha ?? env.KANDEV_HIGHLIGHT_PR_BASE_SHA;
  if (explicitNumber && SHA_PATTERN.test(explicitBase ?? "")) {
    return {
      prNumber: explicitNumber,
      prBaseSha: explicitBase,
      prHeadSha: sourceSha,
    };
  }
  try {
    const result = await runner(
      "gh",
      ["pr", "view", "--json", "number,baseRefOid,headRefOid"],
      { cwd: repoRoot },
    );
    const parsed = JSON.parse(result.stdout);
    if (
      !parsePositiveInteger(parsed.number) ||
      !SHA_PATTERN.test(parsed.baseRefOid ?? "") ||
      parsed.headRefOid !== sourceSha
    ) {
      throw new Error("GitHub PR metadata does not match checked-out HEAD");
    }
    return {
      prNumber: parsed.number,
      prBaseSha: parsed.baseRefOid,
      prHeadSha: parsed.headRefOid,
    };
  } catch (error) {
    const missing = [];
    if (!explicitNumber) missing.push("--pr-number <number>");
    if (!SHA_PATTERN.test(explicitBase ?? ""))
      missing.push("--pr-base-sha <40-char-sha>");
    throw new Error(
      `pr_head provenance needs ${missing.join(" and ")}; automatic 'gh pr view' lookup failed: ${error.message}`,
      { cause: error },
    );
  }
}

async function resolveSourceProvenance({
  source,
  repoRoot,
  prNumber,
  prBaseSha,
  env,
  deps,
  capturedAt,
}) {
  const gate = await deps.verifySourceGate({
    repoRoot,
    source,
    runner: deps.commandRunner,
  });
  if (!SHA_PATTERN.test(gate?.selectedSha ?? "") || gate.clean !== true) {
    throw new Error("source gate must return an exact clean selected SHA");
  }
  if (source === "pr_head") {
    const resolver = deps.resolvePrMetadata ?? defaultResolvePrMetadata;
    const pr = await resolver({
      repoRoot,
      sourceSha: gate.selectedSha,
      prNumber,
      prBaseSha,
      env,
      runner: deps.commandRunner,
    });
    if (
      !parsePositiveInteger(pr?.prNumber) ||
      !SHA_PATTERN.test(pr?.prBaseSha ?? "") ||
      pr?.prHeadSha !== gate.selectedSha
    ) {
      throw new Error(
        "pr_head metadata must include matching PR number, base SHA, and head SHA",
      );
    }
    return {
      captureMode: source,
      sourceSha: gate.selectedSha,
      capturedAt,
      prNumber: pr.prNumber,
      prBaseSha: pr.prBaseSha,
      prHeadSha: gate.selectedSha,
      gate,
    };
  }
  return {
    captureMode: source,
    sourceSha: gate.selectedSha,
    sourceRef: "origin/main",
    capturedAt,
    gate,
  };
}

function landingEvidence(adapter) {
  const sourceSha = adapter?.provenance?.sha;
  const contractVersion =
    adapter?.contracts?.camera?.version ??
    adapter?.contracts?.cameraDirectives?.version ??
    adapter?.provenance?.contracts?.camera?.version;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceSha ?? "")) {
    throw new Error("landing adapter provenance needs exact clean source SHA");
  }
  if (typeof contractVersion !== "string" || !contractVersion.trim()) {
    throw new Error("landing adapter provenance needs camera contract version");
  }
  return { sourceSha, contractVersion, contracts: adapter.contracts };
}

function buildEncodingConfig({
  scenario,
  timeline,
  camera,
  track,
  paths,
  runId,
}) {
  const profile = camera.captureProfile;
  const mobile = scenario.profile.kind === "native-mobile";
  const outputDir = path.join(paths.renderRoot, scenario.id, runId);
  return {
    slug: `${mobile ? "mobile" : "desktop"}-${scenario.id}`,
    rawPath: path.join(paths.captureRoot, "raw", `${scenario.id}.source.mp4`),
    outputDir,
    trimStartMs: 0,
    posterAtMs: Math.max(
      camera.openingSettleMs,
      timeline.totalDurationMs - camera.endingSettleMs,
    ),
    sourceWidth: profile.sourceWidth,
    sourceHeight: profile.sourceHeight,
    outputWidth: profile.deliveryWidth,
    outputHeight: profile.deliveryHeight,
    track,
  };
}

function buildDryRunPlan({
  command,
  scenario,
  scenarioPath,
  scenarioDigest,
  timeline,
  profile,
  sourceProvenance,
  sourceDigest,
  landing,
  paths,
  runId,
  deps,
}) {
  let camera = null;
  let cameraDeferred = null;
  let encodingPlan = null;
  if (landing) {
    try {
      camera = deps.compileCamera({ scenario, timeline });
      const track = landing.materializeCameraTrack(camera);
      encodingPlan = landing.buildHighlightEncodingPlan(
        buildEncodingConfig({
          scenario,
          timeline,
          camera,
          track,
          paths,
          runId,
        }),
      );
    } catch (error) {
      if (
        scenario.story.actions.some((action) => action.kind === "cameraFocus")
      ) {
        cameraDeferred = `runtime semantic focus geometry required: ${error.message}`;
      } else {
        throw error;
      }
    }
  }
  const encodingCommands = Object.values(encodingPlan ?? {}).map((step) => ({
    kind: path.extname(step.outputPath ?? "").slice(1) || null,
    argv: [step.command, ...step.args],
    outputPath: step.outputPath,
  }));
  return {
    contract: "kandev-highlight-dry-run-v1",
    command,
    dryRun: true,
    runId,
    scenario: {
      id: scenario.id,
      path: scenarioPath,
      digest: scenarioDigest,
      title: scenario.title,
    },
    timeline,
    profile: {
      kind: profile.kind,
      nativeMobile: profile.nativeMobile,
      viewport: {
        width: profile.cssWidth,
        height: profile.cssHeight,
        dpr: profile.dpr,
      },
      source: {
        width: profile.sourceWidth,
        height: profile.sourceHeight,
        fps: profile.fps,
      },
      delivery: {
        width: profile.deliveryWidth,
        height: profile.deliveryHeight,
        fps: profile.fps,
      },
    },
    source: sourceProvenance
      ? {
          sourceSha: sourceProvenance.sourceSha,
          mode: sourceProvenance.captureMode,
          digest: sourceDigest,
        }
      : null,
    landing: landing
      ? {
          ...landingEvidence(landing),
          root: landing.root ?? landing.provenance?.root ?? null,
        }
      : null,
    camera: camera ?? { status: "runtime-required", reason: cameraDeferred },
    prerequisites: {
      app: { status: "required", frontendUrl: deps.frontendUrl ?? null },
      capture: {
        executables: ["Xvfb", "Chromium", "ffmpeg", "ffprobe"],
        sourceEncoder: "runtime-readiness-probe",
      },
      selectors: {
        status: "runtime-required",
        claim: "not-resolved-by-static-dry-run",
      },
      browserPlayback: {
        status: "required",
        engine: "Playwright Chromium",
        speed: 1,
      },
      sensitiveScan: {
        defaultCoverage: ["scenario", "camera-metadata"],
        pixelScan: false,
        logScan: false,
        extensionHook: "capture bindings may provide sensitiveScanner",
      },
    },
    captureCommand: [
      "ffmpeg",
      "-f",
      "x11grab",
      "-draw_mouse",
      "0",
      "-framerate",
      String(profile.fps),
      "-video_size",
      `${profile.sourceWidth}x${profile.sourceHeight}`,
      "-i",
      "<allocated-x-display>",
      "-an",
      "<verified-h264-encoder>",
      "-n",
      path.join(paths.captureRoot, "raw", `${scenario.id}.source.mp4`),
    ],
    encodingCommands,
    paths: {
      attempt: paths.attemptRoot,
      capture: paths.captureRoot,
      render: paths.renderRoot,
      qa: paths.qaRoot,
      stagePattern: path.join(paths.stageRoot, "<sha256-manifest-digest>"),
    },
  };
}

function absoluteRenderArtifacts(render) {
  const artifacts = render?.manifest?.artifacts;
  if (!Array.isArray(artifacts))
    throw new Error("render manifest contains no delivery artifacts");
  const seen = new Set();
  const normalized = artifacts.map((artifact) => {
    if (
      !REQUIRED_DELIVERY_KINDS.includes(artifact.kind) ||
      seen.has(artifact.kind)
    ) {
      throw new Error(
        `render artifacts must contain each of mp4, poster, and webm exactly once; invalid ${artifact.kind}`,
      );
    }
    seen.add(artifact.kind);
    const absolute = path.resolve(render.stageDir, artifact.path);
    const relative = path.relative(render.stageDir, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${artifact.kind} render artifact escapes render stage`);
    }
    return { kind: artifact.kind, path: absolute };
  });
  if (seen.size !== REQUIRED_DELIVERY_KINDS.length)
    throw new Error("render artifacts must contain mp4, poster, and webm");
  return normalized;
}

function expectedForArtifact(kind, profile, durationMs) {
  return {
    kind,
    width: profile.deliveryWidth,
    height: profile.deliveryHeight,
    fps: kind === "poster" ? null : profile.fps,
    durationMs: kind === "poster" ? null : durationMs,
    ...(kind === "poster"
      ? {}
      : { durationToleranceMs: Math.ceil(1_000 / profile.fps) }),
    codec: kind === "mp4" ? "h264" : kind === "webm" ? "vp9" : "webp",
    audio: false,
    ...(kind === "mp4" ? { faststart: true } : {}),
  };
}

function stageInput(context, phases) {
  return {
    artifactRoot: context.paths.artifactRoot,
    scenario: context.scenario,
    scenarioPath: context.scenarioPath,
    scenarioDigest: context.scenarioDigest,
    delivery: context.delivery,
    capture: phases.capture,
    render: phases.render,
    qa: phases.qa,
    sourceProvenance: context.sourceProvenance,
    landing: context.recoveredLanding ?? landingEvidence(context.landing),
    toolVersion: `kandev-highlights/${HIGHLIGHT_PIPELINE_VERSION}`,
  };
}

function phaseAdapters(context) {
  const {
    deps,
    scenario,
    scenarioDigest,
    scenarioPath,
    timeline,
    profile,
    sourceProvenance,
    sourceDigest,
    landing,
    paths,
    runId,
    env,
  } = context;
  return {
    validate: async () =>
      writePhaseRecord(
        paths,
        "validate",
        {
          scenarioId: scenario.id,
          scenarioPath,
          scenarioDigest,
          source: sourceProvenance,
          build: context.captureBindings?.buildProvenance ?? null,
          profile,
        },
        deps,
      ),
    storyboard: async () =>
      writePhaseRecord(paths, "storyboard", { timeline }, deps),
    capture: async () => {
      const frontendUrl = deps.frontendUrl ?? env.KANDEV_HIGHLIGHT_FRONTEND_URL;
      if (!/^https?:\/\//.test(frontendUrl ?? "")) {
        throw new Error(
          "capture requires KANDEV_HIGHLIGHT_FRONTEND_URL (or injected frontendUrl) for isolated seeded app",
        );
      }
      const capture = await deps.captureScenario({
        ...context.captureBindings,
        scenario,
        timeline,
        source: sourceProvenance.gate,
        sourceDigest,
        frontendUrl,
        artifactRoot: paths.captureRoot,
        repositoryRoots: [context.repoRoot, landing?.root].filter(Boolean),
        runId,
      });
      if (capture?.receipt?.scenarioDigest !== scenarioDigest)
        throw new Error("capture receipt scenario digest mismatch");
      if (capture?.receipt?.sourceDigest !== sourceDigest)
        throw new Error("capture receipt source digest mismatch");
      if (
        capture?.receipt?.source?.selectedSha !==
        sourceProvenance.gate.selectedSha
      ) {
        throw new Error("capture receipt source gate proof mismatch");
      }
      if (
        capture?.receipt?.build?.sourceSha !==
          sourceProvenance.gate.selectedSha ||
        capture?.receipt?.build?.manifestDigest !==
          context.captureBindings.buildProvenance.manifestDigest
      ) {
        throw new Error("capture receipt build provenance mismatch");
      }
      if (!DIGEST_PATTERN.test(capture?.receipt?.rawMaster?.digest ?? ""))
        throw new Error("capture receipt needs raw master SHA-256");
      if (
        capture?.receipt?.seed?.seedId !== scenario.seed.recipe ||
        !DIGEST_PATTERN.test(capture?.receipt?.seed?.seedDigest ?? "")
      ) {
        throw new Error(
          "capture receipt needs exact declared seed identity and digest",
        );
      }
      return writePhaseRecord(paths, "capture", capture, deps);
    },
    render: async ({ phases }) => {
      const capture = phases.capture;
      const execution = capture.execution ?? capture.receipt?.execution;
      const camera = deps.compileCamera({
        scenario,
        timeline,
        semanticEvents: execution?.steps ?? [],
        execution,
      });
      const render = await deps.renderHighlight({
        scenario,
        capture: {
          rawPath: capture.rawMasterPath ?? capture.receipt.rawMaster.path,
          digest: capture.receipt.rawMaster.digest,
          storyStartOffsetMs: capture.receipt.storyStartOffsetMs,
        },
        camera,
        artifactRoot: paths.renderRoot,
        runId,
        repoRoots: [context.repoRoot, landing.root].filter(Boolean),
        landingAdapter: landing,
        recoverPublished: true,
      });
      const adapterEvidence = landingEvidence(landing);
      const artifactEvidence = await collectRenderArtifactEvidence(
        render,
        paths.renderRoot,
      );
      await writeCameraEvidence(
        paths,
        camera,
        render.cameraTrack,
        adapterEvidence,
      );
      return writePhaseRecord(
        paths,
        "render",
        { ...render, landing: adapterEvidence, artifactEvidence },
        deps,
      );
    },
    qa: async ({ phases }) => {
      const capture = phases.capture;
      const render = phases.render;
      if (await publishedDirectoryExists(paths.qaRoot, "published QA output")) {
        return writePhaseRecord(
          paths,
          "qa",
          await recoverPublishedQa(context, render),
          deps,
        );
      }
      const runtime = await loadRuntimeQaEvidence(context, capture);
      const artifacts = absoluteRenderArtifacts(render).map((artifact) => ({
        ...artifact,
        expected: expectedForArtifact(
          artifact.kind,
          profile,
          timeline.totalDurationMs,
        ),
      }));
      const execution = capture.execution ?? capture.receipt?.execution;
      const geometry = normalizeExecutionGeometry({
        execution,
        captureProfile: profile,
        fps: profile.fps,
      });
      const sensitiveScanner = sensitiveScannerForRuntime(
        context,
        runtime.provenance,
      );
      const qaBuildDir = await fs.mkdtemp(
        path.join(paths.attemptRoot, ".qa-building-"),
      );
      const qaBuildOwnership = await fs.lstat(qaBuildDir);
      let ownedBuildDir = qaBuildDir;
      try {
        const report = await deps.runQualityAssurance({
          scenario,
          artifacts,
          camera: render.cameraTrack,
          pointerTrack: geometry.pointerTrack,
          targetIntervals: geometry.targetIntervals,
          captureEvidence: runtime.captureEvidence,
          runtimeEvidence: runtime.runtimeEvidence,
          runner: deps.commandRunner,
          readFile: deps.readFile,
          browserPlayback: ({ artifacts: reports }) =>
            deps.browserPlayback({
              artifacts: reports,
              webRoot: path.join(context.repoRoot, "apps/web"),
            }),
          cameraAuditor: landing.auditHighlightCameraMotion,
          qaOutputDir: qaBuildDir,
          sensitiveScanner,
        });
        if (report?.passed !== true)
          throw new Error("automatic QA did not pass");
        validateSensitiveScanResult(report.sensitiveData, {
          expectedCoverage: runtime.provenance.scanner.coverage,
        });
        if (report.sensitiveData.passed !== true) {
          throw new Error("automatic QA sensitive-data scan did not pass");
        }
        await requireOwnedQaBuild(qaBuildDir, qaBuildOwnership);
        const completedAt = deps.clock().toISOString();
        const technical = rebasePublishedPaths(
          {
            ...report,
            runtime: runtime.provenance,
            status: "technical_pass",
            passed: true,
            completedAt,
          },
          qaBuildDir,
          paths.qaRoot,
        );
        await writeJsonExclusive(
          path.join(qaBuildDir, "report.json"),
          technical,
        );
        await validateQaPublication(technical, {
          publishedRoot: paths.qaRoot,
          physicalRoot: qaBuildDir,
        });
        await requireOwnedQaBuild(qaBuildDir, qaBuildOwnership);
        if (
          await publishedDirectoryExists(paths.qaRoot, "published QA output")
        ) {
          throw new Error(
            `refusing to overwrite published QA output: ${paths.qaRoot}`,
          );
        }
        try {
          await fs.rename(qaBuildDir, paths.qaRoot);
        } catch (error) {
          if (["EEXIST", "ENOTEMPTY"].includes(error.code)) {
            throw new Error(
              `refusing to overwrite published QA output: ${paths.qaRoot}`,
            );
          }
          throw error;
        }
        ownedBuildDir = null;
        const reportPath = path.join(paths.qaRoot, "report.json");
        const reportDigest = `sha256:${await hashFile(reportPath)}`;
        return await writePhaseRecord(
          paths,
          "qa",
          { ...technical, reportPath, reportDigest },
          deps,
        );
      } catch (error) {
        return cleanupQaBuild(ownedBuildDir, qaBuildOwnership, error);
      }
    },
    stage: async ({ phases }) =>
      writeContentAddressedStage(stageInput(context, phases)),
  };
}

async function recoverContext(context) {
  let attemptRoot;
  try {
    attemptRoot = await resolveAttemptDirectory({
      artifactRoot: context.paths.artifactRoot,
      scenarioId: context.scenario.id,
      runId: context.requestedRunId,
    });
  } catch (error) {
    if (Array.isArray(error.runIds)) {
      const choices = error.runIds.map((candidate) =>
        recoveryNextCommand({ ...context, runId: candidate }, context.command),
      );
      throw new Error(
        `${error.message}. Next commands:\n${choices.join("\n")}`,
      );
    }
    throw new Error(
      `${error.message}. Next command: ${recoveryNextCommand(
        context,
        "capture",
        { newAttempt: true },
      )}`,
    );
  }
  const recoveredRunId = path.basename(attemptRoot);
  const paths = pipelinePaths({
    artifactRoot: context.paths.artifactRoot,
    scenarioId: context.scenario.id,
    runId: recoveredRunId,
  });
  const recovery = { ...context, runId: recoveredRunId, paths };
  const validateRecord = await readPhaseRecord(
    paths,
    "validate",
    recovery,
    "capture",
  );
  recovery.sourceProvenance = validateRecord.value?.source;
  if (validateRecord.value?.scenarioDigest !== context.scenarioDigest) {
    throw recoveryError(
      recovery,
      "scenario changed since validation; validate manifest digest does not match",
      "capture",
      { newAttempt: true },
    );
  }
  const storyboardRecord = await readPhaseRecord(
    paths,
    "storyboard",
    recovery,
    "capture",
  );
  if (
    canonicalJson(storyboardRecord.value?.timeline) !==
    canonicalJson(context.timeline)
  ) {
    throw recoveryError(
      recovery,
      "storyboard timeline does not match the canonical scenario timeline",
      "capture",
      { newAttempt: true },
    );
  }
  const captureRecord = await readPhaseRecord(
    paths,
    "capture",
    recovery,
    "capture",
  );
  if (captureRecord.value?.receipt?.scenarioDigest !== context.scenarioDigest) {
    throw recoveryError(
      recovery,
      "scenario changed since capture; capture manifest digest does not match",
      "capture",
      { newAttempt: true },
    );
  }
  const captureProof = await validateRecoveredCapture(
    recovery,
    validateRecord.value,
    captureRecord.value,
  );
  return {
    ...recovery,
    sourceProvenance: captureProof.source,
    sourceDigest: captureProof.sourceDigest,
    validate: validateRecord.value,
    storyboard: storyboardRecord.value,
    capture: captureRecord.value,
  };
}

export async function runDeclarativeHighlightCommand({
  command,
  scenarioPath,
  artifactRoot,
  source,
  repoRoot = process.cwd(),
  landingRoot,
  runId,
  prNumber,
  prBaseSha,
  dryRun = false,
  allowedExtensionIds = [],
  env = process.env,
  dependencies = {},
} = {}) {
  if (!["capture", "render", "qa", "stage", "run"].includes(command))
    throw new Error("command must be capture, render, qa, stage, or run");
  if (typeof scenarioPath !== "string" || !scenarioPath)
    throw new Error(`${command} requires scenarioPath`);
  if (typeof artifactRoot !== "string" || !artifactRoot)
    throw new Error(`${command} requires --artifact-root outside repositories`);
  if (
    ["capture", "run"].includes(command) &&
    !["pr_head", "current_main"].includes(source)
  ) {
    throw new Error(`${command} --source must be pr_head or current_main`);
  }
  const deps = dependenciesWithDefaults(dependencies);
  const absoluteScenario = path.resolve(scenarioPath);
  const scenarioOptions = { allowedExtensionIds };
  const scenario = await deps.readScenario(absoluteScenario, scenarioOptions);
  const scenarioDigest = deps.computeScenarioDigest(scenario, scenarioOptions);
  const timeline = deps.compileTimeline(scenario, scenarioOptions);
  if (timeline.scenarioDigest !== scenarioDigest)
    throw new Error("compiled timeline scenario digest mismatch");
  const profile = resolveCaptureProfile(scenario.profile);
  const delivery = ["run", "stage"].includes(command)
    ? requireDelivery(deps, scenario)
    : null;
  let captureBindings = null;
  if (["capture", "run"].includes(command) && !dryRun) {
    const candidate =
      typeof deps.loadCaptureBindings === "function"
        ? await deps.loadCaptureBindings({
            scenario,
            repoRoot: path.resolve(repoRoot),
            allowedExtensionIds,
          })
        : deps.captureBindings;
    captureBindings = validateCaptureBindings({
      scenario,
      bindings: candidate,
      allowedExtensionIds,
    });
  }
  const captureTime = deps.clock();
  const capturedAt = captureTime.toISOString();
  const createsAttempt = ["capture", "run"].includes(command);
  const selectedRunId = requireSafeSegment(
    runId ??
      (createsAttempt
        ? defaultRunId(scenarioDigest, capturedAt, deps.runIdNonce())
        : "recover"),
    "runId",
  );
  const externalRoot = assertExternalArtifactRoot({
    artifactRoot: path.resolve(artifactRoot),
    repoRoots: [repoRoot, landingRoot].filter(Boolean),
  });
  const paths = pipelinePaths({
    artifactRoot: externalRoot,
    scenarioId: scenario.id,
    runId: selectedRunId,
  });
  const sourceProvenance = ["capture", "run"].includes(command)
    ? await resolveSourceProvenance({
        source,
        repoRoot,
        prNumber,
        prBaseSha,
        env,
        deps,
        capturedAt,
      })
    : null;
  const sourceDigest = sourceProvenance
    ? computeSourceCaptureDigest(sourceProvenance)
    : null;
  const needsLanding = ["render", "qa", "run"].includes(command);
  const landing = needsLanding
    ? await deps.loadLandingAdapter({
        landingRoot,
        env,
        runner: deps.commandRunner,
      })
    : null;
  if (landing) landingEvidence(landing);
  const common = {
    command,
    scenario,
    scenarioPath: absoluteScenario,
    scenarioDigest,
    timeline,
    profile,
    delivery,
    sourceProvenance,
    sourceDigest,
    landing,
    paths,
    runId: selectedRunId,
    requestedRunId: runId,
    repoRoot: path.resolve(repoRoot),
    deps,
    env,
    allowedExtensionIds,
    captureBindings,
  };
  if (dryRun && createsAttempt) return buildDryRunPlan(common);

  if (["capture", "run"].includes(command)) await reserveAttempt(paths);
  if (command === "run") {
    return runHighlightPipeline({
      scenario,
      adapters: phaseAdapters(common),
      context: common,
    });
  }
  if (command === "capture") {
    const adapters = phaseAdapters(common);
    const phases = {};
    phases.validate = await adapters.validate({ phases });
    phases.storyboard = await adapters.storyboard({ phases });
    phases.capture = await adapters.capture({ phases });
    return {
      contract: "kandev-highlight-command-v1",
      command,
      runId: selectedRunId,
      order: ["validate", "storyboard", "capture"],
      phases,
    };
  }

  const recovered = await recoverContext(common);
  const adapters = phaseAdapters(recovered);
  const phases = { capture: recovered.capture };
  if (command === "render") {
    if (dryRun) {
      return {
        ...buildDryRunPlan(recovered),
        runId: recovered.runId,
        verifiedPhases: ["validate", "storyboard", "capture"],
      };
    }
    phases.render = await adapters.render({ phases });
    return {
      contract: "kandev-highlight-command-v1",
      command,
      runId: recovered.runId,
      order: ["render"],
      phases,
    };
  }
  const renderRecord = await readPhaseRecord(
    recovered.paths,
    "render",
    recovered,
    "render",
  );
  const cameraRecord = await readCameraEvidence(recovered.paths, recovered);
  await validateRecoveredRender(recovered, cameraRecord, renderRecord.value);
  phases.render = { ...renderRecord.value, cameraTrack: cameraRecord.track };
  if (command === "qa" && dryRun) {
    return {
      ...buildDryRunPlan(recovered),
      runId: recovered.runId,
      verifiedPhases: ["validate", "storyboard", "capture", "camera", "render"],
    };
  }
  if (command === "stage") {
    const qaRecord = await readPhaseRecord(
      recovered.paths,
      "qa",
      recovered,
      "qa",
    );
    phases.qa = qaRecord.value;
    await validateRecoveredQa(recovered, phases.render, phases.qa);
    recovered.recoveredLanding = renderRecord.value.landing;
    if (dryRun) {
      const preview = previewContentAddressedStage(
        stageInput(recovered, phases),
      );
      return {
        contract: "kandev-highlight-stage-dry-run-v1",
        command,
        dryRun: true,
        runId: recovered.runId,
        verifiedPhases: [
          "validate",
          "storyboard",
          "capture",
          "camera",
          "render",
          "qa",
        ],
        ...preview,
      };
    }
    const stageAdapters = phaseAdapters(recovered);
    phases.stage = await stageAdapters.stage({ phases });
    return {
      contract: "kandev-highlight-command-v1",
      command,
      runId: recovered.runId,
      order: ["stage"],
      phases,
    };
  }
  phases.qa = await adapters.qa({ phases });
  return {
    contract: "kandev-highlight-command-v1",
    command,
    runId: recovered.runId,
    order: ["qa"],
    phases,
  };
}

async function copyRegular(source, destination, label) {
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink())
    throw new Error(`${label} must be a regular file: ${source}`);
  if ((await fs.realpath(source)) !== path.resolve(source))
    throw new Error(
      `${label} cannot resolve through symlinked parents: ${source}`,
    );
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.copyFile(
      source,
      destination,
      fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE,
    );
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`refusing to overwrite staged ${label}: ${destination}`);
    throw error;
  }
}

function reportArtifacts(qa) {
  if (!Array.isArray(qa?.artifacts))
    throw new Error("accepted QA report needs delivery artifacts");
  const byKind = new Map();
  for (const artifact of qa.artifacts) {
    if (
      !REQUIRED_DELIVERY_KINDS.includes(artifact.kind) ||
      byKind.has(artifact.kind)
    ) {
      throw new Error(
        "accepted QA must report mp4, poster, and webm exactly once",
      );
    }
    byKind.set(artifact.kind, artifact);
  }
  if (byKind.size !== REQUIRED_DELIVERY_KINDS.length)
    throw new Error(
      "accepted QA must report mp4, poster, and webm exactly once",
    );
  return byKind;
}

async function copyDeliverySet({ qa, building, form }) {
  const result = {};
  for (const kind of REQUIRED_DELIVERY_KINDS) {
    const report = qa.get(kind);
    const relative = deliveryRelativePath(form, kind);
    const destination = path.join(building, relative);
    await copyRegular(report.path, destination, `${form} ${kind}`);
    const bytes = await fs.readFile(destination);
    const exactSha = sha256(bytes);
    if (report.bytes !== bytes.length || report.sha256 !== exactSha) {
      throw new Error(`${form} ${kind} QA hash/bytes do not match delivery`);
    }
    result[kind] = deliveryRecord(report, form, kind, {
      bytes: bytes.length,
      sha256: exactSha,
    });
  }
  return result;
}

function deliveryRelativePath(form, kind) {
  const extension = kind === "poster" ? "webp" : kind;
  return `deliveries/${form}.${extension}`;
}

function deliveryRecord(report, form, kind, exact = {}) {
  const probe = report.probe;
  return {
    path: deliveryRelativePath(form, kind),
    bytes: exact.bytes ?? report.bytes,
    sha256: exact.sha256 ?? report.sha256,
    codec: probe.codec,
    width: probe.width,
    height: probe.height,
    fps: kind === "poster" ? null : probe.fps,
    duration: kind === "poster" ? null : probe.durationMs / 1_000,
    audio: probe.audioStreams !== 0,
  };
}

function reviewManifest(input, assets, form) {
  const common = {
    schemaVersion: REVIEW_STAGE_VERSION,
    revision: input.delivery.revision,
    highlight: input.delivery.highlight,
    scenario: { path: "scenario.json", digest: input.scenarioDigest },
    capture: {
      path: `raw/${input.scenario.id}.source.mp4`,
      digest: input.capture.receipt.rawMaster.digest,
    },
    qa: {
      status: "technical_pass",
      passed: true,
      reportPath: "qa/report.json",
      reportDigest: input.qa.reportDigest,
      completedAt: input.qa.completedAt,
    },
    provenance: stageProvenance(input),
  };
  const reason =
    form === "desktop"
      ? "explicit-acceptance-required"
      : "desktop-stage-required";
  const manifest = {
    contract: REVIEW_STAGE_CONTRACT,
    ...common,
    profile: input.scenario.profile.kind,
    promotable: false,
    readyForReview: true,
    reason,
    assets: { [form]: assets },
  };
  manifest.stageDigest = computeStageManifestDigest(manifest);
  return { manifest, reason };
}

function previewContentAddressedStage(input) {
  assertStageInput(input);
  const form =
    input.scenario.profile.kind === "native-mobile" ? "mobile" : "desktop";
  const reports = reportArtifacts(input.qa);
  const assets = Object.fromEntries(
    REQUIRED_DELIVERY_KINDS.map((kind) => [
      kind,
      deliveryRecord(reports.get(kind), form, kind),
    ]),
  );
  const { manifest, reason } = reviewManifest(input, assets, form);
  const target = path.join(
    path.resolve(input.artifactRoot),
    input.scenario.id,
    "stages",
    manifest.stageDigest.slice("sha256:".length),
  );
  return {
    promotable: false,
    readyForReview: true,
    reason,
    stageDigest: manifest.stageDigest,
    target,
    manifestPath: path.join(target, "review.json"),
    manifest,
  };
}

function stageProvenance(input) {
  const seed = input.capture.receipt.seed;
  const source = input.sourceProvenance;
  return {
    captureMode: source.captureMode,
    sourceSha: source.sourceSha,
    capturedAt: source.capturedAt,
    seedId: seed.seedId,
    seedDigest: seed.seedDigest,
    toolVersion: input.toolVersion,
    landingAdapter: {
      sourceSha: input.landing.sourceSha,
      contractVersion: input.landing.contractVersion,
    },
    runtime: structuredClone(input.qa.runtime),
    ...(source.captureMode === "pr_head"
      ? {
          prNumber: source.prNumber,
          prBaseSha: source.prBaseSha,
          prHeadSha: source.prHeadSha,
        }
      : { sourceRef: source.sourceRef }),
  };
}

function assertStageInput(input) {
  if (!input?.delivery?.revision || !input.delivery.highlight)
    throw new Error("stage requires scenario delivery metadata");
  if (input.qa?.passed !== true || input.qa?.status !== "technical_pass")
    throw new Error(
      "review stage requires QA passed=true and status=technical_pass",
    );
  if (!DIGEST_PATTERN.test(input.scenarioDigest ?? ""))
    throw new Error("stage requires exact scenario digest");
  if (!DIGEST_PATTERN.test(input.capture?.receipt?.rawMaster?.digest ?? ""))
    throw new Error("stage requires exact raw capture digest");
  const receipt = input.capture.receipt;
  const source = input.sourceProvenance;
  if (
    !source ||
    receipt.sourceDigest !== computeSourceCaptureDigest(source) ||
    canonicalJson(receipt.source) !== canonicalJson(source.gate)
  ) {
    throw new Error("stage capture source continuity is invalid");
  }
  if (
    receipt.build?.contract !== "kandev-highlight-build-provenance-v1" ||
    !DIGEST_PATTERN.test(receipt.build?.manifestDigest ?? "") ||
    receipt.build?.sourceSha !== source.sourceSha
  ) {
    throw new Error("stage capture build source continuity is invalid");
  }
  if (input.capture?.receipt?.seed?.seedId !== input.scenario.seed.recipe)
    throw new Error("stage seed identity must match scenario seed recipe");
  if (!DIGEST_PATTERN.test(input.capture?.receipt?.seed?.seedDigest ?? ""))
    throw new Error("stage needs exact seed digest");
  if (!DIGEST_PATTERN.test(input.qa?.reportDigest ?? ""))
    throw new Error("stage needs exact QA report digest");
  validateRuntimeProvenance(input.qa?.runtime, {
    sourceMode: source.captureMode,
    sourceSha: source.sourceSha,
    buildManifestDigest: receipt.build.manifestDigest,
  });
  validateSensitiveScanResult(input.qa?.sensitiveData, {
    expectedCoverage: input.qa.runtime.scanner.coverage,
  });
  if (input.qa.sensitiveData.passed !== true) {
    throw new Error("stage requires a passing sensitive-data scan");
  }
  landingEvidence({
    provenance: { sha: input.landing?.sourceSha },
    contracts: { camera: { version: input.landing?.contractVersion } },
  });
}

export async function writeContentAddressedStage(input = {}) {
  assertStageInput(input);
  const artifactRoot = path.resolve(input.artifactRoot);
  const stageRoot = path.join(artifactRoot, input.scenario.id, "stages");
  await rejectSymlinkComponents(artifactRoot);
  await fs.mkdir(stageRoot, { recursive: true });
  const building = await fs.mkdtemp(path.join(stageRoot, ".building-"));
  try {
    const scenarioRelative = "scenario.json";
    const captureRelative = `raw/${input.scenario.id}.source.mp4`;
    const reportRelative = "qa/report.json";
    await copyRegular(
      input.scenarioPath,
      path.join(building, scenarioRelative),
      "scenario",
    );
    await copyRegular(
      input.capture.receipt.rawMaster.path,
      path.join(building, captureRelative),
      "raw master",
    );
    await copyRegular(
      input.qa.reportPath,
      path.join(building, reportRelative),
      "QA report",
    );
    const stagedScenario = JSON.parse(
      await fs.readFile(path.join(building, scenarioRelative), "utf8"),
    );
    if (
      `sha256:${sha256(canonicalJson(stagedScenario))}` !== input.scenarioDigest
    )
      throw new Error("canonical scenario digest changed before staging");
    if (
      `sha256:${await hashFile(path.join(building, captureRelative))}` !==
      input.capture.receipt.rawMaster.digest
    ) {
      throw new Error("raw capture digest changed before staging");
    }
    if (
      `sha256:${await hashFile(path.join(building, reportRelative))}` !==
      input.qa.reportDigest
    ) {
      throw new Error("QA report digest changed before staging");
    }
    const parsedReport = await readJsonRegular(
      path.join(building, reportRelative),
      "staged QA report",
    );
    if (
      parsedReport.passed !== true ||
      parsedReport.status !== "technical_pass"
    ) {
      throw new Error(
        "staged QA report must say passed=true and status=technical_pass consistently",
      );
    }
    const form =
      input.scenario.profile.kind === "native-mobile" ? "mobile" : "desktop";
    const assets = await copyDeliverySet({
      qa: reportArtifacts(input.qa),
      building,
      form,
    });
    const { manifest, reason } = reviewManifest(input, assets, form);
    const manifestName = "review.json";
    await writeJsonExclusive(path.join(building, manifestName), manifest);
    const stageDir = path.join(
      stageRoot,
      manifest.stageDigest.slice("sha256:".length),
    );
    try {
      await fs.rename(building, stageDir);
    } catch (error) {
      if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
        throw new Error(
          `refusing to overwrite content-addressed stage collision: ${stageDir}`,
        );
      }
      throw error;
    }
    return {
      contract: "kandev-highlight-stage-result-v1",
      promotable: false,
      readyForReview: true,
      reason,
      stageDir,
      manifestPath: path.join(stageDir, manifestName),
      stageDigest: manifest.stageDigest,
      manifest,
      input,
    };
  } catch (error) {
    await fs.rm(building, { recursive: true, force: true });
    throw error;
  }
}
