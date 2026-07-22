const OVERLAY_ID = "kandev-highlight-pointer-overlay";

export function overlayBootstrap() {
  const id = "kandev-highlight-pointer-overlay";
  const ensure = () => {
    let overlay = document.getElementById(id);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = id;
      overlay.setAttribute("aria-hidden", "true");
      Object.assign(overlay.style, {
        position: "fixed",
        zIndex: "2147483647",
        width: "20px",
        height: "20px",
        left: "0",
        top: "0",
        border: "2px solid rgba(255,255,255,.96)",
        borderRadius: "9999px",
        background: "rgba(20,20,24,.78)",
        boxShadow: "0 1px 4px rgba(0,0,0,.45)",
        pointerEvents: "none",
        transform: "translate(-50%,-50%)",
        opacity: "0",
        transition:
          "width 80ms linear,height 80ms linear,background 80ms linear",
      });
      document.documentElement.append(overlay);
    }
    return overlay;
  };
  const applyOverlay = (state) => {
    const overlay = ensure();
    overlay.style.left = `${state.x}px`;
    overlay.style.top = `${state.y}px`;
    overlay.style.opacity = state.visible === false ? "0" : "1";
    const touching = state.kind === "touch";
    overlay.style.width = touching ? "32px" : "20px";
    overlay.style.height = touching ? "32px" : "20px";
    overlay.style.background = touching
      ? "rgba(69,126,255,.35)"
      : "rgba(20,20,24,.78)";
    const size = touching ? 32 : 20;
    return {
      x: state.x - size / 2,
      y: state.y - size / 2,
      width: size,
      height: size,
    };
  };
  globalThis.__kandevHighlightOverlay = applyOverlay;
  globalThis.__kandevHighlightInputLedger ??= [];
  if (!globalThis.__kandevHighlightInputListenersInstalled) {
    const record = ({
      eventType,
      inputKind,
      x,
      y,
      buttons = 0,
      visibleKind,
    }) => {
      const overlayBounds = applyOverlay({
        kind: visibleKind,
        x,
        y,
        visible: true,
      });
      const ledger = globalThis.__kandevHighlightInputLedger;
      const entry = {
        sequence: ledger.length + 1,
        eventType,
        inputKind,
        x,
        y,
        buttons,
        isTrusted: true,
        overlayBounds,
      };
      ledger.push(entry);
    };
    const pointer = (event) => {
      if (!event.isTrusted || event.pointerType === "touch") return;
      record({
        eventType: event.type,
        inputKind: "desktop",
        x: event.clientX,
        y: event.clientY,
        buttons: event.buttons,
        visibleKind: "cursor",
      });
    };
    const touch = (event) => {
      if (!event.isTrusted) return;
      const point = event.touches?.[0] ?? event.changedTouches?.[0];
      if (!point) return;
      record({
        eventType: event.type,
        inputKind: "native-mobile",
        x: point.clientX,
        y: point.clientY,
        buttons:
          event.type === "touchend" || event.type === "touchcancel" ? 0 : 1,
        visibleKind:
          event.type === "touchend" || event.type === "touchcancel"
            ? "cursor"
            : "touch",
      });
    };
    for (const type of [
      "pointermove",
      "pointerdown",
      "pointerup",
      "pointercancel",
    ]) {
      document.addEventListener(type, pointer, {
        capture: true,
        passive: true,
      });
    }
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      document.addEventListener(type, touch, { capture: true, passive: true });
    }
    globalThis.__kandevHighlightInputListenersInstalled = true;
  }
  if (document.documentElement) ensure();
  else document.addEventListener("DOMContentLoaded", ensure, { once: true });
}

export async function installCaptureOverlay({ context, page } = {}) {
  if (typeof context?.addInitScript === "function")
    await context.addInitScript(overlayBootstrap);
  if (typeof page?.evaluate !== "function")
    throw new Error("capture overlay needs a Playwright page");
  await page.evaluate(overlayBootstrap);
}

async function updateOverlay(page, state) {
  await page.evaluate((next) => {
    if (typeof globalThis.__kandevHighlightOverlay !== "function") {
      throw new Error("Highlight pointer overlay is not installed");
    }
    globalThis.__kandevHighlightOverlay(next);
  }, state);
}

function touchPoint(x, y) {
  return { x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 };
}

function mouseButtons(button) {
  return button === "right" ? 2 : button === "middle" ? 4 : 1;
}

