const DEFAULT_SAMPLE_INTERVAL_MS = 32;
const DEFAULT_MAX_STEP_PX = 44;
const DEFAULT_MIN_SAMPLES = 12;
const DEFAULT_MIN_WAIT_MS = 4;
const DEFAULT_MAX_SCHEDULE_OVERRUN_MS = 64;

function finite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function point(value, label) {
  if (!value || typeof value !== "object") throw new Error(`${label} must be a point`);
  return { x: finite(value.x, `${label}.x`), y: finite(value.y, `${label}.y`) };
}

function positive(value, fallback, label) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(`${label} must be positive`);
  return resolved;
}

function easeInOutCubic(value) {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function createSamples(from, to, durationMs, count) {
  return Array.from({ length: count }, (_, rawIndex) => {
    const index = rawIndex + 1;
    const linear = index / count;
    const progress = easeInOutCubic(linear);
    return {
      offsetMs: index === count ? durationMs : (durationMs * index) / count,
      progress,
      x: index === count ? to.x : from.x + (to.x - from.x) * progress,
      y: index === count ? to.y : from.y + (to.y - from.y) * progress,
    };
  });
}

function largestStep(from, samples) {
  let prior = from;
  let largest = 0;
  for (const sample of samples) {
    largest = Math.max(largest, Math.hypot(sample.x - prior.x, sample.y - prior.y));
    prior = sample;
  }
  return largest;
}

export function buildCursorTrajectory({
  from,
  to,
  durationMs = 350,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  maxStepPx = DEFAULT_MAX_STEP_PX,
  minSamples = DEFAULT_MIN_SAMPLES,
} = {}) {
  const origin = point(from, "from");
  const destination = point(to, "to");
  positive(durationMs, undefined, "durationMs");
  positive(sampleIntervalMs, undefined, "sampleIntervalMs");
  positive(maxStepPx, undefined, "maxStepPx");
  if (!Number.isInteger(minSamples) || minSamples < 2) throw new Error("minSamples must be an integer >= 2");

  let count = Math.max(minSamples, Math.ceil(durationMs / sampleIntervalMs));
  let samples = createSamples(origin, destination, durationMs, count);
  while (largestStep(origin, samples) > maxStepPx + 1e-9) {
    count += 1;
    if (count > 2_000) throw new Error("cursor trajectory exceeds safe sample count");
    samples = createSamples(origin, destination, durationMs, count);
  }
  return samples;
}

function cloneRect(rect) {
  if (rect === undefined || rect === null) return null;
  const result = {};
  for (const key of ["x", "y", "width", "height"]) {
    result[key] = finite(rect[key], `bounds.${key}`);
  }
  return result;
}

function translateRect(rect, from, to) {
  const source = point(from, "pointer glyph projection source");
  const destination = point(to, "pointer glyph projection destination");
  return {
    x: rect.x + destination.x - source.x,
    y: rect.y + destination.y - source.y,
    width: rect.width,
    height: rect.height,
  };
}

function assertStableGlyphProjection(expected, measured, label) {
  const tolerance = 0.75;
  if (
    ["x", "y", "width", "height"].some(
      (key) => Math.abs(expected[key] - measured[key]) > tolerance,
    )
  ) {
    throw new Error(
      `${label}: pointer glyph geometry changed during movement; expected ${JSON.stringify(expected)}, measured ${JSON.stringify(measured)}`,
    );
  }
}

function assertGlyphContained(rect, viewport, label) {
  if (!rect) throw new Error(`${label}: pointer glyph measurement is required`);
  const epsilon = 1e-6;
  if (
    rect.x < -epsilon ||
    rect.y < -epsilon ||
    rect.x + rect.width > viewport.width + epsilon ||
    rect.y + rect.height > viewport.height + epsilon
  ) {
    throw new Error(`${label}: pointer glyph leaves viewport (${JSON.stringify(rect)})`);
  }
}

function defaultNow() {
  return performance.now();
}

export function createCursorController({
  page,
  viewport,
  now = defaultNow,
  measurePointerGlyph,
  trustedInput,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  maxStepPx = DEFAULT_MAX_STEP_PX,
  minSamples = DEFAULT_MIN_SAMPLES,
  minWaitMs = DEFAULT_MIN_WAIT_MS,
  maxScheduleOverrunMs = DEFAULT_MAX_SCHEDULE_OVERRUN_MS,
} = {}) {
  if (!page || typeof page !== "object") throw new Error("cursor controller needs a page");
  if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) {
    throw new Error("cursor controller needs finite viewport dimensions");
  }
  if (typeof now !== "function") throw new Error("cursor controller now must be a function");
  if (typeof measurePointerGlyph !== "function") {
    throw new Error("cursor controller needs independent pointer glyph measurement");
  }
  positive(minWaitMs, undefined, "minWaitMs");
  if (!Number.isFinite(maxScheduleOverrunMs) || maxScheduleOverrunMs < 0) {
    throw new Error("maxScheduleOverrunMs must be non-negative");
  }
  const sendTrustedInput = trustedInput ?? (async ({ x, y }) => {
    if (typeof page.mouse?.move !== "function") throw new Error("page has no trusted pointer input adapter");
    await page.mouse.move(x, y);
  });
  if (typeof sendTrustedInput !== "function") throw new Error("trustedInput must be a function");

  let current = null;
  let activeMovement = null;
  const movements = [];
  const resyncs = [];

  function finishVisibility(endMs = now()) {
    if (!activeMovement || activeMovement.visibility.endMs !== null) return;
    activeMovement.visibility.endMs = endMs;
    activeMovement = null;
  }

  async function resync(destination, metadata = {}) {
    const next = point(destination, "resync destination");
    finishVisibility();
    const startedAtMs = now();
    await sendTrustedInput({ ...next, phase: "resync", metadata });
    const pointerGlyphBounds = cloneRect(await measurePointerGlyph(next));
    assertGlyphContained(pointerGlyphBounds, viewport, metadata.label ?? "resync");
    const endedAtMs = now();
    current = next;
    const record = { point: { ...next }, pointerGlyphBounds, startedAtMs, endedAtMs, source: metadata.source ?? "trusted-input" };
    resyncs.push(record);
    return record;
  }

  async function moveTo(destination, metadata = {}) {
    const next = point(destination, "cursor destination");
    if (!current) await resync(metadata.from ?? { x: viewport.width / 2, y: viewport.height / 2 }, { label: "initial resync" });
    finishVisibility();
    const movementInput = metadata.trustedInput ?? sendTrustedInput;
    if (typeof movementInput !== "function") throw new Error("cursor movement trustedInput must be a function");
    const label = typeof metadata.label === "string" && metadata.label.trim() ? metadata.label.trim() : "cursor movement";
    const durationMs = positive(metadata.durationMs, 350, "cursor durationMs");
    const trajectory = buildCursorTrajectory({
      from: current,
      to: next,
      durationMs,
      sampleIntervalMs,
      maxStepPx,
      minSamples,
    });
    const movement = {
      label,
      from: { ...current },
      to: { ...next },
      requestedDurationMs: durationMs,
      startedAtMs: now(),
      endedAtMs: null,
      visibility: { startMs: null, endMs: null },
      samples: [],
      schedule: null,
    };
    movement.visibility.startMs = movement.startedAtMs;
    let glyphAnchor = null;
    try {
      for (const [index, planned] of trajectory.entries()) {
        const remainingMs = movement.startedAtMs + planned.offsetMs - now();
        if (remainingMs >= minWaitMs) {
          await page.waitForTimeout(remainingMs);
        }
        const inputStarted = now();
        await movementInput({ x: planned.x, y: planned.y, phase: "travel", label });
        const inputEnded = now();
        const independentlyMeasured = index === 0 || index === trajectory.length - 1;
        let pointerGlyphBounds;
        if (independentlyMeasured) {
          pointerGlyphBounds = cloneRect(await measurePointerGlyph({ x: planned.x, y: planned.y }));
          if (glyphAnchor) {
            assertStableGlyphProjection(
              translateRect(glyphAnchor.bounds, glyphAnchor.point, planned),
              pointerGlyphBounds,
              label,
            );
          } else {
            glyphAnchor = {
              point: { x: planned.x, y: planned.y },
              bounds: pointerGlyphBounds,
            };
          }
        } else {
          pointerGlyphBounds = translateRect(glyphAnchor.bounds, glyphAnchor.point, planned);
        }
        assertGlyphContained(pointerGlyphBounds, viewport, label);
        movement.samples.push({
          ...planned,
          tMs: inputEnded,
          trustedInputElapsedMs: inputEnded - inputStarted,
          pointerGlyphProof: independentlyMeasured ? "measured" : "projected",
          targetBounds: cloneRect(metadata.targetBounds),
          targetGlyphBounds: cloneRect(metadata.targetGlyphBounds),
          pointerGlyphBounds,
        });
      }
    } catch (error) {
      movement.endedAtMs = now();
      movement.visibility.endMs = movement.endedAtMs;
      throw error;
    }
    current = next;
    movement.endedAtMs = now();
    const actualDurationMs = movement.endedAtMs - movement.startedAtMs;
    movement.schedule = {
      requestedDurationMs: durationMs,
      actualDurationMs,
      overrunMs: Math.max(0, actualDurationMs - durationMs),
      maxOverrunMs: maxScheduleOverrunMs,
    };
    movements.push(movement);
    if (movement.schedule.overrunMs > maxScheduleOverrunMs) {
      movement.visibility.endMs = movement.endedAtMs;
      throw new Error(
        `${label}: cursor schedule overran declared ${durationMs}ms by ${Math.round(movement.schedule.overrunMs)}ms; increase cursorDurationMs or reduce movement distance`,
      );
    }
    activeMovement = movement;
    return movement;
  }

  return Object.freeze({
    moveTo,
    dragTo: moveTo,
    resync,
    finishVisibility,
    movements,
    resyncs,
    get current() { return current ? { ...current } : null; },
  });
}
