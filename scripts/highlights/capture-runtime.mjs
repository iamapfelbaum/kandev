import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { resolveCaptureProfile } from "./camera-compiler.mjs";

const SAFE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const DEFAULT_DISPLAY_RANGE = Object.freeze([220, 399]);
const DEFAULT_PORT_RANGE = Object.freeze([49_000, 49_999]);

function integerInRange(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer ${minimum}-${maximum}`);
  }
  return value;
}

function normalizeRange(value, fallback, label, minimum, maximum) {
  const range = value ?? fallback;
  if (!Array.isArray(range) || range.length !== 2)
    throw new Error(`${label} must be [start, end]`);
  const start = integerInRange(range[0], minimum, maximum, `${label}[0]`);
  const end = integerInRange(range[1], minimum, maximum, `${label}[1]`);
  if (start > end) throw new Error(`${label} start must not exceed end`);
  return [start, end];
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function assertExternalArtifactRoot(artifactRoot, repositoryRoots) {
  for (const repositoryRoot of repositoryRoots) {
    if (inside(artifactRoot, repositoryRoot)) {
      throw new Error(
        `capture artifactRoot must stay outside every repository root: ${artifactRoot}`,
      );
    }
  }
}

async function assertCanonicalExternalRoot(plan) {
  const artifactParent = await fs.realpath(path.dirname(plan.artifactRoot));
  for (const repositoryRoot of plan.repositoryRoots) {
    let canonicalRepository;
    try {
      canonicalRepository = await fs.realpath(repositoryRoot);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (
      inside(
        path.join(artifactParent, path.basename(plan.artifactRoot)),
        canonicalRepository,
      )
    ) {
      throw new Error(
        `capture artifactRoot must stay outside every repository root after symlink resolution: ${plan.artifactRoot}`,
      );
    }
  }
}

function normalizeProfile(profile) {
  if (!profile || typeof profile !== "object")
    throw new Error("capture profile is required");
  const scenarioProfile = profile.viewport
    ? profile
    : {
        kind: profile.kind,
        viewport: { width: profile.cssWidth, height: profile.cssHeight },
        deviceScaleFactor: profile.dpr,
      };
  const canonical = resolveCaptureProfile(scenarioProfile);
  for (const field of [
    "sourceWidth",
    "sourceHeight",
    "cssWidth",
    "cssHeight",
    "dpr",
    "fps",
  ]) {
    if (profile[field] !== undefined && profile[field] !== canonical[field]) {
      throw new Error(
        `capture profile ${field} must equal production contract ${canonical[field]}`,
      );
    }
  }
  return canonical;
}

export async function isDisplayAvailable(displayNumber) {
  integerInRange(displayNumber, 1, 9_999, "displayNumber");
  const lockPath = `/tmp/.X${displayNumber}-lock`;
  const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
  const present = await Promise.all(
    [lockPath, socketPath].map(async (entry) => {
      try {
        await fs.access(entry);
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    }),
  );
  return !present.some(Boolean);
}

export async function isTcpPortAvailable(port) {
  integerInRange(port, 1_024, 65_535, "cdpPort");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES")
        resolve(false);
      else reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

export async function allocateRuntimeCoordinates({
  displayRange,
  portRange,
  isDisplayFree = isDisplayAvailable,
  isPortFree = isTcpPortAvailable,
} = {}) {
  const [displayStart, displayEnd] = normalizeRange(
    displayRange,
    DEFAULT_DISPLAY_RANGE,
    "displayRange",
    1,
    9_999,
  );
  const [portStart, portEnd] = normalizeRange(
    portRange,
    DEFAULT_PORT_RANGE,
    "portRange",
    1_024,
    65_535,
  );
  let displayNumber = null;
  for (let candidate = displayStart; candidate <= displayEnd; candidate += 1) {
    if (await isDisplayFree(candidate)) {
      displayNumber = candidate;
      break;
    }
  }
  if (displayNumber === null)
    throw new Error(`no free X display in ${displayStart}-${displayEnd}`);
  let cdpPort = null;
  for (let candidate = portStart; candidate <= portEnd; candidate += 1) {
    if (await isPortFree(candidate)) {
      cdpPort = candidate;
      break;
    }
  }
  if (cdpPort === null)
    throw new Error(`no free CDP port in ${portStart}-${portEnd}`);
  return { displayNumber, cdpPort };
}

export function planCaptureRuntime({
  scenarioId,
  profile,
  artifactRoot,
  repositoryRoots = [process.cwd()],
  runId,
  displayNumber,
  cdpPort,
  browserExecutable,
  xvfbExecutable = "Xvfb",
} = {}) {
  if (typeof scenarioId !== "string" || !SAFE_ID.test(scenarioId)) {
    throw new Error(
      "scenarioId must be a safe lowercase dotted/kebab identifier",
    );
  }
  if (typeof runId !== "string" || !SAFE_RUN_ID.test(runId))
    throw new Error("runId must be a safe identifier");
  if (typeof artifactRoot !== "string" || !path.isAbsolute(artifactRoot)) {
    throw new Error("artifactRoot must be an absolute external path");
  }
  if (!Array.isArray(repositoryRoots) || repositoryRoots.length === 0) {
    throw new Error(
      "repositoryRoots must contain at least one repository path",
    );
  }
  if (
    typeof browserExecutable !== "string" ||
    !path.isAbsolute(browserExecutable)
  ) {
    throw new Error(
      "browserExecutable must be an absolute Playwright Chromium path",
    );
  }
  const captureProfile = normalizeProfile(profile);
  const resolvedRoot = path.resolve(artifactRoot);
  const resolvedRepositories = repositoryRoots.map((entry) =>
    path.resolve(entry),
  );
  assertExternalArtifactRoot(resolvedRoot, resolvedRepositories);
  integerInRange(displayNumber, 1, 9_999, "displayNumber");
  integerInRange(cdpPort, 1_024, 65_535, "cdpPort");
  const runtimeDir = path.join(resolvedRoot, "runtime");
  const profileDir = path.join(runtimeDir, "browser-profile");
  const logsDir = path.join(resolvedRoot, "logs");
  const display = `:${displayNumber}.0`;
  const sourceGeometry = `${captureProfile.sourceWidth}x${captureProfile.sourceHeight}`;
  const coordinateLockPath = path.join(
    os.tmpdir(),
    `kandev-highlight-${displayNumber}-${cdpPort}.lock`,
  );
  return {
    contract: "kandev-highlight-capture-runtime-v1",
    scenarioId,
    runId,
    profile: captureProfile,
    artifactRoot: resolvedRoot,
    repositoryRoots: resolvedRepositories,
    runtimeDir,
    profileDir,
    rawDir: path.join(resolvedRoot, "raw"),
    logsDir,
    evidenceDir: path.join(resolvedRoot, "evidence"),
    rawMasterPath: path.join(resolvedRoot, "raw", `${scenarioId}.source.mp4`),
    lockPath: path.join(runtimeDir, "capture.lock"),
    coordinateLockPath,
    xvfbLogPath: path.join(logsDir, "xvfb.log"),
    chromiumLogPath: path.join(logsDir, "chromium.log"),
    ffmpegLogPath: path.join(logsDir, "ffmpeg.log"),
    progressPath: path.join(logsDir, "ffmpeg.progress"),
    displayNumber,
    display,
    cdpPort,
    cdpEndpoint: `http://127.0.0.1:${cdpPort}`,
    browserMetrics: {
      width: captureProfile.cssWidth,
      height: captureProfile.cssHeight,
      deviceScaleFactor: captureProfile.dpr,
      mobile: captureProfile.nativeMobile,
      touch: captureProfile.nativeMobile,
    },
    xvfb: {
      name: "xvfb",
      command: xvfbExecutable,
      args: [
        `:${displayNumber}`,
        "-screen",
        "0",
        `${sourceGeometry}x24`,
        "-nolisten",
        "tcp",
        "-ac",
      ],
      env: {},
      logPath: path.join(logsDir, "xvfb.log"),
    },
    chromium: {
      name: "chromium",
      command: browserExecutable,
      args: [
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-infobars",
        "--test-type",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-features=Translate,MediaRouter",
        "--force-color-profile=srgb",
        "--hide-scrollbars",
        "--kiosk",
        "--window-position=0,0",
        `--window-size=${captureProfile.sourceWidth},${captureProfile.sourceHeight}`,
        "about:blank",
      ],
      env: { DISPLAY: display },
      logPath: path.join(logsDir, "chromium.log"),
    },
  };
}

