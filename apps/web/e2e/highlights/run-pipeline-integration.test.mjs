import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as pipeline from "./run-pipeline-integration.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "../..");
const FIXTURE_SNAPSHOT = "/external/eval/snapshot";
const FIXTURE_SCENARIO = `${FIXTURE_SNAPSHOT}/eval/quick-start.scenario.json`;
const FIXTURE_ARTIFACTS = "/external/eval/artifacts";
const MAIN_REF = "refs/heads/main";

async function exec(command, args, { cwd } = {}) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const result = await promisify(execFile)(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return { ...result, exitCode: 0 };
}

async function initRepository(root) {
  await fs.mkdir(root, { recursive: true });
  await exec("git", ["init", "--initial-branch=main"], { cwd: root });
  await exec("git", ["config", "user.name", "Highlight Eval"], { cwd: root });
  await exec("git", ["config", "user.email", "highlight-eval@example.invalid"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "committed\n");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["commit", "-m", "fixture"], { cwd: root });
  await exec("git", ["checkout", "-b", "feature/eval"], { cwd: root });
  await fs.writeFile(path.join(root, "FEATURE.md"), "feature head\n");
  await exec("git", ["add", "FEATURE.md"], { cwd: root });
  await exec("git", ["commit", "-m", "feature fixture"], { cwd: root });
  return (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
}

test("facade preserves the public eval contract", () => {
  for (const name of [
    "assertDeterministicRuns",
    "assertRepositoryStateUnchanged",
    "assertRuntimeEvidenceLinks",
    "assertTechnicalReview",
    "buildPipelineCommandSequence",
    "captureRepositoryState",
    "commitScenarioAsPrHead",
    "installFrozenOfflineDependencies",
    "linkIgnoredDependencies",
    "normalizeDeterminismEvidence",
    "projectSemanticPointerEvidence",
    "runBoundedSubprocess",
    "runFreshAgentPipelineEvaluation",
    "runFreshAgentPipelineEvaluationInDocker",
    "runWithEvalRetention",
    "snapshotCommittedRepository",
    "verifyFrozenOfflineDependencies",
  ]) {
    assert.equal(typeof pipeline[name], "function", `${name} must remain exported`);
  }
  assert.equal(pipeline.linkIgnoredDependencies, pipeline.installFrozenOfflineDependencies);
});

test("CLI launches trusted Docker boundary and reserves direct orchestration for inner worker", async () => {
  const source = await fs.readFile(path.join(HERE, "run-pipeline-integration.mjs"), "utf8");
  assert.match(source, /runFreshAgentPipelineEvaluationInDocker\(options\)/);
  assert.match(source, /--inside-docker-boundary/);
  assert.match(source, /runInsideDockerBoundary/);
  assert.doesNotMatch(
    source,
    /const result\s*=\s*await runFreshAgentPipelineEvaluation\(options\)/,
  );
});

test("pipeline command sequence uses production CLI and exact safe arguments", async () => {
  const commands = pipeline.buildPipelineCommandSequence({
    cloneRoot: FIXTURE_SNAPSHOT,
    scenarioPath: FIXTURE_SCENARIO,
    artifactRoot: FIXTURE_ARTIFACTS,
    landingRoot: "/workspace/landing",
    reviewPath: `${FIXTURE_ARTIFACTS}/quick-start/stages/deadbeef/review.json`,
    prNumber: 1,
    prBaseSha: "b".repeat(40),
    nodeExecutable: "/usr/bin/node",
  });

  assert.deepEqual(
    commands.map(({ phase }) => phase),
    ["scaffold", "validate", "storyboard", "run-1", "run-2", "stage-recovery", "promote-dry-run"],
  );
  for (const command of commands) {
    assert.equal(command.command, "/usr/bin/node");
    assert.equal(command.cwd, FIXTURE_SNAPSHOT);
    assert.equal(command.args[0], `${FIXTURE_SNAPSHOT}/scripts/highlights.mjs`);
  }
  assert.deepEqual(commands[0].args.slice(1), [
    "scaffold",
    FIXTURE_SCENARIO,
    "--template",
    "quick-start",
  ]);
  assert.deepEqual(commands[1].args.slice(1), ["validate", FIXTURE_SCENARIO]);
  assert.deepEqual(commands[2].args.slice(1), ["storyboard", FIXTURE_SCENARIO, "--format", "json"]);
  for (const [index, runId] of [
    [3, "fresh-agent-1"],
    [4, "fresh-agent-2"],
  ]) {
    assert.deepEqual(commands[index].args.slice(1), [
      "run",
      FIXTURE_SCENARIO,
      "--artifact-root",
      FIXTURE_ARTIFACTS,
      "--source",
      "pr_head",
      "--pr-number",
      "1",
      "--pr-base-sha",
      "b".repeat(40),
      "--landing-root",
      "/workspace/landing",
      "--runtime",
      "kandev-isolated-e2e",
      "--run-id",
      runId,
    ]);
  }
  assert.deepEqual(commands[5].args.slice(-3), ["--run-id", "fresh-agent-1", "--dry-run"]);
  assert.deepEqual(commands[6].args.slice(-3), [
    "--accept-reviewed-by",
    "fresh-agent-eval",
    "--dry-run",
  ]);
  const packageJson = JSON.parse(await fs.readFile(path.join(WEB_ROOT, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["e2e:highlight-pipeline"],
    "node e2e/highlights/run-pipeline-integration.mjs",
  );
});

test("snapshot keeps immutable main while scaffold commit becomes isolated pr_head", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-pipeline-git-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const sourceRoot = path.join(temp, "source");
  const cloneRoot = path.join(temp, "snapshot");
  const sourceHead = await initRepository(sourceRoot);
  const sourceMain = (await exec("git", ["rev-parse", "main"], { cwd: sourceRoot })).stdout.trim();
  assert.notEqual(sourceHead, sourceMain);
  const sourceBefore = await pipeline.captureRepositoryState(sourceRoot);

  const snapshot = await pipeline.snapshotCommittedRepository({ sourceRoot, cloneRoot });
  assert.equal(snapshot.sourceHead, sourceHead);
  assert.equal(snapshot.snapshotHead, sourceHead);
  assert.equal(snapshot.originMainSha, sourceMain);
  assert.equal(snapshot.localOnly, true);
  assert.equal(snapshot.originRoot, path.join(temp, "origin.git"));
  const bareHead = await exec("git", ["--git-dir", snapshot.originRoot, "rev-parse", MAIN_REF]);
  assert.equal(bareHead.stdout.trim(), sourceMain);

  const scenarioPath = path.join(cloneRoot, "eval", "quick-start.scenario.json");
  await fs.mkdir(path.dirname(scenarioPath), { recursive: true });
  await fs.writeFile(scenarioPath, '{"schemaVersion":1}\n');
  const bound = await pipeline.commitScenarioAsPrHead({ cloneRoot, scenarioPath });
  assert.match(bound.evalHead, /^[a-f0-9]{40}$/);
  assert.equal(bound.headSha, bound.evalHead);
  assert.equal(bound.currentMainSha, sourceMain);
  assert.equal(bound.originMainSha, sourceMain);
  assert.equal(bound.prBaseSha, sourceMain);
  assert.equal(bound.clean, true);
  const boundBareHead = await exec("git", [
    "--git-dir",
    snapshot.originRoot,
    "rev-parse",
    MAIN_REF,
  ]);
  assert.equal(boundBareHead.stdout.trim(), sourceMain);

  await exec("git", ["update-ref", "refs/remotes/origin/main", sourceHead], { cwd: cloneRoot });
  assert.equal(
    (await exec("git", ["rev-parse", "origin/main"], { cwd: cloneRoot })).stdout.trim(),
    sourceHead,
  );
  await exec("git", ["fetch", "--no-tags", "origin", "main"], { cwd: cloneRoot });
  assert.equal(
    (await exec("git", ["rev-parse", "origin/main"], { cwd: cloneRoot })).stdout.trim(),
    sourceMain,
  );
  await pipeline.assertRepositoryStateUnchanged(
    sourceBefore,
    pipeline.captureRepositoryState(sourceRoot),
    "source repository",
  );
});

test("repository-state proof catches tracked and untracked production writes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-pipeline-state-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initRepository(root);
  const before = await pipeline.captureRepositoryState(root);
  await fs.writeFile(path.join(root, "unexpected.txt"), "write\n");
  const after = await pipeline.captureRepositoryState(root);
  await assert.rejects(
    pipeline.assertRepositoryStateUnchanged(before, after, "production repository"),
    /production repository.*changed.*unexpected\.txt/i,
  );
});
