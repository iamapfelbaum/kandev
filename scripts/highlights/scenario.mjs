import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const SCENARIO_SCHEMA_VERSION = 1;
export const SCENARIO_SCHEMA_ID = "https://kandev.com/schemas/highlight-scenario-v1.json";
export const MAX_STORY_DURATION_MS = 15_000;

const PROFILE_KINDS = new Set(["desktop", "native-mobile"]);
const ACTION_KINDS = new Set([
  "click",
  "type",
  "press",
  "hover",
  "moveCursor",
  "waitForVisible",
  "waitForState",
  "drag",
  "pause",
  "cameraFocus",
  "cameraZoom",
  "cameraHold",
  "cameraReturn",
  "extension",
]);
const CAMERA_KINDS = new Set(["cameraFocus", "cameraZoom", "cameraHold", "cameraReturn"]);
const WAIT_STATES = new Set([
  "attached",
  "detached",
  "visible",
  "hidden",
  "enabled",
  "disabled",
  "checked",
  "unchecked",
]);
const EASINGS = new Set(["linear", "easeInOutCubic", "easeOutCubic"]);
const ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const TEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

const ACTION_KEYS = {
  click: ["kind", "target", "button", "clickCount", "cursorDurationMs", "label", "settleMs"],
  type: ["kind", "target", "text", "clear", "keystrokeDelayMs", "cursorDurationMs", "label", "settleMs"],
  press: ["kind", "target", "key", "label", "settleMs"],
  hover: ["kind", "target", "durationMs", "label", "settleMs"],
  moveCursor: ["kind", "target", "durationMs", "easing", "label", "settleMs"],
  waitForVisible: ["kind", "target", "timeoutMs", "label", "settleMs"],
  waitForState: ["kind", "target", "state", "timeoutMs", "label", "settleMs"],
  drag: ["kind", "from", "to", "approachDurationMs", "durationMs", "label", "settleMs"],
  pause: ["kind", "durationMs", "label"],
  cameraFocus: ["kind", "target", "durationMs", "label", "settleMs"],
  cameraZoom: ["kind", "zoom", "durationMs", "label", "settleMs"],
  cameraHold: ["kind", "durationMs", "label"],
  cameraReturn: ["kind", "durationMs", "label", "settleMs"],
  extension: ["kind", "primitiveId", "input", "durationMs", "label", "settleMs"],
};

export class ScenarioValidationError extends Error {
  constructor(errors, filePath) {
    const prefix = filePath ? `Invalid Highlight scenario ${filePath}` : "Invalid Highlight scenario";
    super(`${prefix}:\n${errors.map((error) => `- ${error.pointer || "/"}: ${error.message}`).join("\n")}`);
    this.name = "ScenarioValidationError";
    this.errors = errors;
    this.filePath = filePath;
  }
}

/**
 * Strict zero-dependency validation for schema v1.
 *
 * @param {unknown} scenario
 * @param {{allowedExtensionIds?: Iterable<string>}} options
 * @returns {{ok: boolean, errors: Array<{pointer: string, message: string}>}}
 */
