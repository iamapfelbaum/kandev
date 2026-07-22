const SUPPORTED_STATE_METHODS = Object.freeze({
  enabled: ["isEnabled", true],
  disabled: ["isEnabled", false],
  checked: ["isChecked", true],
  unchecked: ["isChecked", false],
  editable: ["isEditable", true],
});
const WAIT_ASSERTION_KINDS = new Set(["waitForVisible", "waitForState"]);

function defaultNow() {
  return performance.now();
}

function ownFunction(registry, id) {
  return registry && Object.hasOwn(registry, id) && typeof registry[id] === "function"
    ? registry[id]
    : null;
}

function actionList(scenario) {
  const actions = scenario?.story?.actions ?? scenario?.actions;
  if (!Array.isArray(actions)) throw new Error("scenario.story.actions must be an array");
  return actions;
}

export function resolveSemanticLocator(page, target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("semantic target must use testId or role with accessible name");
  }
  const hasTestId = typeof target.testId === "string" && target.testId.trim() !== "";
  const hasRole = typeof target.role === "string" && target.role.trim() !== "";
  const hasName = typeof target.name === "string" && target.name.trim() !== "";
  if (Number(hasTestId) + Number(hasRole && hasName) !== 1 || hasRole !== hasName) {
    throw new Error("semantic target must define exactly one of {testId} or {role, name}");
  }
  const keys = Object.keys(target);
  if (hasTestId && (keys.length !== 1 || typeof page.getByTestId !== "function")) {
    if (keys.length !== 1) throw new Error("semantic target must define exactly one stable selector");
    throw new Error("page does not support testId locators");
  }
  if (!hasTestId && (keys.length !== 2 || typeof page.getByRole !== "function")) {
    if (keys.length !== 2) throw new Error("semantic target must define exactly one stable selector");
    throw new Error("page does not support role locators");
  }
  return hasTestId
    ? page.getByTestId(target.testId)
    : page.getByRole(target.role, { name: target.name, exact: true });
}

async function targetGeometry(locator, action, measureTargetGlyph, { requireIndependentGlyph = false } = {}) {
  const bounds = await locator.boundingBox();
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("semantic target has no visible bounds");
  }
  if (requireIndependentGlyph && typeof measureTargetGlyph !== "function") {
    throw new Error("target glyph independent measurement is required for pointer movement");
  }
  const targetGlyphBounds = typeof measureTargetGlyph === "function"
    ? await measureTargetGlyph(locator, action)
    : null;
  if (requireIndependentGlyph && !targetGlyphBounds) {
    throw new Error("target glyph independent measurement returned no bounds");
  }
  return {
    bounds: { ...bounds },
    glyphBounds: targetGlyphBounds ? { ...targetGlyphBounds } : null,
    center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
  };
}

async function arrive({ locator, action, cursor, durationMs, measureTargetGlyph, label }) {
  const geometry = await targetGeometry(locator, action, measureTargetGlyph, {
    requireIndependentGlyph: Boolean(cursor),
  });
  if (cursor) {
    await cursor.moveTo(geometry.center, {
      durationMs,
      label,
      targetBounds: geometry.bounds,
      targetGlyphBounds: geometry.glyphBounds,
    });
  }
  return geometry;
}

async function activate({
  page,
  locator,
  geometry,
  cursor,
  button = "left",
  clickCount = 1,
  inputKind = "desktop",
  trustedActivation,
}) {
  const activation = {
    x: geometry.center.x,
    y: geometry.center.y,
    button,
    clickCount,
    inputKind,
  };
  if (typeof trustedActivation === "function") {
    await trustedActivation(activation);
  } else if (inputKind === "native-mobile") {
    throw new Error("native-mobile activation needs an injected trusted touch adapter");
  } else if (cursor && typeof page.mouse?.click === "function") {
    await page.mouse.click(geometry.center.x, geometry.center.y, { button, clickCount });
  } else {
    await locator.click({ button, clickCount });
  }
  await page.waitForTimeout(120);
}

