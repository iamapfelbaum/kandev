import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  prepareRuntimeTempNamespace,
  recoverRuntimeWorkerTemps,
  releaseRuntimeWorkerTemp,
  reserveRuntimeWorkerTemp,
  runtimeProcessStartToken,
  verifyRuntimeWorkerTemp,
} from "./runtime-temp.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp("/tmp/khrt-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const namespaceRoot = path.join(root, "n");
  return {
    root,
    namespace: await prepareRuntimeTempNamespace({ namespaceRoot }),
  };
}

test("long retained artifact roots use one serialized short real worker temp", async (t) => {
  const value = await fixture(t);
  const longArtifactRoot = path.join(
    value.root,
    ...Array.from({ length: 18 }, (_, index) => `retained-evidence-${index}`),
  );
  const lease = await reserveRuntimeWorkerTemp({
    namespace: value.namespace,
    runId: "fresh-agent-1",
    artifactRoot: longArtifactRoot,
  });
  t.after(() => releaseRuntimeWorkerTemp(lease).catch(() => {}));

  assert.equal(lease.contract, "kandev-highlight-runtime-temp-lease-v1");
  assert.equal(lease.version, 1);
  assert.equal(lease.namespaceRoot, value.namespace.namespaceRoot);
  assert.equal(lease.coordinateLockRoot, value.namespace.coordinateLockRoot);
  assert.equal(
    path.dirname(lease.workerTempRoot),
    value.namespace.namespaceRoot,
  );
  assert.notEqual(lease.workerTempRoot, longArtifactRoot);
  assert.ok(
    Buffer.byteLength(
      path.join(
        lease.workerTempRoot,
        "org.chromium.Chromium.XXXXXX",
        "SingletonSocket",
      ),
    ) < 108,
    "the worst known Chromium singleton socket path must fit sockaddr_un",
  );
  assert.equal((await fs.lstat(lease.workerTempRoot)).isSymbolicLink(), false);
  assert.equal(await fs.realpath(lease.workerTempRoot), lease.workerTempRoot);
  assert.equal((await verifyRuntimeWorkerTemp(lease)).verified, true);

  const serialized = JSON.parse(JSON.stringify(lease));
  assert.deepEqual(
    serialized,
    lease,
    "no ambient path recomputation is needed",
  );
});

test("worker temp leases are collision-safe and bind root/lock inode plus live owner", async (t) => {
  const value = await fixture(t);
  const input = {
    namespace: value.namespace,
    runId: "same-run",
    artifactRoot: path.join(value.root, "artifacts"),
  };
  const [first, second] = await Promise.all([
    reserveRuntimeWorkerTemp(input),
    reserveRuntimeWorkerTemp(input),
  ]);
  t.after(() => releaseRuntimeWorkerTemp(first).catch(() => {}));
  t.after(() => releaseRuntimeWorkerTemp(second).catch(() => {}));

  assert.notEqual(first.workerTempRoot, second.workerTempRoot);
  assert.notEqual(first.rootIdentity.ino, second.rootIdentity.ino);
  assert.match(first.leaseIdentity.digest, /^sha256:[a-f0-9]{64}$/);

  await assert.rejects(
    verifyRuntimeWorkerTemp(first, {
      processStartToken: async () => "different-live-process",
    }),
    /owner.*start token|live owner/i,
  );

  const replacement = `${first.leasePath}.replacement`;
  await fs.writeFile(replacement, "tampered\n", { flag: "wx" });
  await fs.rename(replacement, first.leasePath);
  await assert.rejects(
    verifyRuntimeWorkerTemp(first),
    /lease.*changed|inode|digest|tamper/i,
  );
  await assert.rejects(
    releaseRuntimeWorkerTemp(first),
    /lease.*changed|inode|digest|tamper/i,
  );
  assert.equal((await fs.lstat(first.workerTempRoot)).isDirectory(), true);
});

