import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";

const tempDirs = [];
const scenarioModule = "./scenario.mjs";

function validScenario() {
  return {
    $schema: "../scenario.schema.json",
    schemaVersion: 1,
    id: "short-task-story",
    title: "Create a task from the board",
    profile: {
      kind: "desktop",
      viewport: { width: 1920, height: 1200 },
      deviceScaleFactor: 2,
    },
    seed: {
      recipe: "kandev.empty-workspace",
      parameters: { workspaceName: "Demo workspace" },
    },
    setup: {
      route: "workspace.board",
      primitives: [],
    },
    story: {
      recipe: "kandev.short-feature",
      openingSettleMs: 600,
      actions: [
        { kind: "moveCursor", target: { role: "button", name: "New task" }, durationMs: 300 },
        { kind: "click", target: { role: "button", name: "New task" }, settleMs: 150 },
        { kind: "type", target: { testId: "task-title" }, text: "Review API", keystrokeDelayMs: 30 },
        { kind: "press", target: { testId: "task-title" }, key: "Enter", settleMs: 200 },
        { kind: "waitForVisible", target: { role: "heading", name: "Review API" }, timeoutMs: 1500 },
        { kind: "cameraFocus", target: { role: "heading", name: "Review API" }, durationMs: 1200 },
        { kind: "cameraZoom", zoom: 1.25, durationMs: 1200 },
        { kind: "cameraHold", durationMs: 450 },
        { kind: "cameraReturn", durationMs: 1200 },
      ],
      endingSettleMs: 700,
    },
    camera: {
      minZoom: 1,
      maxZoom: 1.5,
      safeMarginPx: 48,
      glyphPaddingPx: 10,
      maxPanVelocityPxPerSecond: 1200,
      maxPanAccelerationPxPerSecond2: 3600,
      maxZoomRatePerSecond: 0.6,
      easing: "easeInOutCubic",
    },
  };
}

