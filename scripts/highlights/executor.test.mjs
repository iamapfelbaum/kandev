import assert from "node:assert/strict";
import test from "node:test";

import {
  executePreparedScenario,
  executeScenario,
  prepareScenario,
  resolveSemanticLocator,
} from "./executor.mjs";
import { compileCamera } from "./camera-compiler.mjs";
import { createCursorController } from "./cursor.mjs";
import { compileTimeline } from "./scenario.mjs";

function fakePage() {
  const log = [];
  const locator = {
    async boundingBox() { return { x: 20, y: 30, width: 100, height: 40 }; },
    async click() { log.push("locator.click"); },
    async fill(text) { log.push(`fill:${text}`); },
    async pressSequentially(text, options) { log.push(`type:${text}:${options.delay}`); },
    async press(key) { log.push(`press:${key}`); },
    async hover() { log.push("hover"); },
    async waitFor(options) { log.push(`wait:${options.state}:${options.timeout}`); },
    async isEnabled() { return true; },
  };
  return {
    log,
    locator,
    getByTestId(value) { log.push(`testId:${value}`); return locator; },
    getByRole(role, options) { log.push(`role:${role}:${options.name}:${options.exact}`); return locator; },
    mouse: {
      async click(x, y, options = {}) { log.push(`mouse.click:${x}:${y}:${options.button ?? "left"}:${options.clickCount ?? 1}`); },
      async down() { log.push("mouse.down"); },
      async up() { log.push("mouse.up"); },
    },
    keyboard: { async press(key) { log.push(`keyboard:${key}`); } },
    async waitForTimeout(ms) { log.push(`pause:${ms}`); },
  };
}

test("semantic locator accepts only test id or exact role and accessible name", () => {
  const page = fakePage();
  assert.equal(resolveSemanticLocator(page, { testId: "save" }), page.locator);
  assert.equal(resolveSemanticLocator(page, { role: "button", name: "Save" }), page.locator);
  assert.throws(() => resolveSemanticLocator(page, { css: ".save" }), /semantic target.*testId.*role/i);
  assert.throws(
    () => resolveSemanticLocator(page, { testId: "save", role: "button", name: "Save" }),
    /exactly one/i,
  );
  assert.ok(page.log.includes("role:button:Save:true"));
});

test("executor dispatches canonical actions and allowlisted registries deterministically", async () => {
  const page = fakePage();
  const cursorLog = [];
  const cursor = {
    async moveTo(point, metadata) { cursorLog.push({ op: "move", point, metadata }); },
    async dragTo(point, metadata) { cursorLog.push({ op: "drag", point, metadata }); },
    finishVisibility() {},
  };
  const registryLog = [];
  const scenario = {
    schemaVersion: 1,
    id: "short-story",
    seed: { recipe: "tiny", parameters: { fixed: true } },
    setup: {
      route: "board",
      primitives: [{ primitiveId: "open-workspace", input: { id: "fixed" } }],
    },
    story: {
      actions: [
        { kind: "click", target: { testId: "save" } },
        { kind: "type", target: { role: "textbox", name: "Title" }, text: "Hello", keystrokeDelayMs: 10 },
        { kind: "press", target: { role: "textbox", name: "Title" }, key: "Escape" },
        { kind: "hover", target: { role: "button", name: "More" }, durationMs: 350 },
        { kind: "moveCursor", target: { testId: "save" }, durationMs: 320 },
        { kind: "waitForVisible", target: { testId: "saved" }, timeoutMs: 900 },
        { kind: "waitForState", target: { testId: "save" }, state: "enabled", timeoutMs: 800 },
        {
          kind: "drag",
          from: { testId: "card" },
          to: { testId: "done" },
          approachDurationMs: 350,
          durationMs: 480,
        },
        { kind: "pause", durationMs: 240 },
        { kind: "extension", primitiveId: "open-native-menu", input: { side: "left" } },
      ],
    },
  };

  const result = await executeScenario({
    scenario,
    page,
    cursor,
    seedRegistry: {
      tiny: async ({ parameters }) => registryLog.push(["seed", parameters]),
    },
    primitiveRegistry: {
      "open-workspace": async ({ input, route }) => registryLog.push(["setup", route, input]),
      "open-native-menu": async ({ input }) => registryLog.push(["extension", input]),
    },
    measureTargetGlyph: async () => ({ x: 28, y: 38, width: 72, height: 18 }),
    now: (() => { let value = 0; return () => (value += 10); })(),
  });

  assert.equal(result.steps.length, scenario.story.actions.length);
  assert.deepEqual(registryLog, [
    ["seed", { fixed: true }],
    ["setup", "board", { id: "fixed" }],
    ["extension", { side: "left" }],
  ]);
  assert.ok(page.log.includes("mouse.click:70:50:left:1"));
  assert.ok(page.log.includes("type:Hello:10"));
  assert.ok(page.log.includes("press:Escape"));
  assert.ok(page.log.includes("wait:visible:900"));
  assert.ok(page.log.includes("mouse.down"));
  assert.ok(page.log.includes("mouse.up"));
  assert.ok(page.log.includes("pause:120"));
  assert.equal(cursorLog.filter((entry) => entry.op === "drag").length, 1);
  assert.deepEqual(result.steps.map((step) => step.pointer),
    scenario.story.actions.map((_, index) => `/story/actions/${index}`));
});

