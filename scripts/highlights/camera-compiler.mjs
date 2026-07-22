const PROFILE_CONTRACTS = Object.freeze({
  desktop: Object.freeze({
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
  }),
  "native-mobile": Object.freeze({
    kind: "native-mobile",
    formFactor: "mobile",
    cssWidth: 430,
    cssHeight: 932,
    dpr: 3,
    sourceWidth: 1290,
    sourceHeight: 2796,
    deliveryWidth: 1290,
    deliveryHeight: 2796,
    fps: 25,
    maxZoom: 1.18,
    nativeMobile: true,
  }),
});

const CAMERA_KINDS = new Set(["cameraFocus", "cameraZoom", "cameraHold", "cameraReturn"]);

export function resolveCaptureProfile(profile) {
  const contract = PROFILE_CONTRACTS[profile?.kind];
  if (!contract) throw new Error("capture profile kind must be desktop or native-mobile");
  const expected = `${contract.cssWidth}x${contract.cssHeight}`;
  if (profile.viewport?.width !== contract.cssWidth || profile.viewport?.height !== contract.cssHeight) {
    throw new Error(`${profile.kind} capture requires exact ${expected} viewport; native-mobile must be native portrait, never cropped desktop`);
  }
  if (profile.deviceScaleFactor !== undefined && profile.deviceScaleFactor !== contract.dpr) {
    throw new Error(`${profile.kind} capture requires deviceScaleFactor ${contract.dpr}`);
  }
  return { ...contract };
}

function normalizedRect(rect, profile, label) {
  if (!rect || typeof rect !== "object") throw new Error(`${label} is required`);
  let left;
  let right;
  let top;
  let bottom;
  if (["left", "right", "top", "bottom"].every((key) => Number.isFinite(rect[key]))) {
    ({ left, right, top, bottom } = rect);
  } else if (["x", "y", "width", "height"].every((key) => Number.isFinite(rect[key]))) {
    left = rect.x;
    right = rect.x + rect.width;
    top = rect.y;
    bottom = rect.y + rect.height;
  } else {
    throw new Error(`${label} must contain finite bounds`);
  }
  if (right > 1 || bottom > 1 || left > 1 || top > 1) {
    left /= profile.cssWidth;
    right /= profile.cssWidth;
    top /= profile.cssHeight;
    bottom /= profile.cssHeight;
  }
  if (left < 0 || top < 0 || right > 1 || bottom > 1 || right <= left || bottom <= top) {
    throw new Error(`${label} must be a non-empty rectangle inside source viewport`);
  }
  return { left, right, top, bottom };
}

function union(left, right) {
  return {
    left: Math.min(left.left, right.left),
    right: Math.max(left.right, right.right),
    top: Math.min(left.top, right.top),
    bottom: Math.max(left.bottom, right.bottom),
  };
}

function expand(rect, x, y) {
  return {
    left: Math.max(0, rect.left - x),
    right: Math.min(1, rect.right + x),
    top: Math.max(0, rect.top - y),
    bottom: Math.min(1, rect.bottom + y),
  };
}

function actionIndex(pointer) {
  const match = /^\/story\/actions\/(\d+)$/.exec(pointer ?? "");
  return match ? Number(match[1]) : null;
}

function semanticEventFor(events, index, pointer) {
  return events.find((event) =>
    event?.sourcePointer === pointer || event?.stepIndex === index || event?.actionIndex === index,
  );
}

function normalizePointerTrack(pointerTrack, profile) {
  if (!Array.isArray(pointerTrack)) throw new Error("pointerTrack must be an array");
  const normalizedTrack = pointerTrack.map((sample, index) => {
    if (!Number.isFinite(sample?.x) || !Number.isFinite(sample?.y)) {
      throw new Error(`pointerTrack[${index}] needs finite coordinates`);
    }
    const normalized = structuredClone(sample);
    if (normalized.x > 1 || normalized.y > 1) {
      normalized.x /= profile.cssWidth;
      normalized.y /= profile.cssHeight;
    }
    if (normalized.x < 0 || normalized.x > 1 || normalized.y < 0 || normalized.y > 1) {
      throw new Error(`pointerTrack[${index}] leaves source viewport`);
    }
    if (!Number.isFinite(normalized.tMs) || normalized.tMs < 0) {
      throw new Error(`pointerTrack[${index}] needs a non-negative tMs`);
    }
    if (index > 0 && normalized.tMs <= pointerTrack[index - 1].tMs) {
      throw new Error("pointerTrack timestamps must be strictly increasing");
    }
    return normalized;
  });
  return normalizedTrack;
}

function normalizedExecutionPoint(value, profile, label) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new Error(`${label} needs finite CSS coordinates`);
  }
  const point = { x: value.x / profile.cssWidth, y: value.y / profile.cssHeight };
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
    throw new Error(`${label} leaves source viewport`);
  }
  return point;
}

function samePoint(left, right) {
  return Math.abs(left.x - right.x) <= 1e-9 && Math.abs(left.y - right.y) <= 1e-9;
}

