import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  installFrozenOfflineDependencies,
  verifyFrozenOfflineDependencies,
} from "./pipeline-eval-repository.mjs";

const exec = promisify(execFile);
const PNPM_VERSION = "9.15.9";

async function writeFixtureRepository(root) {
  const files = {
    ".gitignore": "node_modules/\n",
    "apps/.npmrc": "verify-store-integrity=true\n",
    "apps/package.json": `${JSON.stringify({ private: true, packageManager: `pnpm@${PNPM_VERSION}` }, null, 2)}\n`,
    "apps/pnpm-lock.yaml": "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  web: {}\n",
    "apps/pnpm-workspace.yaml": "packages:\n  - 'web'\n",
    "apps/web/package.json": `${JSON.stringify({ name: "fixture-web", private: true }, null, 2)}\n`,
  };
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  await exec("git", ["init", "--initial-branch=main"], { cwd: root });
  await exec("git", ["config", "user.name", "Dependency Fixture"], { cwd: root });
  await exec("git", ["config", "user.email", "dependency@example.invalid"], { cwd: root });
  await exec("git", ["add", "."], { cwd: root });
  await exec("git", ["commit", "-m", "fixture"], { cwd: root });
}

async function createFixture(t, { hostile = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-offline-deps-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "live-source");
  const cloneRoot = path.join(root, "snapshot");
  const storeRoot = path.join(root, "pnpm-store");
  await Promise.all([
    fs.mkdir(path.join(sourceRoot, "apps/node_modules/react"), { recursive: true }),
    fs.mkdir(cloneRoot, { recursive: true }),
    fs.mkdir(storeRoot, { recursive: true }),
  ]);
  await writeFixtureRepository(cloneRoot);
  const calls = [];
  const runCommand = async (command) => {
    calls.push(command);
    if (command.args.includes("--version")) return { stdout: `${PNPM_VERSION}\n` };
    if (command.args.includes("store")) return { stdout: `${storeRoot}\n` };
    const packageRoot = path.join(cloneRoot, "apps/node_modules/.pnpm/react/node_modules/react");
    const webModules = path.join(cloneRoot, "apps/web/node_modules");
    await Promise.all([
      fs.mkdir(packageRoot, { recursive: true }),
      fs.mkdir(webModules, { recursive: true }),
    ]);
    await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"react"}\n');
    const target = hostile
      ? path.join(sourceRoot, "apps/node_modules/react")
      : path.relative(webModules, packageRoot);
    await fs.symlink(target, path.join(webModules, "react"));
    return { stdout: "" };
  };
  return { sourceRoot, cloneRoot, storeRoot, calls, runCommand };
}

test("dependency install is frozen, offline, integrity-checked, and provenance-bound", async (t) => {
  const fixture = await createFixture(t);
  const proof = await installFrozenOfflineDependencies(fixture);

  assert.equal(proof.contract, "kandev-highlight-pipeline-dependencies-v1");
  assert.deepEqual(proof.install.argv, [
    "pnpm",
    "install",
    "--offline",
    "--frozen-lockfile",
    "--verify-store-integrity",
  ]);
  assert.equal(proof.install.packageManager, `pnpm@${PNPM_VERSION}`);
  assert.equal(proof.install.actualVersion, PNPM_VERSION);
  assert.equal(proof.install.storeRoot, fixture.storeRoot);
  assert.equal(proof.install.deadlineMs, 720_000);
  assert.equal(
    fixture.calls.every(
      ({ command, env }) => command === "pnpm" && env.COREPACK_ENABLE_NETWORK === "0",
    ),
    true,
  );
  assert.equal(proof.integrity.lockfileUnchanged, true);
  assert.match(proof.integrity.inputDigest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(proof.integrity.inputs.length >= 4);
  assert.equal(proof.isolation.noExternalTargets, true);
  assert.equal(proof.isolation.symlinkCount, 1);
  assert.equal(proof.integrity.tree.fileCount, 1);
  assert.equal(proof.integrity.tree.symlinkCount, 1);
  assert.ok(proof.integrity.tree.bytes > 0);
  assert.match(proof.integrity.tree.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(proof.repositoryUnchanged, true);
  assert.equal(JSON.stringify(proof).includes("linkedEntries"), false);
  assert.equal(
    fixture.calls.some(
      ({ args }) =>
        args.includes("--offline") &&
        args.includes("--frozen-lockfile") &&
        args.includes("--verify-store-integrity"),
    ),
    true,
  );
  const installCall = fixture.calls.find(({ args }) => args.includes("install"));
  assert.equal(installCall.deadlineMs, 720_000);
  assert.equal((await verifyFrozenOfflineDependencies(proof)).passed, true);
});

test("dependency proof rejects a symlink back into the live source", async (t) => {
  const fixture = await createFixture(t, { hostile: true });
  await assert.rejects(
    installFrozenOfflineDependencies(fixture),
    /dependency symlink.*outside eval snapshot or pnpm store|live source/i,
  );
});

test("after-run verification rejects ignored dependency file mutation", async (t) => {
  const fixture = await createFixture(t);
  const proof = await installFrozenOfflineDependencies(fixture);
  const installedPackage = path.join(
    fixture.cloneRoot,
    "apps/node_modules/.pnpm/react/node_modules/react/package.json",
  );
  await fs.writeFile(installedPackage, '{"name":"tampered"}\n');
  await assert.rejects(verifyFrozenOfflineDependencies(proof), /dependency tree identity changed/i);
});
