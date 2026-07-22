import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync, { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { resolveCaptureProfile } from "./camera-compiler.mjs";
import {
  defaultChromiumSandboxPolicy,
  validateChromiumSandboxPolicy,
} from "./chromium-sandbox-contract.mjs";

const SAFE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const DEFAULT_DISPLAY_RANGE = Object.freeze([220, 399]);
const DEFAULT_PORT_RANGE = Object.freeze([49_000, 49_999]);
const MAX_COORDINATE_LOCK_BYTES = 4 * 1024;
const CHROMIUM_NETWORK_POLICY = Object.freeze({
  contract: "kandev-highlight-chromium-network-policy-v1",
  version: 1,
  webrtcIpHandlingPolicy: "disable_non_proxied_udp",
  quicDisabled: true,
  disabledFeatures: Object.freeze(["DirectSockets", "WebTransport"]),
  switches: Object.freeze([
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-quic",
    "--disable-blink-features=DirectSockets,WebTransport",
  ]),
});

export function chromiumNetworkIsolationPolicy() {
  return structuredClone(CHROMIUM_NETWORK_POLICY);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function chromiumNetworkCommandEvidence(
  command,
  policy = chromiumNetworkIsolationPolicy(),
) {
  if (
    canonicalJson(policy) !== canonicalJson(chromiumNetworkIsolationPolicy())
  ) {
    throw new Error("Chromium network policy is not the canonical contract");
  }
  if (
    !command ||
    typeof command.command !== "string" ||
    !path.isAbsolute(command.command) ||
    !Array.isArray(command.args) ||
    command.args.some((argument) => typeof argument !== "string")
  ) {
    throw new Error(
      "Chromium network command must contain exact executable argv",
    );
  }
  for (const required of policy.switches) {
    if (command.args.filter((argument) => argument === required).length !== 1) {
      throw new Error(
        `Chromium network argv is missing exact switch ${required}`,
      );
    }
  }
  const disabledFeatureArguments = command.args.filter((argument) =>
    argument.startsWith("--disable-features="),
  );
  const disabledFeatures = new Set(
    disabledFeatureArguments.flatMap((argument) =>
      argument.slice("--disable-features=".length).split(","),
    ),
  );
  const disabledBlinkFeatureArguments = command.args.filter((argument) =>
    argument.startsWith("--disable-blink-features="),
  );
  const disabledBlinkFeatures = new Set(
    disabledBlinkFeatureArguments.flatMap((argument) =>
      argument.slice("--disable-blink-features=".length).split(","),
    ),
  );
  if (
    disabledFeatureArguments.length !== 1 ||
    policy.disabledFeatures.some((feature) => !disabledFeatures.has(feature)) ||
    disabledBlinkFeatureArguments.length !== 1 ||
    policy.disabledFeatures.some(
      (feature) => !disabledBlinkFeatures.has(feature),
    ) ||
    command.args.some(
      (argument) =>
        argument === "--enable-quic" ||
        argument.startsWith("--enable-quic=") ||
        (argument.startsWith("--disable-quic") &&
          argument !== "--disable-quic") ||
        (argument.startsWith("--enable-features=") &&
          argument
            .slice("--enable-features=".length)
            .split(",")
            .some((feature) => policy.disabledFeatures.includes(feature))) ||
        (argument.startsWith("--enable-blink-features=") &&
          argument
            .slice("--enable-blink-features=".length)
            .split(",")
            .some((feature) => policy.disabledFeatures.includes(feature))) ||
        (argument.startsWith("--webrtc-ip-handling-policy") &&
          argument !== policy.switches[1]) ||
        (argument.startsWith("--force-webrtc-ip-handling-policy") &&
          argument !== policy.switches[0]),
    )
  ) {
    throw new Error(
      "Chromium network argv enables a forbidden direct transport or omits a disabled feature",
    );
  }
  const args = [...command.args];
  return {
    contract: "kandev-highlight-chromium-network-command-v1",
    version: 1,
    executable: command.command,
    args,
    argsDigest: sha256(canonicalJson(args)),
    policyDigest: sha256(canonicalJson(policy)),
  };
}

export function captureCoordinateLockPath(
  coordinateLockRoot,
  displayNumber,
  cdpPort,
) {
  return path.join(
    coordinateLockRoot,
    `kandev-highlight-${displayNumber}-${cdpPort}.lock`,
  );
}

export async function processStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/);
    const token = fields[19];
    return /^\d+$/.test(token ?? "") ? token : null;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
}