function defaultTrustedEventBarrier(page) {
  return {
    async arm(expected) {
      const afterSequence = await page.evaluate(
        () => globalThis.__kandevHighlightInputLedger?.at(-1)?.sequence ?? 0,
      );
      return async () => {
        const handle = await page.waitForFunction(
          ({ after, eventTypes, inputKind, x, y }) => {
            const ledger = globalThis.__kandevHighlightInputLedger ?? [];
            return (
              ledger.find(
                (entry) =>
                  entry.sequence > after &&
                  eventTypes.includes(entry.eventType) &&
                  entry.inputKind === inputKind &&
                  Math.abs(entry.x - x) <= 0.75 &&
                  Math.abs(entry.y - y) <= 0.75,
              ) ?? false
            );
          },
          { after: afterSequence, ...expected },
          { timeout: 2_000 },
        );
        try {
          return await handle.jsonValue();
        } finally {
          await handle.dispose();
        }
      };
    },
  };
}

function assertTrustedEventProof(proof, expected) {
  if (
    !proof ||
    proof.isTrusted !== true ||
    !expected.eventTypes.includes(proof.eventType) ||
    proof.inputKind !== expected.inputKind ||
    Math.abs(proof.x - expected.x) > 0.75 ||
    Math.abs(proof.y - expected.y) > 0.75
  ) {
    throw new Error(
      `trusted input event was not observed in overlay ledger for ${expected.eventTypes.join("/")} at ${expected.x},${expected.y}`,
    );
  }
  return structuredClone(proof);
}

export function createTrustedInputAdapters({
  page,
  cdp,
  inputKind,
  trustedEventBarrier,
} = {}) {
  if (!page || !cdp)
    throw new Error("trusted input needs page and CDP session");
  if (!new Set(["desktop", "native-mobile"]).has(inputKind))
    throw new Error("inputKind must be desktop or native-mobile");
  const barrier = trustedEventBarrier ?? defaultTrustedEventBarrier(page);
  const ledger = [];
  const dispatch = async (method, params, expected) => {
    const observe = await barrier.arm(expected);
    await cdp.send(method, params);
    const proof = assertTrustedEventProof(await observe(), expected);
    ledger.push(proof);
    return proof;
  };
  const trustedCursor = async ({ x, y }) => {
    if (inputKind === "desktop") {
      await dispatch(
        "Input.dispatchMouseEvent",
        {
          type: "mouseMoved",
          x,
          y,
          button: "none",
          buttons: 0,
        },
        { eventTypes: ["pointermove"], inputKind, x, y },
      );
      return;
    }
    await updateOverlay(page, { kind: "cursor", x, y, visible: true });
  };
  const trustedActivation = async ({
    x,
    y,
    button = "left",
    clickCount = 1,
  }) => {
    if (inputKind === "native-mobile") {
      await dispatch(
        "Input.dispatchTouchEvent",
        {
          type: "touchStart",
          touchPoints: [touchPoint(x, y)],
        },
        { eventTypes: ["touchstart"], inputKind, x, y },
      );
      if (typeof page.waitForTimeout === "function")
        await page.waitForTimeout(48);
      await dispatch(
        "Input.dispatchTouchEvent",
        { type: "touchEnd", touchPoints: [] },
        { eventTypes: ["touchend"], inputKind, x, y },
      );
      return;
    }
    const buttons = mouseButtons(button);
    await dispatch(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x, y, button, buttons, clickCount },
      { eventTypes: ["pointerdown"], inputKind, x, y },
    );
    await dispatch(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x, y, button, buttons: 0, clickCount },
      { eventTypes: ["pointerup"], inputKind, x, y },
    );
  };
  const trustedGesture = {
    async start({ x, y }) {
      if (inputKind === "native-mobile") {
        await dispatch(
          "Input.dispatchTouchEvent",
          { type: "touchStart", touchPoints: [touchPoint(x, y)] },
          { eventTypes: ["touchstart"], inputKind, x, y },
        );
      } else {
        await dispatch(
          "Input.dispatchMouseEvent",
          {
            type: "mousePressed",
            x,
            y,
            button: "left",
            buttons: 1,
            clickCount: 1,
          },
          { eventTypes: ["pointerdown"], inputKind, x, y },
        );
      }
    },
    async move({ x, y }) {
      if (inputKind === "native-mobile") {
        await dispatch(
          "Input.dispatchTouchEvent",
          { type: "touchMove", touchPoints: [touchPoint(x, y)] },
          { eventTypes: ["touchmove"], inputKind, x, y },
        );
      } else {
        await dispatch(
          "Input.dispatchMouseEvent",
          { type: "mouseMoved", x, y, button: "left", buttons: 1 },
          { eventTypes: ["pointermove"], inputKind, x, y },
        );
      }
    },
    async end({ x, y }) {
      if (inputKind === "native-mobile") {
        await dispatch(
          "Input.dispatchTouchEvent",
          { type: "touchEnd", touchPoints: [] },
          { eventTypes: ["touchend"], inputKind, x, y },
        );
      } else {
        await dispatch(
          "Input.dispatchMouseEvent",
          {
            type: "mouseReleased",
            x,
            y,
            button: "left",
            buttons: 0,
            clickCount: 1,
          },
          { eventTypes: ["pointerup"], inputKind, x, y },
        );
      }
    },
  };
  return { trustedCursor, trustedActivation, trustedGesture, ledger };
}

