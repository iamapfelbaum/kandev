import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectRunEvidence, parseLastJsonDocument } from "./pipeline-eval-artifacts.mjs";
import { assertDeterministicRuns } from "./pipeline-eval-evidence.mjs";
import {
  assertRepositoryStateUnchanged,
  captureRepositoryState,
  commitScenarioAsPrHead,
  installFrozenOfflineDependencies,
  snapshotCommittedRepository,
  verifyFrozenOfflineDependencies,
} from "./pipeline-eval-repository.mjs";
import {
  canonicalDirectory,
  DEFAULT_CAPTURE_DEADLINE_MS,
  DEFAULT_SETUP_DEADLINE_MS,
  digestValue,
  isInside,
  PIPELINE_ORDER,
  requireAbsolute,
  runBoundedSubprocess,
} from "./pipeline-eval-shared.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_ROOT = path.resolve(HERE, "../..");
export const DEFAULT_REPO_ROOT = path.resolve(DEFAULT_WEB_ROOT, "../..");
export const DEFAULT_LANDING_ROOT = path.resolve(DEFAULT_REPO_ROOT, "..", "landing");
const QUICK_START_ID = "quick-start";
const TRUSTED_SOURCE_KEY = "KANDEV_HIGHLIGHT_TRUSTED_SOURCE_SHA";
const SYNTHETIC_EVAL_PR_NUMBER = 2_147_483_647;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export function clearInheritedTrustedSource(inheritedEnvironment) {
  const environment = { ...inheritedEnvironment };
  delete environment[TRUSTED_SOURCE_KEY];
  return environment;
}

export function buildPipelineCommandSequence({
  cloneRoot,
  scenarioPath,
  artifactRoot,
  landingRoot,
  reviewPath,
  prNumber,
  prBaseSha,
  nodeExecutable = process.execPath,
} = {}) {
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new Error("pipeline eval prNumber must be a positive integer");
  }
  if (!GIT_OBJECT_PATTERN.test(prBaseSha ?? "")) {
    throw new Error("pipeline eval prBaseSha must be an exact Git SHA");
  }
  const repository = requireAbsolute(cloneRoot, "cloneRoot");
  const scenario = requireAbsolute(scenarioPath, "scenarioPath");
  const artifacts = requireAbsolute(artifactRoot, "artifactRoot");
  const landing = requireAbsolute(landingRoot, "landingRoot");
  const review = requireAbsolute(reviewPath, "reviewPath");
  const cli = path.join(repository, "scripts", "highlights.mjs");
  const command = (phase, args) => ({
    phase,
    command: nodeExecutable,
    args: [cli, ...args],
    cwd: repository,
  });
  const run = (phase, runId) =>
    command(phase, [
      "run",
      scenario,
      "--artifact-root",
      artifacts,
      "--source",
      "pr_head",
      "--pr-number",
      String(prNumber),
      "--pr-base-sha",
      prBaseSha,
      "--landing-root",
      landing,
      "--runtime",
      "kandev-isolated-e2e",
      "--run-id",
      runId,
    ]);
  return [
    command("scaffold", ["scaffold", scenario, "--template", QUICK_START_ID]),
    command("validate", ["validate", scenario]),
    command("storyboard", ["storyboard", scenario, "--format", "json"]),
    run("run-1", "fresh-agent-1"),
    run("run-2", "fresh-agent-2"),
    command("stage-recovery", [
      "stage",
      scenario,
      "--artifact-root",
      artifacts,
      "--run-id",
      "fresh-agent-1",
      "--dry-run",
    ]),
    command("promote-dry-run", [
      "promote",
      review,
      "--accept-reviewed-by",
      "fresh-agent-eval",
      "--dry-run",
    ]),
  ];
}