test("executor failures name step index and JSON pointer", async () => {
  const page = fakePage();
  page.locator.waitFor = async () => { throw new Error("not visible"); };
  const scenario = {
    seed: { recipe: "tiny" },
    story: { actions: [{ kind: "waitForVisible", target: { testId: "missing" }, timeoutMs: 20 }] },
  };

  await assert.rejects(
    executeScenario({ scenario, page, seedRegistry: { tiny: async () => {} } }),
    (error) => {
      assert.match(error.message, /step 0.*\/story\/actions\/0.*not visible/i);
      assert.equal(error.stepIndex, 0);
      assert.equal(error.pointer, "/story/actions/0");
      return true;
    },
  );
});

test("unknown seed and extension ids fail closed", async () => {
  const page = fakePage();
  await assert.rejects(
    executeScenario({ scenario: { seed: { recipe: "shell" }, story: { actions: [] } }, page }),
    /seed recipe.*not allowlisted/i,
  );
  await assert.rejects(
    executeScenario({
      scenario: { story: { actions: [{ kind: "extension", primitiveId: "eval-js" }] } },
      page,
      primitiveRegistry: {},
    }),
    /extension primitive.*not allowlisted/i,
  );
});

test("camera actions delegate while only focus measures geometry and never moves real pointer", async () => {
  const page = fakePage();
  const delegated = [];
  const actions = [
    { kind: "cameraFocus", target: { testId: "card" }, durationMs: 1_200 },
    { kind: "cameraZoom", zoom: 1.4, durationMs: 1_200 },
    { kind: "cameraHold", durationMs: 400 },
    { kind: "cameraReturn", durationMs: 1_200 },
  ];
  const result = await executeScenario({
    scenario: { story: { actions } },
    page,
    measureTargetGlyph: async () => ({ x: 28, y: 38, width: 72, height: 18 }),
    onCameraDirective: async (action, evidence) => delegated.push([action, evidence]),
  });
  assert.deepEqual(delegated.map(([action]) => action), actions);
  assert.deepEqual(delegated[0][1], {
    cameraOnly: true,
    sourcePointer: "/story/actions/0",
    label: "card",
    targetBounds: { x: 20, y: 30, width: 100, height: 40 },
    targetGlyphBounds: { x: 28, y: 38, width: 72, height: 18 },
  });
  assert.equal(Object.hasOwn(delegated[1][1], "targetBounds"), false);
  assert.deepEqual(result.steps.map(({ kind }) => kind), actions.map(({ kind }) => kind));
  assert.deepEqual(result.steps[0].targetBounds, { x: 20, y: 30, width: 100, height: 40 });
  assert.equal(page.log.some((entry) => entry.startsWith("mouse.")), false);
  assert.deepEqual(page.log, ["testId:card"]);
});