export async function measurePointerGlyph(page) {
  return page.evaluate((id) => {
    const rect = document.getElementById(id)?.getBoundingClientRect();
    return rect
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      : null;
  }, OVERLAY_ID);
}

export async function measureTargetGlyph(locator) {
  return locator.evaluate((element) => {
    const root = element.getBoundingClientRect();
    const rootBox = {
      left: root.left ?? root.x,
      top: root.top ?? root.y,
      right: root.right ?? root.x + root.width,
      bottom: root.bottom ?? root.y + root.height,
    };
    const visible = (candidate) => {
      if (typeof candidate?.checkVisibility === "function") {
        return candidate.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        });
      }
      const style = globalThis.getComputedStyle?.(candidate);
      return (
        !style ||
        (style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number.parseFloat(style.opacity || "1") > 0)
      );
    };
    const rects = [];
    const add = (rect) => {
      const left = Math.max(rootBox.left, rect.left ?? rect.x);
      const top = Math.max(rootBox.top, rect.top ?? rect.y);
      const right = Math.min(rootBox.right, rect.right ?? rect.x + rect.width);
      const bottom = Math.min(
        rootBox.bottom,
        rect.bottom ?? rect.y + rect.height,
      );
      if (right > left && bottom > top)
        rects.push({ left, top, right, bottom });
    };
    const selector = "[data-highlight-glyph],svg,img,[role=img]";
    const glyphs = [
      ...(element.matches(selector) ? [element] : []),
      ...element.querySelectorAll(selector),
    ];
    for (const glyph of glyphs) {
      if (visible(glyph)) add(glyph.getBoundingClientRect());
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.trim()) continue;
      if (!visible(walker.currentNode.parentElement ?? element)) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const rect of range.getClientRects()) add(rect);
    }
    if (rects.length === 0)
      throw new Error(
        "semantic target has no visible glyph or text rectangles",
      );
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { x: left, y: top, width: right - left, height: bottom - top };
  });
}

export function bindCaptureNavigation({
  page,
  frontendUrl,
  navigateRoute,
} = {}) {
  if (
    !page ||
    typeof page.url !== "function" ||
    typeof page.goto !== "function"
  ) {
    throw new Error(
      "capture navigation needs a Playwright page with url() and goto()",
    );
  }
  const configuredUrl = frontendUrl;
  const configured = new URL(configuredUrl);
  const assertAllowed = (phase) => {
    const current = page.url();
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      throw new Error(`capture ${phase} URL is invalid: ${current}`);
    }
    if (parsed.origin !== configured.origin) {
      throw new Error(
        `capture ${phase} must remain on allowed frontend origin ${configured.origin}; got ${current}`,
      );
    }
    return parsed;
  };
  return {
    async navigateDefault() {
      await page.goto(configuredUrl, { waitUntil: "domcontentloaded" });
      return assertAllowed("default navigation");
    },
    async navigateRoute(route, context) {
      if (typeof navigateRoute !== "function") {
        throw new Error(
          `capture route '${route}' has no allowlisted navigator`,
        );
      }
      await navigateRoute(route, context);
      return assertAllowed(`route '${route}'`);
    },
    evidence() {
      const final = assertAllowed("record boundary");
      return {
        configuredUrl,
        allowedOrigin: configured.origin,
        finalUrl: final.href,
        finalOrigin: final.origin,
      };
    },
  };
}
