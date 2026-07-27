import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as cache from "./pipeline-eval-docker-cache.mjs";

const MODULE_FILE = "module.mod";

test("private Go module cache is an exact writable copy of the verified read-only input", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-docker-go-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "readonly");
  const evalRoot = path.join(root, "eval");
  const targetRoot = path.join(evalRoot, "go-mod-cache");
  await fs.mkdir(path.join(sourceRoot, "cache/download/example.invalid/mod/@v"), {
    recursive: true,
  });
  await fs.mkdir(evalRoot);
  await fs.writeFile(
    path.join(sourceRoot, "cache/download/example.invalid/mod/@v/v1.0.0.mod"),
    "module example.invalid/mod\n",
  );
  const expected = await cache.captureTreeProof(sourceRoot);

  const prepared = await cache.preparePrivateGoModuleCache({
    sourceRoot,
    targetRoot,
    evalRoot,
    expected,
  });

  assert.equal(prepared.sourceBefore.digest, expected.digest);
  assert.equal(prepared.copy.digest, expected.digest);
  assert.equal(prepared.copy.symlinkCount, 0);
  assert.equal(prepared.targetRoot, targetRoot);
  await fs.writeFile(
    path.join(targetRoot, "cache/download/example.invalid/mod/@v/v1.0.0.lock"),
    "",
  );
  const finalized = await cache.finalizePrivateGoModuleCache(prepared);
  assert.equal(finalized.sourceUnchanged, true);
  assert.equal(finalized.sourceAfter.digest, expected.digest);
  assert.equal(finalized.post.fileCount, expected.fileCount + 1);
});

test("private Go module cache rejects source drift and external symlinks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-docker-go-cache-drift-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "readonly");
  const evalRoot = path.join(root, "eval");
  await fs.mkdir(sourceRoot);
  await fs.mkdir(evalRoot);
  await fs.writeFile(path.join(sourceRoot, MODULE_FILE), "module safe\n");
  const expected = await cache.captureTreeProof(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, MODULE_FILE), "module changed\n");
  await assert.rejects(
    cache.preparePrivateGoModuleCache({
      sourceRoot,
      targetRoot: path.join(evalRoot, "go-mod-cache"),
      evalRoot,
      expected,
    }),
    /input.*changed|digest/i,
  );

  await fs.rm(sourceRoot, { recursive: true });
  await fs.mkdir(sourceRoot);
  await fs.writeFile(path.join(root, "outside"), "secret");
  await fs.symlink(path.join(root, "outside"), path.join(sourceRoot, "linked"));
  await assert.rejects(cache.captureTreeProof(sourceRoot), /symlink/i);
});

test("read-only cache snapshot rejects a source that changes while copied", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-docker-go-cache-snapshot-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "shared");
  const targetRoot = path.join(root, "private", "go-mod");
  await fs.mkdir(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, MODULE_FILE), "module safe\n");

  await assert.rejects(
    cache.snapshotReadOnlyTree({
      sourceRoot,
      targetRoot,
      copy: async (source, target, options) => {
        await fs.cp(source, target, options);
        await fs.writeFile(path.join(sourceRoot, MODULE_FILE), "module changed\n");
      },
    }),
    /changed while snapshotting|source.*changed/i,
  );
  await assert.rejects(fs.access(targetRoot), /ENOENT/);
});

test("private snapshot cleanup removes preserved read-only directories only inside its owner root", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-docker-go-cache-cleanup-"));
  t.after(async () => {
    await fs.chmod(path.join(root, "shared", "module", ".github"), 0o700).catch(() => {});
    await fs.chmod(path.join(root, "shared", "module"), 0o700).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, "shared");
  const privateRoot = path.join(root, "private");
  const targetRoot = path.join(privateRoot, "go-mod");
  await fs.mkdir(path.join(sourceRoot, "module", ".github"), {
    recursive: true,
  });
  await fs.writeFile(path.join(sourceRoot, "module", ".github", "config"), "read-only\n");
  await fs.chmod(path.join(sourceRoot, "module", ".github"), 0o555);
  await fs.chmod(path.join(sourceRoot, "module"), 0o555);
  await cache.snapshotReadOnlyTree({ sourceRoot, targetRoot });

  await cache.removePrivateTree({ targetRoot, privateRoot });

  await assert.rejects(fs.access(targetRoot), /ENOENT/);
  assert.equal(
    await fs.readFile(path.join(sourceRoot, "module", ".github", "config"), "utf8"),
    "read-only\n",
  );
  await assert.rejects(
    cache.removePrivateTree({
      targetRoot: sourceRoot,
      privateRoot,
    }),
    /inside.*private|private.*root/i,
  );
});
