import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { clearInheritedTrustedSource } from "./pipeline-eval-orchestrator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRUSTED_SOURCE_KEY = "KANDEV_HIGHLIGHT_TRUSTED_SOURCE_SHA";

test("trusted source input is absent until the exact eval commit exists", () => {
  const inherited = { [TRUSTED_SOURCE_KEY]: "f".repeat(40), SAFE: "kept" };
  const environment = clearInheritedTrustedSource(inherited);
  assert.deepEqual(environment, { SAFE: "kept" });
  assert.equal(inherited[TRUSTED_SOURCE_KEY], "f".repeat(40));
});

test("eval never creates or defaults trusted source authorization", async () => {
  const source = await fs.readFile(path.join(HERE, "pipeline-eval-orchestrator.mjs"), "utf8");
  assert.doesNotMatch(source, /authorizeTrustedSource|environment\[TRUSTED_SOURCE_KEY\]\s*=/);
  assert.match(source, /clearInheritedTrustedSource/);
  assert.doesNotMatch(source, /commitScenarioAndBindCurrentMain|--source["'],\s*["']current_main/);
});

test("orchestrator re-verifies ignored dependencies after both runs and dry-runs", async () => {
  const source = await fs.readFile(path.join(HERE, "pipeline-eval-orchestrator.mjs"), "utf8");
  assert.match(
    source,
    /executeCaptureRuns\(context[\s\S]*executeDryRuns\(context[\s\S]*verifyFrozenOfflineDependencies\(context\.dependencyInstall\)/,
  );
  assert.match(source, /dependencyVerification/);
});

test("fresh-agent eval selects only the closed host Chromium sandbox policy", async () => {
  const source = await fs.readFile(path.join(HERE, "pipeline-eval-orchestrator.mjs"), "utf8");
  assert.match(source, /environment\.KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX\s*=\s*"auto"/);
  assert.doesNotMatch(
    source,
    /CHROMIUM_(?:ARGS|FLAGS)|BROWSER_(?:ARGS|FLAGS)|--disable-web-security/,
  );
});