function validDelivery() {
  return {
    revision: "r1",
    releaseVersion: "1.2.3",
    summary: "Create focused work without leaving the board.",
    caption: "Open the task dialog, enter a title, and create the task.",
    featureFlags: ["features.highlights"],
    docs: { page: "guide/tasks.md", section: "Create a task" },
    mobileDeclaration: "Feature has a native mobile surface.",
  };
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test("checked-in JSON Schema, declarations, and example describe schema v1", async () => {
  const schema = JSON.parse(await fs.readFile(new URL("./scenario.schema.json", import.meta.url)));
  const declarations = await fs.readFile(new URL("./scenario.d.ts", import.meta.url), "utf8");
  const example = JSON.parse(await fs.readFile(new URL("./examples/quick-start.scenario.json", import.meta.url)));
  const { validateScenario } = await import(scenarioModule);

  assert.equal(schema.$id, "https://kandev.com/schemas/highlight-scenario-v1.json");
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.match(declarations, /export type ScenarioAction/);
  assert.match(declarations, /kind: "native-mobile"/);
  assert.match(declarations, /kind: "desktop"; viewport: \{ width: 1920; height: 1200 \}; deviceScaleFactor: 2/);
  assert.match(declarations, /kind: "native-mobile"; viewport: \{ width: 430; height: 932 \}; deviceScaleFactor: 3/);
  assert.equal(schema.properties.delivery.$ref, "#/$defs/delivery");
  assert.equal(schema.$defs.delivery.additionalProperties, false);
  assert.equal(
    schema.allOf[0].then.properties.delivery.properties.mobileRequired.const,
    true,
  );
  assert.deepEqual(schema.$defs.delivery.required, [
    "revision",
    "releaseVersion",
    "summary",
    "caption",
    "featureFlags",
    "docs",
    "mobileDeclaration",
  ]);
  assert.match(JSON.stringify(schema.allOf), /native-mobile.*hover.*middle.*right/s);
  assert.match(declarations, /export interface DeliveryMetadata/);
  assert.match(declarations, /export type NativeMobileScenarioAction/);
  assert.match(declarations, /export type HighlightScenarioV1\s*=/);
  assert.deepEqual(validateScenario(example), { ok: true, errors: [] });
});

test("scaffold declarations make canonical template overrides unrepresentable", async () => {
  const declarations = await fs.readFile(new URL("./scenario.d.ts", import.meta.url), "utf8");
  assert.match(declarations, /export type ScenarioScaffoldOptions/);
  assert.match(declarations, /templateId: ScenarioTemplateId; id\?: never; title\?: never; profileKind\?: never;/);
  assert.match(declarations, /writeScenarioScaffold\(options: ScenarioScaffoldOptions\)/);
});

test("delivery metadata is optional for capture but required promotion errors at its JSON pointer", async () => {
  const { compileTimeline, requireDeliveryMetadata, validateScenario } = await import(scenarioModule);
  const scenario = validScenario();

  assert.deepEqual(validateScenario(scenario), { ok: true, errors: [] });
  assert.equal(compileTimeline(scenario).delivery, null);
  assert.throws(
    () => requireDeliveryMetadata(scenario),
    (error) => {
      assert.equal(error.name, "ScenarioValidationError");
      assert(error.errors.some((issue) => issue.pointer === "/delivery"));
      assert.match(error.message, /promotion|delivery metadata/i);
      return true;
    },
  );
});

test("delivery metadata maps canonical id and title into stage-manifest fields", async () => {
  const { compileTimeline, requireDeliveryMetadata, validateScenario } = await import(scenarioModule);
  const scenario = validScenario();
  scenario.delivery = validDelivery();

  assert.deepEqual(validateScenario(scenario), { ok: true, errors: [] });
  assert.deepEqual(requireDeliveryMetadata(scenario), {
    revision: "r1",
    highlight: {
      id: "short-task-story",
      title: "Create a task from the board",
      summary: "Create focused work without leaving the board.",
      caption: "Open the task dialog, enter a title, and create the task.",
      releaseVersion: "1.2.3",
      featureFlags: ["features.highlights"],
      docs: { page: "guide/tasks.md", section: "Create a task" },
      mobileDeclaration: "Feature has a native mobile surface.",
      mobileRequired: false,
    },
  });
  assert.deepEqual(compileTimeline(scenario).delivery, scenario.delivery);
});

test("delivery mobileRequired is typed, defaults by profile, and forbids a native false declaration", async () => {
  const { requireDeliveryMetadata, validateScenario } = await import(scenarioModule);
  const desktop = validScenario();
  desktop.delivery = validDelivery();
  assert.equal(requireDeliveryMetadata(desktop).highlight.mobileRequired, false);

  const paired = structuredClone(desktop);
  paired.delivery.mobileRequired = true;
  assert.deepEqual(validateScenario(paired), { ok: true, errors: [] });
  assert.equal(requireDeliveryMetadata(paired).highlight.mobileRequired, true);

  const native = structuredClone(desktop);
  native.profile = { kind: "native-mobile", viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 };
  native.camera.maxZoom = 1.18;
  native.story.actions.find((action) => action.kind === "cameraZoom").zoom = 1.1;
  assert.equal(requireDeliveryMetadata(native).highlight.mobileRequired, true);
  native.delivery.mobileRequired = false;
  assert(validateScenario(native).errors.some((error) =>
    error.pointer === "/delivery/mobileRequired" && /native-mobile.*true|required/i.test(error.message)));
});

test("promotable scenarios keep canonical id and title stage-compatible", async () => {
  const { validateScenario } = await import(scenarioModule);
  const captureOnly = validScenario();
  captureOnly.id = "capture.only";
  assert.deepEqual(validateScenario(captureOnly), { ok: true, errors: [] });

  captureOnly.delivery = validDelivery();
  const invalidId = validateScenario(captureOnly);
  assert(invalidId.errors.some((error) => error.pointer === "/id" && /delivery|promotion|kebab/i.test(error.message)));

  const blankTitle = validScenario();
  blankTitle.title = "   ";
  blankTitle.delivery = validDelivery();
  const invalidTitle = validateScenario(blankTitle);
  assert(invalidTitle.errors.some((error) => error.pointer === "/title" && /nonempty|promotion|delivery/i.test(error.message)));
});

test("canonical digest includes every delivery intent change", async () => {
  const { computeScenarioDigest } = await import(scenarioModule);
  const captureOnly = validScenario();
  const promotable = structuredClone(captureOnly);
  promotable.delivery = validDelivery();
  const changed = structuredClone(promotable);
  changed.delivery.caption = "A different accepted delivery caption.";

  assert.notEqual(computeScenarioDigest(captureOnly), computeScenarioDigest(promotable));
  assert.notEqual(computeScenarioDigest(promotable), computeScenarioDigest(changed));
});

test("delivery metadata rejects unknown or derived fields and malformed values", async () => {
  const { validateScenario } = await import(scenarioModule);
  const scenario = validScenario();
  scenario.delivery = {
    ...validDelivery(),
    revision: "../r1",
    releaseVersion: "v1.2",
    summary: "",
    featureFlags: [],
    mobileDeclaration: "",
    qaStatus: "accepted",
    sourceSha: "0123456789abcdef0123456789abcdef01234567",
    docs: { page: "guide/tasks.txt", section: "", anchor: "create" },
  };
  const result = validateScenario(scenario);

  assert.equal(result.ok, false);
  for (const pointer of [
    "/delivery/revision",
    "/delivery/releaseVersion",
    "/delivery/summary",
    "/delivery/featureFlags",
    "/delivery/mobileDeclaration",
    "/delivery/qaStatus",
    "/delivery/sourceSha",
    "/delivery/docs/page",
    "/delivery/docs/section",
    "/delivery/docs/anchor",
  ]) {
    assert(result.errors.some((error) => error.pointer === pointer), `missing error for ${pointer}`);
  }
});

test("delivery docs path rejects absolute, traversal, and platform-ambiguous paths", async () => {
  const { validateScenario } = await import(scenarioModule);
  for (const unsafePage of ["../guide.md", "guide/../secret.md", "/guide.md", "C:/guide.md", "guide\\tasks.md", "guide//tasks.md", "guide.md?raw=1", "guide.md#part"]) {
    const scenario = validScenario();
    scenario.delivery = { ...validDelivery(), docs: { page: unsafePage, section: "Create a task" } };
    const result = validateScenario(scenario);
    assert.equal(result.ok, false, unsafePage);
    assert(result.errors.some((error) => error.pointer === "/delivery/docs/page" && /relative|markdown|safe/i.test(error.message)), unsafePage);
  }
});

test("native-mobile rejects mouse-only actions while preserving native click and drag", async () => {
  const { validateScenario } = await import(scenarioModule);
  const invalid = validScenario();
  invalid.profile = { kind: "native-mobile", viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 };
  invalid.camera.maxZoom = 1.18;
  invalid.story.actions = [
    { kind: "hover", target: { testId: "menu" } },
    { kind: "click", target: { testId: "open" }, button: "middle" },
    { kind: "click", target: { testId: "open" }, button: "right" },
    { kind: "click", target: { testId: "open" }, clickCount: 2 },
  ];
  const result = validateScenario(invalid);

  assert.equal(result.ok, false);
  for (const pointer of [
    "/story/actions/0/kind",
    "/story/actions/1/button",
    "/story/actions/2/button",
    "/story/actions/3/clickCount",
  ]) {
    const issue = result.errors.find((error) => error.pointer === pointer);
    assert(issue, `missing error for ${pointer}`);
    assert.match(issue.message, /native touch|native click|allowlisted primitive/i);
  }

  const allowed = validScenario();
  allowed.profile = { kind: "native-mobile", viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 };
  allowed.camera.maxZoom = 1.18;
  allowed.story.actions = [
    { kind: "click", target: { testId: "open" }, button: "left", clickCount: 1 },
    { kind: "drag", from: { testId: "card" }, to: { testId: "done" }, durationMs: 500 },
  ];
  assert.deepEqual(validateScenario(allowed), { ok: true, errors: [] });

  const desktop = validScenario();
  desktop.story.actions = [
    { kind: "hover", target: { testId: "menu" } },
    { kind: "click", target: { testId: "open" }, button: "right", clickCount: 3 },
  ];
  assert.deepEqual(validateScenario(desktop), { ok: true, errors: [] });
});

test("validator accepts every built-in action and stable locator form", async () => {
  const { validateScenario } = await import(scenarioModule);
  const scenario = validScenario();
  scenario.story.actions = [
    { kind: "click", target: { testId: "save" }, cursorDurationMs: 400 },
    { kind: "type", target: { role: "textbox", name: "Title" }, text: "Hello", clear: true, cursorDurationMs: 400 },
    { kind: "press", target: { testId: "title" }, key: "Control+Enter" },
    { kind: "hover", target: { role: "button", name: "Actions" }, durationMs: 200 },
    { kind: "moveCursor", target: { testId: "menu" }, durationMs: 300 },
    { kind: "waitForVisible", target: { role: "dialog", name: "Create task" }, timeoutMs: 1000 },
    { kind: "waitForState", target: { testId: "save" }, state: "enabled", timeoutMs: 1000 },
    { kind: "drag", from: { testId: "card" }, to: { role: "region", name: "Done" }, durationMs: 500 },
    { kind: "pause", durationMs: 250 },
    { kind: "cameraFocus", target: { testId: "card" }, durationMs: 1200 },
    { kind: "cameraZoom", zoom: 1.4, durationMs: 1200 },
    { kind: "cameraHold", durationMs: 250 },
    { kind: "cameraReturn", durationMs: 1200 },
  ];

  assert.deepEqual(validateScenario(scenario), { ok: true, errors: [] });
});

test("validator reports actionable JSON pointers and rejects unstable selectors", async () => {
  const { validateScenario } = await import(scenarioModule);
  const scenario = validScenario();
  scenario.profile.kind = "tablet";
  scenario.story.actions = [
    { kind: "click", target: { css: ".primary > button" }, shell: "touch /tmp/pwned" },
    { kind: "click", target: { role: "button", name: "Save", exact: false } },
    { kind: "script", javascript: "window.alert(1)" },
  ];
  const result = validateScenario(scenario);

  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.pointer === "/profile/kind" && /desktop|native-mobile/.test(error.message)));
  assert(result.errors.some((error) => error.pointer === "/story/actions/0/target" && /testId|role/.test(error.message)));
  assert(result.errors.some((error) => error.pointer === "/story/actions/0/shell" && /unknown/.test(error.message)));
  assert(result.errors.some((error) => error.pointer === "/story/actions/1/target/exact" && /unknown|exact/.test(error.message)));
  assert(result.errors.some((error) => error.pointer === "/story/actions/2/kind" && /unsupported/.test(error.message)));
  assert(result.errors.some((error) => error.pointer === "/story/actions/2/javascript" && /unknown/.test(error.message)));
});