async function openCoordinateLockHandle(lockPath) {
  const pathStat = await fs.lstat(lockPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!pathStat) return null;
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error(`coordinate lock must be a non-symlink file: ${lockPath}`);
  }
  let handle;
  try {
    handle = await fs.open(
      lockPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(
      `cannot open coordinate lock without following symlinks: ${lockPath}`,
      { cause: error },
    );
  }
  return { handle, pathStat };
}

function parseCoordinateLock(contents, lockPath) {
  let lock;
  try {
    lock = JSON.parse(contents);
  } catch {
    throw new Error(`malformed coordinate lock: ${lockPath}`);
  }
  if (
    lock?.contract !== "kandev-highlight-coordinate-lock-v1" ||
    !Number.isInteger(lock.owner?.pid) ||
    lock.owner.pid <= 0 ||
    typeof lock.owner?.startToken !== "string" ||
    lock.owner.startToken === "" ||
    typeof lock.artifactRoot !== "string"
  ) {
    throw new Error(`malformed coordinate lock: ${lockPath}`);
  }
  return lock;
}

async function openedCoordinateLock(lockPath) {
  const opened = await openCoordinateLockHandle(lockPath);
  if (!opened) return null;
  try {
    const before = await opened.handle.stat();
    if (
      before.dev !== opened.pathStat.dev ||
      before.ino !== opened.pathStat.ino
    ) {
      throw new Error(`coordinate lock changed while opening: ${lockPath}`);
    }
    if (before.size <= 0 || before.size > MAX_COORDINATE_LOCK_BYTES) {
      throw new Error(`malformed coordinate lock: ${lockPath}`);
    }
    const contents = Buffer.alloc(before.size + 1);
    const { bytesRead } = await opened.handle.read(
      contents,
      0,
      contents.length,
      0,
    );
    const after = await opened.handle.stat();
    if (
      bytesRead !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) {
      throw new Error(`coordinate lock changed while reading: ${lockPath}`);
    }
    return {
      lock: parseCoordinateLock(
        contents.subarray(0, bytesRead).toString("utf8"),
        lockPath,
      ),
      stat: before,
    };
  } finally {
    await opened.handle.close();
  }
}

async function unlinkSameCoordinateLock(lockPath, expectedStat) {
  let current;
  try {
    current = await fs.lstat(lockPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (current.dev !== expectedStat.dev || current.ino !== expectedStat.ino) {
    throw new Error(
      `coordinate lock changed while checking stale owner: ${lockPath}`,
    );
  }
  await fs.unlink(lockPath);
}

async function reclaimDeadCoordinateLock(
  lockPath,
  {
    displayNumber,
    cdpPort,
    getProcessStartToken = processStartToken,
    isDisplayFree = isDisplayAvailable,
    isPortFree = isTcpPortAvailable,
  },
) {
  const opened = await openedCoordinateLock(lockPath);
  if (!opened) return true;
  const currentToken = await getProcessStartToken(opened.lock.owner.pid);
  if (currentToken === opened.lock.owner.startToken) return false;
  if (!(await isDisplayFree(displayNumber)) || !(await isPortFree(cdpPort))) {
    return false;
  }
  await unlinkSameCoordinateLock(lockPath, opened.stat);
  return true;
}

async function defaultCoordinateAvailableInRoot(
  coordinateLockRoot,
  displayNumber,
  cdpPort,
) {
  try {
    return await reclaimDeadCoordinateLock(
      captureCoordinateLockPath(coordinateLockRoot, displayNumber, cdpPort),
      { displayNumber, cdpPort },
    );
  } catch (error) {
    if (/malformed coordinate lock/.test(error.message)) return false;
    throw error;
  }
}

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

function requireAbsoluteCoordinateLockRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("coordinateLockRoot must be an absolute controlled path");
  }
  return path.resolve(value);
}

