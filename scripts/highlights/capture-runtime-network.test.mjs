import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { loadPlaywrightChromium } from "./capture-source.mjs";
import {
  allocateRuntimeCoordinates,
  chromiumNetworkCommandEvidence,
  planCaptureRuntime,
  startCaptureRuntime,
} from "./capture-runtime.mjs";
import {
  CHROMIUM_DOCKER_BOUNDARY_AUTHORIZATION_ENV,
  CHROMIUM_SANDBOX_ENV,
  resolveChromiumSandboxPolicy,
} from "./chromium-sandbox.mjs";
import { prepareRuntimeTempNamespace } from "./runtime-temp.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const AUTHORIZATION_PATH = "/kandev-boundary/authorization.json";
const ATTESTED_DOCKER_BOUNDARY =
  process.env[CHROMIUM_DOCKER_BOUNDARY_AUTHORIZATION_ENV] ===
  AUTHORIZATION_PATH;

function listenUdp(socket) {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      socket.off("error", reject);
      resolve(socket.address());
    });
  });
}

function listenHttp(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
}

function closeSocket(socket) {
  return new Promise((resolve) => socket.close(resolve));
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForPacket(packets, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (packets.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return packets.length;
}

async function gatherIce(page, stunPort) {
  return page.evaluate(async (port) => {
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: `stun:127.0.0.1:${port}` }],
    });
    let candidates = 0;
    peer.addEventListener("icecandidate", (event) => {
      if (event.candidate) candidates += 1;
    });
    peer.createDataChannel("network-proof");
    await peer.setLocalDescription(await peer.createOffer());
    await Promise.race([
      new Promise((resolve) => {
        if (peer.iceGatheringState === "complete") {
          resolve();
          return;
        }
        peer.addEventListener(
          "icegatheringstatechange",
          () => {
            if (peer.iceGatheringState === "complete") resolve();
          },
          { once: false },
        );
      }),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    const result = {
      state: peer.iceGatheringState,
      candidates,
      directTcpSocket: typeof globalThis.TCPSocket,
      directUdpSocket: typeof globalThis.UDPSocket,
      webTransport: typeof globalThis.WebTransport,
    };
    peer.close();
    return result;
  }, stunPort);
}

async function probeWebTransport(page, udpPort) {
  return page.evaluate(async (port) => {
    if (typeof globalThis.WebTransport !== "function") {
      return { surface: typeof globalThis.WebTransport, outcome: "disabled" };
    }
    let transport;
    try {
      transport = new WebTransport(`https://127.0.0.1:${port}/network-proof`);
      const outcome = await Promise.race([
        transport.ready.then(
          () => "ready",
          () => "rejected",
        ),
        new Promise((resolve) => setTimeout(() => resolve("timed-out"), 1_500)),
      ]);
      return { surface: "function", outcome };
    } catch {
      return { surface: "function", outcome: "rejected" };
    } finally {
      try {
        transport?.close();
      } catch {
        // A rejected transport may already be closed by Chromium.
      }
    }
  }, udpPort);
}

