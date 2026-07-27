import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { provisionPrivateGoModuleCache } from "./pipeline-eval-docker-toolchain.mjs";

const SOURCE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const GO_VERSION = "go version go1.24.6 linux/amd64";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-go-module-provision-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const backendRoot = path.join(sourceRoot, "apps", "backend");
  const privateRoot = path.join(root, "private");
  const targetRoot = path.join(privateRoot, "toolchain", "go-mod");
  const goRoot = path.join(root, "go");
  const goExecutable = path.join(goRoot, "bin", "go");
  await fs.mkdir(backendRoot, { recursive: true });
  await fs.mkdir(path.dirname(goExecutable), { recursive: true });
  await fs.mkdir(privateRoot, { mode: 0o700 });
  await fs.writeFile(path.join(backendRoot, "go.mod"), "module example.invalid/kandev\n");
  await fs.writeFile(path.join(backendRoot, "go.sum"), "example.invalid/mod v1.0.0 h1:proof\n");
  await fs.writeFile(goExecutable, "go binary");
  const sourceProof = {
    root: sourceRoot,
    headSha: SOURCE_SHA,
    tree: "c".repeat(40),
    originMainSha: BASE_SHA,
    status: "",
    identity: { device: "1", inode: "2", mode: 0o755 },
  };
  return {
    root,
    sourceRoot,
    backendRoot,
    privateRoot,
    targetRoot,
    goRoot,
    goExecutable,
    sourceProof,
  };
}

function cacheWriter(calls) {
  return async (specification) => {
    calls.push(specification);
    if (specification.phase === "docker-toolchain-go-mod-download") {
      await fs.mkdir(path.join(specification.env.GOMODCACHE, "example.invalid/mod@v1.0.0"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(specification.env.GOMODCACHE, "example.invalid/mod@v1.0.0", "go.mod"),
        "module example.invalid/mod\n",
      );
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

test("outer preflight provisions and offline-proves a source-bound private Go cache", async (t) => {
  const value = await fixture(t);
  const calls = [];
  const provisioned = await provisionPrivateGoModuleCache({
    ...value,
    sourceSha: SOURCE_SHA,
    sourceProof: value.sourceProof,
    goVersion: GO_VERSION,
    inheritedEnv: {
      GOMODCACHE: "/shared/cache-that-must-not-be-used",
      GOPRIVATE: "secret.example",
      TOKEN: "must-not-leak",
    },
    captureSourceProof: async () => structuredClone(value.sourceProof),
    runCommand: cacheWriter(calls),
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args, ["telemetry", "off"]);
  assert.equal(calls[0].phase, "docker-toolchain-go-telemetry-off");
  assert.equal(calls[0].env.GOMODCACHE, value.targetRoot);
  assert.equal(path.relative(value.targetRoot, calls[0].env.HOME).startsWith(".."), true);
  assert.deepEqual(calls[1].args, ["mod", "download", "all"]);
  assert.equal(calls[1].cwd, value.backendRoot);
  assert.equal(calls[1].command, value.goExecutable);
  assert.equal(calls[1].env.GOMODCACHE, value.targetRoot);
  assert.equal(calls[1].env.GOTOOLCHAIN, "local");
  assert.equal(calls[1].env.GOWORK, "off");
  assert.equal(calls[1].env.GOENV, "off");
  assert.equal(calls[1].env.GOPROXY, "https://proxy.golang.org");
  assert.equal(calls[1].env.GOSUMDB, "sum.golang.org");
  assert.equal(calls[1].env.GOPRIVATE, "");
  assert.equal(calls[1].env.TOKEN, undefined);
  assert.equal(calls[2].env.GOPROXY, "off");
  await assert.rejects(fs.access(`${value.targetRoot}.runtime`), /ENOENT/);
  assert.equal(provisioned.targetRoot, value.targetRoot);
  assert.equal(provisioned.proof.fileCount, 1);
  assert.equal(provisioned.offlineProof.status, "passed");
  assert.equal(provisioned.source.repository.headSha, SOURCE_SHA);
  assert.match(provisioned.source.goMod.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(provisioned.source.goSum.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(provisioned.proof.digest, /^sha256:[a-f0-9]{64}$/);
});

test("provisioning rejects a preexisting target and symlinked private parent", async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    provisionPrivateGoModuleCache({
      ...value,
      targetRoot: path.join(value.root, "outside-target"),
      sourceSha: SOURCE_SHA,
      sourceProof: value.sourceProof,
      goVersion: GO_VERSION,
      captureSourceProof: async () => structuredClone(value.sourceProof),
      runCommand: cacheWriter([]),
    }),
    /inside.*private owner/i,
  );
  await fs.mkdir(path.dirname(value.targetRoot));
  await fs.mkdir(value.targetRoot);
  await assert.rejects(
    provisionPrivateGoModuleCache({
      ...value,
      sourceSha: SOURCE_SHA,
      sourceProof: value.sourceProof,
      goVersion: GO_VERSION,
      captureSourceProof: async () => structuredClone(value.sourceProof),
      runCommand: cacheWriter([]),
    }),
    /target.*new|already exists/i,
  );

  await fs.rm(path.join(value.privateRoot, "toolchain"), {
    recursive: true,
  });
  const outside = path.join(value.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "sentinel"), "preserve");
  await fs.symlink(outside, path.join(value.privateRoot, "toolchain"));
  await assert.rejects(
    provisionPrivateGoModuleCache({
      ...value,
      sourceSha: SOURCE_SHA,
      sourceProof: value.sourceProof,
      goVersion: GO_VERSION,
      captureSourceProof: async () => structuredClone(value.sourceProof),
      runCommand: cacheWriter([]),
    }),
    /symlink|canonical|private/i,
  );
  assert.equal(await fs.readFile(path.join(outside, "sentinel"), "utf8"), "preserve");
});

test("offline failure or prepared-source drift removes only the exact partial cache", async (t) => {
  const offline = await fixture(t);
  await assert.rejects(
    provisionPrivateGoModuleCache({
      ...offline,
      sourceSha: SOURCE_SHA,
      sourceProof: offline.sourceProof,
      goVersion: GO_VERSION,
      captureSourceProof: async () => structuredClone(offline.sourceProof),
      runCommand: async (specification) => {
        await cacheWriter([])(specification);
        if (specification.phase === "docker-toolchain-go-mod-offline-proof") {
          throw new Error("offline cache incomplete");
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }),
    /offline cache incomplete/,
  );
  await assert.rejects(fs.access(offline.targetRoot), /ENOENT/);

  const drift = await fixture(t);
  let proofs = 0;
  await assert.rejects(
    provisionPrivateGoModuleCache({
      ...drift,
      sourceSha: SOURCE_SHA,
      sourceProof: drift.sourceProof,
      goVersion: GO_VERSION,
      captureSourceProof: async () => ({
        ...structuredClone(drift.sourceProof),
        tree: proofs++ === 0 ? drift.sourceProof.tree : "d".repeat(40),
      }),
      runCommand: cacheWriter([]),
    }),
    /source.*changed|proof.*changed/i,
  );
  await assert.rejects(fs.access(drift.targetRoot), /ENOENT/);
});