test("cameraFocus execution steps compile directly into semantic camera directives", async () => {
  const page = fakePage();
  const scenario = {
    schemaVersion: 1,
    id: "focus-bridge",
    title: "Focus bridge",
    profile: {
      kind: "desktop",
      viewport: { width: 1920, height: 1200 },
      deviceScaleFactor: 2,
    },
    seed: { recipe: "tiny" },
    setup: { route: "workspace.board", primitives: [] },
    story: {
      openingSettleMs: 400,
      endingSettleMs: 400,
      actions: [
        { kind: "cameraFocus", target: { role: "button", name: "Create task" }, durationMs: 1_200 },
        { kind: "cameraReturn", durationMs: 1_200 },
      ],
    },
    camera: {
      minZoom: 1,
      maxZoom: 1.5,
      safeMarginPx: 48,
      glyphPaddingPx: 10,
      maxPanVelocityPxPerSecond: 1_200,
      maxPanAccelerationPxPerSecond2: 3_600,
      maxZoomRatePerSecond: 0.6,
      easing: "easeInOutCubic",
    },
  };
  const execution = await executeScenario({
    scenario,
    page,
    seedRegistry: { tiny: async () => {} },
    measureTargetGlyph: async () => ({ x: 28, y: 38, width: 72, height: 18 }),
  });
  const plan = compileCamera({
    scenario,
    timeline: compileTimeline(scenario),
    semanticEvents: execution.steps,
  });

  assert.equal(execution.steps[0].sourcePointer, "/story/actions/0");
  assert.deepEqual(execution.steps[0].targetBounds, { x: 20, y: 30, width: 100, height: 40 });
  assert.deepEqual(execution.steps[0].targetGlyphBounds, { x: 28, y: 38, width: 72, height: 18 });
  assert.deepEqual(plan.cameraDirectives.map(({ type }) => type), ["focus", "return"]);
  assert.equal(plan.semanticFocus[0].sourcePointer, "/story/actions/0");
});

test("click options, type clear, action settles, and attached states honor schema", async () => {
  const page = fakePage();
  const cursor = { async moveTo() {}, finishVisibility() {} };
  const scenario = {
    story: {
      actions: [
        {
          kind: "click",
          target: { testId: "row" },
          button: "right",
          clickCount: 2,
          cursorDurationMs: 350,
          settleMs: 175,
        },
        {
          kind: "type",
          target: { testId: "title" },
          text: "Fresh",
          clear: true,
          cursorDurationMs: 350,
          keystrokeDelayMs: 5,
        },
        { kind: "waitForState", target: { testId: "panel" }, state: "attached", timeoutMs: 600 },
        { kind: "waitForState", target: { testId: "spinner" }, state: "detached", timeoutMs: 700 },
      ],
    },
  };
  await executeScenario({
    scenario,
    page,
    cursor,
    measureTargetGlyph: async () => ({ x: 30, y: 40, width: 60, height: 12 }),
  });

  assert.ok(page.log.includes("mouse.click:70:50:right:2"));
  assert.ok(page.log.includes("fill:"));
  assert.ok(page.log.includes("type:Fresh:5"));
  assert.ok(page.log.includes("pause:175"));
  assert.ok(page.log.includes("wait:attached:600"));
  assert.ok(page.log.includes("wait:detached:700"));
});

test("pointer actions require independently measured target glyph geometry", async () => {
  const page = fakePage();
  const cursor = { async moveTo() {}, finishVisibility() {} };
  await assert.rejects(
    executeScenario({
      scenario: { story: { actions: [{ kind: "click", target: { testId: "save" } }] } },
      page,
      cursor,
    }),
    /target glyph.*independent.*required/i,
  );
});

test("native-mobile activation uses injected trusted tap and cursor target cannot be raw coordinates", async () => {
  const page = fakePage();
  const taps = [];
  const cursor = { async moveTo() {}, finishVisibility() {} };
  await executeScenario({
    scenario: { story: { actions: [{ kind: "click", target: { testId: "save" } }] } },
    page,
    cursor,
    inputKind: "native-mobile",
    trustedActivation: async (input) => taps.push(input),
    measureTargetGlyph: async () => ({ x: 30, y: 40, width: 60, height: 12 }),
  });
  assert.deepEqual(taps, [{ x: 70, y: 50, button: "left", clickCount: 1, inputKind: "native-mobile" }]);
  assert.equal(page.log.some((entry) => entry.startsWith("mouse.click")), false);

  await assert.rejects(
    executeScenario({
      scenario: { story: { actions: [{ kind: "moveCursor", position: { x: 20, y: 20 } }] } },
      page,
      cursor,
    }),
    /moveCursor.*semantic target/i,
  );
});

