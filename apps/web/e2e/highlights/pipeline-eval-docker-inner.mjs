import fs from "node:fs/promises";

import {
  INNER_REQUEST_PATH,
  canonicalJson,
  captureDockerRepositoryProof,
  capturePathIdentity,
  digestBytes,
  readJson,
  validateDockerBoundaryAuthorization,
  writeJsonExclusive,
} from "./pipeline-eval-docker-boundary.mjs";
import {
  RUNTIME_NETWORK_GATE,
  validateRuntimeNetworkGateEvidence,
} from "./pipeline-eval-docker-network-gate.mjs";
import { runBoundedSubprocess } from "./pipeline-eval-shared.mjs";

function mountInfoMode(mountInfo, target) {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)[^\\n]*\\s${escaped}\\s+([^\\s]+)`).exec(mountInfo);
  return match?.[1]?.split(",") ?? [];
}

function assertInsideMounts(request, mountInfo) {
  for (const value of request.mounts) {
    const options = mountInfoMode(mountInfo, value.target);
    const expected = value.readOnly ? "ro" : "rw";
    if (!options.includes(expected)) {
      throw new Error(`Docker boundary ${value.target} must be mounted ${expected}`);
    }
  }
}

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
}

function insideEnvironment(inherited = process.env) {
  const allowed = [
    "PATH",
    "LANG",
    "LC_ALL",
    "TZ",
    "HOME",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "COREPACK_HOME",
    "COREPACK_ENABLE_NETWORK",
    "npm_config_store_dir",
    "GOROOT",
    "GOPATH",
    "GOMODCACHE",
    "GOCACHE",
    "GOTOOLCHAIN",
    "CC",
    "LD_LIBRARY_PATH",
    "LIBRARY_PATH",
    "C_INCLUDE_PATH",
    "GCC_EXEC_PREFIX",
    "PLAYWRIGHT_BROWSERS_PATH",
  ];
  const environment = {};
  for (const key of allowed) {
    if (typeof inherited[key] === "string" && inherited[key] !== "") {
      environment[key] = inherited[key];
    }
  }
  environment.KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX = "disabled";
  environment.KANDEV_HIGHLIGHT_DOCKER_BOUNDARY_AUTHORIZATION =
    "/kandev-boundary/authorization.json";
  return environment;
}

function innerDependencies(overrides = {}) {
  return {
    readJson: overrides.readJson ?? readJson,
    readFile: overrides.readFile ?? fs.readFile,
    captureRepositoryProof: overrides.captureRepositoryProof ?? captureDockerRepositoryProof,
    capturePathIdentity: overrides.capturePathIdentity ?? capturePathIdentity,
    writeJson: overrides.writeJson ?? writeJsonExclusive,
    runCommand: overrides.runCommand ?? runBoundedSubprocess,
    runEvaluation: overrides.runEvaluation,
  };
}

function streamEvidence(bytes, filePath) {
  return {
    bytes: bytes.length,
    sha256: digestBytes(bytes),
    path: filePath,
  };
}

async function runRuntimeNetworkGate(context, deps) {
  const result = await deps.runCommand({
    command: RUNTIME_NETWORK_GATE.argv[0],
    args: RUNTIME_NETWORK_GATE.argv.slice(1),
    cwd: context.cloneRoot,
    env: context.environment,
    phase: RUNTIME_NETWORK_GATE.phase,
    logRoot: context.logRoot,
    deadlineMs: 120_000,
  });
  return validateRuntimeNetworkGateEvidence({
    contract: RUNTIME_NETWORK_GATE.contract,
    status: "passed",
    phase: RUNTIME_NETWORK_GATE.phase,
    argv: [...RUNTIME_NETWORK_GATE.argv],
    cwd: context.cloneRoot,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdout: streamEvidence(result.stdoutBytes, result.logPaths?.stdout),
    stderr: streamEvidence(result.stderrBytes, result.logPaths?.stderr),
    recordPath: result.logPaths?.record,
  });
}

async function validateInnerBoundary(requestPath, deps) {
  if (requestPath !== INNER_REQUEST_PATH) {
    throw new Error(`inside Docker boundary request must be ${INNER_REQUEST_PATH}`);
  }
  const request = await deps.readJson(requestPath);
  const authorization = validateDockerBoundaryAuthorization(
    await deps.readJson("/kandev-boundary/authorization.json"),
    request,
  );
  assertInsideMounts(request, await deps.readFile("/proc/self/mountinfo", "utf8"));
  for (const value of request.mounts) {
    const currentIdentity = await deps.capturePathIdentity(value.target);
    if (canonicalJson(currentIdentity) !== canonicalJson(value.identity)) {
      throw new Error(`Docker boundary mount identity changed before evaluation: ${value.target}`);
    }
  }
  const [source, landing] = await Promise.all([
    deps.captureRepositoryProof(request.inner.sourceRoot, { includeOrigin: true }),
    deps.captureRepositoryProof(request.inner.landingRoot),
  ]);
  sameRepositoryProof(source, request.source, "source");
  sameRepositoryProof(landing, request.landing, "landing");
  return { request, authorization };
}

export async function runInsideDockerBoundary({ requestPath, dependencies = {} } = {}) {
  const deps = innerDependencies(dependencies);
  const { request, authorization } = await validateInnerBoundary(requestPath, deps);
  const runEvaluation =
    deps.runEvaluation ??
    (await import("./pipeline-eval-orchestrator.mjs")).runFreshAgentPipelineEvaluation;
  const environment = insideEnvironment(request.environment);
  let networkGate = null;
  let networkGateCalls = 0;
  const result = await runEvaluation({
    sourceRoot: request.inner.sourceRoot,
    landingRoot: request.inner.landingRoot,
    evalParent: request.inner.evalParent,
    captureDeadlineMs: request.inner.captureDeadlineMs,
    inheritedEnv: environment,
    securityEnvironment: environment,
    prNumber: request.inner.prNumber,
    securityBoundary: authorization,
    beforeCapture: async (context) => {
      networkGateCalls += 1;
      if (networkGateCalls !== 1) {
        throw new Error("Docker runtime network gate may run exactly once");
      }
      networkGate = await runRuntimeNetworkGate(context, deps);
      return networkGate;
    },
  });
  if (networkGateCalls !== 1 || !networkGate) {
    throw new Error("Docker evaluation reached completion without its runtime network gate");
  }
  const record = {
    contract: "kandev-highlight-docker-boundary-inner-result-v1",
    status: "passed",
    requestDigest: request.requestDigest,
    containerId: authorization.containerId,
    networkGate,
    result,
  };
  await deps.writeJson("/kandev/eval/boundary-result.json", record);
  return result;
}
