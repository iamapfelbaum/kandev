import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const CONTRACT = "kandev-highlight-promotion-transaction-v1";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PHASES = new Set([
  "building",
  "prepared",
  "revision_published",
  "installed",
]);

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

function safeRelative(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").includes("..")
  ) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return value;
}

async function regularDirectory(directory, label) {
  const absolute = path.resolve(directory);
  const stat = await fs.lstat(absolute).catch(() => null);
  if (
    !stat?.isDirectory() ||
    stat.isSymbolicLink() ||
    (await fs.realpath(absolute)) !== absolute
  ) {
    throw new Error(`${label} must be a canonical non-symlink directory`);
  }
  return absolute;
}

async function regularFile(filePath, label) {
  const absolute = path.resolve(filePath);
  const stat = await fs.lstat(absolute).catch(() => null);
  if (
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    (await fs.realpath(absolute)) !== absolute
  ) {
    throw new Error(`${label} must be a canonical regular file`);
  }
  return { path: absolute, stat };
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncPromotionTree(root) {
  await regularDirectory(root, "promotion tree");
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`promotion tree contains symlink: ${target}`);
      }
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) await syncFile(target);
      else
        throw new Error(`promotion tree contains unsupported entry: ${target}`);
    }
    await syncDirectory(directory);
  }
  await visit(path.resolve(root));
}

function journalSource(journal) {
  const { recordDigest: _recordDigest, ...source } = journal;
  return source;
}

function validateJournal(journal, highlightId) {
  const source = journalSource(journal ?? {});
  const allowed = new Set([
    "contract",
    "highlightId",
    "revision",
    "stageDigest",
    "promotionKey",
    "destination",
    "candidate",
    "phase",
    "preimageSourceDigest",
    "candidateSourceDigest",
    "owner",
    "createdAt",
  ]);
  if (
    Object.keys(source).some((key) => !allowed.has(key)) ||
    source.contract !== CONTRACT ||
    source.highlightId !== highlightId ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(source.revision ?? "") ||
    !DIGEST_PATTERN.test(source.stageDigest ?? "") ||
    !DIGEST_PATTERN.test(source.promotionKey ?? "") ||
    safeRelative(source.destination, "promotion destination") !== highlightId ||
    !safeRelative(source.candidate, "promotion candidate") ||
    !PHASES.has(source.phase) ||
    !(
      source.preimageSourceDigest === null ||
      DIGEST_PATTERN.test(source.preimageSourceDigest ?? "")
    ) ||
    !(
      source.candidateSourceDigest === null ||
      DIGEST_PATTERN.test(source.candidateSourceDigest ?? "")
    ) ||
    !Number.isInteger(source.owner?.pid) ||
    source.owner.pid < 1 ||
    !/^\d+$/.test(source.owner?.startToken ?? "") ||
    !Number.isFinite(Date.parse(source.createdAt ?? "")) ||
    journal.recordDigest !== digestValue(source)
  ) {
    throw new Error("promotion transaction journal is malformed or tampered");
  }
  return source;
}

