/* eslint-disable complexity, max-lines, max-lines-per-function, sonarjs/cognitive-complexity, sonarjs/no-duplicate-string */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_ROOT = path.resolve(HERE, "../..");
const DEFAULT_REPO_ROOT = path.resolve(DEFAULT_WEB_ROOT, "../..");
const DEFAULT_LANDING_ROOT = path.resolve(DEFAULT_REPO_ROOT, "..", "landing");
const PIPELINE_ORDER = Object.freeze([
  "validate",
  "storyboard",
  "capture",
  "render",
  "qa",
  "stage",
]);
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const PREFIXED_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HEX_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_SETUP_DEADLINE_MS = 60_000;
const DEFAULT_CAPTURE_DEADLINE_MS = 12 * 60_000;

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
  return createHash("sha256").update(value).digest("hex");
}

function digestValue(value) {
  return `sha256:${sha256(canonicalJson(value))}`;
}

function digestBytes(value) {
  return `sha256:${sha256(value)}`;
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function requireDigest(value, label, { prefixed = true } = {}) {
  const pattern = prefixed ? PREFIXED_DIGEST_PATTERN : HEX_DIGEST_PATTERN;
  if (!pattern.test(value ?? "")) throw new Error(`${label} must be an exact SHA-256 digest`);
  return value;
}

function safePhaseName(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
    throw new Error(`unsafe eval phase name: ${value}`);
  }
  return value;
}

