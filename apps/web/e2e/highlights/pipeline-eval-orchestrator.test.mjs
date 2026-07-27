import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_QUICK_START_EVAL_DURATION_MS,
  clearInheritedTrustedSource,
  configuredToolchainEnvironment,
} from "./pipeline-eval-orchestrator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRUSTED_SOURCE_KEY = "KANDEV_HIGHLIGHT_TRUSTED_SOURCE_SHA";
const ORCHESTRATOR_FILE = "pipeline-eval-orchestrator.mjs";

test("trusted source input is absent until the exact eval commit exists", () => {
  const inherited = { [TRUSTED_SOURCE_KEY]: "f".repeat(40), SAFE: "kept" };
  const environment = clearInheritedTrustedSource(inherited);
  assert.deepEqual(environment, { SAFE: "kept" });
  assert.equal(inherited[TRUSTED_SOURCE_KEY], "f".repeat(40));
});

test("toolchain discovery probes and preserves the request-bound writable Go cache", async () => {
  const privateGoCache = "/kandev/eval/go-mod-cache";
  const privateBuildCache = "/kandev/eval/go-build-cache";
  const calls = [];
  const environment = await configuredToolchainEnvironment(
    {
      GOMODCACHE: privateGoCache,
      GOCACHE: privateBuildCache,
      SAFE: "kept",
    },
    { GOROOT: "/kandev/toolchain/go" },
    async (specification) => {
      calls.push(specification);
      return {
        stdout: ["/ambient/go-build", "/kandev/toolchain/go-mod", "/ambient/go"].join("\n"),
      };
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.GOMODCACHE, privateGoCache);
  assert.equal(calls[0].env.GOCACHE, privateBuildCache);
  assert.equal(environment.GOMODCACHE, privateGoCache);
  assert.equal(environment.GOCACHE, privateBuildCache);
  assert.equal(environment.GOPATH, "/ambient/go");
  assert.equal(environment.SAFE, "kept");
});

test("eval never creates or defaults trusted source authorization", async () => {
  const source = await fs.readFile(path.join(HERE, ORCHESTRATOR_FILE), "utf8");
  assert.doesNotMatch(source, /authorizeTrustedSource|environment\[TRUSTED_SOURCE_KEY\]\s*=/);
  assert.match(source, /clearInheritedTrustedSource/);
  assert.doesNotMatch(source, /commitScenarioAndBindCurrentMain|--source["'],\s*["']current_main/);
});

test("orchestrator re-verifies ignored dependencies after both runs and dry-runs", async () => {
  const source = await fs.readFile(path.join(HERE, ORCHESTRATOR_FILE), "utf8");
  assert.match(
    source,
    /executeCaptureRuns\(context[\s\S]*executeDryRuns\(context[\s\S]*verifyFrozenOfflineDependencies\(context\.dependencyInstall\)/,
  );
  assert.match(source, /dependencyVerification/);
});

test("Docker runtime gate runs after isolated setup and before first capture", async () => {
  const source = await fs.readFile(path.join(HERE, ORCHESTRATOR_FILE), "utf8");
  assert.match(
    source,
    /setupEvaluation\(input\)[\s\S]*input\.beforeCapture\(context\)[\s\S]*executeCaptureRuns\(context/,
  );
});

test("fresh-agent eval keeps the budgeted quick-start story under five seconds", async () => {
  assert.equal(MAX_QUICK_START_EVAL_DURATION_MS, 5_000);
  const source = await fs.readFile(path.join(HERE, ORCHESTRATOR_FILE), "utf8");
  assert.match(source, /storyboardTimeline\.totalDurationMs > MAX_QUICK_START_EVAL_DURATION_MS/);
});

test("fresh-agent eval selects only the closed host Chromium sandbox policy", async () => {
  const source = await fs.readFile(path.join(HERE, ORCHESTRATOR_FILE), "utf8");
  assert.match(source, /environment\.KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX\s*=\s*"auto"/);
  assert.doesNotMatch(
    source,
    /CHROMIUM_(?:ARGS|FLAGS)|BROWSER_(?:ARGS|FLAGS)|--disable-web-security/,
  );
});