test("native-mobile requires a portrait native viewport", async () => {
  const { validateScenario } = await import(scenarioModule);
  const scenario = validScenario();
  scenario.profile = {
    kind: "native-mobile",
    viewport: { width: 932, height: 430 },
    deviceScaleFactor: 3,
  };
  const result = validateScenario(scenario);
  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.pointer === "/profile/viewport" && /portrait|native-mobile/.test(error.message)));

  scenario.profile.viewport = { width: 430, height: 932 };
  scenario.camera.maxZoom = 1.18;
  scenario.story.actions[6].zoom = 1.1;
  assert.deepEqual(validateScenario(scenario), { ok: true, errors: [] });
});

test("production profiles reject eval-sized viewports and enforce native zoom cap", async () => {
  const { validateScenario } = await import(scenarioModule);
  const desktop = validScenario();
  desktop.profile.viewport = { width: 1440, height: 900 };
  const desktopResult = validateScenario(desktop);
  assert(desktopResult.errors.some((error) => error.pointer === "/profile/viewport" && /1920x1200/.test(error.message)));

  const mobile = validScenario();
  mobile.profile = { kind: "native-mobile", viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 };
  mobile.camera.maxZoom = 1.19;
  mobile.story.actions[6].zoom = 1.1;
  const mobileResult = validateScenario(mobile);
  assert(mobileResult.errors.some((error) => error.pointer === "/camera/maxZoom" && /1\.18/.test(error.message)));
});

