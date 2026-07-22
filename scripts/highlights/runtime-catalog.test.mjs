import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const runtimeModule = () => import("./runtime-catalog.mjs");

async function quickStartScenario() {
  return JSON.parse(
    await fs.readFile(
      new URL("./examples/quick-start.scenario.json", import.meta.url),
      "utf8",
    ),
  );
}

test("catalog exposes one deeply immutable built-in runtime", async () => {
  const {
    BUILTIN_HIGHLIGHT_RUNTIME_ID,
    listHighlightRuntimeIds,
    resolveHighlightRuntime,
  } = await runtimeModule();

  assert.equal(BUILTIN_HIGHLIGHT_RUNTIME_ID, "kandev-isolated-e2e");
  assert.deepEqual(listHighlightRuntimeIds(), ["kandev-isolated-e2e"]);
  const runtime = resolveHighlightRuntime(BUILTIN_HIGHLIGHT_RUNTIME_ID);
  assert.deepEqual(Object.keys(runtime).sort(), [
    "contract",
    "host",
    "id",
    "primitiveIds",
    "profiles",
    "routes",
    "scannerCoverage",
    "scenarioTemplate",
    "seedRecipes",
    "version",
  ]);
  assert.deepEqual(runtime, {
    contract: "kandev-highlight-runtime-v1",
    version: 1,
    id: "kandev-isolated-e2e",
    host: "playwright-isolated-e2e",
    profiles: ["desktop", "native-mobile"],
    seedRecipes: [
      { id: "kandev.highlight.quick-start", parameterKeys: [] },
    ],
    routes: ["workspace.board"],
    primitiveIds: [],
    scannerCoverage: {
      metadata: true,
      visibleDomText: true,
      browserConsole: true,
      runtimeLogs: true,
      renderedPixelOcr: false,
    },
    scenarioTemplate: "scripts/highlights/examples/quick-start.scenario.json",
  });
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.seedRecipes[0]), true);
  assert.throws(() => runtime.profiles.push("custom"), /read only|not extensible/i);
});

test("runtime lookup rejects unknown IDs and path or module injection", async () => {
  const { resolveHighlightRuntime } = await runtimeModule();
  for (const runtimeId of [
    "unknown",
    "../runtime.mjs",
    "/tmp/runtime.mjs",
    "file:///tmp/runtime.mjs",
    "node:child_process",
    "kandev-isolated-e2e;sh",
  ]) {
    assert.throws(
      () => resolveHighlightRuntime(runtimeId),
      /unknown Highlight runtime.*kandev-isolated-e2e/i,
    );
  }
});

test("runtime preflight accepts only registered declarative bindings", async () => {
  const { preflightHighlightRuntime } = await runtimeModule();
  const scenario = await quickStartScenario();
  const result = preflightHighlightRuntime({
    runtimeId: "kandev-isolated-e2e",
    scenario,
  });

  assert.deepEqual(result, {
    contract: "kandev-highlight-runtime-preflight-v1",
    runtimeId: "kandev-isolated-e2e",
    profile: "desktop",
    seedRecipe: "kandev.highlight.quick-start",
    route: "workspace.board",
    primitiveIds: [],
    scannerCoverage: {
      metadata: true,
      visibleDomText: true,
      browserConsole: true,
      runtimeLogs: true,
      renderedPixelOcr: false,
    },
  });

  assert.throws(
    () =>
      preflightHighlightRuntime({
        runtimeId: "kandev-isolated-e2e",
        scenario: {
          ...scenario,
          seed: { recipe: "custom.shell", parameters: {} },
        },
      }),
    /seed recipe 'custom\.shell'.*not registered/i,
  );
  assert.throws(
    () =>
      preflightHighlightRuntime({
        runtimeId: "kandev-isolated-e2e",
        scenario: {
          ...scenario,
          setup: { ...scenario.setup, route: "raw.javascript" },
        },
      }),
    /route 'raw\.javascript'.*not registered/i,
  );
  assert.throws(
    () =>
      preflightHighlightRuntime({
        runtimeId: "kandev-isolated-e2e",
        scenario: {
          ...scenario,
          setup: {
            ...scenario.setup,
            primitives: [{ primitiveId: "custom.exec", input: {} }],
          },
        },
      }),
    /primitive 'custom\.exec'.*not registered/i,
  );
});

test("runtime preflight rejects undeclared seed parameters and malformed scenarios", async () => {
  const { preflightHighlightRuntime } = await runtimeModule();
  const scenario = await quickStartScenario();
  assert.throws(
    () =>
      preflightHighlightRuntime({
        runtimeId: "kandev-isolated-e2e",
        scenario: {
          ...scenario,
          seed: {
            ...scenario.seed,
            parameters: { arbitraryModule: "./capture.mjs" },
          },
        },
      }),
    /seed parameter 'arbitraryModule'.*not registered/i,
  );
  assert.throws(
    () =>
      preflightHighlightRuntime({
        runtimeId: "kandev-isolated-e2e",
        scenario: null,
      }),
    /scenario.*object/i,
  );
  assert.throws(
    () =>
      preflightHighlightRuntime({
        runtimeId: "kandev-isolated-e2e",
        scenario: { ...scenario, story: null },
      }),
    /Invalid Highlight scenario.*\/story/s,
  );
});

test("runtime declarations expose only typed catalog and preflight APIs", async () => {
  const declarations = await fs.readFile(
    new URL("./runtime-catalog.d.ts", import.meta.url),
    "utf8",
  );
  assert.match(declarations, /"kandev-isolated-e2e"/);
  assert.match(declarations, /preflightHighlightRuntime/);
  assert.match(declarations, /renderedPixelOcr: false/);
  assert.doesNotMatch(declarations, /modulePath|shellCommand|javascript/i);
});