async function writeJournal(
  transactionRoot,
  source,
  { exclusive = false } = {},
) {
  const journal = { ...source, recordDigest: digestValue(source) };
  const destination = path.join(transactionRoot, "transaction.json");
  const temporary = path.join(
    transactionRoot,
    `.transaction.${randomUUID()}.tmp`,
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (exclusive) {
    try {
      await fs.link(temporary, destination);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  } else {
    await fs.rename(temporary, destination);
  }
  await syncDirectory(transactionRoot);
  return source;
}

export function promotionKey(manifest) {
  if (!manifest?.acceptance) return manifest?.stageDigest;
  return digestValue({
    highlightId: manifest.highlight?.id,
    revision: manifest.revision,
    acceptedBy: manifest.acceptance.acceptedBy,
    desktopReviewDigest: manifest.acceptance.desktopReviewDigest,
    mobileReviewDigest: manifest.acceptance.mobileReviewDigest ?? null,
  });
}

export function descriptorPromotionKey(descriptor) {
  const acceptance = descriptor?.provenance?.acceptance;
  if (!acceptance) return descriptor?.provenance?.stage_digest;
  return digestValue({
    highlightId: descriptor.id,
    revision: descriptor.active_revision,
    acceptedBy: acceptance.accepted_by,
    desktopReviewDigest: acceptance.desktop_review_digest,
    mobileReviewDigest: acceptance.mobile_review_digest ?? null,
  });
}

export function transactionRootFor(highlightsDir, highlightId) {
  return path.join(highlightsDir, `.promote-${highlightId}.txn`);
}

export async function beginPromotionTransaction({
  highlightsDir,
  highlightId,
  revision,
  stageDigest,
  key,
  preimageSourceDigest,
  owner,
  now,
} = {}) {
  const root = transactionRootFor(highlightsDir, highlightId);
  const initializing = await fs.mkdtemp(
    path.join(highlightsDir, `.promote-${highlightId}.txn.init-`),
  );
  try {
    const source = {
      contract: CONTRACT,
      highlightId,
      revision,
      stageDigest,
      promotionKey: key,
      destination: highlightId,
      candidate: `catalog/${highlightId}`,
      phase: "building",
      preimageSourceDigest: preimageSourceDigest ?? null,
      candidateSourceDigest: null,
      owner: { pid: owner.pid, startToken: owner.startToken },
      createdAt: new Date(now).toISOString(),
    };
    await writeJournal(initializing, source, { exclusive: true });
    await fs.rename(initializing, root);
    await syncDirectory(highlightsDir);
    return { root, journal: source };
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
      throw new Error(`promotion transaction already exists: ${root}`, {
        cause: error,
      });
    }
    throw error;
  }
}

export async function markPromotionPrepared(
  transaction,
  candidateSourceDigest,
) {
  const journal = {
    ...transaction.journal,
    phase: "prepared",
    candidateSourceDigest,
  };
  await writeJournal(transaction.root, journal);
  transaction.journal = journal;
  return transaction;
}

export async function abortBuildingPromotionTransaction(
  transaction,
  highlightsDir,
) {
  if (transaction?.journal?.phase !== "building") return false;
  await removeTransaction(transaction.root, highlightsDir);
  return true;
}

async function readDescriptor(filePath, label) {
  await regularFile(filePath, label);
  let value;
  try {
    value = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
  if (!DIGEST_PATTERN.test(value?.source_digest ?? "")) {
    throw new Error(`${label} needs a source digest`);
  }
  return value;
}

async function hashFile(filePath) {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

async function revisionFiles(root) {
  await regularDirectory(root, "promotion revision");
  const result = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(root, target).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        throw new Error(`promotion revision contains symlink: ${relative}`);
      }
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        const stat = await fs.lstat(target);
        result.push({
          relative,
          bytes: stat.size,
          sha256: await hashFile(target),
        });
      } else {
        throw new Error(
          `promotion revision contains unsupported entry: ${relative}`,
        );
      }
    }
  }
  await visit(root);
  return result;
}

async function verifyPublishedRevision(destination, descriptor, revision) {
  const history = descriptor.revision_history?.find(
    (entry) => entry.revision === revision,
  );
  if (!history || !Array.isArray(history.files)) {
    throw new Error(
      `promotion transaction revision ${revision} has no file proof`,
    );
  }
  const prefix = `revisions/${revision}/`;
  const expected = history.files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({
      relative: file.path.slice(prefix.length),
      bytes: file.bytes,
      sha256: file.sha256,
    }))
    .sort((left, right) => left.relative.localeCompare(right.relative));
  const actual = await revisionFiles(
    path.join(destination, "revisions", revision),
  );
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(
      `promotion transaction revision ${revision} digest, bytes, or file tree changed`,
    );
  }
}

async function existingSourceDigest(destination, computeTreeDigest) {
  const stat = await fs.lstat(destination).catch(() => null);
  if (!stat) return null;
  await regularDirectory(destination, "Highlight promotion destination");
  const descriptor = await readDescriptor(
    path.join(destination, "highlight.json"),
    "Highlight promotion descriptor",
  );
  const computed = await computeTreeDigest(destination);
  if (computed !== descriptor.source_digest) {
    throw new Error("promotion transaction destination content digest changed");
  }
  return computed;
}

async function removeTransaction(root, highlightsDir, operations = {}) {
  await regularDirectory(root, "promotion transaction");
  const tombstoneRoot = path.join(highlightsDir, "_transactions");
  await fs.mkdir(tombstoneRoot, { recursive: true, mode: 0o700 });
  await regularDirectory(tombstoneRoot, "promotion transaction tombstone root");
  const tombstone = path.join(
    tombstoneRoot,
    `${path.basename(root)}.gc-${randomUUID()}`,
  );
  await (operations.rename ?? fs.rename)(root, tombstone);
  await Promise.all([
    syncDirectory(highlightsDir),
    syncDirectory(tombstoneRoot),
  ]);
  try {
    await (operations.removeTree ?? fs.rm)(tombstone, {
      recursive: true,
      force: true,
    });
    await syncDirectory(tombstoneRoot);
  } catch {
    // The atomically detached transaction remains under the catalog-ignored
    // tombstone root. Never prefix-scan it: ownership cannot be proved after
    // a crash, so ambiguous residue is preserved.
  }
}

