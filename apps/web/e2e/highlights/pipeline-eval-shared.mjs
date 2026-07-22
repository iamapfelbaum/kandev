import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_SETUP_DEADLINE_MS = 60_000;
export const DEFAULT_CAPTURE_DEADLINE_MS = 12 * 60_000;
export const PIPELINE_ORDER = Object.freeze([
  "validate",
  "storyboard",
  "capture",
  "render",
  "qa",
  "stage",
]);

const PREFIXED_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HEX_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MINIMUM_DEADLINE_MS = 1_000;
const MINIMUM_LOG_BYTES = 1_024;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function digestValue(value) {
  return `sha256:${sha256(canonicalJson(value))}`;
}

export function digestBytes(value) {
  return `sha256:${sha256(value)}`;
}

export function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function requireAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

export function requireDigest(value, label, { prefixed = true } = {}) {
  const pattern = prefixed ? PREFIXED_DIGEST_PATTERN : HEX_DIGEST_PATTERN;
  if (!pattern.test(value ?? "")) throw new Error(`${label} must be an exact SHA-256 digest`);
  return value;
}

export async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function canonicalDirectory(target, label) {
  const absolute = requireAbsolute(target, label);
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real non-symlink directory: ${absolute}`);
  }
  const real = await fs.realpath(absolute);
  if (real !== absolute)
    throw new Error(`${label} cannot resolve through symlinked parents: ${absolute}`);
  return real;
}

function safePhaseName(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
    throw new Error(`unsafe eval phase name: ${value}`);
  }
  return value;
}

function validateSubprocess({ command, args, deadlineMs, maxOutputBytes }) {
  if (typeof command !== "string" || !command) throw new Error("subprocess command is required");
  if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) {
    throw new Error("subprocess args must be a string argv array");
  }
  if (!Number.isInteger(deadlineMs) || deadlineMs < MINIMUM_DEADLINE_MS) {
    throw new Error("subprocess deadlineMs must be an integer of at least 1000ms");
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < MINIMUM_LOG_BYTES) {
    throw new Error("subprocess maxOutputBytes must be at least 1024 bytes");
  }
}

function appendBounded(state, chunk, maximum) {
  const combined = Buffer.concat([state.bytes, Buffer.from(chunk)]);
  if (combined.length <= maximum) {
    state.bytes = combined;
    return;
  }
  const discarded = combined.length - maximum;
  state.bytes = combined.subarray(discarded);
  state.discarded += discarded;
}

function signalProcess(child, signal) {
  try {
    if (process.platform !== "win32" && Number.isInteger(child.pid)) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function createDeadline(child, deadlineMs) {
  const state = { timedOut: false, termSent: false, killSent: false, killTimer: null };
  const deadline = setTimeout(() => {
    state.timedOut = true;
    state.termSent = signalProcess(child, "SIGTERM");
    state.killTimer = setTimeout(() => {
      state.killSent = signalProcess(child, "SIGKILL");
    }, 2_000);
    state.killTimer.unref();
  }, deadlineMs);
  deadline.unref();
  return {
    state,
    clear() {
      clearTimeout(deadline);
      clearTimeout(state.killTimer);
    },
  };
}

function streamProof(state) {
  return {
    retainedBytes: state.bytes.length,
    discardedBytes: state.discarded,
    truncated: state.discarded > 0,
  };
}

async function persistCommandLogs(logRoot, phase, record, stdout, stderr) {
  if (!logRoot) return null;
  const root = requireAbsolute(logRoot, "command logRoot");
  await fs.mkdir(root, { recursive: true });
  const paths = {
    stdout: path.join(root, `${phase}.stdout.log`),
    stderr: path.join(root, `${phase}.stderr.log`),
    record: path.join(root, `${phase}.json`),
  };
  await Promise.all([
    fs.writeFile(paths.stdout, stdout, { flag: "wx", mode: 0o600 }),
    fs.writeFile(paths.stderr, stderr, { flag: "wx", mode: 0o600 }),
    fs.writeFile(paths.record, `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    }),
  ]);
  return paths;
}

function subprocessError(result) {
  const tail = result.stderr.trim().slice(-2_000);
  const reason = result.timedOut
    ? `exceeded ${result.deadlineMs}ms deadline`
    : `exited ${result.exitCode ?? result.signal}`;
  const error = new Error(
    `Highlight pipeline eval phase ${result.phase} ${reason}${tail ? `: ${tail}` : ""}`,
  );
  error.phase = result.phase;
  error.argv = result.argv;
  error.commandResult = result;
  return error;
}

/** Run one argv-only subprocess with a hard deadline and bounded retained logs. */
export async function runBoundedSubprocess({
  command,
  args = [],
  cwd,
  env = process.env,
  phase = "command",
  logRoot,
  deadlineMs = DEFAULT_SETUP_DEADLINE_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  validateSubprocess({ command, args, deadlineMs, maxOutputBytes });
  const selectedPhase = safePhaseName(phase);
  const startedAt = new Date();
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = { bytes: Buffer.alloc(0), discarded: 0 };
  const stderr = { bytes: Buffer.alloc(0), discarded: 0 };
  child.stdout.on("data", (chunk) => appendBounded(stdout, chunk, maxOutputBytes));
  child.stderr.on("data", (chunk) => appendBounded(stderr, chunk, maxOutputBytes));
  const deadline = createDeadline(child, deadlineMs);
  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  }).finally(deadline.clear);
  const completedAt = new Date();
  const record = {
    contract: "kandev-highlight-pipeline-eval-command-v1",
    phase: selectedPhase,
    argv: [command, ...args],
    cwd: cwd ? path.resolve(cwd) : null,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: deadline.state.timedOut,
    deadlineMs,
    processGroup: {
      detached: process.platform !== "win32",
      termSent: deadline.state.termSent,
      killSent: deadline.state.killSent,
    },
    stdout: streamProof(stdout),
    stderr: streamProof(stderr),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
  };
  const logPaths = await persistCommandLogs(
    logRoot,
    selectedPhase,
    record,
    stdout.bytes,
    stderr.bytes,
  );
  const result = {
    ...record,
    stdout: stdout.bytes.toString("utf8"),
    stderr: stderr.bytes.toString("utf8"),
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    logPaths,
  };
  if (result.timedOut || result.exitCode !== 0) throw subprocessError(result);
  return result;
}

export async function git(repoRoot, args, options = {}) {
  return runBoundedSubprocess({
    command: "git",
    args: repoRoot ? ["-C", repoRoot, ...args] : args,
    cwd: options.cwd,
    phase: options.phase ?? "git",
    deadlineMs: options.deadlineMs ?? DEFAULT_SETUP_DEADLINE_MS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  });
}
