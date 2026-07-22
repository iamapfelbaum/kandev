import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { installCaptureOriginIsolation } from "./capture-origin-isolation.mjs";

const ALLOWED_ORIGIN = "http://localhost:18087";

function fakeCaptureTarget() {
  const primaryFrame = { page: () => page };
  const listeners = new Map();
  const calls = [];
  const context = {
    async addInitScript(script) {
      calls.push({ operation: "addInitScript", script });
    },
    on(event, handler) {
      listeners.set(event, handler);
    },
    off(event, handler) {
      assert.equal(listeners.get(event), handler);
      listeners.delete(event);
    },
    async route(pattern, handler) {
      calls.push({ operation: "route", pattern });
      context.httpHandler = handler;
    },
    async unroute(pattern, handler) {
      calls.push({ operation: "unroute", pattern });
      assert.equal(context.httpHandler, handler);
    },
    async routeWebSocket(pattern, handler) {
      calls.push({ operation: "routeWebSocket", pattern });
      context.webSocketHandler = handler;
    },
  };
  const page = {
    mainFrame: () => primaryFrame,
  };
  const cdp = {
    async send(method, params = {}) {
      calls.push({ operation: "cdp", method, params });
    },
  };
  return { calls, cdp, context, listeners, page, primaryFrame };
}

function httpExchange({ url, frame, resourceType = "fetch" }) {
  const operations = [];
  return {
    operations,
    request: {
      frame: () => frame,
      resourceType: () => resourceType,
      url: () => url,
    },
    route: {
      async abort(reason) {
        operations.push({ operation: "abort", reason });
      },
      async continue() {
        operations.push({ operation: "continue" });
      },
    },
  };
}

function webSocketExchange(url) {
  const operations = [];
  return {
    operations,
    route: {
      async close(options) {
        operations.push({ operation: "close", options });
      },
      connectToServer() {
        operations.push({ operation: "connectToServer" });
      },
      url: () => url,
    },
  };
}

test("origin isolation installs every guard before capture navigation", async () => {
  const target = fakeCaptureTarget();
  const isolation = await installCaptureOriginIsolation({
    context: target.context,
    page: target.page,
    cdp: target.cdp,
    allowedOrigin: ALLOWED_ORIGIN,
  });

  assert.deepEqual(
    target.calls.map(({ operation, method }) => method ?? operation),
    [
      "route",
      "routeWebSocket",
      "addInitScript",
      "Network.enable",
      "Network.setBypassServiceWorker",
      "ServiceWorker.enable",
      "ServiceWorker.stopAllWorkers",
      "ServiceWorker.disable",
    ],
  );
  assert.equal(target.listeners.has("page"), true);
  assert.deepEqual(isolation.snapshot(), {
    contract: "kandev-highlight-origin-isolation-v1",
    version: 1,
    allowedOrigin: ALLOWED_ORIGIN,
    controls: {
      httpRoute: true,
      webSocketRoute: true,
      popupGuard: true,
      subframeGuard: true,
      serviceWorkerBypass: true,
      serviceWorkerRegistrationBlocked: true,
      directTransportConstructorsBlocked: true,
    },
    traffic: {
      httpAllowed: 0,
      httpBlocked: 0,
      webSocketAllowed: 0,
      webSocketBlocked: 0,
    },
    violations: [],
  });
});

test("origin isolation removes direct transport constructors before page scripts", async () => {
  const target = fakeCaptureTarget();
  await installCaptureOriginIsolation({
    context: target.context,
    page: target.page,
    cdp: target.cdp,
    allowedOrigin: ALLOWED_ORIGIN,
  });
  const initScript = target.calls.find(
    ({ operation }) => operation === "addInitScript",
  )?.script;
  assert.equal(typeof initScript, "function");
  const realm = vm.createContext({
    WebTransport: class WebTransport {},
    TCPSocket: class TCPSocket {},
    UDPSocket: class UDPSocket {},
  });

  vm.runInContext(`(${initScript.toString()})()`, realm);

  assert.deepEqual(
    Array.from(
      vm.runInContext(
        "[typeof WebTransport, typeof TCPSocket, typeof UDPSocket]",
        realm,
      ),
    ),
    ["undefined", "undefined", "undefined"],
  );
  assert.throws(
    () =>
      vm.runInContext(
        '"use strict"; globalThis.WebTransport = class WebTransport {}',
        realm,
      ),
    /read only|Cannot assign/i,
  );
});

