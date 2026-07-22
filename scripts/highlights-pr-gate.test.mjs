import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runPrGate } from "./highlights-pr-gate.mjs";

test("unlabeled PR is exempt from Highlight checks", async () => {
  const result = await runPrGate({
    event: { action: "opened", pull_request: { labels: [], head: { sha: "a" }, base: { sha: "b" } } },
    changedFiles: [],
  });
  assert.equal(result.exempt, true);
});

test("approval label on a new PR head is invalidated", async () => {
  await assert.rejects(
    runPrGate({
      event: {
        action: "synchronize",
        pull_request: {
          labels: [{ name: "highlight:required" }, { name: "highlight:approved" }],
          head: { sha: "new" },
          base: { sha: "base" },
        },
      },
      changedFiles: [],
    }),
    /invalid after the PR head changed|stale/i,
  );
});

test("required approval needs a current SHA-pinned PR snippet", async () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  const event = {
    action: "opened",
    pull_request: {
      labels: [{ name: "highlight:required" }, { name: "highlight:approved" }],
      head: { sha: head },
      base: { sha: "fedcba9876543210fedcba9876543210fedcba98" },
      body: "No media link yet.",
    },
  };
  const validate = async () => ({
    count: 1,
    ids: ["cross-task-agent-communication"],
  });
  await assert.rejects(runPrGate({ event, changedFiles: [], validate }), /SHA-pinned snippet/i);

  event.pull_request.body = `<!-- highlight:cross-task-agent-communication head:${head} -->\nhttps://raw.githubusercontent.com/kdlbs/kandev/${head}/docs/public/media/highlights/cross-task-agent-communication/revisions/r1/desktop.mp4`;
  const result = await runPrGate({ event, changedFiles: [], validate });
  assert.equal(result.validation.count, 1);
});

test("required approval rejects a snippet for an unrelated Highlight", async () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  await assert.rejects(
    runPrGate({
      event: {
        action: "opened",
        pull_request: {
          labels: [{ name: "highlight:required" }, { name: "highlight:approved" }],
          head: { sha: head },
          base: { sha: "fedcba9876543210fedcba9876543210fedcba98" },
          body: `<!-- highlight:task-messaging head:${head} -->\nhttps://raw.githubusercontent.com/kdlbs/kandev/${head}/docs/public/media/highlights/task-messaging/revisions/r1/desktop.mp4`,
        },
      },
      changedFiles: [],
    }),
    /known Highlight|matching Highlight|snippet/i,
  );
});

test("workflow runs the gate from a trusted checkout, not PR-controlled code", async () => {
  const workflow = await fs.readFile(
    path.join(process.cwd(), ".github/workflows/highlights-gate.yml"),
    "utf8",
  );
  assert.match(workflow, /path: \.trusted-highlights-validator/);
  assert.match(workflow, /path: \.highlight-pr/);
  assert.match(workflow, /node \.\.\/\.trusted-highlights-validator\/scripts\/highlights-pr-gate\.mjs/);
  assert.doesNotMatch(workflow, /run: node scripts\/highlights-pr-gate\.mjs/);
});
