import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  beginPromotionTransaction,
  markPromotionPrepared,
  recoverPromotionTransaction,
} from "./stage-promotion-transaction.mjs";
import { promoteStagedHighlight } from "./stage.mjs";
import { createStage, probeFixture } from "./stage.test-fixtures.mjs";

const OWNER = { pid: 2_147_483_647, startToken: "1" };

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function fileProof(filePath, bytes) {
  return {
    path: filePath,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function writeCandidate(
  transaction,
  { revision, sourceDigest, previous } = {},
) {
  const candidate = path.join(transaction.root, "catalog", "demo");
  if (previous) {
    await fs.cp(previous, candidate, { recursive: true });
  } else {
    await fs.mkdir(path.join(candidate, "revisions"), {
      recursive: true,
    });
  }
  const revisionDir = path.join(candidate, "revisions", revision);
  await fs.mkdir(revisionDir, { recursive: true });
  const payload = Buffer.from(`payload-${revision}`);
  await fs.writeFile(path.join(revisionDir, "payload.bin"), payload);
  const priorDescriptor = previous
    ? JSON.parse(
        await fs.readFile(path.join(previous, "highlight.json"), "utf8"),
      )
    : null;
  const descriptor = {
    source_digest: sourceDigest,
    revision_history: [
      ...(priorDescriptor?.revision_history ?? []),
      {
        revision,
        files: [fileProof(`revisions/${revision}/payload.bin`, payload)],
      },
    ],
  };
  await fs.writeFile(
    path.join(candidate, "highlight.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
  await markPromotionPrepared(transaction, sourceDigest);
  return candidate;
}

async function transactionFixture(
  t,
  {
    revision = "r1",
    preimageSourceDigest = null,
    previous,
    sourceDigest = digest("1"),
  } = {},
) {
  const highlightsDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "highlight-promotion-checkpoint-"),
  );
  t.after(() => fs.rm(highlightsDir, { recursive: true, force: true }));
  if (previous) {
    await fs.cp(previous, path.join(highlightsDir, "demo"), {
      recursive: true,
    });
  }
  const transaction = await beginPromotionTransaction({
    highlightsDir,
    highlightId: "demo",
    revision,
    stageDigest: digest("a"),
    key: digest("b"),
    preimageSourceDigest,
    owner: OWNER,
    now: "2026-07-22T12:00:00.000Z",
  });
  const candidate = await writeCandidate(transaction, {
    revision,
    sourceDigest,
    previous: previous ? path.join(highlightsDir, "demo") : null,
  });
  return {
    highlightsDir,
    transaction,
    candidate,
    destination: path.join(highlightsDir, "demo"),
  };
}

const treeDigest = async (root) =>
  JSON.parse(await fs.readFile(path.join(root, "highlight.json"), "utf8"))
    .source_digest;
const validateCatalog = async () => ({ count: 1 });

test("new destination installed before journal update recovers idempotently", async (t) => {
  const fixture = await transactionFixture(t);
  await assert.rejects(
    recoverPromotionTransaction({
      ...fixture,
      highlightId: "demo",
      computeTreeDigest: treeDigest,
      validateCatalog,
      operations: {
        rename: async (source, destination) => {
          await fs.rename(source, destination);
          if (destination === fixture.destination) {
            throw new Error("hard-stop after destination install");
          }
        },
      },
    }),
    /hard-stop/,
  );
  await fs.access(path.join(fixture.destination, "highlight.json"));

  const recovered = await recoverPromotionTransaction({
    highlightsDir: fixture.highlightsDir,
    highlightId: "demo",
    computeTreeDigest: treeDigest,
    validateCatalog,
  });
  assert.equal(recovered.recovered, true);
  await assert.rejects(fs.access(fixture.transaction.root), /ENOENT/);
});

test("failed private temp copy leaves no live-tree residue and retries", async (t) => {
  const fixture = await transactionFixture(t);
  await assert.rejects(
    recoverPromotionTransaction({
      highlightsDir: fixture.highlightsDir,
      highlightId: "demo",
      computeTreeDigest: treeDigest,
      validateCatalog,
      operations: {
        copyTree: async (source, destination, options) => {
          await fs.cp(source, destination, options);
          throw new Error("hard-stop during private copy");
        },
      },
    }),
    /hard-stop/,
  );
  await assert.rejects(fs.access(fixture.destination), /ENOENT/);

  const recovered = await recoverPromotionTransaction({
    highlightsDir: fixture.highlightsDir,
    highlightId: "demo",
    computeTreeDigest: treeDigest,
    validateCatalog,
  });
  assert.equal(recovered.recovered, true);
});

test("descriptor installed before journal update recovers existing history", async (t) => {
  const first = await transactionFixture(t);
  await recoverPromotionTransaction({
    highlightsDir: first.highlightsDir,
    highlightId: "demo",
    computeTreeDigest: treeDigest,
    validateCatalog,
  });
  const previous = await fs.mkdtemp(
    path.join(os.tmpdir(), "highlight-promotion-previous-"),
  );
  t.after(() => fs.rm(previous, { recursive: true, force: true }));
  await fs.cp(first.destination, path.join(previous, "demo"), {
    recursive: true,
  });
  const second = await transactionFixture(t, {
    revision: "r2",
    preimageSourceDigest: digest("1"),
    previous: path.join(previous, "demo"),
    sourceDigest: digest("2"),
  });
  const descriptorPath = path.join(second.destination, "highlight.json");
  await assert.rejects(
    recoverPromotionTransaction({
      highlightsDir: second.highlightsDir,
      highlightId: "demo",
      computeTreeDigest: treeDigest,
      validateCatalog,
      operations: {
        rename: async (source, destination) => {
          await fs.rename(source, destination);
          if (destination === descriptorPath) {
            throw new Error("hard-stop after descriptor install");
          }
        },
      },
    }),
    /hard-stop/,
  );
  assert.equal(await treeDigest(second.destination), digest("2"));

  const recovered = await recoverPromotionTransaction({
    highlightsDir: second.highlightsDir,
    highlightId: "demo",
    computeTreeDigest: treeDigest,
    validateCatalog,
  });
  assert.equal(recovered.descriptor.revision_history.length, 2);
});

test("partial initializing journal is discarded before promotion", async (t) => {
  const fixture = await createStage();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const initializing = path.join(
    fixture.highlightsDir,
    ".promote-stage-demo.txn.init-partial",
  );
  await fs.mkdir(initializing, { recursive: true });
  await fs.writeFile(
    path.join(
      initializing,
      ".transaction.00000000-0000-0000-0000-000000000000.tmp",
    ),
    '{"contract":',
  );

  const result = await promoteStagedHighlight({
    manifestPath: fixture.manifestPath,
    repoRoot: fixture.repoRoot,
    highlightsDir: fixture.highlightsDir,
    probe: probeFixture,
  });
  assert.equal(result.descriptor.id, "stage-demo");
  await assert.rejects(fs.access(initializing), /ENOENT/);
});

test("detached cleanup residue cannot block retry or delete foreign content", async (t) => {
  const fixture = await createStage();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const first = await promoteStagedHighlight({
    manifestPath: fixture.manifestPath,
    repoRoot: fixture.repoRoot,
    highlightsDir: fixture.highlightsDir,
    probe: probeFixture,
  });
  const tombstone = path.join(
    fixture.highlightsDir,
    "_transactions",
    "foreign-hard-stop",
  );
  await fs.mkdir(tombstone, { recursive: true });
  await fs.writeFile(path.join(tombstone, "partial"), "cleanup residue");

  const recovered = await promoteStagedHighlight({
    manifestPath: fixture.manifestPath,
    repoRoot: fixture.repoRoot,
    highlightsDir: fixture.highlightsDir,
    probe: probeFixture,
  });
  assert.equal(recovered.recovered, true);
  assert.equal(
    recovered.descriptor.source_digest,
    first.descriptor.source_digest,
  );
  assert.equal(
    await fs.readFile(path.join(tombstone, "partial"), "utf8"),
    "cleanup residue",
  );
});

test("idempotent retry refuses a symlinked private validation root", async (t) => {
  const fixture = await createStage();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  await promoteStagedHighlight({
    manifestPath: fixture.manifestPath,
    repoRoot: fixture.repoRoot,
    highlightsDir: fixture.highlightsDir,
    probe: probeFixture,
  });
  const privateRoot = path.join(fixture.highlightsDir, "_transactions");
  await fs.rmdir(privateRoot);
  const outside = path.join(fixture.base, "foreign-validation-root");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "sentinel"), "preserve");
  await fs.symlink(outside, privateRoot);

  await assert.rejects(
    promoteStagedHighlight({
      manifestPath: fixture.manifestPath,
      repoRoot: fixture.repoRoot,
      highlightsDir: fixture.highlightsDir,
      probe: probeFixture,
    }),
    /validation root.*(?:symlink|canonical)|symlink.*validation root/i,
  );
  assert.equal(
    await fs.readFile(path.join(outside, "sentinel"), "utf8"),
    "preserve",
  );
});