function normalizeCoordinateLockIdentity(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("coordinateLockIdentity must be an inode identity object");
  }
  const keys = ["dev", "ino", "uid", "mode"];
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0) ||
    value.ino === 0
  ) {
    throw new Error("coordinateLockIdentity is invalid");
  }
  return {
    dev: value.dev,
    ino: value.ino,
    uid: value.uid,
    mode: value.mode,
  };
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

async function assertCanonicalCoordinateLockDirectory(coordinateLockRoot) {
  const rootStat = await fs.lstat(coordinateLockRoot).catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(
        `coordinateLockRoot does not exist: ${coordinateLockRoot}`,
      );
    }
    throw error;
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(
      `coordinateLockRoot must be a non-symlink directory: ${coordinateLockRoot}`,
    );
  }
  if ((await fs.realpath(coordinateLockRoot)) !== coordinateLockRoot) {
    throw new Error(
      `coordinateLockRoot cannot resolve through symlinks: ${coordinateLockRoot}`,
    );
  }
  return {
    dev: rootStat.dev,
    ino: rootStat.ino,
    uid: rootStat.uid,
    mode: rootStat.mode & 0o7777,
  };
}

async function assertCanonicalCoordinateLockRoot(plan) {
  const actualIdentity = await assertCanonicalCoordinateLockDirectory(
    plan.coordinateLockRoot,
  );
  if (
    plan.coordinateLockIdentity &&
    ["dev", "ino", "uid", "mode"].some(
      (key) => actualIdentity[key] !== plan.coordinateLockIdentity[key],
    )
  ) {
    throw new Error(
      "coordinateLockRoot inode identity changed before reservation",
    );
  }
  const expected = captureCoordinateLockPath(
    plan.coordinateLockRoot,
    plan.displayNumber,
    plan.cdpPort,
  );
  if (plan.coordinateLockPath !== expected) {
    throw new Error("coordinateLockPath does not match its controlled root");
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
  coordinateLockRoot = os.tmpdir(),
  coordinateLockIdentity,
  isDisplayFree = isDisplayAvailable,
  isPortFree = isTcpPortAvailable,
  isCoordinateAvailable,
} = {}) {
  const resolvedLockRoot =
    requireAbsoluteCoordinateLockRoot(coordinateLockRoot);
  const expectedIdentity = normalizeCoordinateLockIdentity(
    coordinateLockIdentity,
  );
  const actualIdentity =
    await assertCanonicalCoordinateLockDirectory(resolvedLockRoot);
  if (
    expectedIdentity &&
    ["dev", "ino", "uid", "mode"].some(
      (key) => expectedIdentity[key] !== actualIdentity[key],
    )
  ) {
    throw new Error(
      "coordinateLockRoot inode identity changed before allocation",
    );
  }
  const coordinateAvailable =
    isCoordinateAvailable ??
    ((displayNumber, cdpPort) =>
      defaultCoordinateAvailableInRoot(
        resolvedLockRoot,
        displayNumber,
        cdpPort,
      ));
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
  let sawFreeDisplay = false;
  for (
    let displayNumber = displayStart;
    displayNumber <= displayEnd;
    displayNumber += 1
  ) {
    if (!(await isDisplayFree(displayNumber))) continue;
    sawFreeDisplay = true;
    for (let cdpPort = portStart; cdpPort <= portEnd; cdpPort += 1) {
      if (!(await isPortFree(cdpPort))) continue;
      if (!(await coordinateAvailable(displayNumber, cdpPort))) continue;
      return { displayNumber, cdpPort };
    }
  }
  if (!sawFreeDisplay)
    throw new Error(`no free X display in ${displayStart}-${displayEnd}`);
  throw new Error(
    `no free CDP/coordinate pair in displays ${displayStart}-${displayEnd} and ports ${portStart}-${portEnd}`,
  );
}

