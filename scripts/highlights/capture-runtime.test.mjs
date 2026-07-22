import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  allocateRuntimeCoordinates,
  planCaptureRuntime,
  reserveCaptureRuntime,
  spawnManagedProcess,
  startCaptureRuntime,
} from "./capture-runtime.mjs";

const DESKTOP = Object.freeze({
  kind: "desktop",
  cssWidth: 1920,
  cssHeight: 1200,
  dpr: 2,
  sourceWidth: 3840,
  sourceHeight: 2400,
  fps: 25,
  nativeMobile: false,
});

const MOBILE = Object.freeze({
  kind: "native-mobile",
  cssWidth: 430,
  cssHeight: 932,
  dpr: 3,
  sourceWidth: 1290,
  sourceHeight: 2796,
  fps: 25,
  nativeMobile: true,
});

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "highlight-runtime-test-"),
  );
  const repositoryRoot = path.join(root, "repo");
  const artifactParent = path.join(root, "artifacts");
  await fs.mkdir(repositoryRoot);
  await fs.mkdir(artifactParent);
  return { root, repositoryRoot, artifactParent };
}

function runtimeOptions(paths, overrides = {}) {
  return {
    scenarioId: "quick-start",
    profile: DESKTOP,
    artifactRoot: path.join(paths.artifactParent, "run-r01"),
    repositoryRoots: [paths.repositoryRoot],
    runId: "r01",
    displayNumber: 261,
    cdpPort: 49_261,
    browserExecutable: "/opt/playwright/chromium",
    ...overrides,
  };
}

test("plans an external collision-free desktop runtime at native source dimensions", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));

  const plan = planCaptureRuntime(runtimeOptions(paths));

  assert.equal(plan.contract, "kandev-highlight-capture-runtime-v1");
  assert.equal(plan.display, ":261.0");
  assert.equal(plan.cdpEndpoint, "http://127.0.0.1:49261");
  assert.equal(
    plan.profileDir,
    path.join(plan.artifactRoot, "runtime", "browser-profile"),
  );
  assert.equal(
    plan.lockPath,
    path.join(plan.artifactRoot, "runtime", "capture.lock"),
  );
  assert.equal(
    plan.rawMasterPath,
    path.join(plan.artifactRoot, "raw", "quick-start.source.mp4"),
  );
  assert.deepEqual(plan.browserMetrics, {
    width: 1920,
    height: 1200,
    deviceScaleFactor: 2,
    mobile: false,
    touch: false,
  });
  assert.ok(plan.xvfb.args.includes("3840x2400x24"));
  assert.ok(plan.chromium.args.includes("--remote-debugging-port=49261"));
  assert.ok(plan.chromium.args.includes(`--user-data-dir=${plan.profileDir}`));
  assert.ok(plan.chromium.args.includes("--window-size=3840,2400"));
  assert.ok(plan.chromium.args.includes("--kiosk"));
  assert.ok(plan.chromium.args.includes("--disable-infobars"));
  assert.ok(plan.chromium.args.includes("--test-type"));
  assert.equal(plan.chromium.env.DISPLAY, ":261.0");
});

test("plans native-mobile as a portrait source with mobile metrics and touch", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));

  const plan = planCaptureRuntime(runtimeOptions(paths, { profile: MOBILE }));

  assert.ok(plan.xvfb.args.includes("1290x2796x24"));
  assert.ok(plan.chromium.args.includes("--window-size=1290,2796"));
  assert.deepEqual(plan.browserMetrics, {
    width: 430,
    height: 932,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
  });
  assert.notEqual(
    plan.profile.sourceWidth,
    3840,
    "mobile must never reuse/crop desktop source",
  );
});

test("refuses repository-local artifacts, unsafe identifiers, and occupied roots", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));

  assert.throws(
    () =>
      planCaptureRuntime(
        runtimeOptions(paths, {
          artifactRoot: path.join(paths.repositoryRoot, "capture"),
        }),
      ),
    /outside every repository root/,
  );
  assert.throws(
    () =>
      planCaptureRuntime(runtimeOptions(paths, { scenarioId: "../escape" })),
    /scenarioId/,
  );
  assert.throws(
    () => planCaptureRuntime(runtimeOptions(paths, { displayNumber: 0 })),
    /displayNumber/,
  );
  assert.throws(
    () => planCaptureRuntime(runtimeOptions(paths, { cdpPort: 70_000 })),
    /cdpPort/,
  );

  const plan = planCaptureRuntime(runtimeOptions(paths));
  await fs.mkdir(plan.artifactRoot);
  await assert.rejects(
    () => reserveCaptureRuntime(plan),
    /refusing to overwrite capture artifact root/,
  );
});

