import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

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

export function computeSourceCaptureDigest(provenance) {
  if (
    !provenance ||
    !["pr_head", "current_main"].includes(provenance.captureMode) ||
    !SHA_PATTERN.test(provenance.sourceSha ?? "")
  ) {
    throw new Error(
      "source capture identity needs an exact mode and source SHA",
    );
  }
  let identity;
  if (provenance.captureMode === "pr_head") {
    if (
      !Number.isInteger(provenance.prNumber) ||
      provenance.prNumber <= 0 ||
      !SHA_PATTERN.test(provenance.prBaseSha ?? "") ||
      provenance.prHeadSha !== provenance.sourceSha ||
      provenance.sourceRef !== undefined
    ) {
      throw new Error(
        "pr_head source capture identity must bind PR number, base SHA, and head SHA to source SHA",
      );
    }
    identity = {
      captureMode: provenance.captureMode,
      sourceSha: provenance.sourceSha,
      prNumber: provenance.prNumber,
      prBaseSha: provenance.prBaseSha,
      prHeadSha: provenance.prHeadSha,
    };
  } else {
    if (
      provenance.sourceRef !== "origin/main" ||
      [provenance.prNumber, provenance.prBaseSha, provenance.prHeadSha].some(
        (value) => value !== undefined,
      )
    ) {
      throw new Error(
        "current_main source capture identity must bind origin/main without PR metadata",
      );
    }
    identity = {
      captureMode: provenance.captureMode,
      sourceSha: provenance.sourceSha,
      sourceRef: provenance.sourceRef,
    };
  }
  return `sha256:${createHash("sha256")
    .update(canonicalJson(identity))
    .digest("hex")}`;
}

async function defaultRunner(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return { ...result, exitCode: 0 };
}

async function gitValue(runner, repoRoot, args, label) {
  let result;
  try {
    result = await runner("git", ["-C", repoRoot, ...args]);
  } catch (error) {
    throw new Error(`cannot inspect ${label} in ${repoRoot}: ${error.message}`);
  }
  const value = String(result?.stdout ?? result?.output ?? "").trim();
  return value;
}

export async function verifySourceGate({
  repoRoot,
  source,
  runner = defaultRunner,
} = {}) {
  if (source !== "pr_head" && source !== "current_main") {
    throw new Error("source must be pr_head or current_main");
  }
  if (typeof repoRoot !== "string" || repoRoot.trim() === "")
    throw new Error("repoRoot is required");
  const resolvedRoot = path.resolve(repoRoot);
  const [headSha, currentMainSha, status] = await Promise.all([
    gitValue(runner, resolvedRoot, ["rev-parse", "HEAD"], "HEAD"),
    gitValue(runner, resolvedRoot, ["rev-parse", "origin/main"], "origin/main"),
    gitValue(
      runner,
      resolvedRoot,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      "worktree status",
    ),
  ]);
  if (!SHA_PATTERN.test(headSha))
    throw new Error(
      `HEAD did not resolve to an exact Git SHA: ${headSha || "missing"}`,
    );
  if (!SHA_PATTERN.test(currentMainSha)) {
    throw new Error(
      `origin/main did not resolve to an exact Git SHA: ${currentMainSha || "missing"}`,
    );
  }
  if (status !== "")
    throw new Error(`source worktree must be clean; status: ${status}`);
  if (source === "current_main" && headSha !== currentMainSha) {
    throw new Error(
      `current_main requires HEAD ${headSha} to equal origin/main ${currentMainSha}`,
    );
  }
  return {
    contract: "kandev-highlight-source-v1",
    source,
    repoRoot: resolvedRoot,
    selectedSha: source === "pr_head" ? headSha : currentMainSha,
    headSha,
    currentMainSha,
    clean: true,
    status,
  };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function assertExternalArtifactRoot({
  artifactRoot,
  repoRoots = [],
} = {}) {
  if (typeof artifactRoot !== "string" || artifactRoot.trim() === "") {
    throw new Error("artifactRoot is required");
  }
  const resolved = path.resolve(artifactRoot);
  const filesystemRoot = path.parse(resolved).root;
  const unsafeRoots = new Set([filesystemRoot, path.resolve(os.homedir())]);
  if (
    unsafeRoots.has(resolved) ||
    resolved.split(path.sep).filter(Boolean).length < 2
  ) {
    throw new Error(`unsafe artifact root: ${resolved}`);
  }
  for (const repoRoot of repoRoots) {
    if (typeof repoRoot !== "string" || repoRoot.trim() === "") continue;
    const repository = path.resolve(repoRoot);
    if (isWithin(repository, resolved)) {
      throw new Error(
        `artifact root must stay outside repository ${repository}: ${resolved}`,
      );
    }
  }
  return resolved;
}

export function assertPathInside(root, candidate, label = "artifact") {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (
    !isWithin(resolvedRoot, resolvedCandidate) ||
    resolvedCandidate === resolvedRoot
  ) {
    throw new Error(`${label} is outside reserved stage: ${resolvedCandidate}`);
  }
  return resolvedCandidate;
}
