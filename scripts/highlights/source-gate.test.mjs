import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { assertExternalArtifactRoot, verifySourceGate } from "./source-gate.mjs";

const head = "1".repeat(40);
const main = "2".repeat(40);

function gitRunner({ dirty = false, headSha = head, mainSha = main } = {}) {
  return async (_command, args) => {
    if (args.includes("status")) return { stdout: dirty ? " M tracked.txt\n" : "" };
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

test("current_main requires checked-out HEAD equality and every mode requires clean tree", async () => {
  await assert.rejects(
    verifySourceGate({ repoRoot: "/work/kandev", source: "current_main", runner: gitRunner() }),
    /current_main.*HEAD.*origin\/main/i,
  );
  await assert.rejects(
    verifySourceGate({ repoRoot: "/work/kandev", source: "pr_head", runner: gitRunner({ dirty: true }) }),
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
    () => assertExternalArtifactRoot({ artifactRoot: "/work/kandev/.artifacts", repoRoots: ["/work/kandev"] }),
    /outside repository/i,
  );
  assert.throws(
    () => assertExternalArtifactRoot({ artifactRoot: "/", repoRoots: ["/work/kandev"] }),
    /unsafe artifact root/i,
  );
});
