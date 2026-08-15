import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const EVAL_MODULES = [
  "run-pipeline-integration.mjs",
  "pipeline-eval-shared.mjs",
  "pipeline-eval-scenario.mjs",
  "pipeline-eval-commands.mjs",
  "pipeline-eval-repository.mjs",
  "pipeline-eval-evidence.mjs",
  "pipeline-eval-artifacts.mjs",
  "pipeline-eval-visual.mjs",
  "pipeline-eval-orchestrator.mjs",
];

async function sourceLines(relative) {
  const source = await fs.readFile(path.join(HERE, relative), "utf8");
  return { source, lines: source.split("\n").length };
}

test("pipeline eval is split into strict focused modules with a small stable facade", async () => {
  const inlineDisable = ["eslint", "disable"].join("-");
  for (const relative of EVAL_MODULES) {
    const { source, lines } = await sourceLines(relative);
    assert.ok(lines <= 600, `${relative} has ${lines} lines; maximum is 600`);
    assert.equal(source.includes(inlineDisable), false);
  }
  const facade = await sourceLines("run-pipeline-integration.mjs");
  assert.ok(facade.lines <= 150, `facade has ${facade.lines} lines; maximum is 150`);

  const entries = await fs.readdir(HERE);
  const tests = entries.filter(
    (entry) =>
      entry === "run-pipeline-integration.test.mjs" || /^pipeline-eval-.*\.test\.mjs$/.test(entry),
  );
  for (const relative of tests) {
    const { source, lines } = await sourceLines(relative);
    assert.ok(lines <= 600, `${relative} has ${lines} lines; maximum is 600`);
    assert.equal(source.includes(inlineDisable), false);
  }
});

test("package and commit hooks enforce the shared strict eval and sandbox lint gate", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(REPO_ROOT, "apps/web/package.json"), "utf8"),
  );
  const lint = packageJson.scripts["lint:highlight-eval"];
  assert.match(lint, /--no-ignore/);
  assert.match(lint, /--no-inline-config/);
  assert.match(lint, /--max-warnings(?:=|\s+)0/);
  assert.match(lint, /run-pipeline-integration/);
  assert.match(lint, /pipeline-eval/);
  assert.match(lint, /chromium-sandbox/);
  assert.match(lint, /capture-origin-isolation/);

  const hooks = await fs.readFile(path.join(REPO_ROOT, ".pre-commit-config.yaml"), "utf8");
  assert.match(hooks, /id:\s*highlight-eval-lint/);
  assert.match(hooks, /pnpm run lint:highlight-eval/);
  const hookBlock = /id:\s*highlight-eval-lint[\s\S]*?files:\s*([^\n]+)/.exec(hooks);
  assert.ok(hookBlock, "strict lint hook must declare a files matcher");
  const matcher = new RegExp(hookBlock[1]);
  for (const guardedPath of [
    ".pre-commit-config.yaml",
    "apps/web/package.json",
    "apps/web/eslint.config.mjs",
    "apps/web/e2e/highlights/pipeline-eval-shared.mjs",
    "scripts/highlights/chromium-sandbox.mjs",
    "scripts/highlights/capture-origin-isolation.mjs",
  ]) {
    assert.match(guardedPath, matcher);
  }
});