async function readRecoverableJournal(root, highlightId) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const canonical = entries.find(({ name }) => name === "transaction.json");
  if (canonical) {
    await regularFile(
      path.join(root, canonical.name),
      "promotion transaction journal",
    );
    return validateJournal(
      JSON.parse(await fs.readFile(path.join(root, canonical.name), "utf8")),
      highlightId,
    );
  }
  const temporary = entries.filter(({ name }) =>
    /^\.transaction\.[0-9a-f-]+\.tmp$/.test(name),
  );
  if (temporary.length === 0 && entries.length === 0) return null;
  if (temporary.length !== 1 || entries.length !== 1) {
    throw new Error("promotion transaction has no unambiguous durable journal");
  }
  const temporaryPath = path.join(root, temporary[0].name);
  await regularFile(temporaryPath, "promotion transaction temporary journal");
  const journal = validateJournal(
    JSON.parse(await fs.readFile(temporaryPath, "utf8")),
    highlightId,
  );
  if (journal.phase !== "building") {
    throw new Error(
      "unpublished promotion transaction journal must still be building",
    );
  }
  await fs.rename(temporaryPath, path.join(root, "transaction.json"));
  await syncDirectory(root);
  return journal;
}

async function loadTransaction(highlightsDir, highlightId) {
  const root = transactionRootFor(highlightsDir, highlightId);
  const stat = await fs.lstat(root).catch(() => null);
  const prefix = `.promote-${highlightId}.txn.init-`;
  const initializing = (
    await fs.readdir(highlightsDir, {
      withFileTypes: true,
    })
  ).filter(({ name }) => name.startsWith(prefix));
  if (initializing.length > 1 || (stat && initializing.length > 0)) {
    throw new Error("promotion transaction initialization state is ambiguous");
  }
  if (!stat && initializing.length === 0) return null;
  if (!stat) {
    const initializingRoot = path.join(highlightsDir, initializing[0].name);
    await regularDirectory(
      initializingRoot,
      "initializing promotion transaction",
    );
    let journal;
    try {
      journal = await readRecoverableJournal(initializingRoot, highlightId);
    } catch {
      await fs.rm(initializingRoot, { recursive: true, force: true });
      await syncDirectory(highlightsDir);
      return null;
    }
    if (!journal) {
      await fs.rmdir(initializingRoot);
      await syncDirectory(highlightsDir);
      return null;
    }
    await fs.rename(initializingRoot, root);
    await syncDirectory(highlightsDir);
    return { root, journal };
  }
  await regularDirectory(root, "promotion transaction");
  const journal = await readRecoverableJournal(root, highlightId);
  if (!journal) {
    await fs.rmdir(root);
    await syncDirectory(highlightsDir);
    return null;
  }
  return { root, journal };
}

async function finishBuildingTransaction(
  transaction,
  destination,
  highlightsDir,
  computeTreeDigest,
) {
  const digest = await existingSourceDigest(destination, computeTreeDigest);
  if (digest !== transaction.journal.preimageSourceDigest) {
    throw new Error(
      "building promotion transaction destination preimage changed",
    );
  }
  await removeTransaction(transaction.root, highlightsDir);
  return null;
}