async function waitForState(locator, action, page) {
  const timeoutMs = action.timeoutMs ?? 2_000;
  if (["attached", "detached", "visible", "hidden"].includes(action.state)) {
    await locator.waitFor({ state: action.state, timeout: timeoutMs });
    return;
  }
  const contract = SUPPORTED_STATE_METHODS[action.state];
  if (!contract) throw new Error(`unsupported waitForState state: ${action.state}`);
  const [method, expected] = contract;
  if (typeof locator[method] !== "function") throw new Error(`locator cannot query ${action.state} state`);
  const started = defaultNow();
  while ((await locator[method]()) !== expected) {
    if (defaultNow() - started >= timeoutMs) throw new Error(`timed out waiting for state ${action.state}`);
    await page.waitForTimeout(Math.min(50, timeoutMs));
  }
}

async function dispatchAction({
  action,
  sourcePointer,
  page,
  cursor,
  primitiveRegistry,
  measureTargetGlyph,
  onCameraDirective,
  inputKind,
  trustedActivation,
  trustedGesture,
}) {
  switch (action.kind) {
    case "click": {
      const button = action.button ?? "left";
      const clickCount = action.clickCount ?? 1;
      if (inputKind === "native-mobile" && button !== "left") {
        throw new Error("native-mobile click supports only the left/primary button");
      }
      if (inputKind === "native-mobile" && clickCount !== 1) {
        throw new Error("native-mobile clickCount must be 1; repeated taps require explicit click actions");
      }
      const locator = resolveSemanticLocator(page, action.target);
      const geometry = await arrive({
        locator,
        action,
        cursor,
        durationMs: action.cursorDurationMs ?? 350,
        measureTargetGlyph,
        label: action.label ?? "click",
      });
      await activate({
        page,
        locator,
        geometry,
        cursor,
        button,
        clickCount,
        inputKind,
        trustedActivation,
      });
      return { target: geometry };
    }
    case "type": {
      const locator = resolveSemanticLocator(page, action.target);
      if (cursor) {
        const geometry = await arrive({
          locator,
          action,
          cursor,
          durationMs: action.cursorDurationMs ?? 350,
          measureTargetGlyph,
          label: action.label ?? "type focus",
        });
        await activate({ page, locator, geometry, cursor, inputKind, trustedActivation });
      }
      const delay = action.keystrokeDelayMs ?? 35;
      if (action.clear) {
        if (typeof locator.fill !== "function") throw new Error("locator cannot clear text");
        await locator.fill("");
      }
      if (typeof locator.pressSequentially === "function") {
        await locator.pressSequentially(action.text, { delay });
      } else if (delay === 0 && typeof locator.fill === "function") {
        await locator.fill(action.text);
      } else {
        throw new Error("locator cannot type deterministic text");
      }
      return {};
    }
    case "press": {
      const locator = resolveSemanticLocator(page, action.target);
      if (typeof locator.press !== "function") throw new Error("locator cannot press a key");
      await locator.press(action.key);
      return {};
    }
    case "hover": {
      if (inputKind === "native-mobile") {
        throw new Error("hover on native-mobile is not supported; use click or an allowlisted native primitive");
      }
      const locator = resolveSemanticLocator(page, action.target);
      const geometry = await arrive({
        locator,
        action,
        cursor,
        durationMs: action.durationMs ?? 250,
        measureTargetGlyph,
        label: action.label ?? "hover",
      });
      if (!cursor) await locator.hover();
      return { target: geometry };
    }
    case "moveCursor": {
      if (!cursor) throw new Error("moveCursor needs a cursor controller");
      if (action.target) {
        const locator = resolveSemanticLocator(page, action.target);
        const geometry = await arrive({
          locator,
          action,
          cursor,
          durationMs: action.durationMs ?? 350,
          measureTargetGlyph,
          label: action.label ?? "move cursor",
        });
        return { target: geometry };
      }
      throw new Error("moveCursor requires a semantic target");
    }
    case "waitForVisible": {
      const locator = resolveSemanticLocator(page, action.target);
      await locator.waitFor({ state: "visible", timeout: action.timeoutMs ?? 2_000 });
      return {};
    }
    case "waitForState": {
      const locator = resolveSemanticLocator(page, action.target);
      await waitForState(locator, action, page);
      return {};
    }
    case "drag": {
      if (!cursor) throw new Error("drag needs a cursor controller to prevent pointer teleport");
      const source = resolveSemanticLocator(page, action.from);
      const destination = resolveSemanticLocator(page, action.to);
      const from = await arrive({
        locator: source,
        action,
        cursor,
        durationMs: action.approachDurationMs ?? 350,
        measureTargetGlyph,
        label: action.label ? `${action.label} approach` : "drag approach",
      });
      const to = await targetGeometry(destination, action, measureTargetGlyph, { requireIndependentGlyph: true });
      const dragMetadata = {
        durationMs: action.durationMs ?? 600,
        label: action.label ?? "drag",
        targetBounds: to.bounds,
        targetGlyphBounds: to.glyphBounds,
      };
      if (inputKind === "native-mobile") {
        if (![trustedGesture?.start, trustedGesture?.move, trustedGesture?.end].every((method) => typeof method === "function")) {
          throw new Error("native-mobile drag needs trustedGesture start/move/end touch adapters");
        }
        await trustedGesture.start({ ...from.center, inputKind, label: dragMetadata.label });
        let failed = false;
        try {
          await cursor.dragTo(to.center, {
            ...dragMetadata,
            trustedInput: (input) => trustedGesture.move({ ...input, phase: "touchMove", inputKind }),
          });
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          await trustedGesture.end({ ...to.center, inputKind, label: dragMetadata.label, cancelled: failed });
        }
      } else {
        await page.mouse.down();
        await cursor.dragTo(to.center, dragMetadata);
        await page.mouse.up();
      }
      return { source: from, destination: to };
    }
    case "pause":
      await page.waitForTimeout(action.durationMs);
      return {};
    case "extension": {
      const primitive = ownFunction(primitiveRegistry, action.primitiveId);
      if (!primitive) throw new Error(`extension primitive '${action.primitiveId}' is not allowlisted`);
      return (await primitive({ page, input: action.input, action })) ?? {};
    }
    case "cameraFocus": {
      const locator = resolveSemanticLocator(page, action.target);
      const geometry = await targetGeometry(locator, action, measureTargetGlyph, {
        requireIndependentGlyph: true,
      });
      const evidence = {
        cameraOnly: true,
        sourcePointer,
        label: action.label ?? action.target.name ?? action.target.testId,
        targetBounds: geometry.bounds,
        targetGlyphBounds: geometry.glyphBounds,
      };
      if (typeof onCameraDirective === "function") await onCameraDirective(action, evidence);
      return evidence;
    }
    case "cameraZoom":
    case "cameraHold":
    case "cameraReturn": {
      const evidence = { cameraOnly: true, sourcePointer };
      if (typeof onCameraDirective === "function") await onCameraDirective(action, evidence);
      return evidence;
    }
    default:
      throw new Error(`unsupported action kind: ${action.kind}`);
  }
}