test("allocates first display and port pair proven free", async () => {
  const seen = [];
  const coordinates = await allocateRuntimeCoordinates({
    displayRange: [250, 253],
    portRange: [49_250, 49_253],
    isDisplayFree: async (displayNumber) => {
      seen.push(["display", displayNumber]);
      return displayNumber >= 252;
    },
    isPortFree: async (port) => {
      seen.push(["port", port]);
      return port === 49_252;
    },
  });

  assert.deepEqual(coordinates, { displayNumber: 252, cdpPort: 49_252 });
  assert.deepEqual(seen, [
    ["display", 250],
    ["display", 251],
    ["display", 252],
    ["port", 49_250],
    ["port", 49_251],
    ["port", 49_252],
  ]);
});

test("allocation skips a live coordinate lock and retries another pair", async () => {
  const seen = [];
  const coordinates = await allocateRuntimeCoordinates({
    displayRange: [250, 251],
    portRange: [49_250, 49_251],
    isDisplayFree: async () => true,
    isPortFree: async () => true,
    isCoordinateAvailable: async (displayNumber, port) => {
      seen.push([displayNumber, port]);
      return port === 49_251;
    },
  });

  assert.deepEqual(coordinates, { displayNumber: 250, cdpPort: 49_251 });
  assert.deepEqual(seen, [
    [250, 49_250],
    [250, 49_251],
  ]);
});

test("reservation reclaims only a proven-dead PID/start-token coordinate lock", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));
  const plan = planCaptureRuntime(runtimeOptions(paths));
  t.after(() => fs.unlink(plan.coordinateLockPath).catch(() => {}));
  await fs.writeFile(
    plan.coordinateLockPath,
    `${JSON.stringify({
      contract: "kandev-highlight-coordinate-lock-v1",
      owner: { pid: 999_999, startToken: "dead-start-token" },
      artifactRoot: "/external/abandoned-run",
    })}\n`,
    { flag: "wx" },
  );

  await reserveCaptureRuntime(plan, {
    processStartToken: async (pid) =>
      pid === process.pid ? "current-start-token" : null,
    isDisplayFree: async () => true,
    isPortFree: async () => true,
  });

  const recovered = JSON.parse(
    await fs.readFile(plan.coordinateLockPath, "utf8"),
  );
  assert.equal(recovered.contract, "kandev-highlight-coordinate-lock-v1");
  assert.equal(recovered.owner.pid, process.pid);
  assert.match(recovered.owner.startToken, /current-start-token/);
});

test("reservation never unlinks malformed or live coordinate locks", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));
  const malformedPlan = planCaptureRuntime(runtimeOptions(paths));
  t.after(() => fs.unlink(malformedPlan.coordinateLockPath).catch(() => {}));
  await fs.writeFile(malformedPlan.coordinateLockPath, "not-json\n", {
    flag: "wx",
  });
  await assert.rejects(
    () =>
      reserveCaptureRuntime(malformedPlan, {
        processStartToken: async () => "current-start-token",
        isDisplayFree: async () => true,
        isPortFree: async () => true,
      }),
    /malformed coordinate lock/i,
  );
  assert.equal(
    await fs.readFile(malformedPlan.coordinateLockPath, "utf8"),
    "not-json\n",
  );

  await fs.unlink(malformedPlan.coordinateLockPath);
  await fs.writeFile(
    malformedPlan.coordinateLockPath,
    `${JSON.stringify({
      contract: "kandev-highlight-coordinate-lock-v1",
      owner: { pid: process.pid, startToken: "live-token" },
      artifactRoot: "/external/live-run",
    })}\n`,
    { flag: "wx" },
  );
  await assert.rejects(
    () =>
      reserveCaptureRuntime(malformedPlan, {
        processStartToken: async () => "live-token",
        isDisplayFree: async () => true,
        isPortFree: async () => true,
      }),
    /live coordinate lock/i,
  );
  assert.match(
    await fs.readFile(malformedPlan.coordinateLockPath, "utf8"),
    /live-token/,
  );
});

test("managed process waits for SIGKILL exit and rejects a surviving child", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "highlight-process-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 7_331;
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  const waits = [];
  const handlePromise = spawnManagedProcess(
    {
      name: "fixture",
      command: "/fixture/process",
      args: [],
      env: {},
      logPath: path.join(root, "fixture.log"),
    },
    {
      spawnProcess: () => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
      killProcess: (_pid, signal) => signals.push(signal),
      waitForChildExit: async (_child, timeoutMs) => {
        waits.push(timeoutMs);
        return false;
      },
    },
  );
  const handle = await handlePromise;

  await assert.rejects(() => handle.stop(), /survived SIGKILL/i);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(waits, [5_000, 2_000]);
});

