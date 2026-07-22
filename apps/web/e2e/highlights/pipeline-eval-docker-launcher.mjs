import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CONTAINER_ID_PATTERN,
  PLAYWRIGHT_IMAGE_REFERENCE,
  buildDockerCreatePlan,
  canonicalJson,
  captureDockerRepositoryProof,
  capturePathIdentity,
  digestBytes,
  digestValue,
  readJson,
  validateDockerBoundaryAuthorization,
  validateDockerContainerInspection,
  validateDockerDaemonSecurity,
  validateDockerImageInspection,
  writeJsonExclusive,
  writeTextExclusive,
} from "./pipeline-eval-docker-boundary.mjs";
import { prepareDockerInputRepositories } from "./pipeline-eval-docker-input.mjs";
import { discoverDockerToolchain } from "./pipeline-eval-docker-toolchain.mjs";
import {
  canonicalDirectory,
  DEFAULT_CAPTURE_DEADLINE_MS,
  isInside,
  runBoundedSubprocess,
} from "./pipeline-eval-shared.mjs";

export { prepareDockerInputRepositories } from "./pipeline-eval-docker-input.mjs";
export { discoverDockerToolchain } from "./pipeline-eval-docker-toolchain.mjs";
export { runInsideDockerBoundary } from "./pipeline-eval-docker-inner.mjs";

const DEFAULT_SOURCE_ROOT = path.resolve(import.meta.dirname, "../../../..");
const DEFAULT_LANDING_ROOT = path.resolve(DEFAULT_SOURCE_ROOT, "..", "landing");

function sameRepositoryProof(actual, expected, label) {
  const fields = [
    "headSha",
    "tree",
    "status",
    ...(expected.originMainSha ? ["originMainSha"] : []),
  ];
  for (const key of fields) {
    if (actual?.[key] !== expected[key]) {
      throw new Error(`Docker boundary ${label} ${key} changed before evaluation`);
    }
  }
  return true;
}

function parseJsonArray(result, label) {
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`${label} must return exactly one record`);
  }
  return value[0];
}

function authorizationFor(request, inspection) {
  return {
    contract: "kandev-highlight-docker-boundary-authorization-v1",
    requestDigest: request.requestDigest,
    containerId: inspection.containerId,
    imageId: inspection.imageId,
    sourceSha: request.source.headSha,
    sourceOriginMainSha: request.source.originMainSha,
    inspection,
  };
}

async function defaultRunCommand(specification) {
  return runBoundedSubprocess(specification);
}

function dockerCommand(args, phase, deadlineMs) {
  return {
    command: "docker",
    args,
    phase,
    deadlineMs,
    maxOutputBytes: 8 * 1024 * 1024,
  };
}

function createExecutionState(input, deps) {
  if (!path.isAbsolute(input.evidenceRoot ?? "")) {
    throw new Error("Docker host evidence root must be absolute and outside worker mounts");
  }
  if (input.plan.mounts.some((value) => isInside(value.source, input.evidenceRoot))) {
    throw new Error("Docker host evidence root cannot be inside a worker-visible mount");
  }
  return {
    ...input,
    deps,
    requestPath: path.join(input.proofRoot, "request.json"),
    authorizationPath: path.join(input.proofRoot, "authorization.json"),
    receiptPath: path.join(input.evidenceRoot, "outer-boundary.receipt.json"),
    containerId: null,
    authorization: null,
    inner: null,
    exit: null,
    failure: null,
    removed: false,
    logs: { stdout: "", stderr: "" },
    logEvidence: null,
    sourceAfter: null,
    landingAfter: null,
    sourceUnchanged: true,
    landingUnchanged: true,
    upstreamSourceAfter: null,
    upstreamLandingAfter: null,
    upstreamSourceUnchanged: true,
    upstreamLandingUnchanged: true,
  };
}

function retainFailure(state, error) {
  if (!state.failure) state.failure = error;
}