async function runSetup({ scenario, page, seedRegistry, primitiveRegistry, navigateRoute }) {
  if (scenario.seed) {
    const seed = ownFunction(seedRegistry, scenario.seed.recipe);
    if (!seed) throw new Error(`seed recipe '${scenario.seed.recipe}' is not allowlisted`);
    await seed({ page, parameters: scenario.seed.parameters ?? {}, scenario });
  }
  const setup = scenario.setup;
  if (!setup) return;
  if (setup.route && typeof navigateRoute === "function") {
    await navigateRoute(setup.route, { page, scenario });
  }
  for (const [index, primitiveSpec] of (setup.primitives ?? []).entries()) {
    const primitive = ownFunction(primitiveRegistry, primitiveSpec.primitiveId);
    if (!primitive) {
      throw new Error(`setup primitive '${primitiveSpec.primitiveId}' at /setup/primitives/${index} is not allowlisted`);
    }
    await primitive({ page, input: primitiveSpec.input, route: setup.route, scenario });
  }
}

export async function prepareScenario({
  scenario,
  page,
  cursor = null,
  seedRegistry = {},
  primitiveRegistry = {},
  extensionRegistry,
  navigateRoute,
  initialCursor,
  onPrepared,
  measureTargetGlyph,
  onCameraDirective,
  inputKind = "desktop",
  trustedActivation,
  trustedGesture,
  now = defaultNow,
} = {}) {
  if (!scenario || typeof scenario !== "object") throw new Error("scenario is required");
  if (!page || typeof page !== "object") throw new Error("page is required");
  const registry = extensionRegistry ? { ...extensionRegistry, ...primitiveRegistry } : primitiveRegistry;
  await runSetup({
    scenario,
    page,
    seedRegistry,
    primitiveRegistry: registry,
    navigateRoute,
  });
  if (cursor && typeof cursor.resync === "function") {
    const viewport = scenario.profile?.viewport;
    const destination = initialCursor ?? (viewport ? {
      x: viewport.width / 2,
      y: viewport.height * (scenario.profile.kind === "native-mobile" ? 0.82 : 0.72),
    } : null);
    if (destination) await cursor.resync(destination, { source: "scenario preparation", label: "initial cursor" });
  }
  const prepared = {
    contract: "kandev-highlight-prepared-scenario-v1",
    scenario,
    page,
    cursor,
    primitiveRegistry: registry,
    measureTargetGlyph,
    onCameraDirective,
    inputKind,
    trustedActivation,
    trustedGesture,
    preparedAtMs: now(),
  };
  if (typeof onPrepared === "function") await onPrepared(prepared);
  return prepared;
}