test("reservation is atomic and preserves durable raw/log/evidence directories", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));
  const plan = planCaptureRuntime(runtimeOptions(paths));
  t.after(() => fs.unlink(plan.coordinateLockPath).catch(() => {}));

  await reserveCaptureRuntime(plan);

  const lock = JSON.parse(await fs.readFile(plan.lockPath, "utf8"));
  assert.equal(lock.contract, "kandev-highlight-capture-lock-v1");
  assert.equal(lock.scenarioId, "quick-start");
  for (const directory of [
    plan.rawDir,
    plan.logsDir,
    plan.evidenceDir,
    plan.profileDir,
  ]) {
    assert.equal((await fs.stat(directory)).isDirectory(), true);
  }
  await assert.rejects(
    () => reserveCaptureRuntime(plan),
    /refusing to overwrite capture artifact root/,
  );
});

test("starts Xvfb then Chromium and teardown proves transient resources gone", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));
  const plan = planCaptureRuntime(runtimeOptions(paths));
  const events = [];
  const handles = new Map();
  const spawnManaged = async (spec) => {
    const handle = {
      name: spec.name,
      pid: spec.name === "xvfb" ? 101 : 102,
      async stop() {
        events.push(`stop:${spec.name}`);
      },
      isRunning() {
        return false;
      },
    };
    handles.set(spec.name, handle);
    events.push(`spawn:${spec.name}`);
    return handle;
  };

  const runtime = await startCaptureRuntime(plan, {
    spawnManaged,
    isDisplayFree: async () => true,
    isPortFree: async () => true,
    waitForDisplay: async () => events.push("ready:display"),
    waitForCdp: async () => events.push("ready:cdp"),
    verifyDisplayReleased: async () => events.push("released:display"),
    verifyPortReleased: async () => events.push("released:port"),
  });

  assert.deepEqual(events.slice(0, 4), [
    "spawn:xvfb",
    "ready:display",
    "spawn:chromium",
    "ready:cdp",
  ]);
  const teardown = await runtime.stop();
  assert.deepEqual(events.slice(4), [
    "stop:chromium",
    "stop:xvfb",
    "released:display",
    "released:port",
  ]);
  await assert.rejects(fs.stat(plan.profileDir), { code: "ENOENT" });
  await assert.rejects(fs.stat(plan.lockPath), { code: "ENOENT" });
  assert.equal((await fs.stat(plan.rawDir)).isDirectory(), true);
  assert.equal((await fs.stat(plan.logsDir)).isDirectory(), true);
  assert.equal((await fs.stat(plan.evidenceDir)).isDirectory(), true);
  assert.equal(handles.get("chromium").isRunning(), false);
  assert.equal(handles.get("xvfb").isRunning(), false);
  assert.deepEqual(teardown, {
    processesGone: true,
    coordinatesReleased: true,
    profileRemoved: true,
    lockRemoved: true,
    display: ":261.0",
    cdpPort: 49_261,
    processes: [
      { name: "xvfb", pid: 101, gone: true },
      { name: "chromium", pid: 102, gone: true },
    ],
  });
});

test("startup failure tears down partial runtime without deleting recoverable artifacts", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));
  const plan = planCaptureRuntime(runtimeOptions(paths));
  const stopped = [];

  await assert.rejects(
    () =>
      startCaptureRuntime(plan, {
        spawnManaged: async (spec) => ({
          name: spec.name,
          pid: 201,
          async stop() {
            stopped.push(spec.name);
          },
          isRunning() {
            return false;
          },
        }),
        isDisplayFree: async () => true,
        isPortFree: async () => true,
        waitForDisplay: async () => {},
        waitForCdp: async () => {
          throw new Error("CDP port 49261 did not become ready");
        },
        verifyDisplayReleased: async () => {},
        verifyPortReleased: async () => {},
      }),
    /CDP port 49261 did not become ready/,
  );

  assert.deepEqual(stopped, ["chromium", "xvfb"]);
  await assert.rejects(fs.stat(plan.profileDir), { code: "ENOENT" });
  await assert.rejects(fs.stat(plan.lockPath), { code: "ENOENT" });
  assert.equal((await fs.stat(plan.logsDir)).isDirectory(), true);
});

test("startup failure aggregates teardown failure instead of hiding it", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));
  const plan = planCaptureRuntime(
    runtimeOptions(paths, { displayNumber: 263, cdpPort: 49_263 }),
  );

  await assert.rejects(
    () =>
      startCaptureRuntime(plan, {
        spawnManaged: async (spec) => ({
          name: spec.name,
          pid: 301,
          async stop() {
            throw new Error(`${spec.name} teardown failed`);
          },
          isRunning() {
            return true;
          },
        }),
        isDisplayFree: async () => true,
        isPortFree: async () => true,
        waitForDisplay: async () => {},
        waitForCdp: async () => {
          throw new Error("CDP readiness failed");
        },
        verifyDisplayReleased: async () => {},
        verifyPortReleased: async () => {},
      }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(error.message, /startup.*teardown/i);
      assert.equal(error.errors[0].message, "CDP readiness failed");
      assert.match(error.errors[1].message, /capture runtime teardown failed/i);
      return true;
    },
  );
});