async function createAndAuthorizeContainer(state) {
  const created = await state.deps.runCommand({
    command: state.plan.command,
    args: state.plan.args,
    phase: "docker-create",
    deadlineMs: 30_000,
  });
  state.containerId = created.stdout.trim();
  if (!CONTAINER_ID_PATTERN.test(state.containerId)) {
    throw new Error("Docker create did not return exact container ID");
  }
  await state.deps.runCommand(dockerCommand(["start", state.containerId], "docker-start", 30_000));
  const running = await state.deps.runCommand(
    dockerCommand(["inspect", state.containerId], "docker-inspect-running", 30_000),
  );
  const inspection = validateDockerContainerInspection(
    parseJsonArray(running, "running Docker inspect"),
    state.plan.request,
  );
  if (inspection.containerId !== state.containerId) {
    throw new Error("Docker running inspection did not bind the created container identity");
  }
  state.authorization = authorizationFor(state.plan.request, inspection);
  validateDockerBoundaryAuthorization(state.authorization, state.plan.request);
  await state.deps.writeJson(state.authorizationPath, state.authorization);
}

function validateContainerExit(exited, exitCode, request) {
  validateDockerContainerInspection(
    { ...exited, State: { ...exited.State, Running: true, Pid: exited.State?.Pid || 1 } },
    request,
  );
  const invalid = [
    exited.State?.Running !== false,
    exited.State?.ExitCode !== exitCode,
    exited.State?.OOMKilled !== false,
  ];
  if (invalid.some(Boolean)) {
    throw new Error("Docker exit inspection does not match clean bounded worker exit");
  }
}

async function waitForContainerResult(state) {
  const waited = await state.deps.runCommand(
    dockerCommand(
      ["wait", state.containerId],
      "docker-wait",
      state.plan.request.inner.captureDeadlineMs * 2 + 10 * 60_000,
    ),
  );
  const exitCode = Number(waited.stdout.trim());
  if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
    throw new Error("Docker wait did not return valid container exit code");
  }
  state.logs = await state.deps.runCommand(
    dockerCommand(["logs", state.containerId], "docker-logs", 30_000),
  );
  const exitedResult = await state.deps.runCommand(
    dockerCommand(["inspect", state.containerId], "docker-inspect-exit", 30_000),
  );
  validateContainerExit(
    parseJsonArray(exitedResult, "exited Docker inspect"),
    exitCode,
    state.plan.request,
  );
  state.exit = { code: exitCode, oomKilled: false };
  if (exitCode !== 0) throw new Error(`Docker eval worker exited ${exitCode}`);
  state.inner = await state.deps.readJson(path.join(state.evalRoot, "boundary-result.json"));
  if (
    state.inner?.status !== "passed" ||
    state.inner.requestDigest !== state.plan.request.requestDigest
  ) {
    throw new Error("Docker eval worker did not produce request-bound passing result");
  }
}

async function removeContainer(state) {
  if (!state.containerId) return;
  await state.deps.runCommand(
    dockerCommand(["rm", "--force", state.containerId], "docker-remove", 30_000),
  );
  const remaining = await state.deps.runCommand(
    dockerCommand(
      ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `id=${state.containerId}`],
      "docker-removal-check",
      30_000,
    ),
  );
  state.removed = remaining.stdout.trim() === "";
  if (!state.removed) throw new Error("Docker eval container survived removal");
}

async function captureBoundaryPostflight(state) {
  [state.sourceAfter, state.landingAfter] = await Promise.all([
    state.deps.captureRepositoryProof(state.plan.mounts[0].source, { includeOrigin: true }),
    state.deps.captureRepositoryProof(state.plan.mounts[1].source),
  ]);
  sameRepositoryProof(state.sourceAfter, state.sourceBefore, "source postflight");
  sameRepositoryProof(state.landingAfter, state.landingBefore, "landing postflight");
  for (const value of state.plan.mounts) {
    const current = await state.deps.capturePathIdentity(value.source);
    if (canonicalJson(current) !== canonicalJson(value.identity)) {
      throw new Error(`Docker boundary host mount identity changed: ${value.source}`);
    }
  }
  if (state.upstreamSourceRoot && state.upstreamLandingRoot) {
    [state.upstreamSourceAfter, state.upstreamLandingAfter] = await Promise.all([
      state.deps.captureRepositoryProof(state.upstreamSourceRoot, { includeOrigin: true }),
      state.deps.captureRepositoryProof(state.upstreamLandingRoot),
    ]);
    sameRepositoryProof(
      state.upstreamSourceAfter,
      state.upstreamSourceBefore,
      "upstream source postflight",
    );
    sameRepositoryProof(
      state.upstreamLandingAfter,
      state.upstreamLandingBefore,
      "upstream landing postflight",
    );
  }
}