async function writeCaptureMarker(root, metadata) {
  const capture = {
    phase: metadata.phase ?? "capture",
    argv: Array.isArray(metadata.argv) ? [...metadata.argv] : [],
    startedAt: new Date().toISOString(),
  };
  const record = { contract: "kandev-highlight-pipeline-eval-capture-v1", ...capture };
  await fs.writeFile(
    path.join(root, "capture-started.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return capture;
}

async function retainCaptureFailure(root, capture, error) {
  const failurePath = path.join(root, "failure.json");
  const failure = {
    contract: "kandev-highlight-pipeline-eval-failure-v1",
    status: "failed",
    captureStarted: true,
    phase: error.phase ?? capture.phase,
    message: error instanceof Error ? error.message : String(error),
    argv: error.argv ?? capture.argv,
    evalRoot: root,
    logs: error.commandResult?.logPaths ?? null,
    failedAt: new Date().toISOString(),
    recovery: "Inspect retained logs/evidence, then rerun with a fresh external eval root.",
  };
  await fs.writeFile(failurePath, `${JSON.stringify(failure, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  error.evalRoot = root;
  error.failurePath = failurePath;
}

export async function runWithEvalRetention({ evalRoot, task } = {}) {
  const root = requireAbsolute(evalRoot, "evalRoot");
  if (typeof task !== "function") throw new Error("eval retention task is required");
  await fs.mkdir(root, { recursive: true });
  let capture = null;
  const markCaptureStarted = async (metadata = {}) => {
    capture = await writeCaptureMarker(root, metadata);
  };
  try {
    return await task({ markCaptureStarted });
  } catch (error) {
    if (!capture) {
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
    await retainCaptureFailure(root, capture, error);
    throw error;
  }
}

async function configuredToolchainEnvironment(inheritedEnv, securityEnvironment = {}) {
  const environment = clearInheritedTrustedSource({ ...inheritedEnv, ...securityEnvironment });
  environment.KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX = "auto";
  const result = await runBoundedSubprocess({
    command: "go",
    args: ["env", "GOCACHE", "GOMODCACHE", "GOPATH"],
    phase: "go-env",
    deadlineMs: DEFAULT_SETUP_DEADLINE_MS,
  }).catch(() => null);
  if (!result) return environment;
  const [goCache, goModCache, goPath] = result.stdout.trim().split("\n");
  for (const [key, value] of Object.entries({
    GOCACHE: goCache,
    GOMODCACHE: goModCache,
    GOPATH: goPath,
  })) {
    if (value && path.isAbsolute(value)) environment[key] = value;
  }
  return environment;
}

async function invoke(command, options = {}) {
  return runBoundedSubprocess({
    ...command,
    logRoot: options.logRoot,
    env: options.env,
    deadlineMs: options.deadlineMs ?? DEFAULT_SETUP_DEADLINE_MS,
  });
}

function commandResultSummary(result) {
  return {
    phase: result.phase,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    logs: result.logPaths,
  };
}

function evaluationPaths(evalRoot) {
  const cloneRoot = path.join(evalRoot, "snapshot");
  return {
    evalRoot,
    cloneRoot,
    originRoot: path.join(evalRoot, "origin.git"),
    artifactRoot: path.join(evalRoot, "artifacts"),
    logRoot: path.join(evalRoot, "logs"),
    scenarioPath: path.join(cloneRoot, "eval", "quick-start.scenario.json"),
    placeholderReview: path.join(evalRoot, "review-pending.json"),
  };
}

async function cleanRepositoryProofs(source, landing) {
  const [sourceBefore, landingBefore] = await Promise.all([
    captureRepositoryState(source),
    captureRepositoryState(landing),
  ]);
  if (sourceBefore.status !== "") {
    throw new Error(`production source is not clean: ${sourceBefore.status}`);
  }
  if (landingBefore.status !== "") {
    throw new Error(`landing repository is not clean: ${landingBefore.status}`);
  }
  return { sourceBefore, landingBefore };
}

async function invokeInitialCommands(context, commands) {
  const commandEvidence = [];
  let storyboardTimeline;
  for (const command of commands.slice(0, 3)) {
    const result = await invoke(command, context);
    commandEvidence.push(commandResultSummary(result));
    if (command.phase === "storyboard") {
      storyboardTimeline = parseLastJsonDocument(result.stdout, "storyboard");
    }
  }
  if (
    !storyboardTimeline ||
    storyboardTimeline.scenarioId !== QUICK_START_ID ||
    storyboardTimeline.totalDurationMs > 4_000
  ) {
    throw new Error(
      "fresh-agent scaffold storyboard is not the deterministic short quick-start story",
    );
  }
  return { commandEvidence, storyboardTimeline };
}

async function setupEvaluation(input) {
  const context = { ...input, ...evaluationPaths(input.evalRoot) };
  const clean = await cleanRepositoryProofs(input.source, input.landing);
  Object.assign(context, clean);
  context.snapshot = await snapshotCommittedRepository({
    sourceRoot: input.source,
    cloneRoot: context.cloneRoot,
    originRoot: context.originRoot,
  });
  context.environment = await configuredToolchainEnvironment(
    input.inheritedEnv,
    input.securityEnvironment,
  );
  context.dependencyInstall = await installFrozenOfflineDependencies({
    sourceRoot: input.source,
    cloneRoot: context.cloneRoot,
    inheritedEnv: context.environment,
    logRoot: context.logRoot,
  });
  context.commands = buildPipelineCommandSequence({
    cloneRoot: context.cloneRoot,
    scenarioPath: context.scenarioPath,
    artifactRoot: context.artifactRoot,
    landingRoot: input.landing,
    reviewPath: context.placeholderReview,
    prNumber: input.prNumber,
    prBaseSha: context.snapshot.originMainSha,
  });
  const initial = await invokeInitialCommands(
    { logRoot: context.logRoot, env: context.environment },
    context.commands,
  );
  Object.assign(context, initial);
  context.prHead = await commitScenarioAsPrHead({
    cloneRoot: context.cloneRoot,
    scenarioPath: context.scenarioPath,
  });
  if (context.prHead.prBaseSha !== context.snapshot.originMainSha) {
    throw new Error("synthetic pr_head base changed while scaffolding eval scenario");
  }
  context.cloneBoundState = await captureRepositoryState(context.cloneRoot);
  await verifyProductionRepositories(context);
  return context;
}

async function verifyProductionRepositories(context) {
  await Promise.all([
    assertRepositoryStateUnchanged(
      context.sourceBefore,
      captureRepositoryState(context.source),
      "production source",
    ),
    assertRepositoryStateUnchanged(
      context.landingBefore,
      captureRepositoryState(context.landing),
      "landing repository",
    ),
  ]);
}

async function executeOneRun(context, command) {
  const commandResult = await invoke(command, {
    logRoot: context.logRoot,
    env: context.environment,
    deadlineMs: context.captureDeadlineMs,
  });
  context.commandEvidence.push(commandResultSummary(commandResult));
  const productionResult = parseLastJsonDocument(
    commandResult.stdout,
    `${command.phase} production run`,
  );
  return collectRunEvidence({
    commandResult: productionResult,
    scenarioPath: context.scenarioPath,
    artifactRoot: context.artifactRoot,
    evalRoot: context.evalRoot,
    logRoot: context.logRoot,
    env: context.environment,
  });
}

async function executeCaptureRuns(context, markCaptureStarted) {
  const firstCommand = context.commands[3];
  await markCaptureStarted({
    phase: firstCommand.phase,
    argv: [firstCommand.command, ...firstCommand.args],
  });
  context.first = await executeOneRun(context, firstCommand);
  context.second = await executeOneRun(context, context.commands[4]);
  context.deterministic = assertDeterministicRuns(
    context.first.normalized,
    context.second.normalized,
  );
}

async function runRecoveryDryRun(context, command) {
  const before = await captureRepositoryState(context.cloneRoot);
  const result = await invoke(command, { logRoot: context.logRoot, env: context.environment });
  context.commandEvidence.push(commandResultSummary(result));
  const value = parseLastJsonDocument(result.stdout, "stage recovery dry-run");
  const valid =
    value.contract === "kandev-highlight-stage-dry-run-v1" &&
    value.dryRun === true &&
    value.promotable === false;
  if (!valid)
    throw new Error("stage recovery dry-run did not verify the non-promotable review contract");
  await assertRepositoryStateUnchanged(
    before,
    captureRepositoryState(context.cloneRoot),
    "stage recovery dry-run snapshot",
  );
  return value;
}

async function runPromotionDryRun(context, command) {
  const before = await captureRepositoryState(context.cloneRoot);
  const result = await invoke(command, { logRoot: context.logRoot, env: context.environment });
  context.commandEvidence.push(commandResultSummary(result));
  if (!/Dry run: review quick-start\/r1 accepted by fresh-agent-eval/.test(result.stdout)) {
    throw new Error("promotion dry-run did not verify explicit fresh-agent-eval acceptance");
  }
  await assertRepositoryStateUnchanged(
    before,
    captureRepositoryState(context.cloneRoot),
    "promotion dry-run snapshot",
  );
}

async function executeDryRuns(context) {
  const commands = buildPipelineCommandSequence({
    cloneRoot: context.cloneRoot,
    scenarioPath: context.scenarioPath,
    artifactRoot: context.artifactRoot,
    landingRoot: context.landing,
    reviewPath: context.first.reviewPath,
    prNumber: context.prNumber,
    prBaseSha: context.prHead.prBaseSha,
  });
  context.recoveryResult = await runRecoveryDryRun(context, commands[5]);
  await runPromotionDryRun(context, commands[6]);
  await verifyProductionRepositories(context);
  await assertRepositoryStateUnchanged(
    context.cloneBoundState,
    captureRepositoryState(context.cloneRoot),
    "eval snapshot",
  );
}

function summarizeRun(run) {
  return {
    runId: run.runId,
    reviewPath: run.reviewPath,
    qaReportPath: run.qaReportPath,
    rawMasterPath: run.rawMasterPath,
    paths: run.paths,
    digests: run.digests,
    normalizedDigest: run.normalizedDigest,
    selectedFrames: run.selectedFrames,
    media: run.media,
    browser: run.browser,
  };
}

async function writeEvaluationResult(context) {
  const resultBody = {
    contract: "kandev-highlight-pipeline-eval-result-v1",
    status: "passed",
    evalRoot: context.evalRoot,
    artifactRoot: context.artifactRoot,
    logRoot: context.logRoot,
    snapshot: {
      sourceRoot: context.source,
      sourceHead: context.snapshot.sourceHead,
      cloneRoot: context.cloneRoot,
      originRoot: context.originRoot,
      evalHead: context.prHead.evalHead,
      currentMainSha: context.prHead.currentMainSha,
      originMainSha: context.prHead.originMainSha,
      sourceMode: "pr_head",
      syntheticPrNumber: context.prNumber,
      localOnly: true,
      dependencies: context.dependencyInstall,
      dependencyVerification: context.dependencyVerification,
    },
    landing: { root: context.landing, head: context.landingBefore.head },
    scenario: {
      path: context.scenarioPath,
      id: QUICK_START_ID,
      storyboardDurationMs: context.storyboardTimeline.totalDurationMs,
    },
    order: PIPELINE_ORDER,
    commands: context.commandEvidence,
    runs: [context.first, context.second].map(summarizeRun),
    deterministic: context.deterministic,
    recovery: {
      contract: context.recoveryResult.contract,
      dryRun: true,
      reviewPath: context.recoveryResult.manifestPath,
    },
    promotion: {
      dryRun: true,
      acceptedBy: "fresh-agent-eval",
      reviewPath: context.first.reviewPath,
      repositoryUnchanged: true,
    },
    repositoryUnchanged: { source: true, landing: true, snapshot: true },
    securityBoundary: context.securityBoundary ?? null,
    completedAt: new Date().toISOString(),
  };
  const result = { ...resultBody, resultDigest: digestValue(resultBody) };
  const resultPath = path.join(context.evalRoot, "result.json");
  await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { ...result, resultPath };
}

async function executeEvaluation(input, markCaptureStarted) {
  const context = await setupEvaluation(input);
  if (input.beforeCapture) {
    context.networkGate = await input.beforeCapture(context);
  }
  await executeCaptureRuns(context, markCaptureStarted);
  await executeDryRuns(context);
  context.dependencyVerification = await verifyFrozenOfflineDependencies(context.dependencyInstall);
  return writeEvaluationResult(context);
}

export async function runFreshAgentPipelineEvaluation({
  sourceRoot = DEFAULT_REPO_ROOT,
  landingRoot = DEFAULT_LANDING_ROOT,
  evalParent = os.tmpdir(),
  captureDeadlineMs = DEFAULT_CAPTURE_DEADLINE_MS,
  inheritedEnv = process.env,
  securityEnvironment = {},
  prNumber = SYNTHETIC_EVAL_PR_NUMBER,
  securityBoundary = null,
  beforeCapture = null,
} = {}) {
  if (beforeCapture !== null && typeof beforeCapture !== "function") {
    throw new Error("pipeline eval beforeCapture must be a function");
  }
  const source = await canonicalDirectory(path.resolve(sourceRoot), "production source repository");
  const landing = await canonicalDirectory(path.resolve(landingRoot), "landing repository");
  const parent = path.resolve(evalParent);
  if (isInside(source, parent) || isInside(landing, parent)) {
    throw new Error("pipeline eval parent must stay outside source and landing repositories");
  }
  await fs.mkdir(parent, { recursive: true });
  const evalRoot = await fs.mkdtemp(path.join(parent, "kandev-highlight-pipeline-eval-"));
  return runWithEvalRetention({
    evalRoot,
    task: ({ markCaptureStarted }) =>
      executeEvaluation(
        {
          source,
          landing,
          evalRoot,
          captureDeadlineMs,
          inheritedEnv,
          securityEnvironment,
          prNumber,
          securityBoundary,
          beforeCapture,
        },
        markCaptureStarted,
      ),
  });
}