function appendBounded(current, chunk, maximum) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  if (combined.length <= maximum) return { bytes: combined, discarded: 0 };
  const discarded = combined.length - maximum;
  return { bytes: combined.subarray(discarded), discarded };
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
  if (typeof command !== "string" || !command) throw new Error("subprocess command is required");
  if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) {
    throw new Error("subprocess args must be a string argv array");
  }
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1_000) {
    throw new Error("subprocess deadlineMs must be an integer of at least 1000ms");
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024) {
    throw new Error("subprocess maxOutputBytes must be at least 1024 bytes");
  }
  const selectedPhase = safePhaseName(phase);
  const startedAt = new Date();
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let stdoutDiscarded = 0;
  let stderrDiscarded = 0;
  let timedOut = false;
  let termSent = false;
  let killSent = false;
  child.stdout.on("data", (chunk) => {
    const bounded = appendBounded(stdout, chunk, maxOutputBytes);
    stdout = bounded.bytes;
    stdoutDiscarded += bounded.discarded;
  });
  child.stderr.on("data", (chunk) => {
    const bounded = appendBounded(stderr, chunk, maxOutputBytes);
    stderr = bounded.bytes;
    stderrDiscarded += bounded.discarded;
  });

  let killTimer;
  const deadline = setTimeout(() => {
    timedOut = true;
    termSent = signalProcess(child, "SIGTERM");
    killTimer = setTimeout(() => {
      killSent = signalProcess(child, "SIGKILL");
    }, 2_000);
    killTimer.unref();
  }, deadlineMs);
  deadline.unref();

  const outcome = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  }).finally(() => {
    clearTimeout(deadline);
    clearTimeout(killTimer);
  });
  const completedAt = new Date();
  const record = {
    contract: "kandev-highlight-pipeline-eval-command-v1",
    phase: selectedPhase,
    argv: [command, ...args],
    cwd: cwd ? path.resolve(cwd) : null,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut,
    deadlineMs,
    processGroup: { detached: process.platform !== "win32", termSent, killSent },
    stdout: {
      retainedBytes: stdout.length,
      discardedBytes: stdoutDiscarded,
      truncated: stdoutDiscarded > 0,
    },
    stderr: {
      retainedBytes: stderr.length,
      discardedBytes: stderrDiscarded,
      truncated: stderrDiscarded > 0,
    },
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
  };
  let logPaths = null;
  if (logRoot) {
    const absoluteLogRoot = requireAbsolute(logRoot, "command logRoot");
    await fs.mkdir(absoluteLogRoot, { recursive: true });
    logPaths = {
      stdout: path.join(absoluteLogRoot, `${selectedPhase}.stdout.log`),
      stderr: path.join(absoluteLogRoot, `${selectedPhase}.stderr.log`),
      record: path.join(absoluteLogRoot, `${selectedPhase}.json`),
    };
    await Promise.all([
      fs.writeFile(logPaths.stdout, stdout, { flag: "wx", mode: 0o600 }),
      fs.writeFile(logPaths.stderr, stderr, { flag: "wx", mode: 0o600 }),
      fs.writeFile(logPaths.record, `${JSON.stringify(record, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      }),
    ]);
  }
  const result = {
    ...record,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
    stdoutBytes: stdout,
    stderrBytes: stderr,
    logPaths,
  };
  if (timedOut || outcome.exitCode !== 0) {
    const tail = stderr.toString("utf8").trim().slice(-2_000);
    const reason = timedOut
      ? `exceeded ${deadlineMs}ms deadline`
      : `exited ${outcome.exitCode ?? outcome.signal}`;
    const error = new Error(
      `Highlight pipeline eval phase ${selectedPhase} ${reason}${tail ? `: ${tail}` : ""}`,
    );
    error.phase = selectedPhase;
    error.argv = [command, ...args];
    error.commandResult = result;
    throw error;
  }
  return result;
}

async function git(repoRoot, args, options = {}) {
  return runBoundedSubprocess({
    command: "git",
    args: repoRoot ? ["-C", repoRoot, ...args] : args,
    cwd: options.cwd,
    phase: options.phase ?? "git",
    deadlineMs: options.deadlineMs ?? DEFAULT_SETUP_DEADLINE_MS,
    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  });
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalDirectory(target, label) {
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

export function buildPipelineCommandSequence({
  cloneRoot,
  scenarioPath,
  artifactRoot,
  landingRoot,
  reviewPath,
  nodeExecutable = process.execPath,
} = {}) {
  const repository = requireAbsolute(cloneRoot, "cloneRoot");
  const scenario = requireAbsolute(scenarioPath, "scenarioPath");
  const artifacts = requireAbsolute(artifactRoot, "artifactRoot");
  const landing = requireAbsolute(landingRoot, "landingRoot");
  const review = requireAbsolute(reviewPath, "reviewPath");
  const cli = path.join(repository, "scripts", "highlights.mjs");
  const command = (phase, args) => ({
    phase,
    command: nodeExecutable,
    args: [cli, ...args],
    cwd: repository,
  });
  const run = (phase, runId) =>
    command(phase, [
      "run",
      scenario,
      "--artifact-root",
      artifacts,
      "--source",
      "current_main",
      "--landing-root",
      landing,
      "--runtime",
      "kandev-isolated-e2e",
      "--run-id",
      runId,
    ]);
  return [
    command("scaffold", ["scaffold", scenario, "--template", "quick-start"]),
    command("validate", ["validate", scenario]),
    command("storyboard", ["storyboard", scenario, "--format", "json"]),
    run("run-1", "fresh-agent-1"),
    run("run-2", "fresh-agent-2"),
    command("stage-recovery", [
      "stage",
      scenario,
      "--artifact-root",
      artifacts,
      "--run-id",
      "fresh-agent-1",
      "--dry-run",
    ]),
    command("promote-dry-run", [
      "promote",
      review,
      "--accept-reviewed-by",
      "fresh-agent-eval",
      "--dry-run",
    ]),
  ];
}

export async function captureRepositoryState(repoRoot) {
  const repository = await canonicalDirectory(path.resolve(repoRoot), "repository state root");
  const [head, tree, status, tracked, staged] = await Promise.all([
    git(repository, ["rev-parse", "HEAD"]),
    git(repository, ["rev-parse", "HEAD^{tree}"]),
    git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(repository, ["diff", "--binary", "--no-ext-diff", "HEAD"]),
    git(repository, ["diff", "--binary", "--no-ext-diff", "--cached", "HEAD"]),
  ]);
  return {
    contract: "kandev-highlight-pipeline-repository-state-v1",
    root: repository,
    head: head.stdout.trim(),
    tree: tree.stdout.trim(),
    status: status.stdout.trim(),
    trackedDiffDigest: digestBytes(tracked.stdoutBytes),
    stagedDiffDigest: digestBytes(staged.stdoutBytes),
  };
}

export async function assertRepositoryStateUnchanged(
  beforeInput,
  afterInput,
  label = "repository",
) {
  const [before, after] = await Promise.all([beforeInput, afterInput]);
  if (canonicalJson(before) !== canonicalJson(after)) {
    const detail = after?.status || `${before?.head ?? "missing"} -> ${after?.head ?? "missing"}`;
    throw new Error(`${label} changed during zero-write evaluation: ${detail}`);
  }
  return true;
}

/**
 * Make a local bare origin plus a detached work clone at the exact clean source HEAD.
 * The bare remote lets every production source-gate fetch remain honest and network-free.
 */
export async function snapshotCommittedRepository({ sourceRoot, cloneRoot, originRoot } = {}) {
  const source = await canonicalDirectory(path.resolve(sourceRoot), "source repository");
  const snapshot = requireAbsolute(cloneRoot, "cloneRoot");
  const origin = requireAbsolute(
    originRoot ?? path.join(path.dirname(snapshot), "origin.git"),
    "originRoot",
  );
  if (isInside(source, snapshot) || isInside(source, origin)) {
    throw new Error("eval snapshot and bare origin must stay outside source repository");
  }
  if ((await pathExists(snapshot)) || (await pathExists(origin))) {
    throw new Error("refusing to overwrite existing eval snapshot or bare origin");
  }
  const sourceState = await captureRepositoryState(source);
  if (sourceState.status !== "") {
    throw new Error(`source repository must be clean before snapshot: ${sourceState.status}`);
  }
  if (!SHA_PATTERN.test(sourceState.head)) throw new Error("source HEAD is not an exact Git SHA");
  await fs.mkdir(path.dirname(snapshot), { recursive: true });
  await git(null, ["clone", "--bare", "--no-hardlinks", "--local", source, origin], {
    phase: "git-clone-origin",
  });
  await git(null, ["clone", "--no-hardlinks", "--no-checkout", "--local", origin, snapshot], {
    phase: "git-clone-snapshot",
  });
  await git(snapshot, ["checkout", "--detach", sourceState.head], { phase: "git-checkout" });
  const snapshotState = await captureRepositoryState(snapshot);
  if (snapshotState.head !== sourceState.head || snapshotState.status !== "") {
    throw new Error("local eval snapshot does not match the exact clean source HEAD");
  }
  const originHead = (
    await git(null, ["--git-dir", origin, "rev-parse", "refs/heads/main"], {
      phase: "git-origin-head",
    })
  ).stdout.trim();
  if (originHead !== sourceState.head) {
    throw new Error("local bare origin main does not match source HEAD");
  }
  return {
    sourceRoot: source,
    sourceHead: sourceState.head,
    cloneRoot: snapshot,
    snapshotHead: snapshotState.head,
    originRoot: origin,
    originMainSha: originHead,
    localOnly: true,
  };
}

async function localBareOrigin(cloneRoot) {
  const remote = (await git(cloneRoot, ["remote", "get-url", "origin"])).stdout.trim();
  if (!remote || /^(?:[a-z][a-z0-9+.-]*:|[^/]+@)/i.test(remote)) {
    throw new Error("eval snapshot origin must be a local filesystem bare repository");
  }
  const resolved = path.resolve(cloneRoot, remote);
  const origin = await canonicalDirectory(resolved, "eval bare origin");
  const bare = (
    await git(null, ["--git-dir", origin, "rev-parse", "--is-bare-repository"], {
      phase: "git-origin-bare",
    })
  ).stdout.trim();
  if (bare !== "true") throw new Error("eval snapshot origin is not bare");
  return origin;
}

export async function commitScenarioAndBindCurrentMain({ cloneRoot, scenarioPath } = {}) {
  const repository = await canonicalDirectory(path.resolve(cloneRoot), "eval snapshot");
  const scenario = requireAbsolute(scenarioPath, "scenarioPath");
  if (!isInside(repository, scenario) || scenario === repository) {
    throw new Error("eval scenario must stay inside snapshot");
  }
  const scenarioStat = await fs.lstat(scenario).catch(() => null);
  if (!scenarioStat?.isFile() || scenarioStat.isSymbolicLink()) {
    throw new Error("eval scenario must be a regular non-symlink file");
  }
  const relativeScenario = path.relative(repository, scenario).split(path.sep).join("/");
  const statusBefore = (
    await git(repository, ["status", "--porcelain=v1", "--untracked-files=all"])
  ).stdout.trim();
  const entries = statusBefore ? statusBefore.split("\n") : [];
  if (
    entries.length !== 1 ||
    !entries[0].endsWith(relativeScenario) ||
    !entries[0].startsWith("?? ")
  ) {
    throw new Error(
      `eval snapshot must contain only the scaffolded scenario before commit: ${statusBefore || "clean"}`,
    );
  }
  await git(repository, ["config", "user.name", "Kandev Highlight Fresh Agent Eval"]);
  await git(repository, ["config", "user.email", "highlight-eval@kandev.invalid"]);
  await git(repository, ["add", "--", relativeScenario]);
  await git(repository, ["commit", "-m", "test(highlights): add fresh-agent eval scenario"]);
  const evalHead = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
  if (!SHA_PATTERN.test(evalHead))
    throw new Error("eval scenario commit did not produce exact SHA");
  const origin = await localBareOrigin(repository);
  await git(null, ["--git-dir", origin, "fetch", "--no-tags", repository, evalHead], {
    phase: "git-copy-eval-object",
  });
  await git(null, ["--git-dir", origin, "update-ref", "refs/heads/main", evalHead], {
    phase: "git-bind-origin-main",
  });
  await git(
    repository,
    ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
    { phase: "git-fetch-origin-main" },
  );
  const [head, currentMain, originMain, status] = await Promise.all([
    git(repository, ["rev-parse", "HEAD"]),
    git(repository, ["rev-parse", "origin/main"]),
    git(null, ["--git-dir", origin, "rev-parse", "refs/heads/main"], {
      phase: "git-verify-origin-main",
    }),
    git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  const proof = {
    evalHead,
    headSha: head.stdout.trim(),
    currentMainSha: currentMain.stdout.trim(),
    originMainSha: originMain.stdout.trim(),
    originRoot: origin,
    clean: status.stdout.trim() === "",
  };
  if (
    proof.headSha !== evalHead ||
    proof.currentMainSha !== evalHead ||
    proof.originMainSha !== evalHead ||
    !proof.clean
  ) {
    throw new Error(
      "current_main eval proof must bind clean HEAD, fetched origin/main, and bare origin main",
    );
  }
  return proof;
}

async function linkIgnoredNodeModules({ sourceRoot, cloneRoot }) {
  const links = [];
  for (const relative of ["apps/node_modules", "apps/web/node_modules"]) {
    const source = path.join(sourceRoot, relative);
    const target = path.join(cloneRoot, relative);
    const stat = await fs.lstat(source).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(source)) !== source) {
      throw new Error(`reusable dependency directory is missing or unsafe: ${source}`);
    }
    const ignored = await git(cloneRoot, ["check-ignore", "--quiet", relative]).catch((error) => {
      if (error.commandResult?.exitCode === 1) return null;
      throw error;
    });
    if (!ignored) throw new Error(`dependency link target is not Git-ignored: ${relative}`);
    if (await pathExists(target)) throw new Error(`refusing existing dependency target: ${target}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(source, target, "dir");
    links.push({ source, target });
  }
  return links;
}

function stableObject(value, { seed = false } = {}) {
  if (Array.isArray(value)) return value.map((item) => stableObject(item, { seed }));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (
      [
        "runId",
        "capturedAt",
        "completedAt",
        "createdAt",
        "builtAt",
        "generatedAt",
        "recordDigest",
        "phaseManifestDigest",
        "receiptDigest",
        "generatedIds",
        "ports",
        "absoluteMediaStartMs",
        "mediaTimeMs",
        "browserEpochMs",
        "captureEpochMs",
        "storyEpochMs",
        "recorderPid",
        "pid",
      ].includes(key) ||
      /(?:path|root)$/i.test(key) ||
      /^(?:startedAtMs|endedAtMs|preparedAtMs)$/.test(key) ||
      (seed && /Ids?$/.test(key))
    ) {
      continue;
    }
    result[key] = stableObject(value[key], { seed });
  }
  return result;
}

function normalizeFrameTiming(frameTiming = {}) {
  const alignment = frameTiming.alignment ?? frameTiming.frameAlignment;
  const normalized = {
    fps: frameTiming.fps,
    storyDurationMs: frameTiming.storyDurationMs,
    relativeStartFrame: frameTiming.relativeStartFrame ?? 0,
    ...(Number.isInteger(frameTiming.storyFrameCount)
      ? { storyFrameCount: frameTiming.storyFrameCount }
      : {}),
    ...(alignment ? { alignment: stableObject(alignment) } : {}),
    ...(Array.isArray(frameTiming.selectedStoryTimesMs)
      ? { selectedStoryTimesMs: [...frameTiming.selectedStoryTimesMs] }
      : {}),
  };
  return stableObject(normalized);
}

export function normalizeDeterminismEvidence(evidence = {}) {
  const cameraPlan = structuredClone(evidence.camera?.plan ?? {});
  // Pointer sampling has its own semantic projection below. It must not make
  // independently-controlled camera evidence depend on browser scheduling.
  delete cameraPlan.pointerTrack;
  const normalized = {
    scenario: stableObject(evidence.scenario),
    timeline: stableObject(evidence.timeline),
    seed: {
      seedId: evidence.seed?.seedId,
      seedDigest: evidence.seed?.seedDigest,
      invariants: stableObject(evidence.seed?.invariants ?? {}, { seed: true }),
    },
    camera: {
      plan: stableObject(cameraPlan),
      track: stableObject(evidence.camera?.track),
    },
    pointer: stableObject(evidence.pointer),
    frameTiming: normalizeFrameTiming(evidence.frameTiming),
    selectedFrames: (evidence.selectedFrames ?? []).map((frame) => ({
      storyTimeMs: frame.storyTimeMs,
      sha256: frame.sha256,
    })),
  };
  return normalized;
}

function firstDifference(left, right, currentPath = "") {
  if (Object.is(left, right)) return null;
  if (typeof left !== typeof right || left === null || right === null) {
    return { path: currentPath || "$", left, right };
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right))
      return { path: currentPath || "$", left, right };
    if (left.length !== right.length) {
      return { path: `${currentPath}.length`, left: left.length, right: right.length };
    }
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDifference(left[index], right[index], `${currentPath}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (typeof left === "object") {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
        return {
          path: currentPath ? `${currentPath}.${key}` : key,
          left: left[key],
          right: right[key],
        };
      }
      const difference = firstDifference(
        left[key],
        right[key],
        currentPath ? `${currentPath}.${key}` : key,
      );
      if (difference) return difference;
    }
    return null;
  }
  return { path: currentPath || "$", left, right };
}

export function assertDeterministicRuns(first, second) {
  const difference = firstDifference(first, second);
  if (difference) {
    throw new Error(
      `deterministic run mismatch at ${difference.path}: ${JSON.stringify(difference.left)} != ${JSON.stringify(difference.right)}`,
    );
  }
  return { passed: true, digest: digestValue(first) };
}

function assertNoRawReviewPayload(value, pointer = "review") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      /^(?:visibleDomText|browserConsole|runtimeLogs|rawDomText|stdout|stderr|logContents|rawLogs?)$/i.test(
        key,
      )
    ) {
      throw new Error(`${pointer}.${key} embeds forbidden raw DOM or log payload`);
    }
    assertNoRawReviewPayload(child, `${pointer}.${key}`);
  }
}

function assertFileProof(record, label) {
  if (
    !record ||
    typeof record.path !== "string" ||
    !Number.isInteger(record.bytes) ||
    record.bytes <= 0 ||
    !HEX_DIGEST_PATTERN.test(record.sha256 ?? "")
  ) {
    throw new Error(`${label} requires exact path, positive bytes, and SHA-256`);
  }
}

export function assertTechnicalReview({ review, qaReport } = {}) {
  if (
    review?.contract !== "kandev-highlight-review-stage-v2" ||
    review.schemaVersion !== 2 ||
    review.promotable !== false ||
    review.readyForReview !== true
  ) {
    throw new Error("review must use kandev-highlight-review-stage-v2 and remain non-promotable");
  }
  if (review.qa?.status !== "technical_pass" || review.qa?.passed !== true) {
    throw new Error("review QA must be technical_pass with passed=true");
  }
  requireDigest(review.stageDigest, "review stageDigest");
  requireDigest(review.qa.reportDigest, "review QA report digest");
  assertNoRawReviewPayload(review);
  const delivery = review.assets?.desktop;
  for (const [kind, codec] of [
    ["webm", "vp9"],
    ["mp4", "h264"],
    ["poster", "webp"],
  ]) {
    const record = delivery?.[kind];
    assertFileProof(record, `review desktop ${kind}`);
    if (
      record.codec !== codec ||
      record.width !== 1920 ||
      record.height !== 1200 ||
      record.audio !== false
    ) {
      throw new Error(`review desktop ${kind} media contract is invalid`);
    }
  }
  if (
    qaReport?.contract !== "kandev-highlight-qa-v1" ||
    qaReport.status !== "technical_pass" ||
    qaReport.passed !== true
  ) {
    throw new Error("QA report must retain technical_pass");
  }
  if (qaReport.browser?.passed !== true) throw new Error("QA browser playback did not pass");
  if (qaReport.sensitiveData?.passed !== true)
    throw new Error("QA sensitive-data scan did not pass");
  if (!Array.isArray(qaReport.artifacts) || qaReport.artifacts.length !== 3) {
    throw new Error("QA report must contain mp4, webm, and poster artifacts");
  }
  const byKind = new Map(qaReport.artifacts.map((artifact) => [artifact.kind, artifact]));
  for (const kind of ["webm", "mp4", "poster"]) {
    const artifact = byKind.get(kind);
    assertFileProof(artifact, `QA ${kind}`);
    if (kind === "poster") {
      if (artifact.proofs?.skipped !== true)
        throw new Error("QA poster proof must be still-image skipped");
      continue;
    }
    if (artifact.fullDecode?.passed !== true)
      throw new Error(`QA ${kind} full decode did not pass`);
    if (!Array.isArray(artifact.proofs?.keyframes) || artifact.proofs.keyframes.length < 1) {
      throw new Error(`QA ${kind} requires keyframes`);
    }
    artifact.proofs.keyframes.forEach((proof, index) =>
      assertFileProof(proof, `QA ${kind} keyframe ${index}`),
    );
    assertFileProof(artifact.proofs.contactSheet, `QA ${kind} contact sheet`);
  }
  return true;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function assertRuntimeEvidenceLinks({
  commandResult,
  hostResult,
  receipt,
  request,
  build,
  capture,
  camera,
  expected,
} = {}) {
  if (
    commandResult?.contract !== "kandev-highlight-runtime-command-v1" ||
    commandResult.command !== "run" ||
    commandResult.runtimeId !== "kandev-isolated-e2e" ||
    !sameJson(commandResult.order, PIPELINE_ORDER)
  ) {
    throw new Error(
      "runtime command order must be validate -> storyboard -> capture -> render -> qa -> stage",
    );
  }
  const runId = commandResult.runId;
  if (hostResult?.runId !== runId || receipt?.runtimeId !== "kandev-isolated-e2e") {
    throw new Error("runtime host or receipt run identity mismatch");
  }
  requireDigest(commandResult.host?.resultDigest, "runtime result digest");
  requireDigest(commandResult.host?.receiptDigest, "runtime receipt digest");
  if (
    commandResult.host.resultPath !== expected?.resultPath ||
    hostResult.bundle?.resultPath !== expected?.resultPath ||
    commandResult.host.receiptPath !== expected?.receiptPath ||
    hostResult.applicationRuntime?.receiptPath !== expected?.receiptPath ||
    receipt.receiptDigest !== commandResult.host.receiptDigest ||
    hostResult.resultDigest !== commandResult.host.resultDigest
  ) {
    throw new Error("runtime result or receipt fixed path/digest link mismatch");
  }
  const sourceSha = capture?.source?.selectedSha;
  if (
    !SHA_PATTERN.test(sourceSha ?? "") ||
    capture?.sourceDigest === undefined ||
    hostResult.source?.unchanged !== true ||
    hostResult.source?.pre?.selectedSha !== sourceSha ||
    hostResult.source?.post?.selectedSha !== sourceSha ||
    receipt.source?.unchanged !== true ||
    receipt.source?.pre?.selectedSha !== sourceSha ||
    receipt.source?.post?.selectedSha !== sourceSha
  ) {
    throw new Error("runtime source continuity is invalid");
  }
  const buildManifestPath = request?.buildManifestPath ?? capture?.build?.manifestPath;
  const buildDigest = capture?.build?.manifestDigest;
  if (
    buildManifestPath !== expected?.buildManifestPath ||
    (build && build.manifestDigest !== buildDigest) ||
    receipt.build?.manifestDigest !== buildDigest ||
    receipt.build?.sourceSha !== sourceSha ||
    capture.build?.sourceSha !== sourceSha
  ) {
    throw new Error("runtime build path, digest, or source link mismatch");
  }
  if (
    hostResult.capture?.attemptRoot !== expected?.attempt ||
    hostResult.capture?.captureManifestPath !== expected?.captureManifestPath ||
    receipt.capture?.captureManifestPath !== expected?.captureManifestPath ||
    commandResult.phases?.capture?.captureManifestPath !== expected?.captureManifestPath
  ) {
    throw new Error("runtime capture fixed attempt or manifest link mismatch");
  }
  if (
    capture.seed?.seedId !== "kandev.highlight.quick-start" ||
    !PREFIXED_DIGEST_PATTERN.test(capture.seed?.seedDigest ?? "")
  ) {
    throw new Error("capture seed identity or digest mismatch");
  }
  const alignment = capture.frameAlignment ?? capture.capture?.frameAlignment;
  if (
    !alignment ||
    (alignment.fps !== undefined && alignment.fps !== 25) ||
    (alignment.contract !== undefined &&
      alignment.contract !== "kandev-highlight-media-frame-alignment-v1")
  ) {
    throw new Error("capture frame alignment is invalid");
  }
  if (camera?.contract !== "kandev-highlight-camera-evidence-v1") {
    throw new Error("camera evidence contract is invalid");
  }
  requireDigest(camera.recordDigest, "camera record digest");
  const keyframes = camera.track?.keyframes;
  if (!Array.isArray(keyframes) || keyframes.length < 2) {
    throw new Error("camera track needs settled keyframes");
  }
  if (keyframes.some((keyframe) => keyframe.zoom !== 1)) {
    throw new Error("quick-start camera must retain no-zoom identity camera");
  }
  return true;
}

export async function runWithEvalRetention({ evalRoot, task } = {}) {
  const root = requireAbsolute(evalRoot, "evalRoot");
  if (typeof task !== "function") throw new Error("eval retention task is required");
  await fs.mkdir(root, { recursive: true });
  let capture = null;
  const markCaptureStarted = async (metadata = {}) => {
    capture = {
      phase: metadata.phase ?? "capture",
      argv: Array.isArray(metadata.argv) ? [...metadata.argv] : [],
      startedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(root, "capture-started.json"),
      `${JSON.stringify({ contract: "kandev-highlight-pipeline-eval-capture-v1", ...capture }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  };
  try {
    return await task({ markCaptureStarted });
  } catch (error) {
    if (!capture) {
      await fs.rm(root, { recursive: true, force: true });
      throw error;
    }
    const failure = {
      contract: "kandev-highlight-pipeline-eval-failure-v1",
      status: "failed",
      captureStarted: true,
      phase: error.phase ?? capture.phase,
      message: error instanceof Error ? error.message : String(error),
      argv: error.argv ?? capture.argv,
      evalRoot: root,
      logs: error.commandResult?.logPaths ?? null,
      failedAt: new Date().toISOString(),
      recovery: "Inspect retained logs/evidence, then rerun with a fresh external eval root.",
    };
    await fs.writeFile(path.join(root, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    error.evalRoot = root;
    error.failurePath = path.join(root, "failure.json");
    throw error;
  }
}

async function readJsonIdentity(filePath, label) {
  const absolute = requireAbsolute(filePath, label);
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || (await fs.realpath(absolute)) !== absolute) {
    throw new Error(`${label} must be a canonical regular file: ${absolute}`);
  }
  const bytes = await fs.readFile(absolute);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
  return {
    path: absolute,
    bytes: bytes.length,
    digest: digestBytes(bytes),
    value,
  };
}

function parseLastJsonDocument(output, label) {
  const source = String(output).trim();
  for (
    let index = source.lastIndexOf("{");
    index >= 0;
    index = source.lastIndexOf("{", index - 1)
  ) {
    try {
      return JSON.parse(source.slice(index));
    } catch {
      // Build/test output may precede the production CLI's final JSON document.
    }
  }
  throw new Error(`${label} produced no final JSON document`);
}

export function projectSemanticPointerEvidence(execution = {}) {
  return {
    storyDurationMs: execution.storyDurationMs,
    timingToleranceMs: execution.timingToleranceMs,
    steps: (execution.steps ?? []).map((step) => ({
      index: step.index,
      pointer: step.pointer,
      kind: step.kind,
      plannedStartMs: step.plannedStartMs,
      plannedEndMs: step.plannedEndMs,
    })),
    resyncs: (execution.cursorResyncEvidence ?? []).map((resync) => ({
      source: resync.source,
      label: resync.label,
      point: resync.point,
      pointerGlyphBounds: resync.pointerGlyphBounds,
    })),
    movements: (execution.cursorEvidence ?? []).map((movement) => ({
      label: movement.label,
      from: movement.from,
      to: movement.to,
      requestedDurationMs: movement.requestedDurationMs,
      samples: (movement.samples ?? []).map((sample) => ({
        offsetMs: sample.offsetMs,
        progress: sample.progress,
        x: sample.x,
        y: sample.y,
        pointerGlyphBounds: sample.pointerGlyphBounds,
        targetBounds: sample.targetBounds,
        targetGlyphBounds: sample.targetGlyphBounds,
      })),
    })),
  };
}

function settledStoryTimes(timeline) {
  const duration = timeline.totalDurationMs;
  const opening = timeline.events?.find((event) => event.kind === "openingSettle");
  const ending = [...(timeline.events ?? [])]
    .reverse()
    .find((event) => event.kind === "endingSettle");
  const first = Math.max(0, Math.min(duration - 1, Math.round((opening?.endMs ?? 400) / 2)));
  const last = Math.max(
    first,
    Math.min(duration - 1, Math.round(((ending?.startMs ?? duration - 400) + duration) / 2)),
  );
  return [...new Set([first, last])];
}

async function decodeSelectedFrames({
  rawMasterPath,
  storyStartOffsetMs,
  timeline,
  outputRoot,
  runId,
  logRoot,
  env,
}) {
  const selected = [];
  const targetRoot = path.join(outputRoot, runId);
  await fs.mkdir(targetRoot, { recursive: true });
  for (const [index, storyTimeMs] of settledStoryTimes(timeline).entries()) {
    const outputPath = path.join(targetRoot, `story-${String(index + 1).padStart(2, "0")}.png`);
    const mediaSeconds = ((storyStartOffsetMs + storyTimeMs) / 1_000).toFixed(6);
    await runBoundedSubprocess({
      command: "ffmpeg",
      args: [
        "-v",
        "error",
        "-i",
        rawMasterPath,
        "-ss",
        mediaSeconds,
        "-frames:v",
        "1",
        "-c:v",
        "png",
        "-n",
        outputPath,
      ],
      cwd: outputRoot,
      env,
      phase: `${runId}-decode-${index + 1}`,
      logRoot,
      deadlineMs: DEFAULT_SETUP_DEADLINE_MS,
    });
    const bytes = await fs.readFile(outputPath);
    if (bytes.length === 0) throw new Error(`decoded frame is empty: ${outputPath}`);
    selected.push({ storyTimeMs, path: outputPath, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return selected;
}

function expectedRuntimePaths(artifactRoot, runId) {
  const attempt = path.join(artifactRoot, "quick-start", "runs", runId);
  const hostRoot = path.join(artifactRoot, "runtime-host", runId);
  return {
    attempt,
    hostRoot,
    buildRoot: path.join(artifactRoot, "runtime-builds", runId),
    resultPath: path.join(hostRoot, "result.json"),
    receiptPath: path.join(attempt, "evidence", "application-runtime.json"),
    captureManifestPath: path.join(attempt, "capture", "evidence", "capture.json"),
    cameraPath: path.join(attempt, "evidence", "camera.json"),
    buildManifestPath: path.join(
      artifactRoot,
      "runtime-builds",
      runId,
      "evidence",
      "build-provenance.json",
    ),
  };
}

async function collectRunEvidence({
  commandResult,
  scenarioPath,
  artifactRoot,
  evalRoot,
  logRoot,
  env,
}) {
  const runId = commandResult.runId;
  const expected = expectedRuntimePaths(artifactRoot, runId);
  const host = await readJsonIdentity(expected.resultPath, `${runId} runtime host result`);
  const receipt = await readJsonIdentity(expected.receiptPath, `${runId} runtime receipt`);
  const capture = await readJsonIdentity(expected.captureManifestPath, `${runId} capture receipt`);
  const camera = await readJsonIdentity(expected.cameraPath, `${runId} camera evidence`);
  const requestPath = host.value.bundle?.requestPath;
  const request = await readJsonIdentity(requestPath, `${runId} runtime request`);
  const build = await readJsonIdentity(expected.buildManifestPath, `${runId} build manifest`);
  const storyboard = await readJsonIdentity(
    path.join(expected.attempt, "evidence", "storyboard.json"),
    `${runId} storyboard evidence`,
  );
  const reviewPath = commandResult.phases?.stage?.manifestPath;
  const review = await readJsonIdentity(reviewPath, `${runId} review manifest`);
  const qaReportPath = path.join(path.dirname(review.path), review.value.qa?.reportPath ?? "");
  const qa = await readJsonIdentity(qaReportPath, `${runId} staged QA report`);
  const scenario = await readJsonIdentity(scenarioPath, `${runId} scenario`);

  if (host.digest !== commandResult.host.resultDigest) {
    throw new Error(`${runId} runtime result exact bytes do not match command digest`);
  }
  if (receipt.digest !== commandResult.host.receiptDigest) {
    throw new Error(`${runId} runtime receipt exact bytes do not match command digest`);
  }
  if (
    build.value.manifestDigest !==
    digestValue(
      Object.fromEntries(Object.entries(build.value).filter(([key]) => key !== "manifestDigest")),
    )
  ) {
    throw new Error(`${runId} build manifest self digest is invalid`);
  }
  if (
    camera.value.recordDigest !==
    digestValue(
      Object.fromEntries(Object.entries(camera.value).filter(([key]) => key !== "recordDigest")),
    )
  ) {
    throw new Error(`${runId} camera evidence self digest is invalid`);
  }
  assertRuntimeEvidenceLinks({
    commandResult,
    hostResult: host.value,
    receipt: receipt.value,
    request: request.value,
    build: build.value,
    capture: capture.value,
    camera: camera.value,
    expected,
  });
  assertTechnicalReview({ review: review.value, qaReport: qa.value });
  if (qa.digest !== review.value.qa.reportDigest) {
    throw new Error(`${runId} staged QA exact bytes do not match review digest`);
  }
  const timeline = storyboard.value.value?.timeline;
  if (!timeline || timeline.scenarioId !== "quick-start") {
    throw new Error(`${runId} storyboard phase has no quick-start timeline`);
  }
  const selectedFrames = await decodeSelectedFrames({
    rawMasterPath: capture.value.rawMaster?.path,
    storyStartOffsetMs: capture.value.storyStartOffsetMs,
    timeline,
    outputRoot: path.join(evalRoot, "decoded-frames"),
    runId,
    logRoot,
    env,
  });
  const frameAlignment = capture.value.capture?.frameAlignment;
  const normalized = normalizeDeterminismEvidence({
    scenario: {
      id: scenario.value.id,
      digest: capture.value.scenarioDigest,
      value: scenario.value,
    },
    timeline,
    seed: capture.value.seed,
    camera: camera.value,
    pointer: projectSemanticPointerEvidence(capture.value.execution),
    frameTiming: {
      fps: capture.value.capture?.fps,
      storyDurationMs: capture.value.storyDurationMs,
      relativeStartFrame: 0,
      storyFrameCount: frameAlignment?.observedStoryFrames,
      alignment: frameAlignment,
      selectedStoryTimesMs: selectedFrames.map((frame) => frame.storyTimeMs),
    },
    selectedFrames,
  });
  return {
    runId,
    reviewPath: review.path,
    qaReportPath: qa.path,
    rawMasterPath: capture.value.rawMaster?.path,
    paths: expected,
    digests: {
      runtimeResult: host.digest,
      runtimeReceipt: receipt.digest,
      capture: capture.digest,
      build: build.value.manifestDigest,
      camera: camera.value.recordDigest,
      review: review.value.stageDigest,
      qa: qa.digest,
    },
    media: qa.value.artifacts.map((artifact) => ({
      kind: artifact.kind,
      path: artifact.path,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      keyframes: artifact.proofs?.keyframes?.length ?? 0,
      contactSheet: artifact.proofs?.contactSheet ?? null,
    })),
    browser: qa.value.browser,
    selectedFrames,
    normalized,
    normalizedDigest: digestValue(normalized),
  };
}

async function configuredToolchainEnvironment(inheritedEnv = process.env) {
  const environment = { ...inheritedEnv };
  const result = await runBoundedSubprocess({
    command: "go",
    args: ["env", "GOCACHE", "GOMODCACHE", "GOPATH"],
    phase: "go-env",
    deadlineMs: DEFAULT_SETUP_DEADLINE_MS,
  }).catch(() => null);
  if (!result) return environment;
  const [goCache, goModCache, goPath] = result.stdout.trim().split("\n");
  for (const [key, value] of Object.entries({
    GOCACHE: goCache,
    GOMODCACHE: goModCache,
    GOPATH: goPath,
  })) {
    if (value && path.isAbsolute(value)) environment[key] = value;
  }
  return environment;
}

async function invoke(command, { logRoot, env, deadlineMs = DEFAULT_SETUP_DEADLINE_MS } = {}) {
  return runBoundedSubprocess({ ...command, logRoot, env, deadlineMs });
}

function commandResultSummary(result) {
  return {
    phase: result.phase,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    logs: result.logPaths,
  };
}

export async function runFreshAgentPipelineEvaluation({
  sourceRoot = DEFAULT_REPO_ROOT,
  landingRoot = DEFAULT_LANDING_ROOT,
  evalParent = os.tmpdir(),
  captureDeadlineMs = DEFAULT_CAPTURE_DEADLINE_MS,
  inheritedEnv = process.env,
} = {}) {
  const source = await canonicalDirectory(path.resolve(sourceRoot), "production source repository");
  const landing = await canonicalDirectory(path.resolve(landingRoot), "landing repository");
  const parent = path.resolve(evalParent);
  if (isInside(source, parent) || isInside(landing, parent)) {
    throw new Error("pipeline eval parent must stay outside source and landing repositories");
  }
  await fs.mkdir(parent, { recursive: true });
  const evalRoot = await fs.mkdtemp(path.join(parent, "kandev-highlight-pipeline-eval-"));
  return runWithEvalRetention({
    evalRoot,
    task: async ({ markCaptureStarted }) => {
      const cloneRoot = path.join(evalRoot, "snapshot");
      const originRoot = path.join(evalRoot, "origin.git");
      const artifactRoot = path.join(evalRoot, "artifacts");
      const logRoot = path.join(evalRoot, "logs");
      const scenarioPath = path.join(cloneRoot, "eval", "quick-start.scenario.json");
      const placeholderReview = path.join(evalRoot, "review-pending.json");
      const sourceBefore = await captureRepositoryState(source);
      const landingBefore = await captureRepositoryState(landing);
      if (sourceBefore.status !== "")
        throw new Error(`production source is not clean: ${sourceBefore.status}`);
      if (landingBefore.status !== "")
        throw new Error(`landing repository is not clean: ${landingBefore.status}`);
      const snapshot = await snapshotCommittedRepository({
        sourceRoot: source,
        cloneRoot,
        originRoot,
      });
      const dependencyLinks = await linkIgnoredNodeModules({ sourceRoot: source, cloneRoot });
      const environment = await configuredToolchainEnvironment(inheritedEnv);
      const initialCommands = buildPipelineCommandSequence({
        cloneRoot,
        scenarioPath,
        artifactRoot,
        landingRoot: landing,
        reviewPath: placeholderReview,
      });
      const commandEvidence = [];
      const scaffold = await invoke(initialCommands[0], { logRoot, env: environment });
      commandEvidence.push(commandResultSummary(scaffold));
      const validate = await invoke(initialCommands[1], { logRoot, env: environment });
      commandEvidence.push(commandResultSummary(validate));
      const storyboard = await invoke(initialCommands[2], { logRoot, env: environment });
      commandEvidence.push(commandResultSummary(storyboard));
      const storyboardTimeline = parseLastJsonDocument(storyboard.stdout, "storyboard");
      if (
        storyboardTimeline.scenarioId !== "quick-start" ||
        storyboardTimeline.totalDurationMs > 4_000
      ) {
        throw new Error(
          "fresh-agent scaffold storyboard is not the deterministic short quick-start story",
        );
      }
      const currentMain = await commitScenarioAndBindCurrentMain({ cloneRoot, scenarioPath });
      const cloneBoundState = await captureRepositoryState(cloneRoot);
      await assertRepositoryStateUnchanged(
        sourceBefore,
        captureRepositoryState(source),
        "production source",
      );
      await assertRepositoryStateUnchanged(
        landingBefore,
        captureRepositoryState(landing),
        "landing repository",
      );

      await markCaptureStarted({
        phase: initialCommands[3].phase,
        argv: [initialCommands[3].command, ...initialCommands[3].args],
      });
      const firstCommand = await invoke(initialCommands[3], {
        logRoot,
        env: environment,
        deadlineMs: captureDeadlineMs,
      });
      commandEvidence.push(commandResultSummary(firstCommand));
      const firstResult = parseLastJsonDocument(firstCommand.stdout, "first production run");
      const first = await collectRunEvidence({
        commandResult: firstResult,
        scenarioPath,
        artifactRoot,
        evalRoot,
        logRoot,
        env: environment,
      });

      const secondCommand = await invoke(initialCommands[4], {
        logRoot,
        env: environment,
        deadlineMs: captureDeadlineMs,
      });
      commandEvidence.push(commandResultSummary(secondCommand));
      const secondResult = parseLastJsonDocument(secondCommand.stdout, "second production run");
      const second = await collectRunEvidence({
        commandResult: secondResult,
        scenarioPath,
        artifactRoot,
        evalRoot,
        logRoot,
        env: environment,
      });
      const deterministic = assertDeterministicRuns(first.normalized, second.normalized);

      const finalCommands = buildPipelineCommandSequence({
        cloneRoot,
        scenarioPath,
        artifactRoot,
        landingRoot: landing,
        reviewPath: first.reviewPath,
      });
      const beforeRecovery = await captureRepositoryState(cloneRoot);
      const recovery = await invoke(finalCommands[5], { logRoot, env: environment });
      commandEvidence.push(commandResultSummary(recovery));
      const recoveryResult = parseLastJsonDocument(recovery.stdout, "stage recovery dry-run");
      if (
        recoveryResult.contract !== "kandev-highlight-stage-dry-run-v1" ||
        recoveryResult.dryRun !== true ||
        recoveryResult.promotable !== false
      ) {
        throw new Error("stage recovery dry-run did not verify the non-promotable review contract");
      }
      await assertRepositoryStateUnchanged(
        beforeRecovery,
        captureRepositoryState(cloneRoot),
        "stage recovery dry-run snapshot",
      );
      const beforePromotion = await captureRepositoryState(cloneRoot);
      const promotion = await invoke(finalCommands[6], { logRoot, env: environment });
      commandEvidence.push(commandResultSummary(promotion));
      if (!/Dry run: review quick-start\/r1 accepted by fresh-agent-eval/.test(promotion.stdout)) {
        throw new Error("promotion dry-run did not verify explicit fresh-agent-eval acceptance");
      }
      await assertRepositoryStateUnchanged(
        beforePromotion,
        captureRepositoryState(cloneRoot),
        "promotion dry-run snapshot",
      );
      await assertRepositoryStateUnchanged(
        sourceBefore,
        captureRepositoryState(source),
        "production source",
      );
      await assertRepositoryStateUnchanged(
        landingBefore,
        captureRepositoryState(landing),
        "landing repository",
      );
      await assertRepositoryStateUnchanged(
        cloneBoundState,
        captureRepositoryState(cloneRoot),
        "eval snapshot",
      );

      const resultBody = {
        contract: "kandev-highlight-pipeline-eval-result-v1",
        status: "passed",
        evalRoot,
        artifactRoot,
        logRoot,
        snapshot: {
          sourceRoot: source,
          sourceHead: snapshot.sourceHead,
          cloneRoot,
          originRoot,
          evalHead: currentMain.evalHead,
          currentMainSha: currentMain.currentMainSha,
          originMainSha: currentMain.originMainSha,
          localOnly: true,
          dependencyLinks,
        },
        landing: { root: landing, head: landingBefore.head },
        scenario: {
          path: scenarioPath,
          id: "quick-start",
          storyboardDurationMs: storyboardTimeline.totalDurationMs,
        },
        order: PIPELINE_ORDER,
        commands: commandEvidence,
        runs: [first, second].map((run) => ({
          runId: run.runId,
          reviewPath: run.reviewPath,
          qaReportPath: run.qaReportPath,
          rawMasterPath: run.rawMasterPath,
          paths: run.paths,
          digests: run.digests,
          normalizedDigest: run.normalizedDigest,
          selectedFrames: run.selectedFrames,
          media: run.media,
          browser: run.browser,
        })),
        deterministic,
        recovery: {
          contract: recoveryResult.contract,
          dryRun: true,
          reviewPath: recoveryResult.manifestPath,
        },
        promotion: {
          dryRun: true,
          acceptedBy: "fresh-agent-eval",
          reviewPath: first.reviewPath,
          repositoryUnchanged: true,
        },
        repositoryUnchanged: { source: true, landing: true, snapshot: true },
        completedAt: new Date().toISOString(),
      };
      const result = { ...resultBody, resultDigest: digestValue(resultBody) };
      const resultPath = path.join(evalRoot, "result.json");
      await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      return { ...result, resultPath };
    },
  });
}

function parseOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help") return { help: true };
    if (
      !["--source-root", "--landing-root", "--eval-parent", "--capture-timeout-ms"].includes(option)
    ) {
      throw new Error(`unknown pipeline eval option ${option}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    if (values[option] !== undefined) throw new Error(`${option} may be specified only once`);
    values[option] = value;
    index += 1;
  }
  const timeout = values["--capture-timeout-ms"]
    ? Number(values["--capture-timeout-ms"])
    : DEFAULT_CAPTURE_DEADLINE_MS;
  if (!Number.isInteger(timeout) || timeout < 30_000) {
    throw new Error("--capture-timeout-ms must be an integer of at least 30000");
  }
  return {
    sourceRoot: values["--source-root"] ? path.resolve(values["--source-root"]) : DEFAULT_REPO_ROOT,
    landingRoot: values["--landing-root"]
      ? path.resolve(values["--landing-root"])
      : DEFAULT_LANDING_ROOT,
    evalParent: values["--eval-parent"] ? path.resolve(values["--eval-parent"]) : os.tmpdir(),
    captureDeadlineMs: timeout,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: pnpm e2e:highlight-pipeline [--source-root <clean-repo>] [--landing-root <clean-landing-repo>] [--eval-parent <external-dir>] [--capture-timeout-ms <ms>]\n",
    );
    return;
  }
  try {
    const result = await runFreshAgentPipelineEvaluation(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify(
        {
          contract: "kandev-highlight-pipeline-eval-cli-failure-v1",
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
          phase: error.phase ?? null,
          evalRoot: error.evalRoot ?? null,
          failurePath: error.failurePath ?? null,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