test("same-origin HTTP and WebSocket traffic passes through", async () => {
  const target = fakeCaptureTarget();
  const isolation = await installCaptureOriginIsolation({
    context: target.context,
    page: target.page,
    cdp: target.cdp,
    allowedOrigin: ALLOWED_ORIGIN,
  });
  const http = httpExchange({
    url: `${ALLOWED_ORIGIN}/api/health`,
    frame: target.primaryFrame,
  });
  const webSocket = webSocketExchange("ws://localhost:18087/live");

  await target.context.httpHandler(http.route, http.request);
  await target.context.webSocketHandler(webSocket.route);

  assert.deepEqual(http.operations, [{ operation: "continue" }]);
  assert.deepEqual(webSocket.operations, [{ operation: "connectToServer" }]);
  assert.deepEqual(isolation.snapshot().traffic, {
    httpAllowed: 1,
    httpBlocked: 0,
    webSocketAllowed: 1,
    webSocketBlocked: 0,
  });
  assert.deepEqual(isolation.snapshot().violations, []);
});

test("cross-origin, subframe, popup, and WebSocket traffic is blocked with typed evidence", async () => {
  const target = fakeCaptureTarget();
  const isolation = await installCaptureOriginIsolation({
    context: target.context,
    page: target.page,
    cdp: target.cdp,
    allowedOrigin: ALLOWED_ORIGIN,
  });
  const crossOrigin = httpExchange({
    url: "http://127.0.0.1:19090/private",
    frame: target.primaryFrame,
  });
  const childFrame = { page: () => target.page };
  const subframe = httpExchange({
    url: `${ALLOWED_ORIGIN}/embedded`,
    frame: childFrame,
    resourceType: "document",
  });
  const popupPage = { async close() {} };
  const popupFrame = { page: () => popupPage };
  const popup = httpExchange({
    url: `${ALLOWED_ORIGIN}/popup`,
    frame: popupFrame,
    resourceType: "document",
  });
  const webSocket = webSocketExchange("ws://127.0.0.1:19090/socket");

  await target.context.httpHandler(crossOrigin.route, crossOrigin.request);
  await target.context.httpHandler(subframe.route, subframe.request);
  await target.context.httpHandler(popup.route, popup.request);
  await target.context.webSocketHandler(webSocket.route);

  assert.deepEqual(crossOrigin.operations, [
    { operation: "abort", reason: "blockedbyclient" },
  ]);
  assert.deepEqual(subframe.operations, [
    { operation: "abort", reason: "blockedbyclient" },
  ]);
  assert.deepEqual(popup.operations, [
    { operation: "abort", reason: "blockedbyclient" },
  ]);
  assert.deepEqual(webSocket.operations, [
    {
      operation: "close",
      options: { code: 1008, reason: "capture origin policy" },
    },
  ]);
  assert.deepEqual(
    isolation.snapshot().violations.map(({ kind, transport }) => ({
      kind,
      transport,
    })),
    [
      { kind: "cross-origin-request", transport: "http" },
      { kind: "subframe-document", transport: "http" },
      { kind: "popup-document", transport: "http" },
      { kind: "cross-origin-websocket", transport: "websocket" },
    ],
  );
  assert.throws(
    () => isolation.assertClean("before story"),
    /cross-origin-request.*before story/i,
  );

  isolation.dispose();
  assert.equal(target.listeners.has("page"), false);
  assert.equal(target.calls.at(-1).operation, "unroute");
});
