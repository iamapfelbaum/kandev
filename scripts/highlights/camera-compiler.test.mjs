import assert from "node:assert/strict";
import test from "node:test";

import { buildLandingPointerTrack, compileCamera, resolveCaptureProfile } from "./camera-compiler.mjs";
import { compileTimeline } from "./scenario.mjs";

function scenario(actions = [], profileKind = "desktop") {
  const mobile = profileKind === "native-mobile";
  return {
    schemaVersion: 1,
    id: "camera-story",
    title: "Camera story",
    profile: {
      kind: profileKind,
      viewport: mobile ? { width: 430, height: 932 } : { width: 1920, height: 1200 },
      deviceScaleFactor: mobile ? 3 : 2,
    },
    seed: { recipe: "kandev.camera-story" },
    setup: { route: "workspace.board", primitives: [] },
    story: { openingSettleMs: 400, endingSettleMs: 400, actions },
    camera: {
      minZoom: 1,
      maxZoom: mobile ? 1.18 : 1.5,
      safeMarginPx: mobile ? 24 : 48,
      glyphPaddingPx: 10,
      maxPanVelocityPxPerSecond: 1200,
      maxPanAccelerationPxPerSecond2: 3600,
      maxZoomRatePerSecond: 0.6,
      easing: "easeInOutCubic",
    },
  };
}

const focusEvent = {
  stepIndex: 1,
  sourcePointer: "/story/actions/1",
  label: "Create task",
  targetBounds: { left: 0.72, right: 0.97, top: 0.68, bottom: 0.94 },
  targetGlyphBounds: { left: 0.75, right: 0.95, top: 0.72, bottom: 0.9 },
};

test("desktop and native-mobile profiles preserve exact native capture contracts", () => {
  assert.deepEqual(resolveCaptureProfile({
    kind: "desktop",
    viewport: { width: 1920, height: 1200 },
    deviceScaleFactor: 2,
  }), {
    kind: "desktop",
    formFactor: "desktop",
    cssWidth: 1920,
    cssHeight: 1200,
    dpr: 2,
    sourceWidth: 3840,
    sourceHeight: 2400,
    deliveryWidth: 1920,
    deliveryHeight: 1200,
    fps: 25,
    maxZoom: 1.5,
    nativeMobile: false,
  });
  const mobile = resolveCaptureProfile({
    kind: "native-mobile",
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 3,
  });
  assert.equal(mobile.formFactor, "mobile");
  assert.equal(mobile.sourceWidth, 1290);
  assert.equal(mobile.sourceHeight, 2796);
  assert.equal(mobile.deliveryWidth, 1290);
  assert.equal(mobile.nativeMobile, true);
  assert.throws(
    () => resolveCaptureProfile({ kind: "native-mobile", viewport: { width: 1200, height: 700 }, deviceScaleFactor: 3 }),
    /native-mobile.*430x932|portrait/i,
  );
});

test("camera is settled identity when story has no camera action", () => {
  const input = scenario([{ kind: "pause", durationMs: 240 }]);
  const config = compileCamera({ scenario: input, timeline: compileTimeline(input) });

  assert.equal(config.cameraProfile, "highlight-desktop");
  assert.equal(Object.hasOwn(config, "keyframes"), false);
  assert.equal(config.durationMs, 1_040);
  assert.equal(config.openingSettleMs, 400);
  assert.equal(config.endingSettleMs, 400);
  assert.equal(Object.hasOwn(config, "workingZoom"), false);
  assert.equal(Object.hasOwn(config, "pointerTrack"), false);
  assert.deepEqual(config.cameraDirectives, []);
});

test("literal focus, zoom, hold, return sequence contains glyph and keeps stable working depth", () => {
  const input = scenario([
    { kind: "cameraZoom", zoom: 1.45, durationMs: 1_200 },
    { kind: "cameraFocus", target: { testId: "create-task" }, durationMs: 1_200 },
    { kind: "cameraHold", durationMs: 1_000 },
    { kind: "cameraReturn", durationMs: 1_200 },
  ]);
  const config = compileCamera({
    scenario: input,
    timeline: compileTimeline(input),
    semanticEvents: [focusEvent],
  });

  assert.equal(config.cameraProfile, "highlight-desktop");
  assert.equal(Object.hasOwn(config, "keyframes"), false);
  assert.deepEqual(config.cameraDirectives.map(({ type }) => type), ["zoom", "focus", "hold", "return"]);
  assert.deepEqual(config.cameraDirectives[0], {
    type: "zoom",
    atMs: 400,
    zoom: 1.45,
    transitionMs: 1_200,
  });
  assert.equal(config.cameraDirectives[1].atMs, 1_600);
  assert.equal(config.cameraDirectives[1].transitionMs, 1_200);
  assert.equal(config.cameraDirectives[1].target.label, "Create task");
  assert.ok(config.cameraDirectives[1].target.bounds.left < focusEvent.targetBounds.left);
  assert.ok(config.cameraDirectives[1].target.bounds.right > focusEvent.targetGlyphBounds.right);
  assert.deepEqual(config.cameraDirectives[2], { type: "hold", atMs: 2_800, durationMs: 1_000 });
  assert.deepEqual(config.cameraDirectives[3], { type: "return", atMs: 3_800, transitionMs: 1_200 });
  assert.equal(Object.hasOwn(config, "workingZoom"), false);
  assert.equal(config.durationMs, 5_400);
});

