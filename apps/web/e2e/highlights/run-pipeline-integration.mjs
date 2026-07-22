import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_LANDING_ROOT, DEFAULT_REPO_ROOT } from "./pipeline-eval-orchestrator.mjs";
import {
  runFreshAgentPipelineEvaluationInDocker,
  runInsideDockerBoundary,
} from "./pipeline-eval-docker-launcher.mjs";
import { DEFAULT_CAPTURE_DEADLINE_MS } from "./pipeline-eval-shared.mjs";

export {
  assertDeterministicRuns,
  assertRuntimeEvidenceLinks,
  assertTechnicalReview,
  normalizeDeterminismEvidence,
  projectSemanticPointerEvidence,
} from "./pipeline-eval-evidence.mjs";
export {
  assertRepositoryStateUnchanged,
  captureRepositoryState,
  commitScenarioAndBindCurrentMain,
  commitScenarioAsPrHead,
  installFrozenOfflineDependencies,
  linkIgnoredDependencies,
  snapshotCommittedRepository,
  verifyFrozenOfflineDependencies,
} from "./pipeline-eval-repository.mjs";
export {
  buildPipelineCommandSequence,
  runFreshAgentPipelineEvaluation,
  runWithEvalRetention,
} from "./pipeline-eval-orchestrator.mjs";
export { runBoundedSubprocess } from "./pipeline-eval-shared.mjs";
export {
  runFreshAgentPipelineEvaluationInDocker,
  runInsideDockerBoundary,
} from "./pipeline-eval-docker-launcher.mjs";

function parseOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help") return { help: true };
    if (
      !["--source-root", "--landing-root", "--eval-parent", "--capture-timeout-ms"].includes(option)
    ) {
      throw new Error(`unknown pipeline eval option ${option}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    if (values[option] !== undefined) throw new Error(`${option} may be specified only once`);
    values[option] = value;
    index += 1;
  }
  const timeout = values["--capture-timeout-ms"]
    ? Number(values["--capture-timeout-ms"])
    : DEFAULT_CAPTURE_DEADLINE_MS;
  if (!Number.isInteger(timeout) || timeout < 30_000) {
    throw new Error("--capture-timeout-ms must be an integer of at least 30000");
  }
  return {
    sourceRoot: values["--source-root"] ? path.resolve(values["--source-root"]) : DEFAULT_REPO_ROOT,
    landingRoot: values["--landing-root"]
      ? path.resolve(values["--landing-root"])
      : DEFAULT_LANDING_ROOT,
    evalParent: values["--eval-parent"] ? path.resolve(values["--eval-parent"]) : os.tmpdir(),
    captureDeadlineMs: timeout,
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--inside-docker-boundary") {
    if (argv.length !== 2) {
      throw new Error("--inside-docker-boundary requires exactly one fixed request path");
    }
    const result = await runInsideDockerBoundary({ requestPath: argv[1] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: pnpm e2e:highlight-pipeline [--source-root <clean-repo>] [--landing-root <clean-landing-repo>] [--eval-parent <external-dir>] [--capture-timeout-ms <ms>]\n",
    );
    return;
  }
  try {
    const result = await runFreshAgentPipelineEvaluationInDocker(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify(
        {
          contract: "kandev-highlight-pipeline-eval-cli-failure-v1",
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
          phase: error.phase ?? null,
          evalRoot: error.evalRoot ?? null,
          failurePath: error.failurePath ?? null,
          receiptPath: error.receiptPath ?? null,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
