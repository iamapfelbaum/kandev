import { assertValidScenario } from "./scenario.mjs";

const BUILTIN_RUNTIME = deepFreeze({
  contract: "kandev-highlight-runtime-v1",
  version: 1,
  id: "kandev-isolated-e2e",
  host: "playwright-isolated-e2e",
  profiles: ["desktop", "native-mobile"],
  seedRecipes: [
    {
      id: "kandev.highlight.quick-start",
      parameterKeys: [],
    },
  ],
  routes: ["workspace.board"],
  primitiveIds: [],
  scannerCoverage: {
    metadata: true,
    visibleDomText: true,
    browserConsole: true,
    runtimeLogs: false,
    renderedPixelOcr: false,
  },
  scenarioTemplate: "scripts/highlights/examples/quick-start.scenario.json",
});

export const BUILTIN_HIGHLIGHT_RUNTIME_ID = BUILTIN_RUNTIME.id;

const RUNTIMES = new Map([[BUILTIN_RUNTIME.id, BUILTIN_RUNTIME]]);

export function listHighlightRuntimeIds() {
  return [...RUNTIMES.keys()];
}

export function resolveHighlightRuntime(runtimeId) {
  const runtime = RUNTIMES.get(runtimeId);
  if (!runtime) {
    throw new Error(
      `unknown Highlight runtime '${String(runtimeId)}'; available runtimes: ${listHighlightRuntimeIds().join(", ")}`,
    );
  }
  return runtime;
}

export function preflightHighlightRuntime({ runtimeId, scenario } = {}) {
  const runtime = resolveHighlightRuntime(runtimeId);
  if (!isPlainObject(scenario)) {
    throw new Error("Highlight runtime preflight scenario must be a JSON object");
  }

  const profile = scenario.profile?.kind;
  if (!runtime.profiles.includes(profile)) {
    throw new Error(
      `profile '${String(profile)}' is not registered for Highlight runtime '${runtime.id}'`,
    );
  }

  const seedRecipe = scenario.seed?.recipe;
  const seedBinding = runtime.seedRecipes.find((recipe) => recipe.id === seedRecipe);
  if (!seedBinding) {
    throw new Error(
      `seed recipe '${String(seedRecipe)}' is not registered for Highlight runtime '${runtime.id}'`,
    );
  }
  const parameters = scenario.seed?.parameters ?? {};
  if (!isPlainObject(parameters)) {
    throw new Error("Highlight runtime seed parameters must be a JSON object");
  }
  for (const parameter of Object.keys(parameters)) {
    if (!seedBinding.parameterKeys.includes(parameter)) {
      throw new Error(
        `seed parameter '${parameter}' is not registered for recipe '${seedBinding.id}'`,
      );
    }
  }

  const route = scenario.setup?.route;
  if (typeof route !== "string" || !runtime.routes.includes(route)) {
    throw new Error(
      `route '${String(route)}' is not registered for Highlight runtime '${runtime.id}'`,
    );
  }

  const primitiveIds = collectPrimitiveIds(scenario);
  for (const primitiveId of primitiveIds) {
    if (!runtime.primitiveIds.includes(primitiveId)) {
      throw new Error(
        `primitive '${primitiveId}' is not registered for Highlight runtime '${runtime.id}'`,
      );
    }
  }
  assertValidScenario(scenario, { allowedExtensionIds: runtime.primitiveIds });

  return {
    contract: "kandev-highlight-runtime-preflight-v1",
    runtimeId: runtime.id,
    profile,
    seedRecipe: seedBinding.id,
    route,
    primitiveIds,
    scannerCoverage: runtime.scannerCoverage,
  };
}

function collectPrimitiveIds(scenario) {
  const setupPrimitives = Array.isArray(scenario.setup?.primitives)
    ? scenario.setup.primitives
    : [];
  const actions = Array.isArray(scenario.story?.actions)
    ? scenario.story.actions
    : [];
  return [
    ...setupPrimitives.map((primitive) => primitive?.primitiveId),
    ...actions
      .filter((action) => action?.kind === "extension")
      .map((action) => action?.primitiveId),
  ].filter((primitiveId) => typeof primitiveId === "string");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function isPlainObject(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}
