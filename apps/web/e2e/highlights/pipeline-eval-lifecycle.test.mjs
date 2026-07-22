import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertRepositoryStateUnchanged,
  captureRepositoryState,
  commitScenarioAndBindCurrentMain,
  runWithEvalRetention,
  snapshotCommittedRepository,
} from "./run-pipeline-integration.mjs";

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

test("eval lifecycle cleans setup failures but retains capture failures with actionable JSON", async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-pipeline-retain-test-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const setupRoot = path.join(parent, "setup");
  await assert.rejects(
    () =>
      runWithEvalRetention({
        evalRoot: setupRoot,
        task: async () => {
          throw new Error("setup broke");
        },
      }),
    /setup broke/,
  );
  await assert.rejects(() => fs.access(setupRoot), /ENOENT/);

  const captureRoot = path.join(parent, "capture");
  await assert.rejects(
    () =>
      runWithEvalRetention({
        evalRoot: captureRoot,
        task: async ({ markCaptureStarted }) => {
          await markCaptureStarted({ phase: "run-1", argv: ["node", "highlights.mjs", "run"] });
          throw new Error("capture broke");
        },
      }),
    /capture broke/,
  );
  const failure = JSON.parse(await fs.readFile(path.join(captureRoot, "failure.json"), "utf8"));
  assert.equal(failure.contract, "kandev-highlight-pipeline-eval-failure-v1");
  assert.equal(failure.captureStarted, true);
  assert.equal(failure.phase, "run-1");
  assert.match(failure.message, /capture broke/);
  assert.equal(failure.evalRoot, captureRoot);
});

test("snapshot and dry-run repository proofs reject any clone or source mutation", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-pipeline-dry-state-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const sourceRoot = path.join(temp, "source");
  const cloneRoot = path.join(temp, "snapshot");
  await initRepository(sourceRoot);
  await snapshotCommittedRepository({ sourceRoot, cloneRoot });
  const scenarioPath = path.join(cloneRoot, "eval", "scenario.json");
  await fs.mkdir(path.dirname(scenarioPath), { recursive: true });
  await fs.writeFile(scenarioPath, "{}\n");
  await commitScenarioAndBindCurrentMain({ cloneRoot, scenarioPath });
  const sourceBefore = await captureRepositoryState(sourceRoot);
  const cloneBefore = await captureRepositoryState(cloneRoot);
  await assertRepositoryStateUnchanged(
    sourceBefore,
    await captureRepositoryState(sourceRoot),
    "source dry-run",
  );
  await assertRepositoryStateUnchanged(
    cloneBefore,
    await captureRepositoryState(cloneRoot),
    "clone dry-run",
  );
  await fs.writeFile(path.join(cloneRoot, "promotion-write.txt"), "bad\n");
  await assert.rejects(
    () =>
      assertRepositoryStateUnchanged(
        cloneBefore,
        captureRepositoryState(cloneRoot),
        "promotion dry-run",
      ),
    /promotion dry-run.*changed/i,
  );
});
