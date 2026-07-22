import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import {
  assertExternalArtifactRoot,
  verifySourceGate,
} from "./source-gate.mjs";

const head = "1".repeat(40);
const main = "2".repeat(40);

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

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function gitRunner({ dirty = false, headSha = head, mainSha = main } = {}) {
  return async (_command, args) => {
    if (args.includes("status"))
      return { stdout: dirty ? " M tracked.txt\n" : "" };
    if (args.at(-1) === "HEAD") return { stdout: `${headSha}\n` };
    if (args.at(-1) === "origin/main") return { stdout: `${mainSha}\n` };
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  };
}

test("pr_head provenance records exact HEAD/current-main SHA and clean status", async () => {
  const result = await verifySourceGate({
    repoRoot: "/work/kandev",
    source: "pr_head",
    runner: gitRunner(),
  });
  assert.deepEqual(result, {
    contract: "kandev-highlight-source-v1",
    source: "pr_head",
    repoRoot: "/work/kandev",
    selectedSha: head,
    headSha: head,
    currentMainSha: main,
    clean: true,
    status: "",
  });
});

test("source capture digest has one strict canonical PR and current-main contract", async () => {
  const sourceGate = await import("./source-gate.mjs");
  assert.equal(typeof sourceGate.computeSourceCaptureDigest, "function");
  const prIdentity = {
    captureMode: "pr_head",
    sourceSha: head,
    prNumber: 42,
    prBaseSha: main,
    prHeadSha: head,
  };
  const mainIdentity = {
    captureMode: "current_main",
    sourceSha: main,
    sourceRef: "origin/main",
  };
  assert.equal(
    sourceGate.computeSourceCaptureDigest(prIdentity),
    digest(canonicalJson(prIdentity)),
  );
  assert.equal(
    sourceGate.computeSourceCaptureDigest(mainIdentity),
    digest(canonicalJson(mainIdentity)),
  );
  assert.throws(
    () =>
      sourceGate.computeSourceCaptureDigest({
        ...prIdentity,
        prHeadSha: main,
      }),
    /head.*source|source.*head/i,
  );
});

test("current_main requires checked-out HEAD equality and every mode requires clean tree", async () => {
  await assert.rejects(
    verifySourceGate({
      repoRoot: "/work/kandev",
      source: "current_main",
      runner: gitRunner(),
    }),
    /current_main.*HEAD.*origin\/main/i,
  );
  await assert.rejects(
    verifySourceGate({
      repoRoot: "/work/kandev",
      source: "pr_head",
      runner: gitRunner({ dirty: true }),
    }),
    /clean.*tracked\.txt/i,
  );
});

test("artifact root must be a narrow path external to all repositories", () => {
  const root = assertExternalArtifactRoot({
    artifactRoot: "/work/highlight-artifacts/take-123",
    repoRoots: ["/work/kandev", "/work/landing"],
  });
  assert.equal(root, path.resolve("/work/highlight-artifacts/take-123"));
  assert.throws(
    () =>
      assertExternalArtifactRoot({
        artifactRoot: "/work/kandev/.artifacts",
        repoRoots: ["/work/kandev"],
      }),
    /outside repository/i,
  );
  assert.throws(
    () =>
      assertExternalArtifactRoot({
        artifactRoot: "/",
        repoRoots: ["/work/kandev"],
      }),
    /unsafe artifact root/i,
  );
});
