import fs from "node:fs/promises";
import path from "node:path";

import {
  canonicalDirectory,
  canonicalJson,
  digestBytes,
  digestValue,
  git,
  isInside,
  pathExists,
  requireAbsolute,
  runBoundedSubprocess,
} from "./pipeline-eval-shared.mjs";

const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const DEPENDENCY_CONTRACT = "kandev-highlight-pipeline-dependencies-v1";
const MAIN_REF = "refs/heads/main";
const DEPENDENCY_INSTALL_DEADLINE_MS = 5 * 60_000;
const INSTALL_ARGS = Object.freeze([
  "install",
  "--offline",
  "--frozen-lockfile",
  "--verify-store-integrity",
]);
const REQUIRED_INPUTS = Object.freeze([
  "apps/.npmrc",
  "apps/package.json",
  "apps/pnpm-lock.yaml",
  "apps/pnpm-workspace.yaml",
]);

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

/** Create a network-free bare origin and work clone at the exact clean source HEAD. */
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
  const sourceMainSha = await resolveSourceMain(source);
  await fs.mkdir(path.dirname(snapshot), { recursive: true });
  await createSnapshotRepositories({
    source,
    snapshot,
    origin,
    head: sourceState.head,
    mainHead: sourceMainSha,
  });
  const snapshotState = await captureRepositoryState(snapshot);
  const originHead = await bareMainHead(origin);
  if (snapshotState.head !== sourceState.head || snapshotState.status !== "") {
    throw new Error("local eval snapshot does not match the exact clean source HEAD");
  }
  if (originHead !== sourceMainSha) {
    throw new Error("local bare origin main does not match immutable source main");
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

async function resolveSourceMain(source) {
  for (const reference of ["refs/remotes/origin/main^{commit}", "refs/heads/main^{commit}"]) {
    try {
      const result = await git(source, ["rev-parse", "--verify", reference], {
        phase: "git-source-main",
      });
      const value = result.stdout.trim();
      if (SHA_PATTERN.test(value)) return value;
    } catch {
      // A local-only fixture may have main without origin/main.
    }
  }
  throw new Error("source repository needs exact origin/main or local main for eval PR base");
}

async function createSnapshotRepositories({ source, snapshot, origin, head, mainHead }) {
  await git(null, ["clone", "--bare", "--no-hardlinks", "--local", source, origin], {
    phase: "git-clone-origin",
  });
  await git(null, ["--git-dir", origin, "update-ref", MAIN_REF, mainHead], {
    phase: "git-initialize-origin-main",
  });
  await git(null, ["clone", "--no-hardlinks", "--no-checkout", "--local", origin, snapshot], {
    phase: "git-clone-snapshot",
  });
  await git(snapshot, ["checkout", "--detach", head], { phase: "git-checkout" });
}

async function bareMainHead(origin) {
  const result = await git(null, ["--git-dir", origin, "rev-parse", MAIN_REF], {
    phase: "git-origin-head",
  });
  return result.stdout.trim();
}

async function localBareOrigin(cloneRoot) {
  const remote = (await git(cloneRoot, ["remote", "get-url", "origin"])).stdout.trim();
  if (!remote || /^(?:[a-z][a-z0-9+.-]*:|[^/]+@)/i.test(remote)) {
    throw new Error("eval snapshot origin must be a local filesystem bare repository");
  }
  const origin = await canonicalDirectory(path.resolve(cloneRoot, remote), "eval bare origin");
  const bare = (
    await git(null, ["--git-dir", origin, "rev-parse", "--is-bare-repository"], {
      phase: "git-origin-bare",
    })
  ).stdout.trim();
  if (bare !== "true") throw new Error("eval snapshot origin is not bare");
  return origin;
}

async function validateScenarioCommitInput(repository, scenario) {
  if (!isInside(repository, scenario) || scenario === repository) {
    throw new Error("eval scenario must stay inside snapshot");
  }
  const scenarioStat = await fs.lstat(scenario).catch(() => null);
  if (!scenarioStat?.isFile() || scenarioStat.isSymbolicLink()) {
    throw new Error("eval scenario must be a regular non-symlink file");
  }
  const relative = path.relative(repository, scenario).split(path.sep).join("/");
  const status = (
    await git(repository, ["status", "--porcelain=v1", "--untracked-files=all"])
  ).stdout.trim();
  const entries = status ? status.split("\n") : [];
  if (entries.length !== 1 || !entries[0].startsWith("?? ") || !entries[0].endsWith(relative)) {
    throw new Error(
      `eval snapshot must contain only the scaffolded scenario before commit: ${status || "clean"}`,
    );
  }
  return relative;
}

async function commitScenario(repository, relativeScenario) {
  await git(repository, ["config", "user.name", "Kandev Highlight Fresh Agent Eval"]);
  await git(repository, ["config", "user.email", "highlight-eval@kandev.invalid"]);
  await git(repository, ["add", "--", relativeScenario]);
  await git(repository, ["commit", "-m", "test(highlights): add fresh-agent eval scenario"]);
  const evalHead = (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
  if (!SHA_PATTERN.test(evalHead))
    throw new Error("eval scenario commit did not produce exact SHA");
  return evalHead;
}

async function currentMainProof(repository, origin, evalHead) {
  const [head, currentMain, originMain, status] = await Promise.all([
    git(repository, ["rev-parse", "HEAD"]),
    git(repository, ["rev-parse", "origin/main"]),
    git(null, ["--git-dir", origin, "rev-parse", MAIN_REF], {
      phase: "git-verify-origin-main",
    }),
    git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  return {
    evalHead,
    headSha: head.stdout.trim(),
    currentMainSha: currentMain.stdout.trim(),
    originMainSha: originMain.stdout.trim(),
    prBaseSha: originMain.stdout.trim(),
    originRoot: origin,
    clean: status.stdout.trim() === "",
  };
}

export async function commitScenarioAsPrHead({ cloneRoot, scenarioPath } = {}) {
  const repository = await canonicalDirectory(path.resolve(cloneRoot), "eval snapshot");
  const scenario = requireAbsolute(scenarioPath, "scenarioPath");
  const relativeScenario = await validateScenarioCommitInput(repository, scenario);
  const evalHead = await commitScenario(repository, relativeScenario);
  const origin = await localBareOrigin(repository);
  const proof = await currentMainProof(repository, origin, evalHead);
  if (
    proof.headSha !== evalHead ||
    proof.currentMainSha !== proof.originMainSha ||
    proof.currentMainSha === evalHead ||
    !proof.clean
  ) {
    throw new Error(
      "pr_head eval proof must keep immutable origin/main while binding clean synthetic HEAD",
    );
  }
  return proof;
}

/** @deprecated Safe compatibility alias; never mutates origin/main. */
export const commitScenarioAndBindCurrentMain = commitScenarioAsPrHead;

async function workspaceManifestPaths(repository) {
  const paths = [...REQUIRED_INPUTS];
  for (const parentRelative of ["apps", "apps/packages"]) {
    const parent = path.join(repository, parentRelative);
    const entries = await fs.readdir(parent, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const relative = `${parentRelative}/${entry.name}/package.json`;
      if (await pathExists(path.join(repository, relative))) paths.push(relative);
    }
  }
  return [...new Set(paths)].sort();
}

async function fileProofs(repository, relatives) {
  return Promise.all(
    relatives.map(async (relative) => {
      const bytes = await fs.readFile(path.join(repository, relative));
      return { path: relative, bytes: bytes.length, sha256: digestBytes(bytes) };
    }),
  );
}

function expectedPnpmVersion(packageJson) {
  const match = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(packageJson.packageManager ?? "");
  if (!match) throw new Error("apps/package.json packageManager must pin an exact pnpm version");
  return { packageManager: packageJson.packageManager, version: match[1] };
}

function dependencyRootPaths(repository, manifestPaths) {
  const roots = new Set([path.join(repository, "apps/node_modules")]);
  for (const manifest of manifestPaths.filter((relative) => relative.endsWith("package.json"))) {
    roots.add(path.join(path.dirname(path.join(repository, manifest)), "node_modules"));
  }
  return [...roots].sort();
}

async function assertDependencyRootsAbsent(roots) {
  for (const root of roots) {
    if (await pathExists(root)) {
      throw new Error(
        `frozen dependency install requires an empty snapshot: ${root} already exists`,
      );
    }
  }
}

function portableRelative(root, candidate) {
  return path.relative(root, candidate).split(path.sep).join("/");
}

function allowedTargetLabel(target, cloneRoot, storeRoot) {
  if (isInside(cloneRoot, target)) return `snapshot:${portableRelative(cloneRoot, target)}`;
  if (isInside(storeRoot, target)) return `store:${portableRelative(storeRoot, target)}`;
  return null;
}

function compareEntryNames(left, right) {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

async function collectDependencyEntries(current, context) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries.sort(compareEntryNames)) {
    const candidate = path.join(current, entry.name);
    const stat = await fs.lstat(candidate);
    const relative = portableRelative(context.cloneRoot, candidate);
    if (stat.isSymbolicLink()) {
      const [linkTarget, resolved] = await Promise.all([
        fs.readlink(candidate),
        fs.realpath(candidate).catch(() => null),
      ]);
      const resolvedTarget = resolved
        ? allowedTargetLabel(resolved, context.cloneRoot, context.storeRoot)
        : null;
      if (!resolvedTarget) {
        throw new Error(
          `dependency symlink resolves outside eval snapshot or pnpm store (possible live source): ${candidate} -> ${resolved ?? "broken"}`,
        );
      }
      context.entries.push({
        kind: "symlink",
        path: relative,
        mode: stat.mode & 0o7777,
        target: linkTarget,
        resolvedTarget,
      });
      continue;
    }
    if (stat.isDirectory()) {
      await collectDependencyEntries(candidate, context);
      continue;
    }
    if (!stat.isFile()) throw new Error(`unsupported dependency tree entry: ${candidate}`);
    const bytes = await fs.readFile(candidate);
    context.entries.push({
      kind: "file",
      path: relative,
      mode: stat.mode & 0o7777,
      bytes: bytes.length,
      sha256: digestBytes(bytes),
    });
  }
}

function summarizeDependencyEntries(root, cloneRoot, entries) {
  const files = entries.filter(({ kind }) => kind === "file");
  const symlinks = entries.filter(({ kind }) => kind === "symlink");
  return {
    root: portableRelative(cloneRoot, root),
    digest: digestValue(entries),
    fileCount: files.length,
    bytes: files.reduce((total, entry) => total + entry.bytes, 0),
    symlinkCount: symlinks.length,
  };
}

async function dependencyTreeIdentity(roots, cloneRoot, storeRoot) {
  const summaries = [];
  for (const root of roots) {
    const stat = await fs.lstat(root).catch(() => null);
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`dependency root must be a real directory: ${root}`);
    }
    const context = { cloneRoot, storeRoot, entries: [] };
    await collectDependencyEntries(root, context);
    summaries.push(summarizeDependencyEntries(root, cloneRoot, context.entries));
  }
  const fileCount = summaries.reduce((total, root) => total + root.fileCount, 0);
  const bytes = summaries.reduce((total, root) => total + root.bytes, 0);
  const symlinkCount = summaries.reduce((total, root) => total + root.symlinkCount, 0);
  return {
    digest: digestValue(summaries),
    fileCount,
    bytes,
    symlinkCount,
    roots: summaries,
  };
}

async function verifyDependencyIsolation(roots, cloneRoot, storeRoot) {
  const tree = await dependencyTreeIdentity(roots, cloneRoot, storeRoot);
  const installedRoots = tree.roots.map((record) => ({
    root: path.join(cloneRoot, record.root),
    symlinkCount: record.symlinkCount,
  }));
  if (!installedRoots.some(({ root }) => root === path.join(cloneRoot, "apps/node_modules"))) {
    throw new Error("offline pnpm install did not create apps/node_modules");
  }
  return {
    roots: installedRoots,
    symlinkCount: tree.symlinkCount,
    noExternalTargets: true,
    tree,
  };
}

async function runPnpm(runCommand, specification) {
  return runCommand({
    command: "corepack",
    ...specification,
    args: ["pnpm", ...specification.args],
  });
}

export async function installFrozenOfflineDependencies({
  sourceRoot,
  cloneRoot,
  runCommand = runBoundedSubprocess,
  inheritedEnv = process.env,
  logRoot,
} = {}) {
  const source = await canonicalDirectory(path.resolve(sourceRoot), "live source repository");
  const repository = await canonicalDirectory(path.resolve(cloneRoot), "eval snapshot");
  const appsRoot = path.join(repository, "apps");
  const manifestPaths = await workspaceManifestPaths(repository);
  const dependencyRoots = dependencyRootPaths(repository, manifestPaths);
  await assertDependencyRootsAbsent(dependencyRoots);
  const beforeState = await captureRepositoryState(repository);
  const beforeInputs = await fileProofs(repository, manifestPaths);
  const packageJson = JSON.parse(await fs.readFile(path.join(appsRoot, "package.json"), "utf8"));
  const expected = expectedPnpmVersion(packageJson);
  const commandOptions = {
    cwd: appsRoot,
    env: { ...inheritedEnv, COREPACK_ENABLE_NETWORK: "0" },
    logRoot,
  };
  const versionResult = await runPnpm(runCommand, {
    ...commandOptions,
    args: ["--version"],
    phase: "pnpm-version",
  });
  const actualVersion = versionResult.stdout.trim();
  if (actualVersion !== expected.version) {
    throw new Error(
      `pnpm version mismatch: expected ${expected.version}, received ${actualVersion}`,
    );
  }
  const storeResult = await runPnpm(runCommand, {
    ...commandOptions,
    args: ["store", "path"],
    phase: "pnpm-store-path",
  });
  const storeRoot = await canonicalDirectory(
    requireAbsolute(storeResult.stdout.trim(), "pnpm store path"),
    "pnpm store",
  );
  if (isInside(source, storeRoot)) throw new Error("pnpm store cannot be inside the live source");
  await runPnpm(runCommand, {
    ...commandOptions,
    args: [...INSTALL_ARGS],
    phase: "pnpm-install-offline",
    deadlineMs: DEPENDENCY_INSTALL_DEADLINE_MS,
  });
  const afterInputs = await fileProofs(repository, manifestPaths);
  if (canonicalJson(beforeInputs) !== canonicalJson(afterInputs)) {
    throw new Error("frozen offline install changed dependency input bytes");
  }
  await assertRepositoryStateUnchanged(
    beforeState,
    captureRepositoryState(repository),
    "offline dependency install snapshot",
  );
  const verified = await verifyDependencyIsolation(dependencyRoots, repository, storeRoot);
  const { tree, ...isolation } = verified;
  return {
    contract: DEPENDENCY_CONTRACT,
    install: {
      argv: ["corepack", "pnpm", ...INSTALL_ARGS],
      cwd: appsRoot,
      packageManager: expected.packageManager,
      actualVersion,
      nodeVersion: process.version,
      storeRoot,
      offline: true,
      frozenLockfile: true,
      verifyStoreIntegrity: true,
      corepackNetworkDisabled: true,
      deadlineMs: DEPENDENCY_INSTALL_DEADLINE_MS,
    },
    integrity: {
      inputs: beforeInputs,
      inputDigest: digestValue(beforeInputs),
      lockfileUnchanged: true,
      tree,
    },
    isolation: {
      ...isolation,
      sourceRoot: source,
      snapshotRoot: repository,
      storeRoot,
    },
    repositoryUnchanged: true,
  };
}

function requireDependencyProof(proof) {
  if (proof?.contract !== DEPENDENCY_CONTRACT) {
    throw new Error(`dependency proof must use ${DEPENDENCY_CONTRACT}`);
  }
  if (!Array.isArray(proof.integrity?.inputs) || !proof.integrity?.tree) {
    throw new Error("dependency proof is missing integrity inputs or tree identity");
  }
  return proof;
}

export async function verifyFrozenOfflineDependencies(proofInput) {
  const proof = requireDependencyProof(proofInput);
  const repository = await canonicalDirectory(
    proof.isolation.snapshotRoot,
    "dependency proof snapshot",
  );
  const source = await canonicalDirectory(proof.isolation.sourceRoot, "dependency proof source");
  const storeRoot = await canonicalDirectory(
    proof.install.storeRoot,
    "dependency proof pnpm store",
  );
  if (source !== proof.isolation.sourceRoot || storeRoot !== proof.isolation.storeRoot) {
    throw new Error("dependency proof source or pnpm store identity changed");
  }
  const manifestPaths = proof.integrity.inputs.map(({ path: relative }) => relative);
  const currentInputs = await fileProofs(repository, manifestPaths);
  const currentInputDigest = digestValue(currentInputs);
  if (
    canonicalJson(currentInputs) !== canonicalJson(proof.integrity.inputs) ||
    currentInputDigest !== proof.integrity.inputDigest
  ) {
    throw new Error("dependency input identity changed after capture");
  }
  const dependencyRoots = dependencyRootPaths(repository, manifestPaths);
  const current = await verifyDependencyIsolation(dependencyRoots, repository, storeRoot);
  if (canonicalJson(current.tree) !== canonicalJson(proof.integrity.tree)) {
    throw new Error("dependency tree identity changed after capture");
  }
  const expectedIsolation = {
    roots: proof.isolation.roots,
    symlinkCount: proof.isolation.symlinkCount,
    noExternalTargets: true,
  };
  const currentIsolation = {
    roots: current.roots,
    symlinkCount: current.symlinkCount,
    noExternalTargets: current.noExternalTargets,
  };
  if (canonicalJson(currentIsolation) !== canonicalJson(expectedIsolation)) {
    throw new Error("dependency isolation proof changed after capture");
  }
  return { passed: true, treeDigest: current.tree.digest, inputDigest: currentInputDigest };
}

// Compatibility export: callers keep the stable facade while behavior is now a frozen install.
export const linkIgnoredDependencies = installFrozenOfflineDependencies;