test(
  "attested Chromium network controls block STUN after an unguarded positive control",
  {
    timeout: 90_000,
    skip: ATTESTED_DOCKER_BOUNDARY
      ? false
      : "requires the canonical read-only Docker v2 authorization boundary",
  },
  async (t) => {
    const authorization = JSON.parse(
      await fs.readFile(AUTHORIZATION_PATH, "utf8"),
    );
    assert.equal(
      authorization.contract,
      "kandev-highlight-docker-boundary-authorization-v1",
    );
    const sourceProof = {
      contract: "kandev-highlight-source-v1",
      source: "pr_head",
      repoRoot: REPOSITORY_ROOT,
      selectedSha: authorization.sourceSha,
      headSha: authorization.sourceSha,
      currentMainSha: authorization.sourceOriginMainSha,
      clean: true,
      status: "",
    };

    const root = await fs.mkdtemp("/tmp/highlight-udp-");
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const runtimeTempNamespace = await prepareRuntimeTempNamespace({
      namespaceRoot: path.join(root, "n"),
      coordinateLockRoot: "/tmp",
    });

    const udp = dgram.createSocket("udp4");
    const udpAddress = await listenUdp(udp);
    t.after(() => closeSocket(udp).catch(() => {}));
    const packets = [];
    udp.on("message", (message, remote) => {
      packets.push({
        bytes: message.length,
        address: remote.address,
        port: remote.port,
      });
    });

    const server = http.createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("<!doctype html><title>network proof</title>");
    });
    const httpAddress = await listenHttp(server);
    t.after(() => closeServer(server).catch(() => {}));
    const allowedOrigin = `http://127.0.0.1:${httpAddress.port}`;

    const chromium = await loadPlaywrightChromium(
      path.join(REPOSITORY_ROOT, "apps", "web"),
    );
    const executablePath = chromium.executablePath();
    const sandboxPolicy = await resolveChromiumSandboxPolicy({
      inheritedEnv: {
        [CHROMIUM_SANDBOX_ENV]: "disabled",
        [CHROMIUM_DOCKER_BOUNDARY_AUTHORIZATION_ENV]: AUTHORIZATION_PATH,
      },
      chromiumExecutable: executablePath,
      sourceProof,
      allowedOrigin,
    });
    assert.equal(sandboxPolicy.mode, "disabled");
    assert.equal(
      sandboxPolicy.authorization.contract,
      "kandev-highlight-disabled-sandbox-authorization-v2",
    );
    assert.equal(
      sandboxPolicy.authorization.outerBoundary.authorizationPath,
      AUTHORIZATION_PATH,
    );
    assert.equal(sandboxPolicy.authorization.outerBoundary.readOnlyMount, true);
    assert.equal(
      sandboxPolicy.authorization.sourceBinding.mode,
      "exact-boundary",
    );
    assert.equal(
      sandboxPolicy.authorization.sourceBinding.selectedSha,
      authorization.sourceSha,
    );

    const controlBrowser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox"],
    });
    const controlPage = await controlBrowser.newPage();
    await controlPage.goto(allowedOrigin);
    const controlProbe = await gatherIce(controlPage, udpAddress.port);
    assert.ok(
      (await waitForPacket(packets)) > 0,
      `unguarded Chromium emitted no STUN positive-control packet (${JSON.stringify(controlProbe)})`,
    );
    assert.ok(
      packets.every(
        (packet) =>
          packet.bytes >= 20 &&
          ["127.0.0.1", "::ffff:127.0.0.1"].includes(packet.address),
      ),
      `positive-control packets were not loopback STUN: ${JSON.stringify(packets)}`,
    );
    await controlBrowser.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    packets.length = 0;

    const coordinates = await allocateRuntimeCoordinates({
      coordinateLockRoot: runtimeTempNamespace.coordinateLockRoot,
      coordinateLockIdentity: runtimeTempNamespace.coordinateLockIdentity,
    });
    const plan = planCaptureRuntime({
      scenarioId: "network-proof",
      profile: {
        kind: "desktop",
        viewport: { width: 1920, height: 1200 },
        deviceScaleFactor: 2,
      },
      artifactRoot: path.join(root, "capture"),
      repositoryRoots: [REPOSITORY_ROOT],
      runId: "network-proof",
      ...coordinates,
      coordinateLockRoot: runtimeTempNamespace.coordinateLockRoot,
      coordinateLockIdentity: runtimeTempNamespace.coordinateLockIdentity,
      browserExecutable: executablePath,
      chromiumSandbox: sandboxPolicy,
    });
    Object.assign(plan.chromium.env, {
      TMPDIR: runtimeTempNamespace.namespaceRoot,
      TMP: runtimeTempNamespace.namespaceRoot,
      TEMP: runtimeTempNamespace.namespaceRoot,
    });
    const commandEvidence = chromiumNetworkCommandEvidence(
      plan.chromium,
      plan.chromiumNetworkPolicy,
    );
    assert.equal(commandEvidence.executable, executablePath);
    assert.match(commandEvidence.argsDigest, /^sha256:[a-f0-9]{64}$/);

    let runtime;
    try {
      runtime = await startCaptureRuntime(plan);
    } catch (error) {
      const chromiumLog = await fs
        .readFile(plan.chromiumLogPath, "utf8")
        .catch(() => "<missing Chromium log>");
      throw new Error(`${error.message}\nChromium log:\n${chromiumLog}`, {
        cause: error,
      });
    }
    t.after(() => runtime.stop().catch(() => {}));
    const browser = await chromium.connectOverCDP(plan.cdpEndpoint);
    t.after(() => browser.close().catch(() => {}));
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.goto(allowedOrigin);

    const guardedProbe = await gatherIce(page, udpAddress.port);
    const webTransportProbe = await probeWebTransport(page, udpAddress.port);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.deepEqual(
      packets,
      [],
      `forbidden guarded UDP escaped Chromium: ${JSON.stringify({ packets, guardedProbe, webTransportProbe })}`,
    );
    assert.equal(guardedProbe.directTcpSocket, "undefined");
    assert.equal(guardedProbe.directUdpSocket, "undefined");
    assert.notEqual(webTransportProbe.outcome, "ready");

    await browser.close();
    const teardown = await runtime.stop();
    assert.equal(teardown.processesGone, true);
    assert.equal(teardown.coordinatesReleased, true);
  },
);
