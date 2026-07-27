import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { canonicalJson, digestValue, isInside } from "./pipeline-eval-shared.mjs";

const TREE_CONTRACT = "kandev-highlight-readonly-tree-v1";

function hashBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function collectEntries(root, directory, entries) {
  const children = await fs.readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const absolute = path.join(directory, child.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`Go module cache cannot contain symlink: ${relative}`);
    }
    if (stat.isDirectory()) {
      entries.push({
        kind: "directory",
        path: relative,
        mode: stat.mode & 0o7777,
      });
      await collectEntries(root, absolute, entries);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(`Go module cache contains unsupported entry: ${relative}`);
    }
    const bytes = await fs.readFile(absolute);
    entries.push({
      kind: "file",
      path: relative,
      mode: stat.mode & 0o7777,
      bytes: bytes.length,
      sha256: hashBytes(bytes),
    });
  }
}

function proofBody(entries) {
  const files = entries.filter(({ kind }) => kind === "file");
  return {
    contract: TREE_CONTRACT,
    digest: digestValue(entries),
    fileCount: files.length,
    directoryCount: entries.length - files.length,
    bytes: files.reduce((total, entry) => total + entry.bytes, 0),
    symlinkCount: 0,
  };
}

export async function captureTreeProof(rootPath) {
  const root = path.resolve(rootPath);
  const [canonical, stat] = await Promise.all([fs.realpath(root), fs.lstat(root)]);
  if (canonical !== root || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Go module cache must be a canonical non-symlink directory: ${root}`);
  }
  const entries = [];
  await collectEntries(root, root, entries);
  return { root, ...proofBody(entries) };
}

export async function snapshotReadOnlyTree({ sourceRoot, targetRoot, copy = fs.cp } = {}) {
  const source = path.resolve(sourceRoot);
  const target = path.resolve(targetRoot);
  if (target === source || isInside(source, target) || isInside(target, source)) {
    throw new Error("read-only tree snapshot source and target must be disjoint");
  }
  if (await fs.lstat(target).catch(() => null)) {
    throw new Error(`read-only tree snapshot target already exists: ${target}`);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const sourceBefore = await captureTreeProof(source);
  try {
    await copy(source, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
      mode: fsConstants.COPYFILE_FICLONE,
    });
    const [sourceAfter, snapshot] = await Promise.all([
      captureTreeProof(source),
      captureTreeProof(target),
    ]);
    assertSameProof(sourceAfter, sourceBefore, "Go module cache changed while snapshotting");
    assertSameProof(snapshot, sourceBefore, "private Go module cache snapshot");
    return {
      contract: "kandev-highlight-readonly-tree-snapshot-v1",
      sourceBefore,
      sourceAfter,
      snapshot,
      sourceUnchanged: true,
    };
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function removePrivateTree({ targetRoot, privateRoot } = {}) {
  const target = path.resolve(targetRoot);
  const owner = path.resolve(privateRoot);
  if (target === owner || !isInside(owner, target)) {
    throw new Error("private tree cleanup target must stay inside its private owner root");
  }
  const [ownerCanonical, ownerStat] = await Promise.all([fs.realpath(owner), fs.lstat(owner)]);
  if (ownerCanonical !== owner || !ownerStat.isDirectory() || ownerStat.isSymbolicLink()) {
    throw new Error("private tree cleanup owner must be a canonical non-symlink directory");
  }
  const stat = await fs
    .lstat(target)
    .catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(target)) !== target) {
    throw new Error("private tree cleanup target must be a canonical non-symlink directory");
  }
  async function makeDirectoriesWritable(directory) {
    await fs.chmod(directory, 0o700);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await makeDirectoriesWritable(child);
      } else if (!entry.isFile() && !entry.isSymbolicLink()) {
        throw new Error(`private tree cleanup refuses an unsupported entry: ${child}`);
      }
    }
  }
  await makeDirectoriesWritable(target);
  await fs.rm(target, { recursive: true, force: true });
  return true;
}

function comparableProof(proof) {
  const { root: _root, ...value } = proof ?? {};
  return value;
}

function assertSameProof(actual, expected, label) {
  if (
    expected?.contract !== TREE_CONTRACT ||
    canonicalJson(comparableProof(actual)) !== canonicalJson(comparableProof(expected))
  ) {
    throw new Error(`${label} input changed or digest does not match`);
  }
}

function requirePrivateTarget(targetRoot, evalRoot) {
  const target = path.resolve(targetRoot);
  const writableRoot = path.resolve(evalRoot);
  if (target === writableRoot || !isInside(writableRoot, target)) {
    throw new Error("private Go module cache must stay inside the writable eval root");
  }
  return target;
}

export async function preparePrivateGoModuleCache({
  sourceRoot,
  targetRoot,
  evalRoot,
  expected,
} = {}) {
  const target = requirePrivateTarget(targetRoot, evalRoot);
  const existing = await fs
    .lstat(target)
    .catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  if (existing) {
    throw new Error(`private Go module cache target already exists: ${target}`);
  }
  const sourceBefore = await captureTreeProof(sourceRoot);
  assertSameProof(sourceBefore, expected, "read-only Go module cache");
  await fs.cp(sourceBefore.root, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
    mode: fsConstants.COPYFILE_FICLONE,
  });
  const copy = await captureTreeProof(target);
  assertSameProof(copy, sourceBefore, "private Go module cache copy");
  return {
    contract: "kandev-highlight-private-go-module-cache-v1",
    evalRoot: path.resolve(evalRoot),
    sourceRoot: sourceBefore.root,
    targetRoot: target,
    sourceBefore,
    copy,
  };
}

export async function finalizePrivateGoModuleCache(prepared) {
  if (prepared?.contract !== "kandev-highlight-private-go-module-cache-v1") {
    throw new Error("private Go module cache preparation proof is invalid");
  }
  requirePrivateTarget(prepared.targetRoot, prepared.evalRoot);
  const [sourceAfter, post] = await Promise.all([
    captureTreeProof(prepared.sourceRoot),
    captureTreeProof(prepared.targetRoot),
  ]);
  assertSameProof(sourceAfter, prepared.sourceBefore, "read-only Go module cache postflight");
  return {
    ...prepared,
    sourceAfter,
    sourceUnchanged: true,
    post,
    isolation: {
      writableCopy: true,
      insideEvalRoot: true,
      noSymlinks: post.symlinkCount === 0,
    },
  };
}