async function installPreparedTransaction(transaction, context) {
  const {
    highlightsDir,
    destination,
    computeTreeDigest,
    operations = {},
  } = context;
  const copyTree = operations.copyTree ?? fs.cp;
  const copyFile = operations.copyFile ?? fs.copyFile;
  const rename = operations.rename ?? fs.rename;
  const journal = transaction.journal;
  const candidate = path.join(transaction.root, journal.candidate);
  const candidateDescriptor = await readDescriptor(
    path.join(candidate, "highlight.json"),
    "promotion candidate descriptor",
  );
  if (candidateDescriptor.source_digest !== journal.candidateSourceDigest) {
    throw new Error("promotion candidate source digest changed");
  }
  if ((await computeTreeDigest(candidate)) !== journal.candidateSourceDigest) {
    throw new Error("promotion candidate content digest changed");
  }
  const destinationStat = await fs.lstat(destination).catch(() => null);
  let currentDigest = null;
  if (destinationStat) {
    await regularDirectory(destination, "Highlight promotion destination");
    const currentDescriptor = await readDescriptor(
      path.join(destination, "highlight.json"),
      "Highlight promotion descriptor",
    );
    currentDigest = currentDescriptor.source_digest;
    if (currentDigest === journal.candidateSourceDigest) {
      if ((await computeTreeDigest(destination)) !== currentDigest) {
        throw new Error(
          "promotion transaction destination content digest changed",
        );
      }
    } else if (currentDigest === journal.preimageSourceDigest) {
      const publishedRevision = path.join(
        destination,
        "revisions",
        journal.revision,
      );
      const published = await fs.lstat(publishedRevision).catch(() => null);
      if (published) {
        await verifyPublishedRevision(
          destination,
          candidateDescriptor,
          journal.revision,
        );
      }
      const preimageCheck = path.join(
        transaction.root,
        `.preimage-${randomUUID()}`,
      );
      try {
        await fs.cp(destination, preimageCheck, {
          recursive: true,
          force: false,
          errorOnExist: true,
          mode: fsConstants.COPYFILE_FICLONE,
        });
        if (published) {
          await fs.rm(path.join(preimageCheck, "revisions", journal.revision), {
            recursive: true,
          });
        }
        if ((await computeTreeDigest(preimageCheck)) !== currentDigest) {
          throw new Error(
            "promotion transaction destination preimage content changed",
          );
        }
      } finally {
        await fs.rm(preimageCheck, { recursive: true, force: true });
      }
    }
  }
  if (currentDigest === journal.candidateSourceDigest)
    return candidateDescriptor;
  if (currentDigest !== journal.preimageSourceDigest) {
    throw new Error("promotion transaction destination preimage changed");
  }
  if (currentDigest === null) {
    await syncPromotionTree(candidate);
    const install = path.join(transaction.root, `.install-${randomUUID()}`);
    await copyTree(candidate, install, {
      recursive: true,
      force: false,
      errorOnExist: true,
      mode: fsConstants.COPYFILE_FICLONE,
    });
    await syncPromotionTree(install);
    await rename(install, destination);
    await syncDirectory(highlightsDir);
  } else {
    const candidateRevision = path.join(
      candidate,
      "revisions",
      journal.revision,
    );
    const publishedRevision = path.join(
      destination,
      "revisions",
      journal.revision,
    );
    const published = await fs.lstat(publishedRevision).catch(() => null);
    if (!published) {
      await syncPromotionTree(candidateRevision);
      const revisionInstall = path.join(
        transaction.root,
        `.revision-${journal.revision}-${randomUUID()}.install`,
      );
      await copyTree(candidateRevision, revisionInstall, {
        recursive: true,
        force: false,
        errorOnExist: true,
        mode: fsConstants.COPYFILE_FICLONE,
      });
      await syncPromotionTree(revisionInstall);
      await rename(revisionInstall, publishedRevision);
      await syncDirectory(path.dirname(publishedRevision));
    }
    await verifyPublishedRevision(
      destination,
      candidateDescriptor,
      journal.revision,
    );
    const revisionJournal = {
      ...journal,
      phase: "revision_published",
    };
    await writeJournal(transaction.root, revisionJournal);
    transaction.journal = revisionJournal;
    const candidateDescriptorPath = path.join(candidate, "highlight.json");
    const descriptorInstall = path.join(
      transaction.root,
      `.highlight.${randomUUID()}.install`,
    );
    await copyFile(
      candidateDescriptorPath,
      descriptorInstall,
      fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE,
    );
    await syncFile(descriptorInstall);
    await rename(descriptorInstall, path.join(destination, "highlight.json"));
    await syncDirectory(destination);
  }
  const installedJournal = {
    ...transaction.journal,
    phase: "installed",
  };
  await writeJournal(transaction.root, installedJournal);
  transaction.journal = installedJournal;
  return candidateDescriptor;
}

export async function recoverPromotionTransaction({
  highlightsDir,
  highlightId,
  validateCatalog,
  computeTreeDigest,
  operations,
} = {}) {
  const transaction = await loadTransaction(highlightsDir, highlightId);
  if (!transaction) return null;
  const destination = path.join(highlightsDir, highlightId);
  if (transaction.journal.phase === "building") {
    return finishBuildingTransaction(
      transaction,
      destination,
      highlightsDir,
      computeTreeDigest,
    );
  }
  const descriptor = await installPreparedTransaction(transaction, {
    highlightsDir,
    destination,
    computeTreeDigest,
    operations,
  });
  const actual = await readDescriptor(
    path.join(destination, "highlight.json"),
    "installed Highlight descriptor",
  );
  if (actual.source_digest !== transaction.journal.candidateSourceDigest) {
    throw new Error("installed promotion transaction source digest changed");
  }
  if (
    (await computeTreeDigest(destination)) !==
    transaction.journal.candidateSourceDigest
  ) {
    throw new Error("installed promotion transaction content digest changed");
  }
  const validation = await validateCatalog({
    destination,
    transactionRoot: transaction.root,
  });
  await removeTransaction(transaction.root, highlightsDir, operations);
  return {
    descriptor,
    destination,
    stageDigest: transaction.journal.stageDigest,
    promotionKey: transaction.journal.promotionKey,
    validation,
    recovered: true,
  };
}