async function unlinkIfPresent(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function reserveCaptureRuntime(plan) {
  if (plan?.contract !== "kandev-highlight-capture-runtime-v1")
    throw new Error("invalid capture runtime plan");
  await fs.mkdir(path.dirname(plan.artifactRoot), { recursive: true });
  await assertCanonicalExternalRoot(plan);
  try {
    await fs.access(plan.artifactRoot);
    throw new Error(
      `refusing to overwrite capture artifact root: ${plan.artifactRoot}`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let coordinateReserved = false;
  let rootCreated = false;
  try {
    await fs.writeFile(
      plan.coordinateLockPath,
      `${JSON.stringify({ pid: process.pid, artifactRoot: plan.artifactRoot })}\n`,
      { flag: "wx" },
    );
    coordinateReserved = true;
    try {
      await fs.mkdir(plan.artifactRoot);
      rootCreated = true;
    } catch (error) {
      if (error.code === "EEXIST")
        throw new Error(
          `refusing to overwrite capture artifact root: ${plan.artifactRoot}`,
        );
      throw error;
    }
    await fs.mkdir(plan.runtimeDir);
    await Promise.all([
      fs.mkdir(plan.profileDir),
      fs.mkdir(plan.rawDir),
      fs.mkdir(plan.logsDir),
      fs.mkdir(plan.evidenceDir),
    ]);
    const lock = {
      contract: "kandev-highlight-capture-lock-v1",
      scenarioId: plan.scenarioId,
      runId: plan.runId,
      pid: process.pid,
      display: plan.display,
      cdpPort: plan.cdpPort,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(plan.lockPath, `${JSON.stringify(lock, null, 2)}\n`, {
      flag: "wx",
    });
    return lock;
  } catch (error) {
    if (rootCreated)
      await fs
        .rm(plan.artifactRoot, { recursive: true, force: true })
        .catch(() => {});
    if (coordinateReserved)
      await unlinkIfPresent(plan.coordinateLockPath).catch(() => {});
    throw error;
  }
}

function processError(child, spec) {
  return new Promise((resolve, reject) => {
    const onError = (error) =>
      reject(
        new Error(
          `cannot start ${spec.name} (${spec.command}): ${error.message}`,
          { cause: error },
        ),
      );
    child.once("error", onError);
    child.once("spawn", () => {
      child.off("error", onError);
      resolve();
    });
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

export async function spawnManagedProcess(spec) {
  const log = fsSync.createWriteStream(spec.logPath, { flags: "ax" });
  const child = spawn(spec.command, spec.args, {
    env: { ...process.env, ...spec.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  try {
    await processError(child, spec);
  } catch (error) {
    log.end();
    throw error;
  }
  let stopped = false;
  return {
    name: spec.name,
    pid: child.pid,
    isRunning() {
      return child.exitCode === null && child.signalCode === null;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        if (!(await waitForExit(child, 5_000))) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
          await waitForExit(child, 2_000);
        }
      }
      log.end();
      if (child.exitCode === null && child.signalCode === null) {
        throw new Error(`${spec.name} process ${child.pid} survived teardown`);
      }
    },
  };
}

async function pollUntil(check, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const detail = lastError ? `: ${lastError.message}` : "";
  throw new Error(`${message}${detail}`);
}

export async function waitForDisplayReady(plan) {
  const socketPath = `/tmp/.X11-unix/X${plan.displayNumber}`;
  await pollUntil(async () => {
    try {
      await fs.access(socketPath);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }, `X display ${plan.display} did not become ready`);
}

export async function waitForCdpReady(plan) {
  await pollUntil(async () => {
    const response = await fetch(`${plan.cdpEndpoint}/json/version`);
    return response.ok;
  }, `CDP port ${plan.cdpPort} did not become ready`);
}

async function verifyReleased(check, message) {
  await pollUntil(check, message, 8_000);
}

async function removeTransientRuntime(plan) {
  await fs.rm(plan.profileDir, { recursive: true, force: true });
  await unlinkIfPresent(plan.lockPath);
  await unlinkIfPresent(plan.coordinateLockPath);
}

async function pathIsMissing(target) {
  try {
    await fs.access(target);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

export async function startCaptureRuntime(
  plan,
  {
    spawnManaged = spawnManagedProcess,
    isDisplayFree = isDisplayAvailable,
    isPortFree = isTcpPortAvailable,
    waitForDisplay = waitForDisplayReady,
    waitForCdp = waitForCdpReady,
    verifyDisplayReleased = (runtimePlan) =>
      verifyReleased(
        () => isDisplayFree(runtimePlan.displayNumber),
        `X display ${runtimePlan.display} remained occupied after teardown`,
      ),
    verifyPortReleased = (runtimePlan) =>
      verifyReleased(
        () => isPortFree(runtimePlan.cdpPort),
        `CDP port ${runtimePlan.cdpPort} remained occupied after teardown`,
      ),
  } = {},
) {
  if (!(await isDisplayFree(plan.displayNumber)))
    throw new Error(`X display ${plan.display} is already occupied`);
  if (!(await isPortFree(plan.cdpPort)))
    throw new Error(`CDP port ${plan.cdpPort} is already occupied`);
  await reserveCaptureRuntime(plan);
  const handles = [];
  let stopping = null;
  const stop = async () => {
    if (stopping) return stopping;
    stopping = (async () => {
      const failures = [];
      for (const handle of [...handles].reverse()) {
        try {
          await handle.stop();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await verifyDisplayReleased(plan);
      } catch (error) {
        failures.push(error);
      }
      try {
        await verifyPortReleased(plan);
      } catch (error) {
        failures.push(error);
      }
      try {
        await removeTransientRuntime(plan);
      } catch (error) {
        failures.push(error);
      }
      const processes = handles.map((handle) => ({
        name: handle.name,
        pid: handle.pid,
        gone: !handle.isRunning(),
      }));
      if (processes.some((processEvidence) => !processEvidence.gone)) {
        failures.push(
          new Error("one or more capture processes survived teardown"),
        );
      }
      const [profileRemoved, lockRemoved, coordinateLockRemoved] =
        await Promise.all([
          pathIsMissing(plan.profileDir),
          pathIsMissing(plan.lockPath),
          pathIsMissing(plan.coordinateLockPath),
        ]);
      if (!profileRemoved)
        failures.push(
          new Error(`browser profile survived teardown: ${plan.profileDir}`),
        );
      if (!lockRemoved || !coordinateLockRemoved)
        failures.push(new Error("capture runtime lock survived teardown"));
      if (failures.length)
        throw new AggregateError(failures, "capture runtime teardown failed");
      return {
        processesGone: true,
        coordinatesReleased: true,
        profileRemoved,
        lockRemoved: lockRemoved && coordinateLockRemoved,
        display: plan.display,
        cdpPort: plan.cdpPort,
        processes,
      };
    })();
    return stopping;
  };
  try {
    const xvfb = await spawnManaged(plan.xvfb);
    handles.push(xvfb);
    await waitForDisplay(plan, xvfb);
    const chromium = await spawnManaged(plan.chromium);
    handles.push(chromium);
    await waitForCdp(plan, chromium);
    return {
      contract: "kandev-highlight-live-runtime-v1",
      plan,
      handles,
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch (teardownError) {
      error.teardownError = teardownError;
    }
    throw error;
  }
}