test("camera compilation never derives movement from cursor path", () => {
  const input = scenario([
    { kind: "cameraZoom", zoom: 1.4, durationMs: 1_200 },
    { kind: "cameraFocus", target: { testId: "create-task" }, durationMs: 1_200 },
    { kind: "cameraHold", durationMs: 400 },
    { kind: "cameraReturn", durationMs: 1_200 },
  ]);
  const timeline = compileTimeline(input);
  const left = compileCamera({
    scenario: input,
    timeline,
    semanticEvents: [focusEvent],
    pointerTrack: [
      { tMs: 0, x: 0.5, y: 0.72 },
      { tMs: 400, x: 0.5, y: 0.72 },
      { tMs: 800, x: 0.8, y: 0.8 },
      { tMs: 4_400, x: 0.8, y: 0.8 },
      { tMs: 4_800, x: 0.8, y: 0.8 },
    ],
  });
  const right = compileCamera({
    scenario: input,
    timeline,
    semanticEvents: [focusEvent],
    pointerTrack: [
      { tMs: 0, x: 0.5, y: 0.72 },
      { tMs: 400, x: 0.5, y: 0.72 },
      { tMs: 800, x: 0.81, y: 0.8 },
      { tMs: 4_400, x: 0.81, y: 0.8 },
      { tMs: 4_800, x: 0.81, y: 0.8 },
    ],
  });
  assert.deepEqual(left.cameraDirectives, right.cameraDirectives);
  assert.notDeepEqual(left.pointerTrack, right.pointerTrack);
});

test("landing pointer builder uses initial resync and settled strictly increasing bookends", () => {
  const track = buildLandingPointerTrack({
    execution: {
      storyEpochMs: 1_000,
      cursorResyncEvidence: [{
        point: { x: 960, y: 864 },
        startedAtMs: 970,
        endedAtMs: 980,
      }],
      cursorEvidence: [{
        samples: [
          { storyTMs: 700, x: 1_000, y: 800 },
          { storyTMs: 1_100, x: 1_100, y: 720 },
        ],
      }],
    },
    captureProfile: resolveCaptureProfile(scenario().profile),
    durationMs: 2_400,
    openingSettleMs: 400,
    endingSettleMs: 400,
  });

  assert.deepEqual(track, [
    { tMs: 0, x: 0.5, y: 0.72 },
    { tMs: 400, x: 0.5, y: 0.72 },
    { tMs: 700, x: 1_000 / 1_920, y: 800 / 1_200 },
    { tMs: 1_100, x: 1_100 / 1_920, y: 0.6 },
    { tMs: 2_000, x: 1_100 / 1_920, y: 0.6 },
    { tMs: 2_400, x: 1_100 / 1_920, y: 0.6 },
  ]);
  assert.ok(track.every((point, index) => index === 0 || point.tMs > track[index - 1].tMs));
  assert.deepEqual(track[0], { ...track[1], tMs: 0 });
  assert.deepEqual(track.at(-1), { ...track.at(-2), tMs: 2_400 });
});

test("compiler builds a landing-compatible pointer track directly from execution evidence", () => {
  const input = scenario([{ kind: "pause", durationMs: 1_600 }]);
  const timeline = compileTimeline(input);
  const plan = compileCamera({
    scenario: input,
    timeline,
    execution: {
      cursorResyncEvidence: [{ point: { x: 960, y: 864 } }],
      cursorEvidence: [],
    },
  });
  assert.deepEqual(plan.pointerTrack, [
    { tMs: 0, x: 0.5, y: 0.72 },
    { tMs: 400, x: 0.5, y: 0.72 },
    { tMs: 2_000, x: 0.5, y: 0.72 },
    { tMs: 2_400, x: 0.5, y: 0.72 },
  ]);
});

test("compiler rejects mismatched timeline, missing focus geometry, and profile zoom overflow", () => {
  const focusOnly = scenario([{ kind: "cameraFocus", target: { testId: "create-task" }, durationMs: 1_200 }]);
  assert.throws(
    () => compileCamera({ scenario: focusOnly, timeline: compileTimeline(focusOnly) }),
    /\/story\/actions\/0.*focus geometry/i,
  );
  const overflow = scenario([{ kind: "cameraZoom", zoom: 1.1, durationMs: 1_200 }], "native-mobile");
  const validTimeline = compileTimeline(overflow);
  overflow.story.actions[0].zoom = 1.5;
  assert.throws(
    () => compileCamera({ scenario: overflow, timeline: validTimeline }),
    /zoom.*1\.5.*1\.18|maximum.*1\.18/i,
  );
});
