import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { removePrivateTree } from "./pipeline-eval-docker-cache.mjs";
import { acquirePrivateGoToolchain } from "./pipeline-eval-go-toolchain.mjs";

test("acquires the exact checked-in Go directive privately and proves it offline", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-private-go-toolchain-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const privateRoot = path.join(root, "private");
  const backendRoot = path.join(root, "source", "apps", "backend");
  const bootstrapRoot = path.join(privateRoot, "bootstrap");
  const bootstrapExecutable = path.join(root, "bootstrap-go");
  await fs.mkdir(privateRoot, { mode: 0o700 });
  await fs.mkdir(backendRoot, { recursive: true });
  await fs.writeFile(
    path.join(backendRoot, "go.mod"),
    "module example.invalid/kandev\n\ngo 1.26.0\n",
  );
  await fs.writeFile(bootstrapExecutable, "bootstrap");
  const calls = [];
  let acquiredRoot;
  const acquired = await acquirePrivateGoToolchain({
    backendRoot,
    privateRoot,
    bootstrapRoot,
    bootstrapExecutable,
    runCommand: async (specification) => {
      calls.push(specification);
      if (specification.command === bootstrapExecutable) {
        acquiredRoot = path.join(
          specification.env.GOMODCACHE,
          "golang.org/toolchain@v0.0.1-go1.26.0.linux-amd64",
        );
        await fs.mkdir(path.join(acquiredRoot, "bin"), {
          recursive: true,
        });
        await fs.writeFile(path.join(acquiredRoot, "bin", "go"), "go1.26");
        await fs.writeFile(path.join(acquiredRoot, "VERSION"), "go1.26.0\n");
        return { stdout: `${acquiredRoot}\n`, stderr: "", exitCode: 0 };
      }
      return {
        stdout: "go version go1.26.0 linux/amd64\n",
        stderr: "",
        exitCode: 0,
      };
    },
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args, ["env", "GOROOT"]);
  assert.equal(calls[0].env.GOTOOLCHAIN, "go1.26.0");
  assert.equal(calls[0].env.GOENV, "off");
  assert.equal(calls[0].env.GOWORK, "off");
  assert.equal(calls[0].env.GOPROXY, "https://proxy.golang.org");
  assert.equal(calls[1].env.GOPROXY, "off");
  assert.equal(calls[2].command, path.join(acquiredRoot, "bin", "go"));
  assert.equal(calls[2].env.GOTOOLCHAIN, "local");
  assert.equal(acquired.required.go, "1.26.0");
  assert.equal(acquired.required.toolchain, null);
  assert.equal(acquired.version, "go version go1.26.0 linux/amd64");
  assert.equal(acquired.offlineProof.status, "passed");
  assert.match(acquired.tree.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(acquired.binary.digest, /^sha256:[a-f0-9]{64}$/);
  await removePrivateTree({
    targetRoot: acquired.cleanupRoot,
    privateRoot,
  });
  await assert.rejects(fs.access(bootstrapRoot), /ENOENT/);
});

test("toolchain version mismatch fails closed and exact-cleans its private root", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-private-go-toolchain-mismatch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const privateRoot = path.join(root, "private");
  const backendRoot = path.join(root, "source", "apps", "backend");
  const bootstrapRoot = path.join(privateRoot, "bootstrap");
  const bootstrapExecutable = path.join(root, "bootstrap-go");
  await fs.mkdir(privateRoot, { mode: 0o700 });
  await fs.mkdir(backendRoot, { recursive: true });
  await fs.writeFile(
    path.join(backendRoot, "go.mod"),
    "module example.invalid/kandev\n\ngo 1.26.0\n\ntoolchain go1.26.1\n",
  );
  await fs.writeFile(bootstrapExecutable, "bootstrap");
  let acquiredRoot;
  await assert.rejects(
    acquirePrivateGoToolchain({
      backendRoot,
      privateRoot,
      bootstrapRoot,
      bootstrapExecutable,
      runCommand: async (specification) => {
        if (specification.command === bootstrapExecutable) {
          acquiredRoot = path.join(
            specification.env.GOMODCACHE,
            "golang.org/toolchain@v0.0.1-go1.26.1.linux-amd64",
          );
          await fs.mkdir(path.join(acquiredRoot, "bin"), {
            recursive: true,
          });
          await fs.writeFile(path.join(acquiredRoot, "bin", "go"), "wrong version");
          return {
            stdout: `${acquiredRoot}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        return {
          stdout: "go version go1.26.0 linux/amd64\n",
          stderr: "",
          exitCode: 0,
        };
      },
    }),
    /requirement.*1\.26\.1|version.*1\.26\.1/i,
  );
  await assert.rejects(fs.access(bootstrapRoot), /ENOENT/);
});
