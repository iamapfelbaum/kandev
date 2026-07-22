const CONTRACT = "kandev-highlight-origin-isolation-v1";
const HTTP_ROUTE_PATTERN = "**/*";
const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);

function parseAllowedOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "capture origin isolation allowedOrigin must be an absolute loopback HTTP origin",
    );
  }
  if (
    parsed.protocol !== "http:" ||
    !LOOPBACK_HOSTS.includes(parsed.hostname) ||
    parsed.port === "" ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error(
      "capture origin isolation allowedOrigin must be an absolute loopback HTTP origin",
    );
  }
  return parsed;
}

function requireCaptureContext(context) {
  if (
    typeof context?.route !== "function" ||
    typeof context?.unroute !== "function" ||
    typeof context?.routeWebSocket !== "function" ||
    typeof context?.addInitScript !== "function" ||
    typeof context?.on !== "function" ||
    typeof context?.off !== "function"
  ) {
    throw new Error(
      "capture origin isolation needs a routable Playwright browser context",
    );
  }
}

function requireCaptureTarget({ context, page, cdp }) {
  requireCaptureContext(context);
  if (typeof page?.mainFrame !== "function") {
    throw new Error("capture origin isolation needs a Playwright page");
  }
  if (typeof cdp?.send !== "function") {
    throw new Error("capture origin isolation needs a page CDP session");
  }
}

function installMainWorldGuards() {
  for (const constructorName of ["WebTransport", "TCPSocket", "UDPSocket"]) {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      constructorName,
    );
    Object.defineProperty(globalThis, constructorName, {
      configurable: false,
      enumerable: descriptor?.enumerable ?? false,
      writable: false,
      value: undefined,
    });
  }
  const container = globalThis.navigator?.serviceWorker;
  if (!container) return;
  const prototype = Object.getPrototypeOf(container);
  Object.defineProperty(prototype, "register", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: () =>
      Promise.reject(
        new DOMException(
          "Service workers are disabled during highlight capture",
          "SecurityError",
        ),
      ),
  });
}

function safeFrame(request) {
  try {
    return request.frame();
  } catch {
    return null;
  }
}

function safeFramePage(frame) {
  try {
    return frame?.page() ?? null;
  } catch {
    return null;
  }
}

function classifyHttpRequest(request, page, allowedOrigin) {
  const url = request.url();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "invalid-request-url", origin: null, url };
  }
  if (parsed.origin !== allowedOrigin) {
    return { kind: "cross-origin-request", origin: parsed.origin, url };
  }
  if (request.resourceType() !== "document") return null;
  const frame = safeFrame(request);
  if (frame === page.mainFrame()) return null;
  return {
    kind: safeFramePage(frame) === page ? "subframe-document" : "popup-document",
    origin: parsed.origin,
    url,
  };
}

function webSocketOrigin(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!new Set(["ws:", "wss:"]).has(parsed.protocol)) return null;
  const protocol = parsed.protocol === "ws:" ? "http:" : "https:";
  return `${protocol}//${parsed.host}`;
}

function controlsEvidence() {
  return {
    httpRoute: true,
    webSocketRoute: true,
    popupGuard: true,
    subframeGuard: true,
    serviceWorkerBypass: true,
    serviceWorkerRegistrationBlocked: true,
    directTransportConstructorsBlocked: true,
  };
}

function createIsolationState(configured) {
  const traffic = {
    httpAllowed: 0,
    httpBlocked: 0,
    webSocketAllowed: 0,
    webSocketBlocked: 0,
  };
  const violations = [];
  let sequence = 0;
  return {
    traffic,
    violations,
    recordViolation({ kind, transport, url, origin }) {
      violations.push({
        sequence: (sequence += 1),
        kind,
        transport,
        url,
        origin,
        message: `${kind} blocked by capture origin policy for ${configured.origin}`,
      });
    },
  };
}

function createOriginHandlers({ page, configured, state }) {
  const handleHttp = async (route, request) => {
    const violation = classifyHttpRequest(request, page, configured.origin);
    if (!violation) {
      state.traffic.httpAllowed += 1;
      await route.continue();
      return;
    }
    state.traffic.httpBlocked += 1;
    state.recordViolation({ ...violation, transport: "http" });
    await route.abort("blockedbyclient");
  };
  const handleWebSocket = async (webSocketRoute) => {
    const url = webSocketRoute.url();
    const origin = webSocketOrigin(url);
    if (origin === configured.origin) {
      state.traffic.webSocketAllowed += 1;
      webSocketRoute.connectToServer();
      return;
    }
    state.traffic.webSocketBlocked += 1;
    state.recordViolation({
      kind: "cross-origin-websocket",
      transport: "websocket",
      url,
      origin,
    });
    await webSocketRoute.close({
      code: 1008,
      reason: "capture origin policy",
    });
  };
  const handlePopup = (openedPage) => {
    const url = typeof openedPage?.url === "function" ? openedPage.url() : null;
    state.recordViolation({
      kind: "popup-created",
      transport: "browser",
      url,
      origin: url ? webSafeOrigin(url) : null,
    });
    if (typeof openedPage?.close === "function") {
      void openedPage.close({ runBeforeUnload: false }).catch(() => {});
    }
  };
  return { handleHttp, handleWebSocket, handlePopup };
}

async function installControls({ context, cdp, handlers }) {
  await context.route(HTTP_ROUTE_PATTERN, handlers.handleHttp);
  await context.routeWebSocket(HTTP_ROUTE_PATTERN, handlers.handleWebSocket);
  await context.addInitScript(installMainWorldGuards);
  context.on("page", handlers.handlePopup);
  await cdp.send("Network.enable");
  await cdp.send("Network.setBypassServiceWorker", { bypass: true });
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await cdp.send("ServiceWorker.disable");
}

export async function installCaptureOriginIsolation({
  context,
  page,
  cdp,
  allowedOrigin,
} = {}) {
  requireCaptureTarget({ context, page, cdp });
  const configured = parseAllowedOrigin(allowedOrigin);
  const state = createIsolationState(configured);
  const handlers = createOriginHandlers({ page, configured, state });
  let disposed = false;
  await installControls({ context, cdp, handlers });

  const snapshot = () => ({
    contract: CONTRACT,
    version: 1,
    allowedOrigin: configured.origin,
    controls: controlsEvidence(),
    traffic: structuredClone(state.traffic),
    violations: structuredClone(state.violations),
  });
  return {
    assertClean(label) {
      if (disposed) {
        throw new Error("capture origin isolation is already disposed");
      }
      if (state.violations.length > 0) {
        throw new Error(
          `${state.violations[0].kind} blocked by capture origin isolation at ${label}`,
        );
      }
      return snapshot();
    },
    snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      context.off("page", handlers.handlePopup);
      void context
        .unroute(HTTP_ROUTE_PATTERN, handlers.handleHttp)
        .catch(() => {});
    },
  };
}

function webSafeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
