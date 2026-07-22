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
  // Main-world telemetry drives the overlay only. It is forgeable by the app
  // and must never be treated as receipt authority.
  globalThis.__kandevHighlightObservedInputLedger ??= [];
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
      const ledger = globalThis.__kandevHighlightObservedInputLedger;
      const entry = {
        sequence: ledger.length + 1,
        authority: "dom-observation",
        observationalOnly: true,
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

export function createTrustedInputAdapters({ page, cdp, inputKind } = {}) {
  if (!page || !cdp)
    throw new Error("trusted input needs page and CDP session");
  if (!new Set(["desktop", "native-mobile"]).has(inputKind))
    throw new Error("inputKind must be desktop or native-mobile");
  const ledger = [];
  let nextSequence = 0;
  const dispatch = async (method, params, { operation, x, y }) => {
    // Only a successful host-side CDP command can advance this ledger. No
    // browser-main-world value participates in the authoritative proof.
    await cdp.send(method, params);
    nextSequence += 1;
    const coordinates = Object.freeze({ x, y });
    const touchPoints = Object.freeze(
      (params.touchPoints ?? []).map((point) => Object.freeze({ ...point })),
    );
    const proof = Object.freeze({
      contract: "kandev-highlight-host-input-dispatch-v1",
      sequence: nextSequence,
      authority: "host-cdp",
      dispatchSucceeded: true,
      operation,
      cdpMethod: method,
      type: params.type,
      inputKind,
      coordinates,
      key: params.key ?? null,
      code: params.code ?? null,
      text: params.text ?? null,
      button: params.button ?? null,
      buttons: params.buttons ?? null,
      clickCount: params.clickCount ?? null,
      touchPoints,
    });
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
        { operation: "cursor-move", x, y },
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
        { operation: "activation-start", x, y },
      );
      if (typeof page.waitForTimeout === "function")
        await page.waitForTimeout(48);
      await dispatch(
        "Input.dispatchTouchEvent",
        { type: "touchEnd", touchPoints: [] },
        { operation: "activation-end", x, y },
      );
      return;
    }
    const buttons = mouseButtons(button);
    await dispatch(
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x, y, button, buttons, clickCount },
      { operation: "activation-start", x, y },
    );
    await dispatch(
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x, y, button, buttons: 0, clickCount },
      { operation: "activation-end", x, y },
    );
  };
  const trustedGesture = {
    async start({ x, y }) {
      if (inputKind === "native-mobile") {
        await dispatch(
          "Input.dispatchTouchEvent",
          { type: "touchStart", touchPoints: [touchPoint(x, y)] },
          { operation: "gesture-start", x, y },
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
          { operation: "gesture-start", x, y },
        );
      }
    },
    async move({ x, y }) {
      if (inputKind === "native-mobile") {
        await dispatch(
          "Input.dispatchTouchEvent",
          { type: "touchMove", touchPoints: [touchPoint(x, y)] },
          { operation: "gesture-move", x, y },
        );
      } else {
        await dispatch(
          "Input.dispatchMouseEvent",
          { type: "mouseMoved", x, y, button: "left", buttons: 1 },
          { operation: "gesture-move", x, y },
        );
      }
    },
    async end({ x, y }) {
      if (inputKind === "native-mobile") {
        await dispatch(
          "Input.dispatchTouchEvent",
          { type: "touchEnd", touchPoints: [] },
          { operation: "gesture-end", x, y },
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
          { operation: "gesture-end", x, y },
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
  context,
  frontendUrl,
  navigateRoute,
} = {}) {
  if (
    !page ||
    typeof page.url !== "function" ||
    typeof page.goto !== "function" ||
    typeof page.on !== "function" ||
    typeof page.off !== "function" ||
    typeof page.mainFrame !== "function"
  ) {
    throw new Error(
      "capture navigation needs an observable Playwright page with url(), goto(), and mainFrame()",
    );
  }
  if (
    !context ||
    typeof context.pages !== "function" ||
    typeof context.on !== "function" ||
    typeof context.off !== "function"
  ) {
    throw new Error(
      "capture navigation needs an observable Playwright browser context to guard top-level pages",
    );
  }
  const configuredUrl = frontendUrl;
  const configured = new URL(configuredUrl);
  const events = [];
  const checkpoints = [];
  const violations = [];
  const pageListeners = new Map();
  const pageIds = new Map([[page, "primary"]]);
  let sequence = 0;
  let disposed = false;

  const record = (collection, value) => {
    const entry = { sequence: (sequence += 1), ...value };
    collection.push(entry);
    return entry;
  };
  const parseUrl = (current, phase) => {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      const message = `capture ${phase} URL is invalid: ${current}`;
      record(violations, { kind: "invalid-url", phase, url: current, message });
      return null;
    }
    return parsed;
  };
  const recordViolation = (violation) => {
    if (
      violations.some(
        (entry) =>
          entry.kind === violation.kind &&
          entry.page === violation.page &&
          entry.url === violation.url,
      )
    ) {
      return;
    }
    record(violations, violation);
  };
  const observeNavigation = (observedPage, frame, phase) => {
    if (frame && frame !== observedPage.mainFrame()) return;
    const pageId = pageIds.get(observedPage) ?? "extra";
    const current = frame?.url?.() ?? observedPage.url();
    const parsed = parseUrl(current, phase);
    const event = {
      kind: "top-level-navigation",
      page: pageId,
      phase,
      url: current,
      origin: parsed?.origin ?? null,
      allowed: pageId === "primary" && parsed?.origin === configured.origin,
    };
    const previous = events.at(-1);
    if (
      !previous ||
      previous.kind !== event.kind ||
      previous.page !== event.page ||
      previous.url !== event.url
    ) {
      record(events, event);
    }
    if (pageId !== "primary") return;
    if (parsed && parsed.origin !== configured.origin) {
      recordViolation({
        kind: "cross-origin-navigation",
        page: pageId,
        phase,
        url: current,
        origin: parsed.origin,
        message:
          `capture ${phase} must remain on allowed frontend origin ${configured.origin}; ` +
          `got ${current}`,
      });
    }
  };
  const attachPage = (observedPage, pageId) => {
    pageIds.set(observedPage, pageId);
    if (
      typeof observedPage.on !== "function" ||
      typeof observedPage.off !== "function" ||
      typeof observedPage.mainFrame !== "function" ||
      typeof observedPage.url !== "function"
    ) {
      recordViolation({
        kind: "unobservable-top-level-page",
        page: pageId,
        url: null,
        message: `capture opened unobservable extra top-level page ${pageId}`,
      });
      return;
    }
    const listener = (frame) =>
      observeNavigation(observedPage, frame, `${pageId} navigation`);
    observedPage.on("framenavigated", listener);
    pageListeners.set(observedPage, listener);
  };
  const onPage = (openedPage) => {
    const pageId = `extra-${pageIds.size}`;
    attachPage(openedPage, pageId);
    const current = openedPage.url?.() ?? null;
    record(events, {
      kind: "top-level-page-opened",
      page: pageId,
      url: current,
    });
    recordViolation({
      kind: "extra-top-level-page",
      page: pageId,
      url: current,
      message: `capture opened extra top-level page ${pageId}${current ? ` at ${current}` : ""}`,
    });
  };
  attachPage(page, "primary");
  context.on("page", onPage);

  const snapshot = () => {
    const finalUrl = page.url();
    let finalOrigin = null;
    try {
      finalOrigin = new URL(finalUrl).origin;
    } catch {
      // The invalid URL violation is captured by the nearest checkpoint.
    }
    return {
      contract: "kandev-highlight-navigation-evidence-v1",
      version: 1,
      configuredUrl,
      allowedOrigin: configured.origin,
      finalUrl,
      finalOrigin,
      events: structuredClone(events),
      checkpoints: structuredClone(checkpoints),
      violations: structuredClone(violations),
    };
  };

  const checkpoint = (label) => {
    if (disposed)
      throw new Error("capture navigation guard is already disposed");
    const pages = context.pages();
    if (pages.length !== 1 || pages[0] !== page) {
      recordViolation({
        kind: "extra-top-level-page",
        page: "context",
        url: null,
        message: `capture has ${pages.length} top-level pages instead of exactly the primary page`,
      });
    }
    observeNavigation(page, page.mainFrame(), label);
    const current = page.url();
    const parsed = parseUrl(current, label);
    if (parsed && parsed.origin !== configured.origin) {
      recordViolation({
        kind: "cross-origin-navigation",
        page: "primary",
        phase: label,
        url: current,
        origin: parsed.origin,
        message:
          `capture ${label} must remain on allowed frontend origin ${configured.origin}; ` +
          `got ${current}`,
      });
    }
    if (violations.length > 0) {
      throw new Error(
        `${violations[0].message}; detected at deterministic checkpoint '${label}'`,
      );
    }
    record(checkpoints, {
      label,
      url: parsed.href,
      origin: parsed.origin,
      topLevelPageCount: pages.length,
    });
    return parsed;
  };
  return {
    async navigateDefault() {
      await page.goto(configuredUrl, { waitUntil: "domcontentloaded" });
      return checkpoint("default navigation");
    },
    async navigateRoute(route, context) {
      if (typeof navigateRoute !== "function") {
        throw new Error(
          `capture route '${route}' has no allowlisted navigator`,
        );
      }
      await navigateRoute(route, context);
      return checkpoint(`route '${route}'`);
    },
    checkpoint,
    snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      context.off("page", onPage);
      for (const [observedPage, listener] of pageListeners) {
        observedPage.off("framenavigated", listener);
      }
      pageListeners.clear();
    },
    evidence() {
      checkpoint("record boundary");
      return snapshot();
    },
  };
}
