import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { buildCaptureCheckout } from "../../apps/web/e2e/highlights/run-capture-integration.mjs";
import {
  buildRuntimeHostCommand,
  runHighlightRuntimeHost,
  validateRuntimeHostRequest,
} from "./runtime-host.mjs";
import {
  BUILTIN_HIGHLIGHT_RUNTIME_ID,
  preflightHighlightRuntime,
  resolveHighlightRuntime,
} from "./runtime-catalog.mjs";
import {
  compileTimeline,
  computeScenarioDigest,
  readScenario,
  requireDeliveryMetadata,
} from "./scenario.mjs";
import {
  assertExternalArtifactRoot,
  verifySourceGate,
} from "./source-gate.mjs";
import { runDeclarativeHighlightCommand } from "./pipeline.mjs";

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_RUNTIME_HOST_LOG_BYTES = 8 * 1024 * 1024;

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

function digestValue(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function requireExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} requires ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) {
      throw new Error(`${label} contains unknown property ${key}`);
    }
  }
}

async function commandRunner(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return { ...result, exitCode: 0 };
}

function dependenciesWithDefaults(dependencies) {
  return {
    readScenario,
    compileTimeline,
    computeScenarioDigest,
    requireDeliveryMetadata,
    resolveRuntime: resolveHighlightRuntime,
    preflightRuntime: preflightHighlightRuntime,
    verifySourceGate,
    resolvePrMetadata,
    buildCaptureCheckout,
    runRuntimeHost: runHighlightRuntimeHost,
    pipelineRunner: runDeclarativeHighlightCommand,
    buildRuntimeHostCommand,
    commandRunner,
    clock: () => new Date(),
    runIdNonce: () => randomBytes(4).toString("hex"),
    ...dependencies,
  };
}

function requireSafeRunId(value) {
  if (!SAFE_RUN_ID.test(value ?? "") || value === "." || value === "..") {
    throw new Error("runtime runId must be a safe identifier");
  }
  return value;
}

function allocateRunId({ requested, scenarioDigest, now, nonce }) {
  if (requested !== undefined) return requireSafeRunId(requested);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("runtime clock must return a valid Date");
  }
  if (!/^[a-z0-9]{8,20}$/.test(nonce ?? "")) {
    throw new Error(
      "runtime run ID uniqueness token must be 8-20 lowercase letters or digits",
    );
  }
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  return requireSafeRunId(
    `run-${scenarioDigest.slice("sha256:".length, "sha256:".length + 12)}-${timestamp}-${nonce}`,
  );
}

async function rejectExistingSymlinks(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(
        `runtime artifact path cannot contain symlinks: ${current}`,
      );
    }
  }
  const stat = await fs.lstat(absolute).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat && !stat.isDirectory()) {
    throw new Error(`runtime artifact root must be a directory: ${absolute}`);
  }
}

function validateSourceProof(proof, { source, repoRoot }) {
  if (
    proof?.contract !== "kandev-highlight-source-v1" ||
    proof.source !== source ||
    proof.clean !== true ||
    proof.status !== "" ||
    !SHA_PATTERN.test(proof.selectedSha ?? "") ||
    typeof proof.repoRoot !== "string" ||
    path.resolve(proof.repoRoot) !== repoRoot
  ) {
    throw new Error(
      "trusted runtime source gate must return an exact clean source proof",
    );
  }
  return proof;
}

function validateBaseRefName(value) {
  const forbidden = /[\x00-\x20\x7f~^:?*[\]\\]/;
  const segments = typeof value === "string" ? value.split("/") : [];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 244 ||
    value === "@" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    forbidden.test(value) ||
    segments.some(
      (segment) =>
        !segment || segment.startsWith(".") || segment.endsWith(".lock"),
    )
  ) {
    throw new Error(
      "automatic PR metadata returned an unsafe base branch name",
    );
  }
  return value;
}

