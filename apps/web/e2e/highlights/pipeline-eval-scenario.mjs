import fs from "node:fs/promises";
import path from "node:path";

import {
  canonicalDirectory,
  canonicalJson,
  digestBytes,
  git,
  isInside,
} from "./pipeline-eval-shared.mjs";

export const PIPELINE_EVALUATION_CONTRACT = "kandev-highlight-pipeline-evaluation-v1";

const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_SCENARIO_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const COMMITTED_SCENARIO_MODE = "committed-scenario";

function exactKeys(value, expected, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())
  ) {
    throw new Error(`${label} has unsupported fields`);
  }
}

export function normalizeRepositoryRelativeScenarioPath(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    !SAFE_SCENARIO_PATH_PATTERN.test(value) ||
    value.includes("\\")
  ) {
    throw new Error("scenario must be a safe repository-relative path");
  }
  const normalized = path.posix.normalize(value);
  const segments = value.split("/");
  if (
    normalized !== value ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("scenario must be a canonical repository-relative path");
  }
  if (!value.endsWith(".scenario.json")) {
    throw new Error("scenario repository-relative path must end in .scenario.json");
  }
  return value;
}

export function quickStartEvaluation() {
  return {
    contract: PIPELINE_EVALUATION_CONTRACT,
    mode: "quick-start",
    scenario: null,
  };
}

function validateCommittedScenario(value, source) {
  exactKeys(
    value,
    ["path", "sourceHead", "gitBlobSha", "bytes", "sha256"],
    "committed scenario proof",
  );
  const scenario = {
    path: normalizeRepositoryRelativeScenarioPath(value.path),
    sourceHead: value.sourceHead,
    gitBlobSha: value.gitBlobSha,
    bytes: value.bytes,
    sha256: value.sha256,
  };
  if (
    !GIT_OBJECT_PATTERN.test(scenario.sourceHead ?? "") ||
    !GIT_OBJECT_PATTERN.test(scenario.gitBlobSha ?? "") ||
    !Number.isInteger(scenario.bytes) ||
    scenario.bytes < 1 ||
    !SHA256_PATTERN.test(scenario.sha256 ?? "")
  ) {
    throw new Error("committed scenario proof must bind exact Git objects, bytes, and SHA-256");
  }
  if (source && scenario.sourceHead !== source.headSha) {
    throw new Error("committed scenario source HEAD does not match the repository proof");
  }
  return scenario;
}

export function validatePipelineEvaluation(value, source = null) {
  exactKeys(value, ["contract", "mode", "scenario"], "pipeline evaluation");
  if (value.contract !== PIPELINE_EVALUATION_CONTRACT) {
    throw new Error("pipeline evaluation contract is invalid");
  }
  if (value.mode === "quick-start") {
    if (value.scenario !== null) {
      throw new Error("quick-start pipeline evaluation cannot supply a scenario");
    }
    return quickStartEvaluation();
  }
  if (value.mode !== COMMITTED_SCENARIO_MODE) {
    throw new Error("pipeline evaluation mode is invalid");
  }
  return {
    contract: PIPELINE_EVALUATION_CONTRACT,
    mode: COMMITTED_SCENARIO_MODE,
    scenario: validateCommittedScenario(value.scenario, source),
  };
}

async function trackedHeadBytes(repository, relative) {
  try {
    await git(repository, ["ls-files", "--error-unmatch", "--", relative], {
      phase: "git-scenario-tracked",
    });
  } catch {
    throw new Error(`scenario must be tracked and committed at HEAD: ${relative}`);
  }
  const [sourceHead, gitBlob, bytes] = await Promise.all([
    git(repository, ["rev-parse", "HEAD"], { phase: "git-scenario-head" }),
    git(repository, ["rev-parse", `HEAD:${relative}`], { phase: "git-scenario-blob" }),
    git(repository, ["show", `HEAD:${relative}`], { phase: "git-scenario-bytes" }),
  ]);
  return {
    sourceHead: sourceHead.stdout.trim(),
    gitBlobSha: gitBlob.stdout.trim(),
    bytes: bytes.stdoutBytes,
  };
}

export async function captureCommittedScenarioEvaluation({ sourceRoot, scenarioPath } = {}) {
  const repository = await canonicalDirectory(
    path.resolve(sourceRoot ?? ""),
    "scenario source repository",
  );
  const relative = normalizeRepositoryRelativeScenarioPath(scenarioPath);
  const candidate = path.resolve(repository, relative);
  if (candidate === repository || !isInside(repository, candidate)) {
    throw new Error("scenario must stay inside the source repository");
  }
  const value = await fs.lstat(candidate).catch(() => null);
  if (!value?.isFile() || value.isSymbolicLink()) {
    throw new Error("scenario must be a regular non-symlink file");
  }
  if ((await fs.realpath(candidate)) !== candidate) {
    throw new Error("scenario cannot resolve through symlinked parents");
  }
  const status = (
    await git(repository, ["status", "--porcelain=v1", "--untracked-files=all", "--", relative], {
      phase: "git-scenario-status",
    })
  ).stdout.trim();
  if (status !== "")
    throw new Error(`scenario is modified and must match committed bytes: ${status}`);

  const [worktreeBytes, committed] = await Promise.all([
    fs.readFile(candidate),
    trackedHeadBytes(repository, relative),
  ]);
  if (
    worktreeBytes.length !== committed.bytes.length ||
    digestBytes(worktreeBytes) !== digestBytes(committed.bytes)
  ) {
    throw new Error("scenario worktree bytes do not match committed HEAD bytes");
  }
  return validatePipelineEvaluation({
    contract: PIPELINE_EVALUATION_CONTRACT,
    mode: COMMITTED_SCENARIO_MODE,
    scenario: {
      path: relative,
      sourceHead: committed.sourceHead,
      gitBlobSha: committed.gitBlobSha,
      bytes: worktreeBytes.length,
      sha256: digestBytes(worktreeBytes),
    },
  });
}

export async function capturePipelineEvaluation({ sourceRoot, scenarioPath = null } = {}) {
  return scenarioPath === null
    ? quickStartEvaluation()
    : captureCommittedScenarioEvaluation({ sourceRoot, scenarioPath });
}

export async function assertCommittedScenarioEvaluation({
  sourceRoot,
  evaluation: expectedInput,
} = {}) {
  const expected = validatePipelineEvaluation(expectedInput);
  if (expected.mode !== COMMITTED_SCENARIO_MODE) {
    throw new Error("mounted scenario proof requires committed-scenario mode");
  }
  const actual = await captureCommittedScenarioEvaluation({
    sourceRoot,
    scenarioPath: expected.scenario.path,
  });
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("mounted scenario does not match the request-bound committed proof");
  }
  return actual;
}

export async function assertRepositoryPipelineEvaluation({ sourceRoot, evaluation } = {}) {
  const selected = validatePipelineEvaluation(evaluation);
  return selected.mode === COMMITTED_SCENARIO_MODE
    ? assertCommittedScenarioEvaluation({ sourceRoot, evaluation: selected })
    : selected;
}