test("settles and semantic camera transitions enforce stable minimum durations", async () => {
  const { validateScenario } = await import(scenarioModule);
  const scenario = validScenario();
  scenario.story.openingSettleMs = 399;
  scenario.story.endingSettleMs = 399;
  scenario.story.actions = [
    { kind: "cameraFocus", target: { testId: "card" }, durationMs: 1199 },
    { kind: "cameraHold", durationMs: 239 },
    { kind: "cameraReturn", durationMs: 1199 },
  ];
  const result = validateScenario(scenario);
  assert(result.errors.some((error) => error.pointer === "/story/openingSettleMs" && /400/.test(error.message)));
  assert(result.errors.some((error) => error.pointer === "/story/endingSettleMs" && /400/.test(error.message)));
  assert(result.errors.some((error) => error.pointer === "/story/actions/0/durationMs" && /1200/.test(error.message)));
  assert(result.errors.some((error) => error.pointer === "/story/actions/1/durationMs" && /240/.test(error.message)));
  assert(result.errors.some((error) => error.pointer === "/story/actions/2/durationMs" && /1200/.test(error.message)));
});

test("extension primitives require an explicit caller allowlist", async () => {
  const { validateScenario } = await import(scenarioModule);
  const scenario = validScenario();
  scenario.story.actions = [{
    kind: "extension",
    primitiveId: "kandev.select-worktree",
    input: { name: "demo" },
    durationMs: 300,
  }];

  const rejected = validateScenario(scenario);
  assert.equal(rejected.ok, false);
  assert(rejected.errors.some((error) => error.pointer === "/story/actions/0/primitiveId" && /allowlist/.test(error.message)));
  assert.deepEqual(
    validateScenario(scenario, { allowedExtensionIds: ["kandev.select-worktree"] }),
    { ok: true, errors: [] },
  );
});