function boundaryReceipt(state) {
  const receiptBody = {
    contract: "kandev-highlight-docker-boundary-receipt-v1",
    status: state.failure ? "failed" : "passed",
    requestDigest: state.plan.request.requestDigest,
    image: state.plan.request.image,
    container: { id: state.containerId, removed: state.removed },
    argv: state.plan.args,
    security: state.plan.request.security,
    network: state.plan.request.network,
    mounts: state.plan.request.mounts,
    source: {
      before: state.sourceBefore,
      after: state.sourceAfter,
      unchanged: state.sourceUnchanged,
    },
    landing: {
      before: state.landingBefore,
      after: state.landingAfter,
      unchanged: state.landingUnchanged,
    },
    upstream: state.upstreamSourceRoot
      ? {
          source: {
            root: state.upstreamSourceRoot,
            before: state.upstreamSourceBefore,
            after: state.upstreamSourceAfter,
            unchanged: state.upstreamSourceUnchanged,
          },
          landing: {
            root: state.upstreamLandingRoot,
            before: state.upstreamLandingBefore,
            after: state.upstreamLandingAfter,
            unchanged: state.upstreamLandingUnchanged,
          },
        }
      : null,
    authorization: state.authorization,
    exit: state.exit,
    logs: state.logEvidence,
    innerResultDigest: state.inner ? digestValue(state.inner) : null,
    error: state.failure?.message ?? null,
  };
  return {
    ...receiptBody,
    receiptDigest: digestValue(receiptBody),
    receiptPath: state.receiptPath,
  };
}

function resolveExecutionDependencies(overrides = {}) {
  return {
    runCommand: overrides.runCommand ?? defaultRunCommand,
    captureRepositoryProof: overrides.captureRepositoryProof ?? captureDockerRepositoryProof,
    capturePathIdentity: overrides.capturePathIdentity ?? capturePathIdentity,
    readJson: overrides.readJson ?? readJson,
    writeJson: overrides.writeJson ?? writeJsonExclusive,
    writeText: overrides.writeText ?? writeTextExclusive,
  };
}

async function persistContainerLogs(state) {
  const stdout = state.logs.stdout ?? "";
  const stderr = state.logs.stderr ?? "";
  const stdoutPath = path.join(state.evidenceRoot, "outer-container.stdout.log");
  const stderrPath = path.join(state.evidenceRoot, "outer-container.stderr.log");
  await Promise.all([
    state.deps.writeText(stdoutPath, stdout),
    state.deps.writeText(stderrPath, stderr),
  ]);
  state.logEvidence = {
    stdout: {
      path: stdoutPath,
      bytes: Buffer.byteLength(stdout),
      sha256: digestBytes(stdout),
      truncated: state.logs.stdoutTruncated === true,
    },
    stderr: {
      path: stderrPath,
      bytes: Buffer.byteLength(stderr),
      sha256: digestBytes(stderr),
      truncated: state.logs.stderrTruncated === true,
    },
  };
}

export async function executeDockerBoundaryPlan(input = {}) {
  const deps = resolveExecutionDependencies(input.dependencies);
  const state = createExecutionState(input, deps);
  await deps.writeJson(state.requestPath, state.plan.request);
  try {
    await createAndAuthorizeContainer(state);
    await waitForContainerResult(state);
  } catch (error) {
    retainFailure(state, error);
  }
  try {
    await removeContainer(state);
  } catch (error) {
    retainFailure(state, error);
  }
  try {
    await captureBoundaryPostflight(state);
  } catch (error) {
    state.sourceUnchanged = canonicalJson(state.sourceAfter) === canonicalJson(state.sourceBefore);
    state.landingUnchanged =
      canonicalJson(state.landingAfter) === canonicalJson(state.landingBefore);
    state.upstreamSourceUnchanged =
      canonicalJson(state.upstreamSourceAfter) === canonicalJson(state.upstreamSourceBefore);
    state.upstreamLandingUnchanged =
      canonicalJson(state.upstreamLandingAfter) === canonicalJson(state.upstreamLandingBefore);
    retainFailure(state, error);
  }
  try {
    await persistContainerLogs(state);
  } catch (error) {
    retainFailure(state, error);
  }
  const receipt = boundaryReceipt(state);
  await deps.writeJson(state.receiptPath, receipt);
  if (state.failure) {
    state.failure.receiptPath = state.receiptPath;
    state.failure.evalRoot = state.evalRoot;
    throw state.failure;
  }
  return receipt;
}
async function inspectDockerImage(runCommand) {
  const result = await runCommand({
    command: "docker",
    args: ["image", "inspect", PLAYWRIGHT_IMAGE_REFERENCE],
    phase: "docker-image-inspect",
    deadlineMs: 30_000,
  });
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Docker image inspection returned invalid JSON: ${error.message}`);
  }
  return validateDockerImageInspection(value);
}

async function inspectDockerDaemon(runCommand) {
  const result = await runCommand({
    command: "docker",
    args: ["info", "--format", "{{json .SecurityOptions}}"],
    phase: "docker-daemon-security",
    deadlineMs: 30_000,
  });
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Docker daemon security inspection returned invalid JSON: ${error.message}`);
  }
  return validateDockerDaemonSecurity(value);
}