function wrapStepError(cause, index, pointer, action) {
  const message = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(`Scenario step ${index} (${pointer}, ${action?.kind ?? "unknown"}) failed: ${message}`, { cause });
  error.stepIndex = index;
  error.pointer = pointer;
  error.actionKind = action?.kind;
  return error;
}

function assertDeterministicWaitResolution(action, resolutionMs, timingToleranceMs) {
  if (!WAIT_ASSERTION_KINDS.has(action.kind) || resolutionMs <= timingToleranceMs) return;
  const timeoutMs = action.timeoutMs ?? 2_000;
  throw new Error(
    `${action.kind} assertion resolved in ${Math.round(resolutionMs)}ms, exceeding deterministic timing tolerance ${timingToleranceMs}ms; `
      + `timeoutMs=${timeoutMs} is a failure bound, not a storyboard hold. Seed the state for immediate resolution; use pause or settleMs for an intended hold`,
  );
}

function normalizedCursorEvidence(cursor, storyEpochMs) {
  if (!Array.isArray(cursor?.movements)) return [];
  return cursor.movements.map((movement) => ({
    ...structuredClone(movement),
    storyStartedAtMs: movement.startedAtMs - storyEpochMs,
    storyEndedAtMs: movement.endedAtMs - storyEpochMs,
    storyVisibility: {
      startMs: movement.visibility.startMs - storyEpochMs,
      endMs: movement.visibility.endMs - storyEpochMs,
    },
    samples: movement.samples.map((sample) => ({
      ...structuredClone(sample),
      storyTMs: sample.tMs - storyEpochMs,
    })),
  }));
}

function normalizedCursorResyncEvidence(cursor, storyEpochMs) {
  if (!Array.isArray(cursor?.resyncs)) return [];
  return cursor.resyncs.map((resync) => ({
    ...structuredClone(resync),
    storyStartedAtMs: Number.isFinite(resync.startedAtMs) ? resync.startedAtMs - storyEpochMs : null,
    storyEndedAtMs: Number.isFinite(resync.endedAtMs) ? resync.endedAtMs - storyEpochMs : null,
  }));
}