test("setup primitives are allowlisted and remain outside the recording timeline", async () => {
  const { compileTimeline, validateScenario } = await import(scenarioModule);
  const scenario = validScenario();
  scenario.setup.primitives = [{ primitiveId: "kandev.open-board", input: { column: "Todo" } }];
  const rejected = validateScenario(scenario);
  assert(rejected.errors.some((error) => error.pointer === "/setup/primitives/0/primitiveId" && /allowlist/.test(error.message)));

  const options = { allowedExtensionIds: ["kandev.open-board"] };
  assert.deepEqual(validateScenario(scenario, options), { ok: true, errors: [] });
  const timeline = compileTimeline(scenario, options);
  assert.equal(timeline.setup.route, "workspace.board");
  assert.equal(timeline.setup.primitives[0].primitiveId, "kandev.open-board");
  assert.equal(timeline.events[0].kind, "openingSettle");
  assert(timeline.events.every((event) => event.kind !== "extension"));
});

test("camera zoom stays explicit and inside declared bounds", async () => {
  const { validateScenario } = await import(scenarioModule);
  const noCamera = validScenario();
  delete noCamera.camera;
  noCamera.story.actions = [{ kind: "click", target: { testId: "save" } }];
  assert.deepEqual(validateScenario(noCamera), { ok: true, errors: [] });

  const scenario = validScenario();
  scenario.story.actions = [{ kind: "cameraZoom", zoom: 2.4, durationMs: 1200 }];
  const result = validateScenario(scenario);
  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.pointer === "/story/actions/0/zoom" && /1.*1\.5|bounds/.test(error.message)));

  const identity = validScenario();
  identity.camera.minZoom = 1.1;
  const identityResult = validateScenario(identity);
  assert(identityResult.errors.some((error) => error.pointer === "/camera/minZoom" && /identity|1/.test(error.message)));
});

test("camera focus and zoom are separate unambiguous intents", async () => {
  const { validateScenario } = await import(scenarioModule);
  const scenario = validScenario();
  scenario.story.actions = [{ kind: "cameraFocus", target: { testId: "card" }, zoom: 1.25, durationMs: 1200 }];
  const result = validateScenario(scenario);
  assert.equal(result.ok, false);
  assert(result.errors.some((error) => error.pointer === "/story/actions/0/zoom" && /unknown/.test(error.message)));
});