test("native-mobile drag uses touch start, dense touch moves, and touch end without page mouse", async () => {
  const page = fakePage();
  const hoverInput = [];
  const touchInput = [];
  let clock = 0;
  const cursor = createCursorController({
    page,
    viewport: { width: 430, height: 932 },
    now: () => (clock += 5),
    trustedInput: async (input) => hoverInput.push(input),
    measurePointerGlyph: async ({ x, y }) => ({ x, y, width: 8, height: 10 }),
  });
  const trustedGesture = {
    async start(input) { touchInput.push({ phase: "touchStart", ...input }); },
    async move(input) { touchInput.push({ phase: "touchMove", ...input }); },
    async end(input) { touchInput.push({ phase: "touchEnd", ...input }); },
  };

  await executeScenario({
    scenario: {
      profile: { kind: "native-mobile", viewport: { width: 430, height: 932 } },
      story: { actions: [{ kind: "drag", from: { testId: "card" }, to: { testId: "done" } }] },
    },
    page,
    cursor,
    inputKind: "native-mobile",
    trustedGesture,
    measureTargetGlyph: async () => ({ x: 28, y: 38, width: 72, height: 18 }),
  });

  assert.equal(touchInput[0].phase, "touchStart");
  assert.ok(touchInput.filter(({ phase }) => phase === "touchMove").length >= 12);
  assert.equal(touchInput.at(-1).phase, "touchEnd");
  assert.equal(page.log.includes("mouse.down"), false);
  assert.equal(page.log.includes("mouse.up"), false);
  assert.ok(hoverInput.length >= 12, "pre-contact cursor approach remains smooth trusted movement");
});

test("native-mobile rejects hover, non-left click, and repeated click semantics", async () => {
  const page = fakePage();
  await assert.rejects(executeScenario({
    scenario: { story: { actions: [{ kind: "hover", target: { testId: "menu" } }] } },
    page,
    inputKind: "native-mobile",
  }), /hover.*native-mobile.*not supported/i);
  await assert.rejects(executeScenario({
    scenario: { story: { actions: [{ kind: "click", target: { testId: "menu" }, button: "right" }] } },
    page,
    inputKind: "native-mobile",
    trustedActivation: async () => {},
  }), /native-mobile.*left.*button/i);
  await assert.rejects(executeScenario({
    scenario: { story: { actions: [{ kind: "click", target: { testId: "menu" }, clickCount: 2 }] } },
    page,
    inputKind: "native-mobile",
    trustedActivation: async () => {},
  }), /native-mobile.*clickCount.*1/i);
});

test("omitted executor timing defaults match the compiled storyboard contract", async () => {
  const page = fakePage();
  const cursorCalls = [];
  const cursor = {
    async moveTo(point, metadata) { cursorCalls.push(["move", point, metadata]); },
    async dragTo(point, metadata) { cursorCalls.push(["drag", point, metadata]); },
    finishVisibility() {},
  };
  const scenario = {
    schemaVersion: 1,
    id: "default-timings",
    title: "Default timings",
    profile: { kind: "desktop", viewport: { width: 1920, height: 1200 }, deviceScaleFactor: 2 },
    seed: { recipe: "tiny" },
    setup: { route: "workspace.board", primitives: [] },
    story: {
      openingSettleMs: 400,
      endingSettleMs: 400,
      actions: [
        { kind: "type", target: { testId: "title" }, text: "abcd" },
        { kind: "hover", target: { testId: "menu" } },
        { kind: "drag", from: { testId: "card" }, to: { testId: "done" } },
        { kind: "waitForVisible", target: { testId: "ready" } },
        { kind: "waitForState", target: { testId: "panel" }, state: "attached" },
      ],
    },
  };
  const timeline = compileTimeline(scenario);
  await executeScenario({
    scenario,
    page,
    cursor,
    seedRegistry: { tiny: async () => {} },
    measureTargetGlyph: async () => ({ x: 28, y: 38, width: 72, height: 18 }),
  });

  assert.ok(page.log.includes("type:abcd:35"));
  assert.deepEqual(cursorCalls.map(([kind, , metadata]) => [kind, metadata.durationMs]), [
    ["move", timeline.events[1].cursorDurationMs],
    ["move", timeline.events[2].cursorDurationMs],
    ["move", timeline.events[3].approachDurationMs],
    ["drag", timeline.events[3].actionDurationMs - timeline.events[3].approachDurationMs],
  ]);
  assert.ok(page.log.includes("wait:visible:2000"));
  assert.ok(page.log.includes("wait:attached:2000"));
});

test("default executor and cursor clocks produce monotonic story-relative samples", async () => {
  const page = fakePage();
  const cursor = createCursorController({
    page,
    viewport: { width: 1920, height: 1200 },
    trustedInput: async () => {},
    measurePointerGlyph: async ({ x, y }) => ({ x, y, width: 8, height: 10 }),
  });
  const execution = await executeScenario({
    scenario: {
      profile: { kind: "desktop", viewport: { width: 1920, height: 1200 } },
      story: { actions: [{ kind: "moveCursor", target: { testId: "save" }, durationMs: 50 }] },
    },
    page,
    cursor,
    measureTargetGlyph: async () => ({ x: 28, y: 38, width: 72, height: 18 }),
  });
  const samples = execution.cursorEvidence[0].samples;
  assert.ok(samples.length >= 12);
  assert.ok(samples.every(({ storyTMs }) => storyTMs >= 0 && storyTMs < 10_000));
  assert.ok(samples.every((sample, index) => index === 0 || sample.storyTMs >= samples[index - 1].storyTMs));
});