export async function executePreparedScenario({
  prepared,
  timeline,
  now = defaultNow,
  timingToleranceMs = 64,
  onRecordingStart,
  onRecordingEnd,
  onStep,
} = {}) {
  if (prepared?.contract !== "kandev-highlight-prepared-scenario-v1") {
    throw new Error("executePreparedScenario needs prepared scenario boundary");
  }
  if (!Number.isFinite(timingToleranceMs) || timingToleranceMs < 0) {
    throw new Error("timingToleranceMs must be non-negative");
  }
  const {
    scenario,
    page,
    cursor,
    primitiveRegistry,
    measureTargetGlyph,
    onCameraDirective,
    inputKind,
    trustedActivation,
    trustedGesture,
  } = prepared;
  const actions = actionList(scenario);
  if (timeline && (timeline.scenarioId !== scenario.id || !Array.isArray(timeline.events))) {
    throw new Error("prepared execution timeline does not match scenario");
  }
  if (typeof onRecordingStart === "function") await onRecordingStart({ prepared, timeline });
  const storyEpochMs = now();
  const elapsed = () => now() - storyEpochMs;
  const waitUntil = async (targetMs, label) => {
    const before = elapsed();
    if (before < targetMs) await page.waitForTimeout(targetMs - before);
    const after = elapsed();
    const overrun = after - targetMs;
    if (overrun > timingToleranceMs) {
      throw new Error(`${label} overran planned slot by ${Math.round(overrun)}ms`);
    }
    return after;
  };

  const openingMs = scenario.story?.openingSettleMs ?? 0;
  const endingMs = scenario.story?.endingSettleMs ?? 0;
  if (timeline) {
    const opening = timeline.events[0];
    if (opening?.kind !== "openingSettle") throw new Error("timeline must begin with openingSettle");
    await waitUntil(opening.endMs, "opening settle");
  } else if (openingMs) {
    await page.waitForTimeout(openingMs);
  }

  const steps = [];
  for (const [index, action] of actions.entries()) {
    const pointer = `/story/actions/${index}`;
    const planned = timeline?.events.find((event) => event.sourcePointer === pointer);
    if (timeline && (!planned || planned.kind !== action.kind)) {
      throw new Error(`${pointer}: compiled timeline event is missing or mismatched`);
    }
    try {
      if (planned) await waitUntil(planned.startMs, `step ${index} start`);
      const startedAtMs = elapsed();
      const evidence = await dispatchAction({
        action,
        sourcePointer: pointer,
        page,
        cursor,
        primitiveRegistry,
        measureTargetGlyph,
        onCameraDirective,
        inputKind,
        trustedActivation,
        trustedGesture,
      });
      if (WAIT_ASSERTION_KINDS.has(action.kind)) {
        assertDeterministicWaitResolution(action, elapsed() - startedAtMs, timingToleranceMs);
      }
      if (action.settleMs) await page.waitForTimeout(action.settleMs);
      if (planned) await waitUntil(planned.endMs, `step ${index} (${pointer})`);
      const step = {
        index,
        pointer,
        sourcePointer: pointer,
        kind: action.kind,
        startedAtMs,
        endedAtMs: elapsed(),
        plannedStartMs: planned?.startMs ?? null,
        plannedEndMs: planned?.endMs ?? null,
        ...evidence,
      };
      steps.push(step);
      if (typeof onStep === "function") await onStep(step);
    } catch (cause) {
      throw wrapStepError(cause, index, pointer, action);
    }
  }
  if (timeline) {
    const ending = timeline.events.at(-1);
    if (ending?.kind !== "endingSettle") throw new Error("timeline must end with endingSettle");
    await waitUntil(ending.startMs, "ending settle start");
    await waitUntil(ending.endMs, "ending settle");
  } else if (endingMs) {
    await page.waitForTimeout(endingMs);
  }
  cursor?.finishVisibility?.();
  const storyDurationMs = timeline?.totalDurationMs ?? elapsed();
  const result = {
    contract: "kandev-highlight-execution-v1",
    scenarioId: scenario.id ?? null,
    storyEpochMs,
    storyDurationMs,
    timingToleranceMs,
    timelineDigest: timeline?.scenarioDigest ?? null,
    steps,
    cursorResyncEvidence: normalizedCursorResyncEvidence(cursor, storyEpochMs),
    cursorEvidence: normalizedCursorEvidence(cursor, storyEpochMs),
  };
  if (typeof onRecordingEnd === "function") await onRecordingEnd(result);
  return result;
}

export async function executeScenario(options = {}) {
  const prepared = await prepareScenario(options);
  return executePreparedScenario({
    prepared,
    timeline: options.timeline,
    now: options.now,
    timingToleranceMs: options.timingToleranceMs,
    onRecordingStart: options.onRecordingStart,
    onRecordingEnd: options.onRecordingEnd,
    onStep: options.onStep,
  });
}