export async function runFreshAgentPipelineEvaluationInDocker({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  landingRoot = DEFAULT_LANDING_ROOT,
  evalParent = os.tmpdir(),
  captureDeadlineMs = DEFAULT_CAPTURE_DEADLINE_MS,
  inheritedEnv = process.env,
  dependencies = {},
} = {}) {
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const source = await canonicalDirectory(path.resolve(sourceRoot), "Docker eval source");
  const landing = await canonicalDirectory(path.resolve(landingRoot), "Docker eval landing");
  const parent = path.resolve(evalParent);
  if (isInside(source, parent) || isInside(landing, parent)) {
    throw new Error("Docker eval parent must stay outside source and landing repositories");
  }
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = await canonicalDirectory(parent, "Docker eval parent");
  const evalRoot = await fs.mkdtemp(path.join(canonicalParent, "kandev-highlight-docker-eval-"));
  const proofRoot = await fs.mkdtemp(path.join(canonicalParent, "kandev-highlight-docker-proof-"));
  const inputContainerRoot = await fs.mkdtemp(
    path.join(canonicalParent, "kandev-highlight-docker-input-"),
  );
  const evidenceRoot = await fs.mkdtemp(
    path.join(canonicalParent, "kandev-highlight-docker-evidence-"),
  );
  await Promise.all([
    fs.chmod(evalRoot, 0o700),
    fs.chmod(proofRoot, 0o700),
    fs.chmod(inputContainerRoot, 0o700),
    fs.chmod(evidenceRoot, 0o700),
  ]);
  try {
    const [prepared, image, daemonSecurity, toolchain] = await Promise.all([
      prepareDockerInputRepositories({
        sourceRoot: source,
        landingRoot: landing,
        inputRoot: path.join(inputContainerRoot, "repositories"),
      }),
      inspectDockerImage(runCommand),
      inspectDockerDaemon(runCommand),
      discoverDockerToolchain({ sourceRoot: source, inheritedEnv, runCommand }),
    ]);
    const plan = buildDockerCreatePlan({
      sourceRoot: prepared.sourceRoot,
      landingRoot: prepared.landingRoot,
      evalRoot,
      proofRoot,
      sourceProof: prepared.sourceProof,
      landingProof: prepared.landingProof,
      writableProofs: {
        eval: await capturePathIdentity(evalRoot),
        proof: await capturePathIdentity(proofRoot),
      },
      image,
      uid: typeof process.getuid === "function" ? process.getuid() : null,
      gid: typeof process.getgid === "function" ? process.getgid() : null,
      captureDeadlineMs,
      toolchainMounts: toolchain.mounts,
      environment: toolchain.environment,
      daemonSecurity,
    });
    const receipt = await executeDockerBoundaryPlan({
      plan,
      proofRoot,
      evalRoot,
      evidenceRoot,
      sourceBefore: prepared.sourceProof,
      landingBefore: prepared.landingProof,
      upstreamSourceRoot: prepared.upstreamSourceRoot,
      upstreamLandingRoot: prepared.upstreamLandingRoot,
      upstreamSourceBefore: prepared.upstreamSourceProof,
      upstreamLandingBefore: prepared.upstreamLandingProof,
      dependencies: { runCommand },
    });
    return {
      contract: "kandev-highlight-docker-boundary-launcher-result-v1",
      status: "passed",
      evalRoot,
      evidenceRoot,
      receiptPath: receipt.receiptPath,
      receiptDigest: receipt.receiptDigest,
      upstream: receipt.upstream,
      result: (await readJson(path.join(evalRoot, "boundary-result.json"))).result,
    };
  } finally {
    await Promise.all([
      fs.rm(proofRoot, { recursive: true, force: true }),
      fs.rm(inputContainerRoot, { recursive: true, force: true }),
    ]);
  }
}