export function planCaptureRuntime({
  scenarioId,
  profile,
  artifactRoot,
  repositoryRoots = [process.cwd()],
  runId,
  displayNumber,
  cdpPort,
  coordinateLockRoot = os.tmpdir(),
  coordinateLockIdentity,
  browserExecutable,
  chromiumSandbox = defaultChromiumSandboxPolicy(),
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
  const sandboxPolicy = validateChromiumSandboxPolicy(chromiumSandbox);
  const captureProfile = normalizeProfile(profile);
  const resolvedRoot = path.resolve(artifactRoot);
  const resolvedCoordinateLockRoot =
    requireAbsoluteCoordinateLockRoot(coordinateLockRoot);
  const resolvedCoordinateLockIdentity = normalizeCoordinateLockIdentity(
    coordinateLockIdentity,
  );
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
  const coordinateLockPath = captureCoordinateLockPath(
    resolvedCoordinateLockRoot,
    displayNumber,
    cdpPort,
  );
  const chromiumNetworkPolicy = chromiumNetworkIsolationPolicy();
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
    coordinateLockRoot: resolvedCoordinateLockRoot,
    coordinateLockIdentity: resolvedCoordinateLockIdentity,
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
    chromiumSandbox: sandboxPolicy,
    chromiumNetworkPolicy,
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
        `--disable-features=Translate,MediaRouter,${chromiumNetworkPolicy.disabledFeatures.join(",")}`,
        ...chromiumNetworkPolicy.switches,
        "--force-color-profile=srgb",
        "--hide-scrollbars",
        "--kiosk",
        "--window-position=0,0",
        `--window-size=${captureProfile.sourceWidth},${captureProfile.sourceHeight}`,
        ...(sandboxPolicy.mode === "disabled" ? ["--no-sandbox"] : []),
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

async function acquireCoordinateLock(
  plan,
  {
    getProcessStartToken = processStartToken,
    isDisplayFree = isDisplayAvailable,
    isPortFree = isTcpPortAvailable,
  } = {},
) {
  const startToken = await getProcessStartToken(process.pid);
  if (typeof startToken !== "string" || startToken === "") {
    throw new Error(
      `cannot prove capture owner start token for PID ${process.pid}`,
    );
  }
  const payload = {
    contract: "kandev-highlight-coordinate-lock-v1",
    owner: { pid: process.pid, startToken },
    artifactRoot: plan.artifactRoot,
    display: plan.display,
    cdpPort: plan.cdpPort,
  };
  const contents = `${JSON.stringify(payload)}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    try {
      handle = await fs.open(
        plan.coordinateLockPath,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(contents);
      await handle.sync();
      const stat = await handle.stat();
      await handle.close();
      handle = null;
      return {
        payload,
        identity: { dev: stat.dev, ino: stat.ino },
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error.code !== "EEXIST") throw error;
      const reclaimed = await reclaimDeadCoordinateLock(
        plan.coordinateLockPath,
        {
          displayNumber: plan.displayNumber,
          cdpPort: plan.cdpPort,
          getProcessStartToken,
          isDisplayFree,
          isPortFree,
        },
      );
      if (!reclaimed) {
        const busy = new Error(
          `live coordinate lock occupies ${plan.display}/${plan.cdpPort}`,
        );
        busy.code = "KANDEV_CAPTURE_COORDINATE_BUSY";
        throw busy;
      }
    }
  }
  throw new Error(
    `coordinate lock remained contended after retry: ${plan.coordinateLockPath}`,
  );
}

async function releaseOwnedCoordinateLock(plan, reservation) {
  const opened = await openedCoordinateLock(plan.coordinateLockPath);
  if (!opened) {
    throw new Error(
      `owned coordinate lock disappeared before teardown: ${plan.coordinateLockPath}`,
    );
  }
  const expected = reservation.payload;
  if (
    opened.stat.dev !== reservation.identity.dev ||
    opened.stat.ino !== reservation.identity.ino ||
    opened.lock.contract !== expected.contract ||
    opened.lock.owner.pid !== expected.owner.pid ||
    opened.lock.owner.startToken !== expected.owner.startToken ||
    opened.lock.artifactRoot !== expected.artifactRoot ||
    opened.lock.display !== expected.display ||
    opened.lock.cdpPort !== expected.cdpPort
  ) {
    throw new Error(
      `coordinate lock changed after reservation; preserving current path: ${plan.coordinateLockPath}`,
    );
  }
  await unlinkSameCoordinateLock(plan.coordinateLockPath, opened.stat);
}

export async function reserveCaptureRuntime(
  plan,
  {
    processStartToken: getProcessStartToken = processStartToken,
    isDisplayFree = isDisplayAvailable,
    isPortFree = isTcpPortAvailable,
  } = {},
) {
  if (plan?.contract !== "kandev-highlight-capture-runtime-v1")
    throw new Error("invalid capture runtime plan");
  await fs.mkdir(path.dirname(plan.artifactRoot), { recursive: true });
  await Promise.all([
    assertCanonicalExternalRoot(plan),
    assertCanonicalCoordinateLockRoot(plan),
  ]);
  try {
    await fs.access(plan.artifactRoot);
    throw new Error(
      `refusing to overwrite capture artifact root: ${plan.artifactRoot}`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let coordinateReservation = null;
  let rootCreated = false;
  try {
    coordinateReservation = await acquireCoordinateLock(plan, {
      getProcessStartToken,
      isDisplayFree,
      isPortFree,
    });
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
    return { ...lock, coordinateReservation };
  } catch (error) {
    const errors = [error];
    if (rootCreated) {
      try {
        await fs.rm(plan.artifactRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }
    if (coordinateReservation) {
      try {
        await releaseOwnedCoordinateLock(plan, coordinateReservation);
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "capture runtime reservation and cleanup failed",
      );
    }
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

export async function spawnManagedProcess(
  spec,
  {
    spawnProcess = spawn,
    killProcess = process.kill,
    waitForChildExit = waitForExit,
  } = {},
) {
  const log = fsSync.createWriteStream(spec.logPath, { flags: "ax" });
  const child = spawnProcess(spec.command, spec.args, {
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
      try {
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          try {
            killProcess(-child.pid, "SIGTERM");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
          if (!(await waitForChildExit(child, 5_000))) {
            try {
              killProcess(-child.pid, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") throw error;
            }
            if (!(await waitForChildExit(child, 2_000))) {
              throw new Error(
                `${spec.name} process ${child.pid} survived SIGKILL`,
              );
            }
          }
        }
        if (child.exitCode === null && child.signalCode === null) {
          throw new Error(
            `${spec.name} process ${child.pid} survived teardown`,
          );
        }
      } finally {
        log.end();
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

async function removeTransientRuntime(plan, coordinateReservation) {
  await fs.rm(plan.profileDir, { recursive: true, force: true });
  await unlinkIfPresent(plan.lockPath);
  await releaseOwnedCoordinateLock(plan, coordinateReservation);
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
  chromiumNetworkCommandEvidence(plan.chromium, plan.chromiumNetworkPolicy);
  if (!(await isDisplayFree(plan.displayNumber)))
    throw new Error(`X display ${plan.display} is already occupied`);
  if (!(await isPortFree(plan.cdpPort)))
    throw new Error(`CDP port ${plan.cdpPort} is already occupied`);
  const reservation = await reserveCaptureRuntime(plan, {
    isDisplayFree,
    isPortFree,
  });
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
        await removeTransientRuntime(plan, reservation.coordinateReservation);
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
      throw new AggregateError(
        [error, teardownError],
        "capture runtime startup and teardown failed",
      );
    }
    throw error;
  }
}