export function buildLandingPointerTrack({
  execution,
  captureProfile,
  durationMs,
  openingSettleMs,
  endingSettleMs,
} = {}) {
  if (!execution || typeof execution !== "object") throw new Error("pointer builder needs execution evidence");
  if (!Number.isFinite(captureProfile?.cssWidth) || !Number.isFinite(captureProfile?.cssHeight)) {
    throw new Error("pointer builder needs captureProfile CSS dimensions");
  }
  if (![durationMs, openingSettleMs, endingSettleMs].every(Number.isFinite)) {
    throw new Error("pointer builder needs finite duration and settle bounds");
  }
  if (openingSettleMs < 0 || endingSettleMs < 0 || openingSettleMs + endingSettleMs >= durationMs) {
    throw new Error("pointer builder settle bounds leave no story interval");
  }
  const initialResync = execution.cursorResyncEvidence?.at(-1);
  if (!initialResync?.point) {
    throw new Error("pointer builder needs initial cursor resync evidence from scenario preparation");
  }
  const initial = normalizedExecutionPoint(initialResync.point, captureProfile, "initial cursor resync");
  const endingStartMs = durationMs - endingSettleMs;
  const rawSamples = (execution.cursorEvidence ?? []).flatMap((movement) => movement.samples ?? []).map((sample, index) => {
    const tMs = Number.isFinite(sample.storyTMs)
      ? sample.storyTMs
      : sample.tMs - execution.storyEpochMs;
    if (!Number.isFinite(tMs)) throw new Error(`cursor sample ${index} needs story-relative time`);
    return {
      tMs,
      ...normalizedExecutionPoint(sample, captureProfile, `cursor sample ${index}`),
    };
  }).sort((left, right) => left.tMs - right.tMs);

  const track = [
    { tMs: 0, ...initial },
    { tMs: openingSettleMs, ...initial },
  ];
  for (const sample of rawSamples) {
    if (sample.tMs <= openingSettleMs) {
      if (!samePoint(sample, initial)) {
        throw new Error(`pointer moves during ${openingSettleMs}ms opening settle`);
      }
      continue;
    }
    if (sample.tMs > endingStartMs) {
      throw new Error(`pointer moves during ${endingSettleMs}ms ending settle`);
    }
    const prior = track.at(-1);
    if (sample.tMs === prior.tMs) {
      if (!samePoint(sample, prior)) throw new Error(`pointer has conflicting samples at ${sample.tMs}ms`);
      continue;
    }
    track.push(sample);
  }
  const finalPoint = track.at(-1);
  if (finalPoint.tMs < endingStartMs) track.push({ tMs: endingStartMs, x: finalPoint.x, y: finalPoint.y });
  track.push({ tMs: durationMs, x: track.at(-1).x, y: track.at(-1).y });
  return track;
}

function assertTimelineMatches(scenario, timeline) {
  if (!timeline || timeline.scenarioId !== scenario.id || !Array.isArray(timeline.events)) {
    throw new Error("camera compiler needs matching compiled timeline");
  }
  const endMs = timeline.events.at(-1)?.endMs;
  if (!Number.isFinite(timeline.totalDurationMs) || endMs !== timeline.totalDurationMs) {
    throw new Error("camera timeline duration is inconsistent");
  }
  if (timeline.totalDurationMs > 15_000) throw new Error("camera timeline exceeds 15000ms Highlight limit");
}

/**
 * Compile schema-v1 camera actions into landing's canonical Highlight directives.
 * This module intentionally does not generate keyframes or motion. Landing's
 * product-loop-highlight adapter owns easing, containment, and motion limits.
 */
