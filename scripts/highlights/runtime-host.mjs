import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  preflightCaptureIntegration,
  selectIntegrationPortOffset,
  verifyCaptureBuildProvenance,
  waitForIntegrationPortRelease,
} from "../../apps/web/e2e/highlights/run-capture-integration.mjs";
import { preflightHighlightRuntime } from "./runtime-catalog.mjs";
import { computeScenarioDigest, readScenario } from "./scenario.mjs";
import { isDisplayAvailable } from "./capture-runtime.mjs";
import { verifySourceGate } from "./source-gate.mjs";
import {
  canonicalJson,
  compactRuntimeBuildProof,
  requireAbsolute,
  requireExactKeys,
  validateRuntimeHostRequest,
  validateRuntimeSourceProof,
  validateRuntimeToolPreflight,
  validateRuntimeWorkerRequest,
  validateRuntimeWorkerResult,
} from "./runtime-host-contracts.mjs";
import {
  buildRuntimeFailureEvidence,
  buildRuntimeHostResult,
  cleanupRuntimeHostFixture,
  compactRuntimeSourceProof,
  computeRuntimeSourceCaptureDigest,
  initializeRuntimeHostBundle,
  maybeRuntimeFileIdentity,
  preflightRuntimeHostPaths,
  prepareRuntimeHostBundle,
  readRuntimeJsonRegular,
  reserveRuntimeHostBundle,
  runtimeFileIdentity,
  runtimePathRemoved,
  snapshotRuntimeFile,
  structuredRuntimeFailure,
  verifyRuntimeCaptureArtifacts,
  verifyRuntimeCaptureTeardown,
  writeRuntimeApplicationReceipt,
  writeRuntimeHostOutcome,
  writeRuntimeJsonAtomicExclusive,
  writeRuntimeWorkerResult,
} from "./runtime-host-bundle.mjs";
import {
  isRuntimeProcessGone,
  normalizeRuntimeProcessResult,
  runOwnedRuntimeProcess,
} from "./runtime-owned-process.mjs";