export function validateScenario(scenario, { allowedExtensionIds = [] } = {}) {
  const errors = [];
  const allowedExtensions = new Set(allowedExtensionIds);
  if (!isPlainObject(scenario)) {
    addError(errors, "", "must be a JSON object");
    return { ok: false, errors };
  }

  rejectUnknownKeys(scenario, ["$schema", "schemaVersion", "id", "title", "description", "profile", "seed", "setup", "story", "camera"], "", errors);
  if (scenario.$schema !== undefined) stringValue(scenario.$schema, "/$schema", errors, { min: 1, max: 240 });
  if (scenario.schemaVersion !== SCENARIO_SCHEMA_VERSION) addError(errors, "/schemaVersion", `must equal ${SCENARIO_SCHEMA_VERSION}`);
  idValue(scenario.id, "/id", errors);
  stringValue(scenario.title, "/title", errors, { min: 1, max: 120 });
  if (scenario.description !== undefined) stringValue(scenario.description, "/description", errors, { min: 1, max: 500 });
  validateProfile(scenario.profile, errors);
  validateSeed(scenario.seed, errors);
  validateSetup(scenario.setup, allowedExtensions, errors);
  validateStory(scenario.story, scenario.camera, allowedExtensions, errors);
  if (scenario.camera !== undefined) validateCamera(scenario.camera, scenario.profile, errors);

  if (errors.length === 0) {
    const duration = estimateStoryDuration(scenario.story);
    if (duration > MAX_STORY_DURATION_MS) {
      addError(errors, "/story", `planned duration ${duration}ms exceeds ${MAX_STORY_DURATION_MS}ms Highlight limit`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function assertValidScenario(scenario, options = {}) {
  const result = validateScenario(scenario, options);
  if (!result.ok) throw new ScenarioValidationError(result.errors, options.filePath);
  return scenario;
}

export async function readScenario(filePath, options = {}) {
  const absolute = path.resolve(filePath);
  let scenario;
  try {
    scenario = JSON.parse(await fs.readFile(absolute, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read Highlight scenario ${absolute}: ${error.message}`);
  }
  return assertValidScenario(scenario, { ...options, filePath: absolute });
}

export function canonicalScenarioJson(scenario, options = {}) {
  assertValidScenario(scenario, options);
  return canonicalJson(scenario);
}

export function computeScenarioDigest(scenario, options = {}) {
  return `sha256:${createHash("sha256").update(canonicalScenarioJson(scenario, options)).digest("hex")}`;
}

export function compileTimeline(scenario, options = {}) {
  assertValidScenario(scenario, options);
  const events = [];
  let cursorMs = 0;
  const append = ({ kind, durationMs, sourcePointer, intent, movesCursor = false, controlsCamera = false, settleMs = 0, cursorDurationMs = 0, activationDurationMs = 0, approachDurationMs = 0 }) => {
    const actionDurationMs = durationMs;
    const totalDurationMs = actionDurationMs + settleMs;
    const event = {
      index: events.length,
      kind,
      sourcePointer,
      startMs: cursorMs,
      endMs: cursorMs + totalDurationMs,
      durationMs: totalDurationMs,
      actionDurationMs,
      settleMs,
      movesCursor,
      controlsCamera,
      cursorDurationMs,
      activationDurationMs,
      approachDurationMs,
      intent,
    };
    events.push(event);
    cursorMs = event.endMs;
  };

  append({
    kind: "openingSettle",
    durationMs: scenario.story.openingSettleMs,
    sourcePointer: "/story/openingSettleMs",
    intent: "Hold opening frame until UI is settled",
  });
  scenario.story.actions.forEach((action, index) => {
    const timing = actionTiming(action);
    append({
      kind: action.kind,
      durationMs: timing.durationMs,
      sourcePointer: `/story/actions/${index}`,
      intent: action.label ?? describeAction(action),
      movesCursor: ["click", "type", "hover", "moveCursor", "drag"].includes(action.kind),
      controlsCamera: CAMERA_KINDS.has(action.kind),
      settleMs: action.settleMs ?? 0,
      cursorDurationMs: timing.cursorDurationMs,
      activationDurationMs: timing.activationDurationMs,
      approachDurationMs: timing.approachDurationMs,
    });
  });
  append({
    kind: "endingSettle",
    durationMs: scenario.story.endingSettleMs,
    sourcePointer: "/story/endingSettleMs",
    intent: "Hold final frame until UI and camera are settled",
  });

  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    scenarioId: scenario.id,
    title: scenario.title,
    profile: scenario.profile.kind,
    viewport: { ...scenario.profile.viewport },
    storyRecipe: scenario.story.recipe ?? null,
    setup: structuredClone(scenario.setup),
    recordingStartsAfterSetup: true,
    initialCameraZoom: 1,
    scenarioDigest: computeScenarioDigest(scenario, options),
    totalDurationMs: cursorMs,
    events,
  };
}

export function renderStoryboard(timeline, { format = "markdown" } = {}) {
  if (format === "json") return `${JSON.stringify(timeline, null, 2)}\n`;
  if (format !== "markdown") throw new Error(`unsupported storyboard format: ${format}`);
  const rows = timeline.events.map((event) =>
    `| ${formatSeconds(event.startMs)} | ${formatSeconds(event.endMs)} | ${escapeCell(event.kind)} | ${escapeCell(event.intent)} |`,
  );
  return [
    `# Storyboard: ${timeline.title}`,
    "",
    `- Scenario: \`${timeline.scenarioId}\``,
    `- Profile: \`${timeline.profile}\` (${timeline.viewport.width}x${timeline.viewport.height})`,
    `- Planned duration: ${formatSeconds(timeline.totalDurationMs)}`,
    `- Scenario digest: \`${timeline.scenarioDigest}\``,
    "- Initial camera zoom: `1` (no implicit zoom)",
    "",
    "| Start | End | Kind | Intent |",
    "|---:|---:|---|---|",
    ...rows,
    "",
  ].join("\n");
}

export function createScenarioScaffold({ id, title, profileKind = "desktop" } = {}) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error("scenario id must be lowercase dotted/kebab identifier");
  if (!PROFILE_KINDS.has(profileKind)) throw new Error("profile must be desktop or native-mobile");
  const nativeMobile = profileKind === "native-mobile";
  const scenario = {
    $schema: SCENARIO_SCHEMA_ID,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id,
    title: title ?? titleFromId(id),
    profile: {
      kind: profileKind,
      viewport: nativeMobile ? { width: 430, height: 932 } : { width: 1920, height: 1200 },
      deviceScaleFactor: nativeMobile ? 3 : 2,
    },
    seed: {
      recipe: "kandev.empty-workspace",
      parameters: {},
    },
    setup: {
      route: "workspace.board",
      primitives: [],
    },
    story: {
      recipe: "kandev.short-feature",
      openingSettleMs: 600,
      actions: [
        { kind: "moveCursor", target: { testId: "replace-with-stable-test-id" }, durationMs: 350 },
        { kind: "click", target: { testId: "replace-with-stable-test-id" }, settleMs: 200 },
        { kind: "pause", durationMs: 500, label: "Show completed state" },
      ],
      endingSettleMs: 700,
    },
  };
  return assertValidScenario(scenario);
}

export async function writeScenarioScaffold({ destination, id, title, profileKind = "desktop", dryRun = false } = {}) {
  if (!destination) throw new Error("scaffold destination is required");
  const absolute = path.resolve(destination);
  const scenario = createScenarioScaffold({ id, title, profileKind });
  const contents = `${JSON.stringify(scenario, null, 2)}\n`;
  if (!dryRun) {
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    try {
      await fs.writeFile(absolute, contents, { flag: "wx" });
    } catch (error) {
      if (error.code === "EEXIST") throw new Error(`refusing to overwrite existing scenario: ${absolute}`);
      throw error;
    }
  }
  return { destination: absolute, dryRun, scenario, contents };
}

function validateProfile(profile, errors) {
  if (!objectValue(profile, "/profile", errors)) return;
  rejectUnknownKeys(profile, ["kind", "viewport", "deviceScaleFactor"], "/profile", errors);
  if (!PROFILE_KINDS.has(profile.kind)) addError(errors, "/profile/kind", "must be desktop or native-mobile");
  if (objectValue(profile.viewport, "/profile/viewport", errors)) {
    rejectUnknownKeys(profile.viewport, ["width", "height"], "/profile/viewport", errors);
    integerValue(profile.viewport.width, "/profile/viewport/width", errors, 320, 3840);
    integerValue(profile.viewport.height, "/profile/viewport/height", errors, 568, 3200);
    if (profile.kind === "desktop" && (profile.viewport.width !== 1920 || profile.viewport.height !== 1200)) {
      addError(errors, "/profile/viewport", "desktop production profile must be 1920x1200 CSS pixels (3840x2400 source at DPR2)");
    }
    if (profile.kind === "native-mobile" && (profile.viewport.width !== 430 || profile.viewport.height !== 932)) {
      addError(errors, "/profile/viewport", "native-mobile production profile must be portrait 430x932 CSS pixels (1290x2796 source at DPR3); never crop desktop capture");
    }
  }
  numberValue(profile.deviceScaleFactor, "/profile/deviceScaleFactor", errors, 1, 4);
  if (profile.kind === "desktop" && profile.deviceScaleFactor !== 2) addError(errors, "/profile/deviceScaleFactor", "desktop production profile must use DPR2");
  if (profile.kind === "native-mobile" && profile.deviceScaleFactor !== 3) addError(errors, "/profile/deviceScaleFactor", "native-mobile production profile must use DPR3");
}

function validateSeed(seed, errors) {
  if (!objectValue(seed, "/seed", errors)) return;
  rejectUnknownKeys(seed, ["recipe", "parameters"], "/seed", errors);
  idValue(seed.recipe, "/seed/recipe", errors);
  if (seed.parameters !== undefined) {
    if (!objectValue(seed.parameters, "/seed/parameters", errors)) return;
    validateJsonValue(seed.parameters, "/seed/parameters", errors);
  }
}

function validateSetup(setup, allowedExtensions, errors) {
  if (!objectValue(setup, "/setup", errors)) return;
  rejectUnknownKeys(setup, ["route", "primitives"], "/setup", errors);
  if (setup.route !== undefined) idValue(setup.route, "/setup/route", errors);
  if (!Array.isArray(setup.primitives)) {
    addError(errors, "/setup/primitives", "must be an array");
    return;
  }
  if (setup.primitives.length > 20) addError(errors, "/setup/primitives", "must contain at most 20 setup primitives");
  setup.primitives.forEach((primitive, index) => {
    const pointer = `/setup/primitives/${index}`;
    if (!objectValue(primitive, pointer, errors)) return;
    rejectUnknownKeys(primitive, ["primitiveId", "input"], pointer, errors);
    validatePrimitive(primitive, pointer, allowedExtensions, errors);
  });
}

function validateStory(story, camera, allowedExtensions, errors) {
  if (!objectValue(story, "/story", errors)) return;
  rejectUnknownKeys(story, ["recipe", "openingSettleMs", "actions", "endingSettleMs"], "/story", errors);
  if (story.recipe !== undefined) idValue(story.recipe, "/story/recipe", errors);
  integerValue(story.openingSettleMs, "/story/openingSettleMs", errors, 400, 5000);
  integerValue(story.endingSettleMs, "/story/endingSettleMs", errors, 400, 5000);
  if (!Array.isArray(story.actions)) {
    addError(errors, "/story/actions", "must be an array");
    return;
  }
  if (story.actions.length < 1 || story.actions.length > 100) addError(errors, "/story/actions", "must contain 1-100 actions");
  story.actions.forEach((action, index) => validateAction(action, index, camera, allowedExtensions, errors));
}

function validateAction(action, index, camera, allowedExtensions, errors) {
  const pointer = `/story/actions/${index}`;
  if (!objectValue(action, pointer, errors)) return;
  const kind = action.kind;
  if (typeof kind !== "string" || !ACTION_KINDS.has(kind)) {
    addError(errors, `${pointer}/kind`, `unsupported action kind; expected one of ${[...ACTION_KINDS].join(", ")}`);
    rejectUnknownKeys(action, ["kind"], pointer, errors);
    return;
  }
  rejectUnknownKeys(action, ACTION_KEYS[kind], pointer, errors);
  if (action.label !== undefined) stringValue(action.label, `${pointer}/label`, errors, { min: 1, max: 160 });
  if (action.settleMs !== undefined) integerValue(action.settleMs, `${pointer}/settleMs`, errors, 0, 5000);

  if (["click", "type", "press", "hover", "moveCursor", "waitForVisible", "waitForState", "cameraFocus"].includes(kind)) {
    validateTarget(action.target, `${pointer}/target`, errors);
  }
  if (kind === "drag") {
    validateTarget(action.from, `${pointer}/from`, errors);
    validateTarget(action.to, `${pointer}/to`, errors);
  }
  if (kind === "click") {
    if (action.button !== undefined && !["left", "middle", "right"].includes(action.button)) addError(errors, `${pointer}/button`, "must be left, middle, or right");
    if (action.clickCount !== undefined) integerValue(action.clickCount, `${pointer}/clickCount`, errors, 1, 3);
    if (action.cursorDurationMs !== undefined) integerValue(action.cursorDurationMs, `${pointer}/cursorDurationMs`, errors, 50, 5000);
  } else if (kind === "type") {
    stringValue(action.text, `${pointer}/text`, errors, { min: 1, max: 1000 });
    if (action.clear !== undefined && typeof action.clear !== "boolean") addError(errors, `${pointer}/clear`, "must be a boolean");
    if (action.keystrokeDelayMs !== undefined) integerValue(action.keystrokeDelayMs, `${pointer}/keystrokeDelayMs`, errors, 0, 250);
    if (action.cursorDurationMs !== undefined) integerValue(action.cursorDurationMs, `${pointer}/cursorDurationMs`, errors, 50, 5000);
  } else if (kind === "press") {
    stringValue(action.key, `${pointer}/key`, errors, { min: 1, max: 64 });
  } else if (["hover", "moveCursor"].includes(kind)) {
    if (action.durationMs !== undefined) integerValue(action.durationMs, `${pointer}/durationMs`, errors, 50, 5000);
    if (action.easing !== undefined && !EASINGS.has(action.easing)) addError(errors, `${pointer}/easing`, "must be a supported easing");
  } else if (["waitForVisible", "waitForState"].includes(kind)) {
    if (action.timeoutMs !== undefined) integerValue(action.timeoutMs, `${pointer}/timeoutMs`, errors, 100, 10_000);
    if (kind === "waitForState" && !WAIT_STATES.has(action.state)) addError(errors, `${pointer}/state`, `must be one of ${[...WAIT_STATES].join(", ")}`);
  } else if (kind === "drag") {
    if (action.approachDurationMs !== undefined) integerValue(action.approachDurationMs, `${pointer}/approachDurationMs`, errors, 50, 5000);
    if (action.durationMs !== undefined) integerValue(action.durationMs, `${pointer}/durationMs`, errors, 100, 5000);
  } else if (kind === "pause") {
    integerValue(action.durationMs, `${pointer}/durationMs`, errors, 50, 5000);
  } else if (kind === "cameraHold") {
    integerValue(action.durationMs, `${pointer}/durationMs`, errors, 240, 5000);
  } else if (CAMERA_KINDS.has(kind)) {
    if (!camera) addError(errors, pointer, "camera directive requires top-level camera bounds");
    if (kind === "cameraZoom" && action.zoom !== undefined) {
      numberValue(action.zoom, `${pointer}/zoom`, errors, 1, 3);
      if (camera && Number.isFinite(action.zoom) && (action.zoom < camera.minZoom || action.zoom > camera.maxZoom)) {
        addError(errors, `${pointer}/zoom`, `must stay inside camera bounds ${camera.minZoom}-${camera.maxZoom}`);
      }
    }
    if (kind === "cameraZoom" && action.zoom === undefined) addError(errors, `${pointer}/zoom`, "is required for explicit zoom");
    if (action.durationMs !== undefined) integerValue(action.durationMs, `${pointer}/durationMs`, errors, 1200, 5000);
  } else if (kind === "extension") {
    validatePrimitive(action, pointer, allowedExtensions, errors);
    if (action.durationMs !== undefined) integerValue(action.durationMs, `${pointer}/durationMs`, errors, 0, 5000);
  }
}

function validateTarget(target, pointer, errors) {
  if (!objectValue(target, pointer, errors)) return;
  const hasTestId = Object.hasOwn(target, "testId");
  const hasRole = Object.hasOwn(target, "role");
  const hasName = Object.hasOwn(target, "name");
  if (hasTestId && !hasRole && !hasName) {
    rejectUnknownKeys(target, ["testId"], pointer, errors);
    if (typeof target.testId !== "string" || !TEST_ID_PATTERN.test(target.testId) || target.testId.length > 128) {
      addError(errors, `${pointer}/testId`, "must be a stable testId");
    }
    return;
  }
  if (!hasTestId && hasRole && hasName) {
    rejectUnknownKeys(target, ["role", "name"], pointer, errors);
    if (typeof target.role !== "string" || !/^[a-z][a-z0-9-]{1,31}$/.test(target.role)) addError(errors, `${pointer}/role`, "must be a lowercase ARIA role");
    stringValue(target.name, `${pointer}/name`, errors, { min: 1, max: 160 });
    return;
  }
  addError(errors, pointer, "must contain exactly {testId} or {role, name}; CSS, XPath, and raw text selectors are not allowed");
  rejectUnknownKeys(target, ["testId", "role", "name", "exact"], pointer, errors);
}

function validateCamera(camera, profile, errors) {
  if (!objectValue(camera, "/camera", errors)) return;
  const keys = ["minZoom", "maxZoom", "safeMarginPx", "glyphPaddingPx", "maxPanVelocityPxPerSecond", "maxPanAccelerationPxPerSecond2", "maxZoomRatePerSecond", "easing"];
  rejectUnknownKeys(camera, keys, "/camera", errors);
  if (camera.minZoom !== 1) addError(errors, "/camera/minZoom", "must be identity zoom 1");
  const maxZoomCap = profile?.kind === "native-mobile" ? 1.18 : 1.5;
  numberValue(camera.maxZoom, "/camera/maxZoom", errors, 1, maxZoomCap);
  if (Number.isFinite(camera.minZoom) && Number.isFinite(camera.maxZoom) && camera.minZoom > camera.maxZoom) addError(errors, "/camera", "minZoom must not exceed maxZoom");
  integerValue(camera.safeMarginPx, "/camera/safeMarginPx", errors, 16, 240);
  integerValue(camera.glyphPaddingPx, "/camera/glyphPaddingPx", errors, 0, 64);
  if (Number.isFinite(camera.glyphPaddingPx) && Number.isFinite(camera.safeMarginPx) && camera.glyphPaddingPx > camera.safeMarginPx) addError(errors, "/camera/glyphPaddingPx", "must not exceed safeMarginPx");
  numberValue(camera.maxPanVelocityPxPerSecond, "/camera/maxPanVelocityPxPerSecond", errors, 100, 4000);
  numberValue(camera.maxPanAccelerationPxPerSecond2, "/camera/maxPanAccelerationPxPerSecond2", errors, 100, 12_000);
  numberValue(camera.maxZoomRatePerSecond, "/camera/maxZoomRatePerSecond", errors, 0.1, 2);
  if (!EASINGS.has(camera.easing)) addError(errors, "/camera/easing", `must be one of ${[...EASINGS].join(", ")}`);
}

function actionTiming(action) {
  switch (action.kind) {
    case "click": {
      const cursorDurationMs = action.cursorDurationMs ?? 350;
      const activationDurationMs = 120;
      return { durationMs: cursorDurationMs + activationDurationMs, cursorDurationMs, activationDurationMs, approachDurationMs: 0 };
    }
    case "type": {
      const cursorDurationMs = action.cursorDurationMs ?? 350;
      const activationDurationMs = 120;
      const typingDurationMs = Math.max(80, [...action.text].length * (action.keystrokeDelayMs ?? 35));
      return { durationMs: cursorDurationMs + activationDurationMs + typingDurationMs, cursorDurationMs, activationDurationMs, approachDurationMs: 0 };
    }
    case "press": return simpleTiming(80);
    case "hover": return cursorTiming(action.durationMs ?? 250);
    case "moveCursor": return cursorTiming(action.durationMs ?? 350);
    case "waitForVisible":
    case "waitForState": return simpleTiming(action.timeoutMs ?? 2000);
    case "drag": {
      const approachDurationMs = action.approachDurationMs ?? 350;
      const dragDurationMs = action.durationMs ?? 600;
      return { durationMs: approachDurationMs + dragDurationMs, cursorDurationMs: approachDurationMs + dragDurationMs, activationDurationMs: 0, approachDurationMs };
    }
    case "pause":
    case "cameraHold": return simpleTiming(action.durationMs);
    case "cameraFocus":
    case "cameraZoom":
    case "cameraReturn": return simpleTiming(action.durationMs ?? 1200);
    case "extension": return simpleTiming(action.durationMs ?? 250);
    default: return simpleTiming(0);
  }
}

function simpleTiming(durationMs) {
  return { durationMs, cursorDurationMs: 0, activationDurationMs: 0, approachDurationMs: 0 };
}

function cursorTiming(durationMs) {
  return { durationMs, cursorDurationMs: durationMs, activationDurationMs: 0, approachDurationMs: 0 };
}

function estimateStoryDuration(story) {
  return story.openingSettleMs + story.endingSettleMs + story.actions.reduce(
    (sum, action) => sum + actionTiming(action).durationMs + (action.settleMs ?? 0),
    0,
  );
}

function validatePrimitive(primitive, pointer, allowedExtensions, errors) {
  idValue(primitive.primitiveId, `${pointer}/primitiveId`, errors);
  if (typeof primitive.primitiveId === "string" && !allowedExtensions.has(primitive.primitiveId)) {
    addError(errors, `${pointer}/primitiveId`, "must appear in caller-provided extension allowlist");
  }
  if (primitive.input !== undefined && objectValue(primitive.input, `${pointer}/input`, errors)) {
    validateJsonValue(primitive.input, `${pointer}/input`, errors);
  }
}

function describeAction(action) {
  const target = action.target ? describeTarget(action.target) : null;
  switch (action.kind) {
    case "click": return `Click ${target}`;
    case "type": return `Type ${JSON.stringify(action.text)} into ${target}`;
    case "press": return `Press ${action.key} on ${target}`;
    case "hover": return `Hover ${target}`;
    case "moveCursor": return `Move cursor to ${target}`;
    case "waitForVisible": return `Wait for ${target} to be visible`;
    case "waitForState": return `Wait for ${target} to become ${action.state}`;
    case "drag": return `Drag ${describeTarget(action.from)} to ${describeTarget(action.to)}`;
    case "pause": return "Pause on current product state";
    case "cameraFocus": return `Focus camera on ${target} without changing zoom`;
    case "cameraZoom": return `Set camera zoom to ${action.zoom}x`;
    case "cameraHold": return "Hold camera position";
    case "cameraReturn": return "Return camera to settled origin at 1x";
    case "extension": return `Run allowlisted primitive ${action.primitiveId}`;
    default: return action.kind;
  }
}

function describeTarget(target) {
  return target.testId ? `testId:${target.testId}` : `${target.role}:${target.name}`;
}

function rejectUnknownKeys(value, allowed, pointer, errors) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) addError(errors, `${pointer}/${escapePointer(key)}`, "unknown property");
  }
}

function idValue(value, pointer, errors) {
  if (typeof value !== "string" || value.length > 128 || !ID_PATTERN.test(value)) addError(errors, pointer, "must be a lowercase dotted/kebab identifier");
}

function stringValue(value, pointer, errors, { min, max }) {
  if (typeof value !== "string" || value.length < min || value.length > max) addError(errors, pointer, `must be a string of ${min}-${max} characters`);
}

function integerValue(value, pointer, errors, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) addError(errors, pointer, `must be an integer from ${min} to ${max}`);
}

function numberValue(value, pointer, errors, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) addError(errors, pointer, `must be a finite number from ${min} to ${max}`);
}

function objectValue(value, pointer, errors) {
  if (!isPlainObject(value)) {
    addError(errors, pointer, "must be a JSON object");
    return false;
  }
  return true;
}

function validateJsonValue(value, pointer, errors) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) addError(errors, pointer, "must contain only finite JSON numbers");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonValue(item, `${pointer}/${index}`, errors));
    return;
  }
  if (isPlainObject(value)) {
    Object.entries(value).forEach(([key, item]) => validateJsonValue(item, `${pointer}/${escapePointer(key)}`, errors));
    return;
  }
  addError(errors, pointer, "must contain JSON values only");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function addError(errors, pointer, message) {
  errors.push({ pointer: pointer || "/", message });
}

function escapePointer(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function formatSeconds(milliseconds) {
  return `${(milliseconds / 1000).toFixed(3)}s`;
}

function titleFromId(id) {
  return id.split(/[.-]/).map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(" ");
}
