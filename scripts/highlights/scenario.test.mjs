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
  assert.deepEqual(validateScenario(example), { ok: true, errors: [] });
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
  await assert.rejects(fs.access(destination));

  await writeScenarioScaffold({ destination, id: "demo", profileKind: "desktop" });
  await assert.rejects(writeScenarioScaffold({ destination, id: "demo" }), /exists|overwrite/i);
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

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
}