test("canonical digest ignores object key order but detects semantic changes", async () => {
  const { canonicalScenarioJson, computeScenarioDigest } = await import(scenarioModule);
  const scenario = validScenario();
  const reordered = JSON.parse(JSON.stringify(scenario, Object.keys(scenario).reverse()));
  const recursivelyReordered = reverseKeys(scenario);

  assert.equal(computeScenarioDigest(scenario), computeScenarioDigest(recursivelyReordered));
  assert.equal(canonicalScenarioJson(scenario), canonicalScenarioJson(recursivelyReordered));
  recursivelyReordered.story.actions[0].durationMs += 1;
  assert.notEqual(computeScenarioDigest(scenario), computeScenarioDigest(recursivelyReordered));
  assert.equal(typeof reordered, "object");
});

test("timeline compiler is deterministic and keeps cursor and camera events independent", async () => {
  const { compileTimeline } = await import(scenarioModule);
  const scenario = validScenario();
  const first = compileTimeline(scenario);
  const second = compileTimeline(reverseKeys(scenario));

  assert.deepEqual(first, second);
  assert.match(first.scenarioDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.events[0].kind, "openingSettle");
  assert.equal(first.events.at(-1).kind, "endingSettle");
  const cursor = first.events.find((event) => event.kind === "moveCursor");
  const camera = first.events.find((event) => event.kind === "cameraFocus");
  const click = first.events.find((event) => event.kind === "click");
  const type = first.events.find((event) => event.kind === "type");
  assert.notEqual(cursor.index, camera.index);
  assert.equal(camera.movesCursor, false);
  assert.equal(click.movesCursor, true);
  assert.equal(click.cursorDurationMs, 350);
  assert.equal(click.activationDurationMs, 120);
  assert.equal(type.movesCursor, true);
  assert.equal(type.cursorDurationMs, 350);
  assert.equal(type.activationDurationMs, 120);
  assert.equal(first.totalDurationMs, first.events.at(-1).endMs);
});

test("wait timeout bounds failures without reserving a storyboard hold", async () => {
  const { compileTimeline, renderStoryboard, validateScenario } = await import(scenarioModule);
  const scenario = validScenario();
  scenario.story.openingSettleMs = 400;
  scenario.story.actions = [
    { kind: "waitForVisible", target: { testId: "ready" }, timeoutMs: 5_000 },
    { kind: "waitForState", target: { testId: "save" }, state: "enabled", timeoutMs: 5_000 },
  ];
  scenario.story.endingSettleMs = 400;

  assert.deepEqual(validateScenario(scenario), { ok: true, errors: [] });
  const timeline = compileTimeline(scenario);
  const waits = timeline.events.filter((event) => event.kind.startsWith("waitFor"));
  assert.deepEqual(waits.map(({ startMs, endMs, actionDurationMs, timeoutBoundMs }) => ({
    startMs,
    endMs,
    actionDurationMs,
    timeoutBoundMs,
  })), [
    { startMs: 400, endMs: 400, actionDurationMs: 0, timeoutBoundMs: 5_000 },
    { startMs: 400, endMs: 400, actionDurationMs: 0, timeoutBoundMs: 5_000 },
  ]);
  assert.equal(timeline.totalDurationMs, 800);
  assert.match(renderStoryboard(timeline), /timeout bound 5000ms; adds no hold/i);
});