export function compileCamera({
  scenario,
  timeline,
  semanticEvents = [],
  pointerTrack,
  execution,
  pointerGlyph,
} = {}) {
  if (!scenario || typeof scenario !== "object") throw new Error("camera compiler needs scenario");
  assertTimelineMatches(scenario, timeline);
  const profile = resolveCaptureProfile(scenario.profile);
  const options = scenario.camera ?? {};
  const minZoom = options.minZoom ?? 1;
  const maxZoom = options.maxZoom ?? profile.maxZoom;
  if (minZoom < 1 || maxZoom > profile.maxZoom || minZoom > maxZoom) {
    throw new Error(`camera zoom bounds must stay between 1 and profile maximum ${profile.maxZoom}`);
  }
  if (scenario.story.openingSettleMs < 400 || scenario.story.endingSettleMs < 400) {
    throw new Error("camera opening and ending settle must each be at least 400ms");
  }

  const safeMarginPx = options.safeMarginPx ?? (profile.nativeMobile ? 24 : 48);
  const pointerSafeMargin = {
    top: safeMarginPx / profile.deliveryHeight,
    right: safeMarginPx / profile.deliveryWidth,
    bottom: safeMarginPx / profile.deliveryHeight,
    left: safeMarginPx / profile.deliveryWidth,
  };
  const glyphPaddingPx = options.glyphPaddingPx ?? 10;
  const glyphPaddingX = glyphPaddingPx / profile.cssWidth;
  const glyphPaddingY = glyphPaddingPx / profile.cssHeight;
  const cameraDirectives = [];
  const semanticFocus = [];

  for (const event of timeline.events) {
    if (!event.controlsCamera) continue;
    const index = actionIndex(event.sourcePointer);
    const action = scenario.story.actions[index];
    if (!action || !CAMERA_KINDS.has(action.kind)) {
      throw new Error(`${event.sourcePointer}: timeline camera action does not match scenario`);
    }
    if (action.kind === "cameraZoom") {
      if (action.zoom < minZoom || action.zoom > maxZoom || action.zoom > profile.maxZoom) {
        throw new Error(`camera zoom ${action.zoom} exceeds maximum ${Math.min(maxZoom, profile.maxZoom)}`);
      }
      if (event.actionDurationMs < 1_200) throw new Error(`${event.sourcePointer}: camera zoom transition must be at least 1200ms`);
      cameraDirectives.push({
        type: "zoom",
        atMs: event.startMs,
        zoom: action.zoom,
        transitionMs: event.actionDurationMs,
      });
      continue;
    }
    if (action.kind === "cameraFocus") {
      if (action.zoom !== undefined) {
        throw new Error(`${event.sourcePointer}: cameraFocus cannot change depth; use a separate cameraZoom action`);
      }
      if (event.actionDurationMs < 1_200) throw new Error(`${event.sourcePointer}: camera focus transition must be at least 1200ms`);
      const semantic = semanticEventFor(semanticEvents, index, event.sourcePointer);
      if (!semantic) throw new Error(`${event.sourcePointer}: focus geometry is missing`);
      const targetBounds = normalizedRect(semantic.targetBounds, profile, `${event.sourcePointer} target bounds`);
      const targetGlyphBounds = normalizedRect(
        semantic.targetGlyphBounds,
        profile,
        `${event.sourcePointer} target glyph bounds`,
      );
      const bounds = expand(union(targetBounds, targetGlyphBounds), glyphPaddingX, glyphPaddingY);
      const label = semantic.label ?? action.label ?? "focus target";
      cameraDirectives.push({
        type: "focus",
        atMs: event.startMs,
        target: {
          x: (bounds.left + bounds.right) / 2,
          y: (bounds.top + bounds.bottom) / 2,
          label,
          bounds,
        },
        transitionMs: event.actionDurationMs,
      });
      semanticFocus.push({
        sourcePointer: event.sourcePointer,
        targetBounds,
        targetGlyphBounds,
        framedBounds: bounds,
      });
      continue;
    }
    if (action.kind === "cameraHold") {
      if (event.actionDurationMs < 240) throw new Error(`${event.sourcePointer}: camera hold must be at least 240ms`);
      cameraDirectives.push({ type: "hold", atMs: event.startMs, durationMs: event.actionDurationMs });
      continue;
    }
    if (event.actionDurationMs < 1_200) throw new Error(`${event.sourcePointer}: camera return must be at least 1200ms`);
    cameraDirectives.push({ type: "return", atMs: event.startMs, transitionMs: event.actionDurationMs });
  }

  if (execution !== undefined && pointerTrack !== undefined) {
    throw new Error("camera compiler accepts execution or pointerTrack, not both");
  }
  const resolvedPointerTrack = execution !== undefined
    ? buildLandingPointerTrack({
      execution,
      captureProfile: profile,
      durationMs: timeline.totalDurationMs,
      openingSettleMs: scenario.story.openingSettleMs,
      endingSettleMs: scenario.story.endingSettleMs,
    })
    : pointerTrack === undefined
      ? undefined
      : normalizePointerTrack(pointerTrack, profile);

  return {
    contract: "kandev-highlight-camera-plan-v1",
    scenarioDigest: timeline.scenarioDigest ?? null,
    formFactor: profile.formFactor,
    cameraProfile: profile.nativeMobile ? "highlight-native-mobile" : "highlight-desktop",
    profile: profile.kind,
    captureProfile: profile,
    durationMs: timeline.totalDurationMs,
    openingSettleMs: scenario.story.openingSettleMs,
    endingSettleMs: scenario.story.endingSettleMs,
    cameraDirectives,
    pointerSafeMargin,
    pointerGlyph: pointerGlyph ? structuredClone(pointerGlyph) : undefined,
    ...(resolvedPointerTrack === undefined ? {} : { pointerTrack: resolvedPointerTrack }),
    bounds: {
      minZoom,
      maxZoom: Math.min(maxZoom, profile.maxZoom),
      safeMarginPx,
      glyphPaddingPx,
      maxPanVelocityPxPerSecond: options.maxPanVelocityPxPerSecond ?? 1_200,
      maxPanAccelerationPxPerSecond2: options.maxPanAccelerationPxPerSecond2 ?? 3_600,
      maxZoomRatePerSecond: options.maxZoomRatePerSecond ?? 0.6,
      easing: options.easing ?? "easeInOutCubic",
    },
    semanticFocus,
    materializer: "landing:scripts/product-loop-highlight.mjs#createHighlightCameraTrack",
  };
}