export {
  runOwnedRuntimeProcess,
  validateRuntimeHostRequest,
  validateRuntimeWorkerRequest,
  validateRuntimeWorkerResult,
  writeRuntimeWorkerResult,
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = path.resolve(MODULE_DIR, "../..");
const DEFAULT_WEB_ROOT = path.join(DEFAULT_REPOSITORY_ROOT, "apps", "web");
const DEFAULT_PROCESS_DEADLINE_MS = 240_000;

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
    processRunner: runOwnedRuntimeProcess,
    waitForPortRelease: waitForIntegrationPortRelease,
    isDisplayReleased: isDisplayAvailable,
    isProcessGone: isRuntimeProcessGone,
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

export async function runHighlightRuntimeHost({
  request: input,
  inheritedEnv = process.env,
  dependencies = {},
} = {}) {
  const request = validateRuntimeHostRequest(input);
  const deps = dependenciesWithDefaults(dependencies);
  const expectedRepositoryRoot =
    dependencies.expectedRepositoryRoot ?? DEFAULT_REPOSITORY_ROOT;
  await preflightRuntimeHostPaths(request, expectedRepositoryRoot);
  const scenarioFileBefore = await snapshotRuntimeFile(
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
  const sourceProofBefore = validateRuntimeSourceProof(
    await deps.verifySourceGate({
      repoRoot: request.repositoryRoot,
      source: request.source,
    }),
    request,
  );
  const build = compactRuntimeBuildProof(
    await deps.verifyBuildProvenance(request.buildManifestPath, {
      expectedSourceSha: sourceProofBefore.selectedSha,
      expectedRepositoryRoot: request.repositoryRoot,
    }),
    sourceProofBefore,
  );
  const tools = validateRuntimeToolPreflight(
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

  const paths = await reserveRuntimeHostBundle(request);
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
    pre: compactRuntimeSourceProof(sourceProofBefore),
    post: null,
    unchanged: false,
  };
  try {
    await prepareRuntimeHostBundle(paths);
    const workerRequest = buildWorkerRequest({
      request,
      sourceProof: sourceProofBefore,
      build,
      tools,
      port,
      bundleRoot: paths.bundleRoot,
    });
    phase = "request";
    requestIdentity = await initializeRuntimeHostBundle(paths, workerRequest);
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
      execution = normalizeRuntimeProcessResult(
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
      execution = normalizeRuntimeProcessResult(
        { exitCode: null, signal: null },
        dependencies.processDeadlineMs ?? DEFAULT_PROCESS_DEADLINE_MS,
      );
      processFailure = structuredRuntimeFailure(
        "playwright-launch-failed",
        "playwright",
      );
    }
    if (!processFailure && execution.exitCode !== 0) {
      processFailure = structuredRuntimeFailure(
        execution.timedOut
          ? "playwright-deadline-exceeded"
          : "playwright-exit-failed",
        "playwright",
      );
    }

    phase = "postflight";
    let postflightFailure = null;
    try {
      sourceAfter = validateRuntimeSourceProof(
        await deps.verifySourceGate({
          repoRoot: request.repositoryRoot,
          source: request.source,
        }),
        request,
      );
      if (canonicalJson(sourceAfter) !== canonicalJson(sourceProofBefore)) {
        throw new Error("source proof changed during runtime capture");
      }
      sourceEvidence.post = compactRuntimeSourceProof(sourceAfter);
    } catch {
      postflightFailure = structuredRuntimeFailure(
        "source-postflight-failed",
        "postflight",
      );
    }
    try {
      const [scenarioFileAfter, scenarioAfter] = await Promise.all([
        snapshotRuntimeFile(request.scenarioPath, "post-run runtime scenario"),
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
      postflightFailure ??= structuredRuntimeFailure(
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
    logIdentity = await runtimeFileIdentity(paths.logPath, "runtime host log");
    execution.log.capturedBytes = logIdentity.bytes;

    phase = "worker-result";
    let workerFailure = null;
    let captureTeardown = null;
    try {
      workerIdentity = await runtimeFileIdentity(
        paths.workerResultPath,
        "runtime worker result",
      );
      workerResult = validateRuntimeWorkerResult(
        await readRuntimeJsonRegular(
          paths.workerResultPath,
          "runtime worker result",
        ),
        workerRequest,
      );
      capture = await verifyRuntimeCaptureArtifacts(
        workerResult,
        workerRequest,
        {
          scenarioId: scenario.id,
          scenarioDigest,
          sourceDigest: computeRuntimeSourceCaptureDigest(
            request,
            sourceProofBefore,
          ),
        },
      );
      captureTeardown = await verifyRuntimeCaptureTeardown(
        capture,
        workerRequest,
        scenario.id,
        deps,
      );
      const { receipt: _verifiedCaptureReceipt, ...compactCapture } = capture;
      capture = compactCapture;
    } catch {
      workerFailure = structuredRuntimeFailure(
        "worker-result-invalid",
        "worker-result",
      );
    }
    const fixtureTempRootRemoved = await runtimePathRemoved(paths.fixtureRoot);
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
      failure = structuredRuntimeFailure(
        "runtime-teardown-incomplete",
        "teardown",
      );
    }
    phase = "finalize";
    const completedAt = deps.clock().toISOString();
    if (!Number.isFinite(Date.parse(completedAt))) {
      throw new Error("runtime host clock returned invalid time");
    }

    if (workerResult && capture && workerIdentity) {
      applicationRuntime = await writeRuntimeApplicationReceipt({
        workerRequest,
        scenarioId: scenario.id,
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
    }
    if (failure) {
      const evidence = buildRuntimeFailureEvidence({
        request,
        phase: failure.phase,
        code: failure.code,
        completedAt,
      });
      await writeRuntimeJsonAtomicExclusive(
        paths.failurePath,
        evidence,
        "runtime host failure evidence",
      );
    }
    const result = await writeRuntimeHostOutcome({
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
    await cleanupRuntimeHostFixture(paths);
    logIdentity ??= await maybeRuntimeFileIdentity(
      paths.logPath,
      "runtime host log",
    );
    const completedAt = safeCompletedAt(deps.clock);
    const failure = structuredRuntimeFailure("runtime-host-internal", phase);
    const evidence = buildRuntimeFailureEvidence({
      request,
      phase,
      code: failure.code,
      completedAt,
    });
    let evidenceWriteError = null;
    try {
      await writeRuntimeJsonAtomicExclusive(
        paths.failurePath,
        evidence,
        "runtime host failure evidence",
      );
    } catch (writeError) {
      evidenceWriteError = writeError;
    }
    const result = buildRuntimeHostResult({
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
      await writeRuntimeJsonAtomicExclusive(
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