async function resolvePrMetadata({
  repoRoot,
  sourceSha,
  prNumber,
  prBaseSha,
  env,
  runner,
}) {
  const number = Number(prNumber ?? env.KANDEV_HIGHLIGHT_PR_NUMBER);
  const baseSha = prBaseSha ?? env.KANDEV_HIGHLIGHT_PR_BASE_SHA;
  if (
    Number.isInteger(number) &&
    number > 0 &&
    SHA_PATTERN.test(baseSha ?? "")
  ) {
    return { prNumber: number, prBaseSha: baseSha, prHeadSha: sourceSha };
  }
  let result;
  try {
    result = await runner(
      "gh",
      ["pr", "view", "--json", "number,baseRefName,headRefOid"],
      {
        cwd: repoRoot,
      },
    );
  } catch (error) {
    throw new Error(
      `pr_head runtime request needs --pr-number and --pr-base-sha; automatic 'gh pr view' lookup failed: ${error.message}`,
      { cause: error },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`cannot parse automatic PR metadata: ${error.message}`);
  }
  if (
    !Number.isInteger(parsed.number) ||
    parsed.number <= 0 ||
    parsed.headRefOid !== sourceSha
  ) {
    throw new Error(
      "automatic PR metadata does not match the selected source SHA",
    );
  }
  const baseRefName = validateBaseRefName(parsed.baseRefName);
  let baseResult;
  try {
    baseResult = await runner("git", ["rev-parse", `origin/${baseRefName}`], {
      cwd: repoRoot,
    });
  } catch (error) {
    throw new Error(
      `cannot resolve automatic PR base branch origin/${baseRefName}: ${error.message}`,
      { cause: error },
    );
  }
  const resolvedBaseSha = baseResult.stdout?.trim();
  if (!SHA_PATTERN.test(resolvedBaseSha ?? "")) {
    throw new Error("automatic PR base branch did not resolve to an exact SHA");
  }
  return {
    prNumber: parsed.number,
    prBaseSha: resolvedBaseSha,
    prHeadSha: parsed.headRefOid,
  };
}

function validateResolvedPr(value, sourceSha) {
  if (
    !Number.isInteger(value?.prNumber) ||
    value.prNumber <= 0 ||
    !SHA_PATTERN.test(value?.prBaseSha ?? "") ||
    value.prHeadSha !== sourceSha
  ) {
    throw new Error(
      "pr_head runtime metadata must bind PR number, base SHA, and selected head SHA",
    );
  }
  return { number: value.prNumber, baseSha: value.prBaseSha };
}

function validateBuild(build, sourceProof, expectedRoot) {
  if (
    typeof build?.manifestPath !== "string" ||
    !path.isAbsolute(build.manifestPath) ||
    build.manifest?.contract !== "kandev-highlight-build-provenance-v1" ||
    !DIGEST_PATTERN.test(build.manifest?.manifestDigest ?? "") ||
    build.manifest?.source?.selectedSha !== sourceProof.selectedSha
  ) {
    throw new Error(
      "runtime build proof does not bind the selected source SHA",
    );
  }
  const relative = path.relative(
    expectedRoot,
    path.resolve(build.manifestPath),
  );
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      "runtime build manifest must stay inside its reserved build root",
    );
  }
  return build;
}

function validateHostLogIdentity(identity, execution, expectedPath) {
  requireExactKeys(
    identity,
    ["path", "bytes", "digest"],
    "runtime host log identity",
  );
  const truthfulTruncation =
    execution.truncated === execution.discardedBytes > 0 &&
    (!execution.truncated || execution.capturedBytes === execution.limitBytes);
  if (
    identity.path !== expectedPath ||
    !Number.isSafeInteger(identity.bytes) ||
    identity.bytes < 0 ||
    !DIGEST_PATTERN.test(identity.digest ?? "") ||
    !Number.isSafeInteger(execution.limitBytes) ||
    execution.limitBytes <= 0 ||
    execution.limitBytes > MAX_RUNTIME_HOST_LOG_BYTES ||
    !Number.isSafeInteger(execution.capturedBytes) ||
    execution.capturedBytes < 0 ||
    execution.capturedBytes > execution.limitBytes ||
    execution.capturedBytes !== identity.bytes ||
    !Number.isSafeInteger(execution.discardedBytes) ||
    execution.discardedBytes < 0 ||
    typeof execution.truncated !== "boolean" ||
    !truthfulTruncation
  ) {
    throw new Error(
      "runtime host log identity or bounded truncation counters are invalid",
    );
  }
}

