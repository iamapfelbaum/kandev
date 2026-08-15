import path from "node:path";

import { quickStartEvaluation, validatePipelineEvaluation } from "./pipeline-eval-scenario.mjs";
import { requireAbsolute } from "./pipeline-eval-shared.mjs";

export const QUICK_START_ID = "quick-start";

const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export function buildPipelineCommandSequence({
  cloneRoot,
  scenarioPath,
  artifactRoot,
  landingRoot,
  reviewPath,
  prNumber,
  prBaseSha,
  nodeExecutable = process.execPath,
  evaluation = quickStartEvaluation(),
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
  const selectedEvaluation = validatePipelineEvaluation(evaluation);
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
  const initial =
    selectedEvaluation.mode === "quick-start"
      ? [command("scaffold", ["scaffold", scenario, "--template", QUICK_START_ID])]
      : [];
  const runs = [run("run-1", "fresh-agent-1")];
  if (selectedEvaluation.mode === "quick-start") {
    runs.push(run("run-2", "fresh-agent-2"));
  }
  return [
    ...initial,
    command("validate", ["validate", scenario]),
    command("storyboard", ["storyboard", scenario, "--format", "json"]),
    ...runs,
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
