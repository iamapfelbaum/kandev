import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as runtimeBundle from "./runtime-host-bundle.mjs";

const {
  cleanupRuntimeHostFixture,
  initializeRuntimeHostBundle,
  preflightRuntimeHostPaths,
  prepareRuntimeHostBundle,
  reserveRuntimeHostBundle,
  snapshotRuntimeFile,
  verifyRuntimeCaptureArtifacts,
  verifyRuntimeCaptureTeardown,
  writeRuntimeApplicationReceipt,
  writeRuntimeHostOutcome,
  writeRuntimeWorkerResult,
} = runtimeBundle;

test("runtime host bundle reserves one immutable run and bounds snapshots", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-bundle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = await reserveRuntimeHostBundle({
    artifactRoot: root,
    runId: "run-bundle",
  });
  assert.equal(paths.bundleRoot, path.join(root, "runtime-host", "run-bundle"));
  await assert.rejects(
    reserveRuntimeHostBundle({ artifactRoot: root, runId: "run-bundle" }),
    /refusing to overwrite runtime host bundle/,
  );

  const evidencePath = path.join(paths.bundleRoot, "evidence.json");
  await fs.writeFile(evidencePath, "test");
  assert.equal((await snapshotRuntimeFile(evidencePath, "evidence")).bytes, 4);
  await assert.rejects(
    snapshotRuntimeFile(evidencePath, "evidence", { maxBytes: 3 }),
    /exceeds its 3-byte bound/,
  );
});

test("runtime host bundle keeps one deep evidence storage Interface", () => {
  for (const operation of [
    cleanupRuntimeHostFixture,
    initializeRuntimeHostBundle,
    preflightRuntimeHostPaths,
    prepareRuntimeHostBundle,
    verifyRuntimeCaptureArtifacts,
    verifyRuntimeCaptureTeardown,
    writeRuntimeApplicationReceipt,
    writeRuntimeHostOutcome,
    writeRuntimeWorkerResult,
  ]) {
    assert.equal(typeof operation, "function");
  }
});
