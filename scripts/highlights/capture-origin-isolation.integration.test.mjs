import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";

import { chromium } from "../../apps/web/node_modules/@playwright/test/index.mjs";
import { installCaptureOriginIsolation } from "./capture-origin-isolation.mjs";

function acceptWebSocket(request, socket, counters) {
  counters.upgrades.push(request.url);
  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
}

async function startObservedServer() {
  const counters = { requests: [], upgrades: [] };
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    counters.requests.push(request.url);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>capture isolation fixture</title>");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    acceptWebSocket(request, socket, counters);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    counters,
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

async function launchLocalTestBrowser() {
  // This browser sees only test-owned loopback servers. Make the test's
  // sandbox choice explicit and suppress unrelated Chromium background I/O.
  return chromium.launch({
    headless: true,
    chromiumSandbox: false,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
    ],
  });
}

function runFetchAttacks(page, origins) {
  return page.evaluate(
    async ({ allowedOrigin, forbiddenOrigin }) => {
      const sameOriginFetch = await fetch(`${allowedOrigin}/api/allowed`).then(
        (response) => response.status,
      );
      const forbiddenFetch = await fetch(
        `${forbiddenOrigin}/api/forbidden`,
      ).then(
        () => "unexpected-success",
        () => "blocked",
      );
      const serviceWorker = await navigator.serviceWorker
        .register("/sw.js")
        .then(
          () => "unexpected-success",
          () => "blocked",
        );
      return { forbiddenFetch, sameOriginFetch, serviceWorker };
    },
    origins,
  );
}

function runSocketAttacks(page, origins) {
  return page.evaluate(
    async ({ allowedOrigin, forbiddenOrigin }) => {
      const settleSocket = (url) =>
        new Promise((resolve) => {
          const socket = new WebSocket(url);
          let finished = false;
          let timeout;
          const finish = (value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            resolve(value);
          };
          socket.addEventListener("open", () => finish("open"), {
            once: true,
          });
          socket.addEventListener("error", () => finish("error"), {
            once: true,
          });
          socket.addEventListener("close", () => finish("close"), {
            once: true,
          });
          timeout = setTimeout(() => finish("timeout"), 2_000);
        });
      const [sameOriginWebSocket, forbiddenWebSocket] = await Promise.all([
        settleSocket(allowedOrigin.replace("http:", "ws:") + "/live"),
        settleSocket(forbiddenOrigin.replace("http:", "ws:") + "/private"),
      ]);
      return { sameOriginWebSocket, forbiddenWebSocket };
    },
    origins,
  );
}

function runDocumentAndWorkerAttacks(page, origins) {
  return page.evaluate(
    async ({ allowedOrigin, forbiddenOrigin }) => {
      const loadFrame = (url) =>
        new Promise((resolve) => {
          const frame = document.createElement("iframe");
          let finished = false;
          let timeout;
          const finish = (value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            frame.remove();
            resolve(value);
          };
          frame.addEventListener("load", () => finish("load"), {
            once: true,
          });
          frame.addEventListener("error", () => finish("error"), {
            once: true,
          });
          frame.src = url;
          document.body.append(frame);
          timeout = setTimeout(() => finish("timeout"), 2_000);
        });
      const runWorker = (url) =>
        new Promise((resolve) => {
          const source = `try { importScripts(${JSON.stringify(
            url,
          )}); postMessage("unexpected-success"); } catch { postMessage("blocked"); }`;
          const blobUrl = URL.createObjectURL(
            new Blob([source], { type: "text/javascript" }),
          );
          const worker = new Worker(blobUrl);
          let finished = false;
          let timeout;
          const finish = (value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            worker.terminate();
            URL.revokeObjectURL(blobUrl);
            resolve(value);
          };
          worker.addEventListener("message", (event) => finish(event.data), {
            once: true,
          });
          worker.addEventListener("error", () => finish("blocked"), {
            once: true,
          });
          timeout = setTimeout(() => finish("timeout"), 2_000);
        });
      const popup = globalThis.open(`${allowedOrigin}/popup`);
      const [subframe, worker] = await Promise.all([
        loadFrame(`${allowedOrigin}/embedded`),
        runWorker(`${forbiddenOrigin}/worker.js`),
      ]);
      return {
        popupOpened: popup !== null,
        subframe,
        worker,
      };
    },
    origins,
  );
}

function assertIsolationResults({ browserResults, allowed, forbidden, evidence }) {
  assert.equal(browserResults.sameOriginFetch, 200);
  assert.equal(browserResults.sameOriginWebSocket, "open");
  assert.equal(browserResults.forbiddenFetch, "blocked");
  assert.notEqual(browserResults.forbiddenWebSocket, "open");
  assert.equal(browserResults.serviceWorker, "blocked");
  assert.equal(browserResults.worker, "blocked");
  assert.equal(browserResults.popupOpened, true);
  assert.deepEqual(forbidden.counters, { requests: [], upgrades: [] });
  assert.equal(allowed.counters.requests.includes("/api/allowed"), true);
  assert.equal(allowed.counters.requests.includes("/sw.js"), false);
  assert.equal(allowed.counters.requests.includes("/embedded"), false);
  assert.equal(allowed.counters.requests.includes("/popup"), false);
  assert.deepEqual(allowed.counters.upgrades, ["/live"]);
  const kinds = new Set(evidence.violations.map(({ kind }) => kind));
  assert.equal(kinds.has("cross-origin-request"), true);
  assert.equal(kinds.has("cross-origin-websocket"), true);
  assert.equal(kinds.has("subframe-document"), true);
  assert.equal(
    kinds.has("popup-document") || kinds.has("popup-created"),
    true,
  );
  assert.equal(evidence.traffic.httpAllowed >= 2, true);
  assert.equal(evidence.traffic.httpBlocked >= 2, true);
  assert.equal(evidence.traffic.webSocketAllowed, 1);
  assert.equal(evidence.traffic.webSocketBlocked, 1);
}

test("Playwright origin isolation gives forbidden HTTP and WS servers zero requests", async (t) => {
  const [allowed, forbidden, browser] = await Promise.all([
    startObservedServer(),
    startObservedServer(),
    launchLocalTestBrowser(),
  ]);
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const isolation = await installCaptureOriginIsolation({
    context,
    page,
    cdp,
    allowedOrigin: allowed.origin,
  });
  t.after(async () => {
    await browser.close();
    isolation.dispose();
    await Promise.all([allowed.close(), forbidden.close()]);
  });

  await page.goto(allowed.origin, { waitUntil: "domcontentloaded" });
  const origins = {
    allowedOrigin: allowed.origin,
    forbiddenOrigin: forbidden.origin,
  };
  const results = await Promise.all([
    runFetchAttacks(page, origins),
    runSocketAttacks(page, origins),
    runDocumentAndWorkerAttacks(page, origins),
  ]);
  assertIsolationResults({
    browserResults: Object.assign({}, ...results),
    allowed,
    forbidden,
    evidence: isolation.snapshot(),
  });
});