test("storyboard renders machine JSON and human Markdown", async () => {
  const { compileTimeline, renderStoryboard } = await import(scenarioModule);
  const timeline = compileTimeline(validScenario());
  const machine = JSON.parse(renderStoryboard(timeline, { format: "json" }));
  const markdown = renderStoryboard(timeline, { format: "markdown" });

  assert.equal(machine.scenarioId, "short-task-story");
  assert.match(markdown, /^# Storyboard: Create a task from the board/m);
  assert.match(markdown, /\| Start \| End \| Kind \| Intent \|/);
  assert.match(markdown, /cameraFocus.*Review API/);
});

test("scaffold refuses overwrite and dry-run leaves no file", async () => {
  const { writeScenarioScaffold } = await import(scenarioModule);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-scenario-"));
  tempDirs.push(dir);
  const destination = path.join(dir, "demo.scenario.json");

  const preview = await writeScenarioScaffold({ destination, id: "demo", profileKind: "native-mobile", dryRun: true });
  assert.equal(preview.scenario.profile.kind, "native-mobile");
  assert.equal(preview.scenario.delivery, undefined);
  assert.match(preview.scenario.description, /TODO.*delivery metadata.*promotion/i);
  await assert.rejects(fs.access(destination));

  await writeScenarioScaffold({ destination, id: "demo", profileKind: "desktop" });
  await assert.rejects(writeScenarioScaffold({ destination, id: "demo" }), /exists|overwrite/i);
});

test("quick-start template is checked in, promotion-ready, and digest-stable", async () => {
  const {
    compileTimeline,
    computeScenarioDigest,
    readScenarioTemplate,
    requireDeliveryMetadata,
    validateScenario,
  } = await import(scenarioModule);
  const checkedIn = JSON.parse(
    await fs.readFile(
      new URL("./examples/quick-start.scenario.json", import.meta.url),
      "utf8",
    ),
  );

  const first = await readScenarioTemplate("quick-start");
  const second = await readScenarioTemplate("quick-start");

  assert.deepEqual(first, checkedIn);
  assert.notEqual(first, second);
  assert.deepEqual(validateScenario(first), { ok: true, errors: [] });
  assert.equal(first.seed.recipe, "kandev.highlight.quick-start");
  assert.equal(first.setup.route, "workspace.board");
  assert.equal(first.profile.kind, "desktop");
  assert.equal(requireDeliveryMetadata(first).highlight.mobileRequired, false);
  assert.equal(first.delivery.docs.page, "tasks-and-workflows.md");
  assert.equal(first.delivery.docs.section, "Create a task");
  const click = first.story.actions.find((action) => action.kind === "click");
  assert.equal(click.cursorDurationMs, 1_000);
  const timeline = compileTimeline(first);
  const clickEvent = timeline.events.find(
    (event) => event.sourcePointer === "/story/actions/1",
  );
  assert.equal(clickEvent.cursorDurationMs, 1_000);
  assert.equal(clickEvent.actionDurationMs, 1_120);
  assert.ok(timeline.totalDurationMs <= 4_000);
  assert.equal(computeScenarioDigest(first), computeScenarioDigest(second));
  assert.doesNotMatch(JSON.stringify(first), /replace-with|TODO|kandev\.empty-workspace/);
  for (const action of first.story.actions) {
    for (const target of [action.target, action.from, action.to].filter(Boolean)) {
      assert.ok(target.testId || (target.role && target.name));
      assert.equal("css" in target || "xpath" in target, false);
    }
  }
});

test("quick-start template scaffolds a runnable scenario without edits", async () => {
  const { computeScenarioDigest, readScenario, readScenarioTemplate, writeScenarioScaffold } = await import(scenarioModule);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-template-"));
  tempDirs.push(dir);
  const destination = path.join(dir, "fresh-agent.scenario.json");
  const canonical = await readScenarioTemplate("quick-start");

  const preview = await writeScenarioScaffold({
    destination,
    templateId: "quick-start",
    dryRun: true,
  });
  assert.equal(preview.scenario.id, "quick-start");
  assert.equal(preview.scenario.title, "Quick start");
  assert.equal(preview.scenario.delivery.revision, "r1");
  assert.equal(computeScenarioDigest(preview.scenario), computeScenarioDigest(canonical));
  await assert.rejects(fs.access(destination), /ENOENT/);

  await writeScenarioScaffold({
    destination,
    templateId: "quick-start",
  });
  assert.equal((await readScenario(destination)).seed.recipe, "kandev.highlight.quick-start");
  await assert.rejects(
    writeScenarioScaffold({ destination, templateId: "quick-start" }),
    /overwrite|exists/i,
  );
});

for (const { flag, override } of [
  { flag: "--id", override: { id: "quick-start" } },
  { flag: "--title", override: { title: "Quick start" } },
  { flag: "--profile", override: { profileKind: "desktop" } },
]) {
  test(`quick-start template rejects ${flag} override even when value is canonical`, async () => {
    const { writeScenarioScaffold } = await import(scenarioModule);
    await assert.rejects(
      writeScenarioScaffold({
        destination: path.resolve(`/tmp/quick-start-${flag.slice(2)}.json`),
        templateId: "quick-start",
        ...override,
        dryRun: true,
      }),
      new RegExp(`quick-start.*canonical.*does not accept ${flag}`, "i"),
    );
  });
}

test("template selection is closed and rejects unsupported native-mobile output", async () => {
  const { readScenarioTemplate, writeScenarioScaffold } = await import(scenarioModule);
  await assert.rejects(readScenarioTemplate("../custom.mjs"), /unknown scenario template/i);
  await assert.rejects(readScenarioTemplate("toString"), /unknown scenario template/i);
  await assert.rejects(
    writeScenarioScaffold({
      destination: "/external/not-written.json",
      templateId: "quick-start",
      profileKind: "native-mobile",
      dryRun: true,
    }),
    /quick-start.*desktop|native-mobile.*template/i,
  );
});

test("CLI validate disambiguates catalog and scenario while dry-run stays useful", async () => {
  const script = path.resolve("scripts/highlights.mjs");
  const example = path.resolve("scripts/highlights/examples/quick-start.scenario.json");
  const scenarioValidation = spawnSync(process.execPath, [script, "validate", example], { encoding: "utf8" });
  assert.equal(scenarioValidation.status, 0, scenarioValidation.stderr);
  assert.match(scenarioValidation.stdout, /Validated scenario quick-start/);
  assert.match(scenarioValidation.stdout, /sha256:/);

  const catalogValidation = spawnSync(process.execPath, [script, "validate"], { encoding: "utf8" });
  assert.equal(catalogValidation.status, 0, catalogValidation.stderr);
  assert.match(catalogValidation.stdout, /Validated 0 Highlights/);

  const storyboard = spawnSync(process.execPath, [script, "storyboard", example, "--format", "markdown", "--dry-run"], { encoding: "utf8" });
  assert.equal(storyboard.status, 0, storyboard.stderr);
  assert.match(storyboard.stdout, /# Storyboard: Quick start/);
  assert.match(storyboard.stdout, /Dry run:/);
});

test("CLI scaffold previews, writes once, and refuses overwrite", async () => {
  const script = path.resolve("scripts/highlights.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-cli-scaffold-"));
  tempDirs.push(dir);
  const destination = path.join(dir, "cli-demo.scenario.json");
  const args = [script, "scaffold", destination, "--id", "cli-demo", "--profile", "native-mobile"];

  const preview = spawnSync(process.execPath, [...args, "--dry-run"], { encoding: "utf8" });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Dry run:/);
  await assert.rejects(fs.access(destination));

  const write = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(write.status, 0, write.stderr);
  const scenario = JSON.parse(await fs.readFile(destination, "utf8"));
  assert.equal(scenario.profile.kind, "native-mobile");

  const collision = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.notEqual(collision.status, 0);
  assert.match(collision.stderr, /overwrite|exists/i);
});

test("CLI quick-start template needs no id or manual JSON edits", async () => {
  const script = path.resolve("scripts/highlights.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-cli-template-"));
  tempDirs.push(dir);
  const destination = path.join(dir, "quick-start.scenario.json");
  const args = [script, "scaffold", destination, "--template", "quick-start"];

  const preview = spawnSync(process.execPath, [...args, "--dry-run"], {
    encoding: "utf8",
  });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /kandev\.highlight\.quick-start/);
  assert.match(preview.stdout, /"delivery"/);
  await assert.rejects(fs.access(destination), /ENOENT/);

  const write = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(write.status, 0, write.stderr);
  const scenario = JSON.parse(await fs.readFile(destination, "utf8"));
  assert.equal(scenario.id, "quick-start");
  assert.equal(scenario.delivery.mobileRequired, false);

  const native = spawnSync(
    process.execPath,
    [...args, "--profile", "native-mobile", "--dry-run"],
    { encoding: "utf8" },
  );
  assert.notEqual(native.status, 0);
  assert.match(native.stderr, /quick-start.*desktop|native-mobile.*template/i);
});

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
}
