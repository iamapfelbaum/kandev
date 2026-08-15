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
import {
  captureTreeProof,
  finalizePrivateGoModuleCache,
  preparePrivateGoModuleCache,
} from "./pipeline-eval-docker-cache.mjs";
import { CONTAINER_GO_ROOT, compactTreeProof } from "./pipeline-eval-go-provision-contract.mjs";
import {
  captureCommittedScenarioEvaluation,
  validatePipelineEvaluation,
} from "./pipeline-eval-scenario.mjs";
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
    captureScenarioEvaluation:
      overrides.captureScenarioEvaluation ?? captureCommittedScenarioEvaluation,
    capturePathIdentity: overrides.capturePathIdentity ?? capturePathIdentity,
    captureTreeProof: overrides.captureTreeProof ?? captureTreeProof,
    captureFileProof:
      overrides.captureFileProof ??
      (async (filePath) => {
        const bytes = await fs.readFile(filePath);
        return { bytes: bytes.length, digest: digestBytes(bytes) };
      }),
    writeJson: overrides.writeJson ?? writeJsonExclusive,
    runCommand: overrides.runCommand ?? runBoundedSubprocess,
    runEvaluation: overrides.runEvaluation,
    prepareGoModuleCache: overrides.prepareGoModuleCache ?? preparePrivateGoModuleCache,
    finalizeGoModuleCache: overrides.finalizeGoModuleCache ?? finalizePrivateGoModuleCache,
  };
}

export async function validateMountedGoToolchain(request, deps) {
  const acquired = request.goModuleCache?.provision?.toolchain?.acquired;
  if (!acquired) return;
  const [tree, binary] = await Promise.all([
    deps.captureTreeProof(CONTAINER_GO_ROOT).then(compactTreeProof),
    deps.captureFileProof(`${CONTAINER_GO_ROOT}/bin/go`),
  ]);
  if (
    canonicalJson(tree) !== canonicalJson(acquired.tree) ||
    canonicalJson(binary) !== canonicalJson(acquired.binary)
  ) {
    throw new Error(
      "Docker boundary acquired Go toolchain tree or binary changed before evaluation",
    );
  }
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
  await validateMountedGoToolchain(request, deps);
  const [source, landing] = await Promise.all([
    deps.captureRepositoryProof(request.inner.sourceRoot, { includeOrigin: true }),
    deps.captureRepositoryProof(request.inner.landingRoot),
  ]);
  sameRepositoryProof(source, request.source, "source");
  sameRepositoryProof(landing, request.landing, "landing");
  const evaluation = validatePipelineEvaluation(request.evaluation, source);
  if (evaluation.mode === "committed-scenario") {
    const mounted = await deps.captureScenarioEvaluation({
      sourceRoot: request.inner.sourceRoot,
      scenarioPath: evaluation.scenario.path,
    });
    if (canonicalJson(mounted) !== canonicalJson(evaluation)) {
      throw new Error("mounted scenario does not match the request-bound evaluation proof");
    }
  }
  return { request, authorization, evaluation };
}

async function executeBoundaryEvaluation({
  deps,
  request,
  authorization,
  evaluation,
  environment,
  runEvaluation,
}) {
  const gate = { calls: 0, evidence: null };
  let result = null;
  let failure = null;
  try {
    result = await runEvaluation({
      sourceRoot: request.inner.sourceRoot,
      landingRoot: request.inner.landingRoot,
      evalParent: request.inner.evalParent,
      captureDeadlineMs: request.inner.captureDeadlineMs,
      inheritedEnv: environment,
      securityEnvironment: environment,
      prNumber: request.inner.prNumber,
      securityBoundary: authorization,
      evaluation,
      beforeCapture: async (context) => {
        gate.calls += 1;
        if (gate.calls !== 1) {
          throw new Error("Docker runtime network gate may run exactly once");
        }
        gate.evidence = await runRuntimeNetworkGate(context, deps);
        return gate.evidence;
      },
    });
    if (gate.calls !== 1 || !gate.evidence) {
      throw new Error("Docker evaluation reached completion without its runtime network gate");
    }
  } catch (error) {
    failure = error;
  }
  return { result, failure, networkGate: gate.evidence };
}

function failureEvidence(failure) {
  if (!failure) return null;
  return {
    message: failure instanceof Error ? failure.message : String(failure),
    phase: failure?.phase ?? null,
    evalRoot: failure?.evalRoot ?? null,
    failurePath: failure?.failurePath ?? null,
  };
}

export async function runInsideDockerBoundary({ requestPath, dependencies = {} } = {}) {
  const deps = innerDependencies(dependencies);
  const { request, authorization, evaluation } = await validateInnerBoundary(requestPath, deps);
  const runEvaluation =
    deps.runEvaluation ??
    (await import("./pipeline-eval-orchestrator.mjs")).runFreshAgentPipelineEvaluation;
  const environment = insideEnvironment(request.environment);
  let preparedGoModuleCache = null;
  if (request.goModuleCache) {
    preparedGoModuleCache = await deps.prepareGoModuleCache({
      sourceRoot: request.goModuleCache.sourceRoot,
      targetRoot: request.goModuleCache.targetRoot,
      evalRoot: request.inner.evalParent,
      expected: request.goModuleCache.input,
    });
    environment.GOMODCACHE = request.goModuleCache.targetRoot;
  }
  const execution = await executeBoundaryEvaluation({
    deps,
    request,
    authorization,
    evaluation,
    environment,
    runEvaluation,
  });
  let goModuleCache = null;
  if (preparedGoModuleCache) {
    try {
      goModuleCache = {
        ...(await deps.finalizeGoModuleCache(preparedGoModuleCache)),
        provision: structuredClone(request.goModuleCache.provision),
      };
    } catch (error) {
      execution.failure = execution.failure
        ? new AggregateError(
            [execution.failure, error],
            "Docker evaluation and private Go module cache postflight failed",
          )
        : error;
    }
  }
  const { result, failure, networkGate } = execution;
  const record = {
    contract: "kandev-highlight-docker-boundary-inner-result-v1",
    status: failure ? "failed" : "passed",
    requestDigest: request.requestDigest,
    evaluation,
    containerId: authorization.containerId,
    networkGate,
    goModuleCache,
    result,
    failure: failureEvidence(failure),
  };
  await deps.writeJson("/kandev/eval/boundary-result.json", record);
  if (failure) throw failure;
  return result;
}