function timedScenario() {
  return {
    schemaVersion: 1,
    id: "timed-story",
    title: "Timed story",
    profile: {
      kind: "desktop",
      viewport: { width: 1920, height: 1200 },
      deviceScaleFactor: 2,
    },
    seed: { recipe: "tiny" },
    setup: { route: "workspace.board", primitives: [{ primitiveId: "prepare", input: { fixed: true } }] },
    story: {
      openingSettleMs: 400,
      actions: [
        { kind: "waitForVisible", target: { testId: "ready" }, timeoutMs: 5_000 },
        { kind: "waitForState", target: { testId: "panel" }, state: "attached", timeoutMs: 5_000 },
      ],
      endingSettleMs: 400,
    },
  };
}

test("prepare boundary completes seed, route, setup, and cursor resync before recorder starts", async () => {
  const order = [];
  const page = fakePage();
  const cursor = {
    async resync(point) { order.push(["resync", point]); },
    finishVisibility() {},
  };
  const scenario = timedScenario();
  const prepared = await prepareScenario({
    scenario,
    page,
    cursor,
    seedRegistry: { tiny: async () => order.push(["seed"]) },
    primitiveRegistry: { prepare: async () => order.push(["primitive"]) },
    navigateRoute: async (route) => order.push(["route", route]),
    onPrepared: async () => order.push(["prepared"]),
  });

  assert.deepEqual(order.map(([kind]) => kind), ["seed", "route", "primitive", "resync", "prepared"]);
  assert.equal(prepared.contract, "kandev-highlight-prepared-scenario-v1");
  assert.equal(page.log.some((entry) => entry.startsWith("wait:")), false);
});

test("prepared execution allows a quick wait assertion without padding its timeout bound", async () => {
  const scenario = timedScenario();
  const order = [];
  let clock = 0;
  const page = fakePage();
  page.waitForTimeout = async (ms) => { order.push(["sleep", ms]); clock += ms; };
  page.locator.waitFor = async (options) => { order.push([options.state, options.timeout]); clock += 10; };
  const prepared = await prepareScenario({
    scenario,
    page,
    seedRegistry: { tiny: async () => {} },
    primitiveRegistry: { prepare: async () => {} },
    now: () => clock,
  });
  const result = await executePreparedScenario({
    prepared,
    timeline: compileTimeline(scenario, { allowedExtensionIds: ["prepare"] }),
    now: () => clock,
    onRecordingStart: async () => order.push(["record-start"]),
    onRecordingEnd: async () => order.push(["record-end"]),
  });

  assert.equal(order[0][0], "record-start");
  assert.deepEqual(order.filter(([kind]) => kind === "sleep").map(([, ms]) => ms), [400, 380]);
  assert.deepEqual(order.find(([kind]) => kind === "visible"), ["visible", 5_000]);
  assert.deepEqual(order.find(([kind]) => kind === "attached"), ["attached", 5_000]);
  assert.equal(order.at(-1)[0], "record-end");
  assert.equal(result.storyDurationMs, 800);
  assert.equal(result.steps[0].plannedStartMs, 400);
  assert.equal(result.steps[0].plannedEndMs, 400);
  assert.equal(result.steps[0].endedAtMs, 410);
  assert.equal(result.steps[1].plannedStartMs, 400);
  assert.equal(result.steps[1].plannedEndMs, 400);
  assert.equal(result.steps[1].endedAtMs, 420);
});

test("prepared execution reports a nondeterministic wait overrun as a bound, not a hold", async () => {
  const scenario = timedScenario();
  let clock = 0;
  const page = fakePage();
  page.waitForTimeout = async (ms) => { clock += ms; };
  page.locator.waitFor = async () => { clock += 120; };
  const prepared = await prepareScenario({
    scenario,
    page,
    seedRegistry: { tiny: async () => {} },
    primitiveRegistry: { prepare: async () => {} },
    now: () => clock,
  });
  await assert.rejects(
    executePreparedScenario({
      prepared,
      timeline: compileTimeline(scenario, { allowedExtensionIds: ["prepare"] }),
      now: () => clock,
      timingToleranceMs: 32,
    }),
    /step 0.*\/story\/actions\/0.*waitForVisible.*120ms.*timeoutMs.*5000.*bound.*pause|settle/is,
  );
});