test("worker temp recovery is inspect-only and never deletes a dead or live lease", async (t) => {
  const value = await fixture(t);
  const dead = await reserveRuntimeWorkerTemp({
    namespace: value.namespace,
    runId: "dead-run",
    artifactRoot: path.join(value.root, "dead-artifacts"),
    owner: { pid: 999_999, startToken: "1234" },
    processStartToken: async () => "1234",
  });
  const live = await reserveRuntimeWorkerTemp({
    namespace: value.namespace,
    runId: "live-run",
    artifactRoot: path.join(value.root, "live-artifacts"),
  });
  t.after(() => releaseRuntimeWorkerTemp(live).catch(() => {}));

  const recovery = await recoverRuntimeWorkerTemps({
    namespace: value.namespace,
    processStartToken: async (pid) =>
      pid === process.pid ? runtimeProcessStartToken(pid) : null,
  });
  assert.deepEqual(recovery.removed, []);
  assert.deepEqual(recovery.live, [live.workerTempRoot]);
  assert.deepEqual(recovery.preserved, [dead.workerTempRoot]);
  assert.equal((await fs.lstat(dead.workerTempRoot)).isDirectory(), true);
  assert.equal((await fs.lstat(live.workerTempRoot)).isDirectory(), true);
});

test("pre-existing unsafe namespaces are rejected without mutating permissions", async (t) => {
  const root = await fs.mkdtemp("/tmp/khrt-unsafe-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const namespaceRoot = path.join(root, "n");
  await fs.mkdir(namespaceRoot, { mode: 0o755 });
  await fs.chmod(namespaceRoot, 0o755);

  await assert.rejects(
    prepareRuntimeTempNamespace({ namespaceRoot }),
    /group or world permissions|private/i,
  );
  assert.equal((await fs.lstat(namespaceRoot)).mode & 0o777, 0o755);
});

test("worker temp overrides cannot move the independent coordinate lock root", async (t) => {
  const root = await fs.mkdtemp("/tmp/khrt-scope-");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const namespaceRoot = path.join(root, "worker-namespace");
  const coordinateLockRoot = path.join(root, "global-coordinate-locks");
  const namespace = await prepareRuntimeTempNamespace({
    namespaceRoot,
    coordinateLockRoot,
  });

  assert.equal(namespace.namespaceRoot, namespaceRoot);
  assert.equal(namespace.coordinateLockRoot, coordinateLockRoot);
  assert.equal(path.dirname(namespace.coordinateLockRoot), root);
});

test("cleanup refuses a non-empty worker temp instead of traversing it", async (t) => {
  const value = await fixture(t);
  const lease = await reserveRuntimeWorkerTemp({
    namespace: value.namespace,
    runId: "non-empty",
    artifactRoot: path.join(value.root, "artifacts"),
  });
  const nested = path.join(lease.workerTempRoot, "browser-temp");
  await fs.mkdir(nested);
  const sentinel = path.join(nested, "ordinary.tmp");
  await fs.writeFile(sentinel, "temporary\n");

  await assert.rejects(
    releaseRuntimeWorkerTemp(lease),
    /non-empty|retained entries|refusing.*cleanup/i,
  );
  assert.equal(await fs.readFile(sentinel, "utf8"), "temporary\n");
  assert.equal((await fs.lstat(lease.workerTempRoot)).isDirectory(), true);
});

test("cleanup preserves an opened worker root renamed outside its namespace", async (t) => {
  const value = await fixture(t);
  const lease = await reserveRuntimeWorkerTemp({
    namespace: value.namespace,
    runId: "rename-race",
    artifactRoot: path.join(value.root, "artifacts"),
  });
  const moved = path.join(value.root, "renamed-worker-root");

  await assert.rejects(
    releaseRuntimeWorkerTemp(lease, {
      afterRootOpen: async () => {
        await fs.rename(lease.workerTempRoot, moved);
      },
    }),
    /root.*changed|renamed|tamper/i,
  );
  assert.equal((await fs.lstat(moved)).isDirectory(), true);
  assert.equal(
    (await fs.lstat(path.join(moved, "runtime-temp.lease.json"))).isFile(),
    true,
  );
});

test("rewriting a live lease owner can never authorize stale recovery", async (t) => {
  const value = await fixture(t);
  const lease = await reserveRuntimeWorkerTemp({
    namespace: value.namespace,
    runId: "forged-owner",
    artifactRoot: path.join(value.root, "artifacts"),
  });
  const body = JSON.parse(await fs.readFile(lease.leasePath, "utf8"));
  body.owner = { pid: 999_999, startToken: "1234" };
  await fs.writeFile(lease.leasePath, `${JSON.stringify(body, null, 2)}\n`);

  const recovery = await recoverRuntimeWorkerTemps({
    namespace: value.namespace,
    processStartToken: async () => null,
  });
  assert.deepEqual(recovery.removed, []);
  assert.deepEqual(recovery.preserved, [lease.workerTempRoot]);
  assert.equal((await fs.lstat(lease.workerTempRoot)).isDirectory(), true);
});
