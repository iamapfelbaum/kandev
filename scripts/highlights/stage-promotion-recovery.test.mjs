import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { promoteStagedHighlight } from "./stage.mjs";
import { createStage, probeFixture } from "./stage.test-fixtures.mjs";

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digestValue(value) {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

async function interruptedRevisionPromotion() {
  const first = await createStage({ revision: "r1" });
  await promoteStagedHighlight({
    manifestPath: first.manifestPath,
    repoRoot: first.repoRoot,
    highlightsDir: first.highlightsDir,
    probe: probeFixture,
    now: "2026-07-22T12:00:00.000Z",
  });
  const second = await createStage({
    revision: "r2",
    existing: first,
    payloadSuffix: "-r2",
  });
  const destination = path.join(first.highlightsDir, "stage-demo");
  const scratchHighlights = path.join(first.base, "scratch-highlights");
  await fs.mkdir(scratchHighlights);
  await fs.cp(destination, path.join(scratchHighlights, "stage-demo"), {
    recursive: true,
  });
  const completed = await promoteStagedHighlight({
    manifestPath: second.manifestPath,
    repoRoot: first.repoRoot,
    highlightsDir: scratchHighlights,
    probe: probeFixture,
    now: "2026-07-22T13:00:00.000Z",
  });
  const transactionRoot = path.join(
    first.highlightsDir,
    ".promote-stage-demo.txn",
  );
  const candidate = path.join(transactionRoot, "candidate");
  await fs.mkdir(transactionRoot);
  await fs.cp(completed.destination, candidate, { recursive: true });
  await fs.cp(
    path.join(candidate, "revisions/r2"),
    path.join(destination, "revisions/r2"),
    { recursive: true },
  );
  const previous = JSON.parse(
    await fs.readFile(path.join(destination, "highlight.json"), "utf8"),
  );
  const next = JSON.parse(
    await fs.readFile(path.join(candidate, "highlight.json"), "utf8"),
  );
  const journalBody = {
    contract: "kandev-highlight-promotion-transaction-v1",
    highlightId: "stage-demo",
    revision: "r2",
    stageDigest: second.manifest.stageDigest,
    promotionKey: second.manifest.stageDigest,
    destination: "stage-demo",
    candidate: "candidate",
    phase: "revision_published",
    preimageSourceDigest: previous.source_digest,
    candidateSourceDigest: next.source_digest,
    owner: { pid: 2_147_483_647, startToken: "1" },
    createdAt: "2026-07-22T13:00:00.000Z",
  };
  await fs.writeFile(
    path.join(transactionRoot, "transaction.json"),
    `${JSON.stringify(
      { ...journalBody, recordDigest: digestValue(journalBody) },
      null,
      2,
    )}\n`,
  );
  return { first, second, destination, transactionRoot };
}

test("retry finalizes a journal-bound published revision without losing prior history", async () => {
  const fixture = await interruptedRevisionPromotion();
  const oldMedia = await fs.readFile(
    path.join(fixture.destination, "revisions/r1/desktop.mp4"),
  );

  const result = await promoteStagedHighlight({
    manifestPath: fixture.second.manifestPath,
    repoRoot: fixture.first.repoRoot,
    highlightsDir: fixture.first.highlightsDir,
    probe: probeFixture,
    now: "2026-07-22T14:00:00.000Z",
  });

  assert.equal(result.recovered, true);
  assert.equal(result.descriptor.active_revision, "r2");
  assert.deepEqual(
    result.descriptor.revision_history.map(({ revision }) => revision),
    ["r1", "r2"],
  );
  assert.deepEqual(
    await fs.readFile(
      path.join(fixture.destination, "revisions/r1/desktop.mp4"),
    ),
    oldMedia,
  );
  await fs.access(path.join(fixture.destination, "revisions/r2/desktop.mp4"));
  await assert.rejects(fs.access(fixture.transactionRoot), /ENOENT/);
  await assert.rejects(
    fs.access(
      path.join(fixture.first.highlightsDir, ".promote-stage-demo.lock"),
    ),
    /ENOENT/,
  );
});

test("retry fails closed and preserves a tampered journal-bound orphan revision", async () => {
  const fixture = await interruptedRevisionPromotion();
  const tampered = path.join(fixture.destination, "revisions/r2/desktop.mp4");
  await fs.appendFile(tampered, "tampered");

  await assert.rejects(
    promoteStagedHighlight({
      manifestPath: fixture.second.manifestPath,
      repoRoot: fixture.first.repoRoot,
      highlightsDir: fixture.first.highlightsDir,
      probe: probeFixture,
    }),
    /transaction|(?:revision|candidate).*(?:digest|hash|bytes)|tamper/i,
  );
  assert.match(await fs.readFile(tampered, "utf8"), /tampered$/);
  await fs.access(fixture.transactionRoot);
  const descriptor = JSON.parse(
    await fs.readFile(path.join(fixture.destination, "highlight.json"), "utf8"),
  );
  assert.equal(descriptor.active_revision, "r1");
});
