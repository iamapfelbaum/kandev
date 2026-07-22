import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_PROCESS_DEADLINE_MS = 240_000;
const DEFAULT_LOG_LIMIT_BYTES = 8 * 1024 * 1024;

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function duration(value, fallback, label) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return selected;
}

function waitMilliseconds(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupGone(pid, killProcess = process.kill) {
  try {
    killProcess(-pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    if (error.code === "EPERM") return false;
    throw error;
  }
}

async function waitForProcessGroupGone(
  pid,
  timeoutMs,
  { killProcess = process.kill } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processGroupGone(pid, killProcess)) return true;
    await waitMilliseconds(20);
  }
  return processGroupGone(pid, killProcess);
}

export async function runOwnedRuntimeProcess({
  command,
  env,
  logPath,
  deadlineMs = DEFAULT_PROCESS_DEADLINE_MS,
  termGraceMs = 5_000,
  killGraceMs = 2_000,
  logLimitBytes = DEFAULT_LOG_LIMIT_BYTES,
  signalSource = process,
  spawnProcess = spawn,
  killProcess = process.kill,
} = {}) {
  const trustedDeadline = duration(deadlineMs, null, "runtime deadlineMs");
  const trustedTermGrace = duration(termGraceMs, null, "runtime termGraceMs");
  const trustedKillGrace = duration(killGraceMs, null, "runtime killGraceMs");
  const trustedLogLimit = duration(
    logLimitBytes,
    null,
    "runtime logLimitBytes",
  );
  if (
    !isRecord(command) ||
    typeof command.command !== "string" ||
    !path.isAbsolute(command.command) ||
    !Array.isArray(command.args) ||
    typeof command.cwd !== "string" ||
    !path.isAbsolute(command.cwd)
  ) {
    throw new Error("owned runtime process requires an absolute fixed command");
  }
  const log = await fs.open(
    logPath,
    fsConstants.O_WRONLY |
      fsConstants.O_APPEND |
      fsConstants.O_CREAT |
      fsConstants.O_NOFOLLOW,
    0o600,
  );
  let child;
  let logWrites = Promise.resolve();
  let capturedBytes = 0;
  let discardedBytes = 0;
  let termSent = false;
  let killSent = false;
  let timedOut = false;
  let parentSignal = null;
  let closeOutcome = null;
  let finishClose;
  const closed = new Promise((resolve) => {
    finishClose = resolve;
  });
  let finishStopStarted;
  const stopStarted = new Promise((resolve) => {
    finishStopStarted = resolve;
  });
  const consume = (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const available = Math.max(0, trustedLogLimit - capturedBytes);
    const retained = bytes.subarray(0, available);
    capturedBytes += retained.byteLength;
    discardedBytes += bytes.byteLength - retained.byteLength;
    if (retained.byteLength > 0) {
      logWrites = logWrites.then(() => log.write(retained));
    }
  };
  const sendGroupSignal = (signal) => {
    if (!child?.pid) return;
    try {
      killProcess(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  let stopping = null;
  const stop = () => {
    if (stopping) return stopping;
    finishStopStarted();
    stopping = (async () => {
      if (!child?.pid || processGroupGone(child.pid, killProcess)) return;
      termSent = true;
      sendGroupSignal("SIGTERM");
      if (
        await waitForProcessGroupGone(child.pid, trustedTermGrace, {
          killProcess,
        })
      ) {
        return;
      }
      killSent = true;
      sendGroupSignal("SIGKILL");
      await waitForProcessGroupGone(child.pid, trustedKillGrace, {
        killProcess,
      });
    })();
    return stopping;
  };
  const signalHandlers = new Map();
  let deadline;
  try {
    child = spawnProcess(command.command, command.args, {
      cwd: command.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("error", (error) => {
      if (!closeOutcome) {
        closeOutcome = { launchError: error, exitCode: null, signal: null };
        finishClose(closeOutcome);
      }
    });
    child.once("close", (exitCode, signal) => {
      if (!closeOutcome) {
        closeOutcome = { launchError: null, exitCode, signal };
        finishClose(closeOutcome);
      }
    });
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        parentSignal ??= signal;
        void stop();
      };
      signalHandlers.set(signal, handler);
      signalSource.on(signal, handler);
    }
    deadline = setTimeout(() => {
      timedOut = true;
      void stop();
    }, trustedDeadline);
    deadline.unref?.();
    await Promise.race([
      closed,
      (async () => {
        await stopStarted;
        await stopping;
        if (!closeOutcome) {
          closeOutcome = {
            launchError: null,
            exitCode: null,
            signal: killSent ? "SIGKILL" : "SIGTERM",
          };
          finishClose(closeOutcome);
        }
      })(),
    ]);
    if (stopping) await stopping;
    let gone = child.pid ? processGroupGone(child.pid, killProcess) : true;
    if (!gone) {
      await stop();
      gone = processGroupGone(child.pid, killProcess);
    }
    await logWrites;
    if (closeOutcome.launchError) {
      throw new Error(
        `cannot launch fixed Highlight Playwright host: ${closeOutcome.launchError.message}`,
        { cause: closeOutcome.launchError },
      );
    }
    if (parentSignal && signalSource === process) {
      process.exitCode = parentSignal === "SIGINT" ? 130 : 143;
    }
    return {
      exitCode: parentSignal ? null : closeOutcome.exitCode,
      signal: parentSignal ?? closeOutcome.signal,
      timedOut,
      deadlineMs: trustedDeadline,
      processGroup: {
        pid: child.pid ?? null,
        termSent,
        killSent,
        exited: closeOutcome.exitCode !== null || closeOutcome.signal !== null,
        gone,
      },
      log: {
        limitBytes: trustedLogLimit,
        capturedBytes,
        discardedBytes,
        truncated: discardedBytes > 0,
      },
    };
  } finally {
    if (deadline) clearTimeout(deadline);
    for (const [signal, handler] of signalHandlers) {
      signalSource.off(signal, handler);
    }
    if (child?.pid && !processGroupGone(child.pid, killProcess)) {
      try {
        await stop();
      } catch {
        // The caller receives the primary launch/execution failure.
      }
    }
    await logWrites.catch(() => {});
    await log.close();
  }
}

export function isRuntimeProcessGone(pid, killProcess = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killProcess(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    if (error.code === "EPERM") return false;
    throw error;
  }
}

export function normalizeRuntimeProcessResult(
  value,
  deadlineMs = DEFAULT_PROCESS_DEADLINE_MS,
) {
  if (
    !isRecord(value) ||
    !(value.exitCode === null || Number.isInteger(value.exitCode)) ||
    !(value.signal === null || typeof value.signal === "string")
  ) {
    throw new Error("runtime process result is invalid");
  }
  const processGroup = isRecord(value.processGroup)
    ? structuredClone(value.processGroup)
    : {
        pid: null,
        termSent: false,
        killSent: false,
        exited: value.exitCode !== null || value.signal !== null,
        gone: value.exitCode !== null || value.signal !== null,
      };
  const log = isRecord(value.log)
    ? structuredClone(value.log)
    : {
        limitBytes: DEFAULT_LOG_LIMIT_BYTES,
        capturedBytes: null,
        discardedBytes: 0,
        truncated: false,
      };
  return {
    exitCode: value.exitCode,
    signal: value.signal,
    timedOut: value.timedOut === true,
    deadlineMs:
      Number.isInteger(value.deadlineMs) && value.deadlineMs > 0
        ? value.deadlineMs
        : deadlineMs,
    processGroup,
    log,
  };
}