function validateHostResult(
  result,
  request,
  scenario,
  scenarioDigest,
  sourceProof,
) {
  const keys = [
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
  ];
  requireExactKeys(result, keys, "runtime host result");
  const body = structuredClone(result);
  delete body.resultDigest;
  const hostRoot = path.join(
    request.artifactRoot,
    "runtime-host",
    request.runId,
  );
  const attemptRoot = path.join(
    request.artifactRoot,
    scenario.id,
    "runs",
    request.runId,
  );
  requireExactKeys(
    result.bundle,
    [
      "path",
      "requestPath",
      "workerResultPath",
      "logPath",
      "failurePath",
      "resultPath",
    ],
    "runtime host bundle",
  );
  requireExactKeys(
    result.scenario,
    ["id", "path", "bytes", "digest"],
    "runtime host scenario",
  );
  requireExactKeys(
    result.source,
    ["pre", "post", "unchanged"],
    "runtime host source",
  );
  for (const [label, proof] of [
    ["pre", result.source.pre],
    ["post", result.source.post],
  ]) {
    requireExactKeys(
      proof,
      ["contract", "mode", "selectedSha", "headSha", "currentMainSha"],
      `runtime host ${label} source`,
    );
  }
  requireExactKeys(
    result.applicationRuntime,
    ["receiptPath", "digest"],
    "runtime receipt link",
  );
  requireExactKeys(
    result.execution,
    ["exitCode", "signal", "timedOut", "deadlineMs", "processGroup", "log"],
    "runtime host execution",
  );
  requireExactKeys(
    result.execution.processGroup,
    ["pid", "termSent", "killSent", "exited", "gone"],
    "runtime host process group",
  );
  requireExactKeys(
    result.execution.log,
    ["limitBytes", "capturedBytes", "discardedBytes", "truncated"],
    "runtime host execution log",
  );
  requireExactKeys(
    result.teardown,
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
    result.teardown.capture,
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
  const expectedBundle = {
    path: hostRoot,
    requestPath: path.join(hostRoot, "request.json"),
    workerResultPath: path.join(hostRoot, "worker-result.json"),
    logPath: path.join(hostRoot, "playwright.log"),
    failurePath: path.join(hostRoot, "failure.json"),
    resultPath: path.join(hostRoot, "result.json"),
  };
  validateHostLogIdentity(
    result.log,
    result.execution.log,
    expectedBundle.logPath,
  );
  if (
    result.contract !== "kandev-highlight-runtime-host-result-v1" ||
    result.version !== 1 ||
    result.status !== "succeeded" ||
    result.runtimeId !== request.runtimeId ||
    result.runId !== request.runId ||
    result.resultDigest !== digestValue(canonicalJson(body)) ||
    !DIGEST_PATTERN.test(result.applicationRuntime?.digest ?? "") ||
    !result.capture ||
    result.scenario.id !== scenario.id ||
    result.scenario.path !== request.scenarioPath ||
    result.scenario.digest !== scenarioDigest ||
    result.source.unchanged !== true ||
    canonicalJson(result.source.pre) !== canonicalJson(result.source.post) ||
    result.source.pre?.mode !== request.source ||
    result.source.pre?.contract !== sourceProof.contract ||
    result.source.pre?.selectedSha !== sourceProof.selectedSha ||
    canonicalJson(result.bundle) !== canonicalJson(expectedBundle) ||
    result.applicationRuntime.receiptPath !==
      path.join(attemptRoot, "evidence", "application-runtime.json") ||
    result.capture.attemptRoot !== attemptRoot ||
    result.capture.scenarioDigest !== scenarioDigest ||
    result.capture.phaseManifestPath !==
      path.join(attemptRoot, "evidence", "capture.json") ||
    result.capture.captureManifestPath !==
      path.join(attemptRoot, "capture", "evidence", "capture.json") ||
    result.capture.rawMasterPath !==
      path.join(attemptRoot, "capture", "raw", `${scenario.id}.source.mp4`) ||
    Object.entries(result.teardown).some(
      ([key, value]) => key !== "capture" && value !== true,
    ) ||
    !result.teardown.capture ||
    Object.values(result.teardown.capture).some((value) => value !== true) ||
    result.execution?.exitCode !== 0 ||
    result.execution?.signal !== null ||
    result.execution?.timedOut !== false ||
    result.execution?.processGroup?.exited !== true ||
    result.execution?.processGroup?.gone !== true ||
    result.failure !== null
  ) {
    throw new Error(
      "trusted runtime host did not return a complete successful capture receipt",
    );
  }
  return result;
}

function compactHostLink(result) {
  return {
    contract: result.contract,
    resultPath: result.bundle.resultPath,
    resultDigest: result.resultDigest,
    receiptPath: result.applicationRuntime.receiptPath,
    receiptDigest: result.applicationRuntime.digest,
  };
}

function phaseReferences({ artifactRoot, scenarioId, runId, hostResult }) {
  const evidenceRoot = path.join(
    artifactRoot,
    scenarioId,
    "runs",
    runId,
    "evidence",
  );
  return {
    validate: {
      contract: "kandev-highlight-runtime-phase-reference-v1",
      phase: "validate",
      manifestPath: path.join(evidenceRoot, "validate.json"),
    },
    storyboard: {
      contract: "kandev-highlight-runtime-phase-reference-v1",
      phase: "storyboard",
      manifestPath: path.join(evidenceRoot, "storyboard.json"),
    },
    capture: structuredClone(hostResult.capture),
  };
}

function dryRunPlan({
  command,
  scenario,
  scenarioPath,
  scenarioDigest,
  runtimePreflight,
  runtimeId,
  source,
  prNumber,
  prBaseSha,
  repoRoot,
  artifactRoot,
  buildRoot,
  runId,
  hostCommand,
}) {
  const order =
    command === "run"
      ? ["validate", "storyboard", "capture", "render", "qa", "stage"]
      : ["validate", "storyboard", "capture"];
  return {
    contract: "kandev-highlight-runtime-dry-run-v1",
    command,
    dryRun: true,
    zeroWrites: true,
    runId,
    runtime: runtimePreflight,
    scenario: { id: scenario.id, path: scenarioPath, digest: scenarioDigest },
    source: {
      mode: source,
      pullRequest:
        source === "pr_head"
          ? Number.isInteger(Number(prNumber)) &&
            SHA_PATTERN.test(prBaseSha ?? "")
            ? { number: Number(prNumber), baseSha: prBaseSha }
            : { status: "resolve-before-build", command: ["gh", "pr", "view"] }
          : null,
    },
    build: {
      adapter: "buildCaptureCheckout",
      artifactRoot: buildRoot,
      commands: [
        {
          command: "make",
          args: ["-C", "apps/backend", "build"],
          cwd: repoRoot,
        },
        {
          command: "pnpm",
          args: ["--filter", "@kandev/web", "build"],
          cwd: path.join(repoRoot, "apps"),
        },
      ],
    },
    host: {
      requestContract: "kandev-highlight-runtime-host-request-v1",
      command: hostCommand,
    },
    prerequisites: {
      tools: ["ffmpeg", "Xvfb", "Playwright Chromium", "ffprobe"],
      sourceGate: source,
      runtimeId,
    },
    order,
    paths: {
      build: buildRoot,
      hostBundle: path.join(artifactRoot, "runtime-host", runId),
      attempt: path.join(artifactRoot, scenario.id, "runs", runId),
      stagePattern: path.join(
        artifactRoot,
        scenario.id,
        "stages",
        "<sha256-manifest-digest>",
      ),
    },
  };
}

export async function runTrustedHighlightCommand({
  command,
  scenarioPath,
  artifactRoot,
  source,
  repoRoot = process.cwd(),
  landingRoot,
  runId,
  runtimeId = BUILTIN_HIGHLIGHT_RUNTIME_ID,
  prNumber,
  prBaseSha,
  allowedExtensionIds = [],
  dryRun = false,
  env = process.env,
  dependencies = {},
} = {}) {
  if (!["capture", "run"].includes(command)) {
    throw new Error("trusted runtime command must be capture or run");
  }
  if (!["pr_head", "current_main"].includes(source)) {
    throw new Error(`${command} --source must be pr_head or current_main`);
  }
  if (typeof scenarioPath !== "string" || !scenarioPath) {
    throw new Error(`${command} requires scenarioPath`);
  }
  if (typeof artifactRoot !== "string" || !artifactRoot) {
    throw new Error(`${command} requires --artifact-root outside repositories`);
  }
  const deps = dependenciesWithDefaults(dependencies);
  const runtime = deps.resolveRuntime(runtimeId);
  const unknownExtensions = allowedExtensionIds.filter(
    (primitiveId) => !runtime.primitiveIds.includes(primitiveId),
  );
  if (unknownExtensions.length > 0) {
    throw new Error(
      `runtime '${runtime.id}' does not register --allow-extension ${unknownExtensions.join(", ")}`,
    );
  }
  const absoluteRepository = path.resolve(repoRoot);
  const absoluteScenario = path.resolve(absoluteRepository, scenarioPath);
  const scenarioOptions = { allowedExtensionIds: runtime.primitiveIds };
  const scenario = await deps.readScenario(absoluteScenario, scenarioOptions);
  const scenarioDigest = deps.computeScenarioDigest(scenario, scenarioOptions);
  const timeline = deps.compileTimeline(scenario, scenarioOptions);
  if (timeline.scenarioDigest !== scenarioDigest) {
    throw new Error("runtime compiled timeline scenario digest mismatch");
  }
  const runtimePreflight = deps.preflightRuntime({
    runtimeId: runtime.id,
    scenario,
  });
  if (command === "run")
    deps.requireDeliveryMetadata(scenario, scenarioOptions);
  const selectedRunId = allocateRunId({
    requested: runId,
    scenarioDigest,
    now: deps.clock(),
    nonce: deps.runIdNonce(),
  });
  const externalRoot = assertExternalArtifactRoot({
    artifactRoot: path.resolve(artifactRoot),
    repoRoots: [absoluteRepository, landingRoot].filter(Boolean),
  });
  await rejectExistingSymlinks(externalRoot);
  const buildRoot = path.join(externalRoot, "runtime-builds", selectedRunId);
  const hostCommand = deps.buildRuntimeHostCommand({
    webRoot: path.join(absoluteRepository, "apps", "web"),
  });
  if (dryRun) {
    return dryRunPlan({
      command,
      scenario,
      scenarioPath: absoluteScenario,
      scenarioDigest,
      runtimePreflight,
      runtimeId: runtime.id,
      source,
      prNumber,
      prBaseSha,
      repoRoot: absoluteRepository,
      artifactRoot: externalRoot,
      buildRoot,
      runId: selectedRunId,
      hostCommand,
    });
  }

  const sourceProof = validateSourceProof(
    await deps.verifySourceGate({
      repoRoot: absoluteRepository,
      source,
      runner: deps.commandRunner,
    }),
    { source, repoRoot: absoluteRepository },
  );
  const pullRequest =
    source === "pr_head"
      ? validateResolvedPr(
          await deps.resolvePrMetadata({
            repoRoot: absoluteRepository,
            sourceSha: sourceProof.selectedSha,
            prNumber,
            prBaseSha,
            env,
            runner: deps.commandRunner,
          }),
          sourceProof.selectedSha,
        )
      : null;
  const build = validateBuild(
    await deps.buildCaptureCheckout({
      repoRoot: absoluteRepository,
      webRoot: path.join(absoluteRepository, "apps", "web"),
      artifactRoot: buildRoot,
      source,
    }),
    sourceProof,
    buildRoot,
  );
  const request = validateRuntimeHostRequest({
    contract: "kandev-highlight-runtime-host-request-v1",
    version: 1,
    runtimeId: runtime.id,
    scenarioPath: absoluteScenario,
    artifactRoot: externalRoot,
    repositoryRoot: absoluteRepository,
    buildManifestPath: path.resolve(build.manifestPath),
    source,
    runId: selectedRunId,
    pullRequest,
  });
  const hostResult = validateHostResult(
    await deps.runRuntimeHost({ request, inheritedEnv: env }),
    request,
    scenario,
    scenarioDigest,
    sourceProof,
  );
  const phases = phaseReferences({
    artifactRoot: externalRoot,
    scenarioId: scenario.id,
    runId: selectedRunId,
    hostResult,
  });
  const order = ["validate", "storyboard", "capture"];
  if (command === "run") {
    const pipelineOptions = {
      scenarioPath: absoluteScenario,
      artifactRoot: externalRoot,
      landingRoot: landingRoot
        ? path.resolve(absoluteRepository, landingRoot)
        : undefined,
      runId: selectedRunId,
      allowedExtensionIds: runtime.primitiveIds,
      repoRoot: absoluteRepository,
      env,
    };
    for (const phase of ["render", "qa", "stage"]) {
      const result = await deps.pipelineRunner({
        ...pipelineOptions,
        command: phase,
      });
      if (result?.runId !== selectedRunId || !result.phases?.[phase]) {
        throw new Error(
          `trusted runtime ${phase} did not return the selected run phase`,
        );
      }
      phases[phase] = result.phases[phase];
      order.push(phase);
    }
  }
  return {
    contract: "kandev-highlight-runtime-command-v1",
    command,
    runtimeId: runtime.id,
    runId: selectedRunId,
    order,
    host: compactHostLink(hostResult),
    phases,
  };
}
