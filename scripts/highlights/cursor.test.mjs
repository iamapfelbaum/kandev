import assert from "node:assert/strict";
import test from "node:test";

import { buildCursorTrajectory, createCursorController } from "./cursor.mjs";

test("cursor trajectory is eased, dense, bounded, and ends exactly at target", () => {
  const samples = buildCursorTrajectory({
    from: { x: 10, y: 20 },
    to: { x: 610, y: 320 },
    durationMs: 384,
  });

  assert.ok(samples.length >= 12);
  assert.deepEqual(samples.at(-1), {
    offsetMs: 384,
    progress: 1,
    x: 610,
    y: 320,
  });
  for (let index = 1; index < samples.length; index += 1) {
    assert.ok(samples[index].progress > samples[index - 1].progress);
    assert.ok(Math.hypot(
      samples[index].x - samples[index - 1].x,
      samples[index].y - samples[index - 1].y,
    ) <= 44.000001);
  }
  assert.ok(samples[0].progress < 1 / samples.length);
});

test("controller drives every sample through trusted input and records independent geometry", async () => {
  let time = 0;
  const moves = [];
  const waits = [];
  const page = {
    mouse: {
      async move(x, y) {
        moves.push({ x, y });
        time += 7;
      },
    },
    async waitForTimeout(ms) {
      waits.push(ms);
      time += ms;
    },
  };
  const controller = createCursorController({
    page,
    viewport: { width: 800, height: 600 },
    now: () => time,
    measurePointerGlyph: async ({ x, y }) => ({ x, y, width: 18, height: 22 }),
  });

  await controller.resync({ x: 40, y: 50 });
  const targetBounds = { x: 650, y: 480, width: 80, height: 40 };
  const targetGlyphBounds = { x: 664, y: 491, width: 42, height: 16 };
  const movement = await controller.moveTo(
    { x: 690, y: 500 },
    { durationMs: 384, targetBounds, targetGlyphBounds, label: "Save" },
  );
  controller.finishVisibility();

  assert.equal(moves.length, movement.samples.length + 1);
  assert.ok(movement.samples.length >= 12);
  assert.ok(waits.every((value) => value >= 4 && value <= 32));
  assert.deepEqual(moves.at(-1), { x: 690, y: 500 });
  assert.notStrictEqual(movement.samples[0].targetBounds, movement.samples[0].pointerGlyphBounds);
  assert.notStrictEqual(movement.samples[0].targetGlyphBounds, movement.samples[0].pointerGlyphBounds);
  assert.equal(movement.visibility.startMs, movement.startedAtMs);
  assert.ok(Number.isFinite(movement.visibility.endMs));
});

test("cursor duration is an absolute schedule that absorbs bounded input and glyph proof cost", async () => {
  let time = 0;
  let measurements = 0;
  const page = {
    mouse: {
      async move() {
        time += 5;
      },
    },
    async waitForTimeout(ms) {
      time += ms;
    },
  };
  const controller = createCursorController({
    page,
    viewport: { width: 1920, height: 1200 },
    now: () => time,
    measurePointerGlyph: async ({ x, y }) => {
      measurements += 1;
      time += 7;
      return { x: x - 10, y: y - 10, width: 20, height: 20 };
    },
  });

  await controller.resync({ x: 200, y: 900 });
  const movement = await controller.moveTo(
    { x: 1700, y: 100 },
    { durationMs: 1_000, label: "Create task" },
  );

  assert.ok(movement.samples.length > 12, "long motion retains bounded native steps");
  assert.equal(
    measurements,
    3,
    "resync plus independently measured movement endpoints are enough to prove a fixed glyph path",
  );
  assert.equal(movement.schedule.requestedDurationMs, 1_000);
  assert.ok(movement.schedule.overrunMs <= 16);
  assert.equal(movement.samples[0].pointerGlyphProof, "measured");
  assert.equal(movement.samples.at(-1).pointerGlyphProof, "measured");
  assert.ok(
    movement.samples.slice(1, -1).every((sample) => sample.pointerGlyphProof === "projected"),
  );
});

test("cursor reports an actionable schedule overrun when trusted input cannot meet declared duration", async () => {
  let time = 0;
  const page = {
    mouse: {
      async move() {
        time += 80;
      },
    },
    async waitForTimeout(ms) {
      time += ms;
    },
  };
  const controller = createCursorController({
    page,
    viewport: { width: 800, height: 600 },
    now: () => time,
    measurePointerGlyph: async ({ x, y }) => ({
      x: x - 10,
      y: y - 10,
      width: 20,
      height: 20,
    }),
  });
  await controller.resync({ x: 100, y: 100 });

  await assert.rejects(
    controller.moveTo(
      { x: 700, y: 500 },
      { durationMs: 320, label: "Slow target" },
    ),
    /Slow target.*cursor schedule.*increase cursorDurationMs/i,
  );
});

test("controller rejects a clipped pointer glyph with movement context", async () => {
  let time = 0;
  const page = {
    mouse: { async move() { time += 1; } },
    async waitForTimeout(ms) { time += ms; },
  };
  const controller = createCursorController({
    page,
    viewport: { width: 100, height: 100 },
    now: () => time,
    measurePointerGlyph: async ({ x, y }) => ({ x, y, width: 20, height: 20 }),
  });
  await controller.resync({ x: 20, y: 20 });

  await assert.rejects(
    controller.moveTo({ x: 95, y: 95 }, { label: "edge", durationMs: 320 }),
    /edge.*pointer glyph.*viewport/i,
  );
});
