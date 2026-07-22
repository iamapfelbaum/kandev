import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runOwnedRuntimeProcess } from "./runtime-owned-process.mjs";

test("owned runtime process enforces its deadline and proves its process group gone", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "runtime-owned-process-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await runOwnedRuntimeProcess({
    command: {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
    },
    env: { PATH: process.env.PATH ?? "/usr/bin" },
    logPath: path.join(root, "process.log"),
    deadlineMs: 80,
    termGraceMs: 40,
    killGraceMs: 500,
    logLimitBytes: 1024,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.processGroup.termSent, true);
  assert.equal(result.processGroup.exited, true);
  assert.equal(result.processGroup.gone, true);
});

test("owned runtime process consumes output while bounding the preserved log", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-bounded-log-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const logPath = path.join(root, "process.log");
  const result = await runOwnedRuntimeProcess({
    command: {
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('x'.repeat(65536)); process.stderr.write('y'.repeat(65536))",
      ],
      cwd: root,
    },
    env: { PATH: process.env.PATH ?? "/usr/bin" },
    logPath,
    deadlineMs: 2_000,
    termGraceMs: 50,
    killGraceMs: 500,
    logLimitBytes: 1024,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.log.limitBytes, 1024);
  assert.equal(result.log.capturedBytes, 1024);
  assert.equal(result.log.truncated, true);
  assert(result.log.discardedBytes > 0);
  assert.equal((await fs.stat(logPath)).size, 1024);
});

test("owned runtime process removes surviving members after its leader exits", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "runtime-orphan-group-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const leafPidPath = path.join(root, "leaf.pid");
  let groupPid;
  t.after(() => {
    if (!groupPid) return;
    try {
      process.kill(-groupPid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
  const script = [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const leaf = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    `fs.writeFileSync(${JSON.stringify(leafPidPath)}, String(leaf.pid));`,
    "leaf.unref();",
  ].join("\n");
  const result = await runOwnedRuntimeProcess({
    command: {
      command: process.execPath,
      args: ["-e", script],
      cwd: root,
    },
    env: { PATH: process.env.PATH ?? "/usr/bin" },
    logPath: path.join(root, "process.log"),
    deadlineMs: 2_000,
    termGraceMs: 50,
    killGraceMs: 500,
    logLimitBytes: 1024,
  });
  groupPid = result.processGroup.pid;

  assert.equal(result.exitCode, 0);
  assert.equal(result.processGroup.termSent, true);
  assert.equal(result.processGroup.gone, true);
  const leafPid = Number(await fs.readFile(leafPidPath, "utf8"));
  assert.throws(() => process.kill(leafPid, 0), { code: "ESRCH" });
});

test("owned runtime process cleans its group when the parent receives a signal", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "runtime-parent-signal-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const signalSource = new EventEmitter();
  const running = runOwnedRuntimeProcess({
    command: {
      command: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      cwd: root,
    },
    env: { PATH: process.env.PATH ?? "/usr/bin" },
    logPath: path.join(root, "process.log"),
    deadlineMs: 5_000,
    termGraceMs: 40,
    killGraceMs: 500,
    logLimitBytes: 1024,
    signalSource,
  });
  setTimeout(() => signalSource.emit("SIGTERM"), 80);
  const result = await running;

  assert.equal(result.timedOut, false);
  assert.equal(result.processGroup.termSent, true);
  assert.equal(result.processGroup.killSent, true);
  assert.equal(result.processGroup.gone, true);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});
