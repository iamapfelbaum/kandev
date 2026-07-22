import { constants as fsConstants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  computeSourceDigest,
  parseHighlightDescriptor,
  validateHighlights,
} from "../highlights.mjs";
import {
  computeScenarioDigest,
  readScenario,
} from "./scenario.mjs";

export const STAGE_MANIFEST_VERSION = 1;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const ADAPTER_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ASSET_KEYS = ["webm", "mp4", "poster"];
const ASSET_EXTENSIONS = { webm: ".webm", mp4: ".mp4", poster: ".webp" };
const ASSET_NAMES = { webm: "webm", mp4: "mp4", poster: "webp" };

export function computeStageManifestDigest(manifest) {
  if (!isObject(manifest)) throw new Error("stage manifest must be an object");
  const source = structuredClone(manifest);
  delete source.stageDigest;
  return `sha256:${createHash("sha256").update(canonicalJson(source)).digest("hex")}`;
}

export async function readStageManifest(manifestPath, {
  repoRoot = process.cwd(),
  allowedExtensionIds = [],
} = {}) {
  const absoluteManifest = path.resolve(manifestPath);
  const stageDir = path.dirname(absoluteManifest);
  const stageRealDir = await assertExternalStage(stageDir, repoRoot);
  const manifestRealPath = await resolveStageRegularFile(
    stageDir,
    stageRealDir,
    path.basename(absoluteManifest),
    "stage manifest",
  );
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestRealPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read stage manifest ${absoluteManifest}: ${error.message}`);
  }
  validateManifestShape(manifest);
  const computedStageDigest = computeStageManifestDigest(manifest);
  if (manifest.stageDigest !== computedStageDigest) throw new Error("stage manifest digest does not match manifest content");
  if (path.basename(stageRealDir) !== manifest.stageDigest.slice("sha256:".length)) {
    throw new Error("stage directory must be named by its stage digest");
  }
  if (manifest.qa.status !== "accepted") throw new Error("stage promotion requires accepted QA");

  const scenarioPath = await resolveStageRegularFile(stageDir, stageRealDir, manifest.scenario.path, "scenario");
  const scenario = await readScenario(scenarioPath, { allowedExtensionIds });
  if (computeScenarioDigest(scenario, { allowedExtensionIds }) !== manifest.scenario.digest) {
    throw new Error("scenario source digest does not match staged scenario");
  }
  if (scenario.seed.recipe !== manifest.provenance.seedId) {
    throw new Error("staged provenance seed identity does not match declarative scenario seed");
  }
  const capturePath = await resolveStageRegularFile(stageDir, stageRealDir, manifest.capture.path, "capture");
  if (`sha256:${await hashFile(capturePath)}` !== manifest.capture.digest) throw new Error("capture digest does not match staged raw master");
  const reportPath = await resolveStageRegularFile(stageDir, stageRealDir, manifest.qa.reportPath, "QA report");
  const reportBytes = await fs.readFile(reportPath);
  if (`sha256:${createHash("sha256").update(reportBytes).digest("hex")}` !== manifest.qa.reportDigest) throw new Error("QA report digest does not match staged report");
  let qaReport;
  try {
    qaReport = JSON.parse(reportBytes);
  } catch (error) {
    throw new Error(`staged QA report is invalid JSON: ${error.message}`);
  }
  if (!isObject(qaReport) || qaReport.passed === false || (qaReport.status !== "accepted" && qaReport.passed !== true)) {
    throw new Error("staged QA report must record accepted QA");
  }

  const assets = {};
  const seenPaths = new Set();
  for (const form of ["desktop", "mobile"]) {
    if (!manifest.assets[form]) continue;
    assets[form] = {};
    for (const kind of ASSET_KEYS) {
      const record = manifest.assets[form][kind];
      const filePath = await resolveStageRegularFile(stageDir, stageRealDir, record.path, `${form} ${kind}`);
      if (seenPaths.has(filePath)) throw new Error(`stage asset path is reused: ${record.path}`);
      seenPaths.add(filePath);
      const stat = await fs.lstat(filePath);
      if (stat.size !== record.bytes || await hashFile(filePath) !== record.sha256) {
        throw new Error(`${form} ${kind} hash/bytes do not match stage manifest`);
      }
      assets[form][kind] = { record, filePath };
    }
  }
  return { manifest, stageDir, scenario, scenarioPath, capturePath, reportPath, assets };
}

export async function promoteStagedHighlight({
  manifestPath,
  repoRoot = process.cwd(),
  highlightsDir = path.join(repoRoot, "docs/public/media/highlights"),
  allowedExtensionIds = [],
  probe,
  now = new Date(),
} = {}) {
  if (!manifestPath) throw new Error("stage manifest path is required");
  const staged = await readStageManifest(manifestPath, { repoRoot, allowedExtensionIds });
  const { manifest } = staged;
  await fs.mkdir(highlightsDir, { recursive: true });
  const lockPath = path.join(highlightsDir, `.promote-${manifest.highlight.id}.lock`);
  try {
    await fs.mkdir(lockPath);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Highlight promotion already in progress for ${manifest.highlight.id}; lock exists at ${lockPath}`);
    throw error;
  }
  try {
    return await promoteVerifiedStage({ staged, repoRoot, highlightsDir, allowedExtensionIds, probe, now });
  } finally {
    await fs.rmdir(lockPath).catch(() => {});
  }
}

async function promoteVerifiedStage({ staged, repoRoot, highlightsDir, allowedExtensionIds, probe, now }) {
  const { manifest } = staged;
  const destination = path.join(highlightsDir, manifest.highlight.id);
  const destinationStat = await fs.lstat(destination).catch(() => null);
  if (destinationStat && !destinationStat.isDirectory()) throw new Error(`Highlight destination collision: ${destination}`);
  let existingDescriptor = null;
  if (destinationStat) {
    existingDescriptor = await parseHighlightDescriptor(path.join(destination, "highlight.json"));
    if (existingDescriptor.status !== "queued") throw new Error(`cannot add revision to ${existingDescriptor.status} Highlight ${existingDescriptor.id}`);
    if (await exists(path.join(destination, "revisions", manifest.revision)) || existingDescriptor.revision_history?.some((entry) => entry.revision === manifest.revision)) {
      throw new Error(`revision ${manifest.revision} already exists; refusing overwrite collision`);
    }
  }

  const transactionRoot = await fs.mkdtemp(path.join(highlightsDir, ".promote-"));
  const candidateCatalog = path.join(transactionRoot, "catalog");
  const candidateDir = path.join(candidateCatalog, manifest.highlight.id);
  let previousDir;
  try {
    await fs.mkdir(candidateCatalog, { recursive: true });
    if (destinationStat) await fs.cp(destination, candidateDir, { recursive: true, errorOnExist: true });
    else await fs.mkdir(candidateDir, { recursive: true });

    const revisionDir = path.join(candidateDir, "revisions", manifest.revision);
    await fs.mkdir(path.dirname(revisionDir), { recursive: true });
    await fs.mkdir(revisionDir, { recursive: false });
    const desktop = await copyAssetSet(staged.assets.desktop, revisionDir, manifest.revision, "desktop");
    const mobileAssets = staged.assets.mobile
      ? await copyAssetSet(staged.assets.mobile, revisionDir, manifest.revision, "mobile")
      : null;
    const scenarioRecord = await copyTrackedFile(staged.scenarioPath, path.join(revisionDir, "scenario.json"), `revisions/${manifest.revision}/scenario.json`);
    scenarioRecord.digest = manifest.scenario.digest;

    const compact = buildCompactProvenance(manifest);
    const provenanceBytes = Buffer.from(`${JSON.stringify(compact, null, 2)}\n`);
    const provenancePath = path.join(revisionDir, "provenance.json");
    await fs.writeFile(provenancePath, provenanceBytes, { flag: "wx" });
    const provenanceRecord = fileRecord(`revisions/${manifest.revision}/provenance.json`, provenanceBytes);

    const revisionHistory = existingDescriptor?.revision_history
      ? structuredClone(existingDescriptor.revision_history)
      : existingDescriptor ? deriveLegacyRevisionHistory(existingDescriptor) : [];
    const activeFiles = [
      ...Object.values(desktop),
      ...Object.values(mobileAssets ?? {}),
      scenarioRecord,
      provenanceRecord,
    ].map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 }));
    revisionHistory.push({ revision: manifest.revision, files: activeFiles });

    const descriptor = buildDescriptor({
      manifest,
      existingDescriptor,
      desktop,
      mobileAssets,
      scenarioRecord,
      provenanceRecord,
      revisionHistory,
      now,
    });
    const descriptorPath = path.join(candidateDir, "highlight.json");
    await writeJson(descriptorPath, descriptor);
    descriptor.source_digest = await computeSourceDigest(candidateDir);
    await writeJson(descriptorPath, descriptor);

    const validation = await validateHighlights({
      repoRoot,
      highlightsDir: candidateCatalog,
      probe,
      now,
      allowedExtensionIds,
    });

    if (destinationStat) {
      previousDir = path.join(transactionRoot, "previous");
      await fs.rename(destination, previousDir);
      try {
        await fs.rename(candidateDir, destination);
      } catch (error) {
        await fs.rename(previousDir, destination);
        previousDir = undefined;
        throw error;
      }
    } else {
      if (await exists(destination)) throw new Error(`Highlight destination appeared during promotion: ${destination}`);
      await fs.rename(candidateDir, destination);
    }
    if (previousDir) await fs.rm(previousDir, { recursive: true, force: true });
    await fs.rm(transactionRoot, { recursive: true, force: true });
    return { descriptor, destination, stageDigest: manifest.stageDigest, validation };
  } catch (error) {
    if (previousDir && !(await exists(destination)) && await exists(previousDir)) {
      await fs.rename(previousDir, destination).catch(() => {});
    }
    await fs.rm(transactionRoot, { recursive: true, force: true });
    throw error;
  }
}

function validateManifestShape(manifest) {
  assertObjectKeys(manifest, ["schemaVersion", "stageDigest", "revision", "highlight", "scenario", "capture", "qa", "provenance", "assets"], "stage manifest");
  if (manifest.schemaVersion !== STAGE_MANIFEST_VERSION) throw new Error(`stage manifest schemaVersion must be ${STAGE_MANIFEST_VERSION}`);
  if (!DIGEST_PATTERN.test(manifest.stageDigest)) throw new Error("stageDigest must be SHA-256");
  if (typeof manifest.revision !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(manifest.revision)) throw new Error("stage revision is invalid");
  validateHighlightMetadata(manifest.highlight);
  assertObjectKeys(manifest.scenario, ["path", "digest"], "scenario");
  assertSafeRelative(manifest.scenario.path, "scenario path");
  if (!DIGEST_PATTERN.test(manifest.scenario.digest)) throw new Error("scenario digest must be SHA-256");
  assertObjectKeys(manifest.capture, ["path", "digest"], "capture");
  assertSafeRelative(manifest.capture.path, "capture path");
  if (!DIGEST_PATTERN.test(manifest.capture.digest)) throw new Error("capture digest must be SHA-256");
  assertObjectKeys(manifest.qa, ["status", "reportPath", "reportDigest", "acceptedAt"], "QA");
  assertSafeRelative(manifest.qa.reportPath, "QA report path");
  if (!DIGEST_PATTERN.test(manifest.qa.reportDigest) || !validDate(manifest.qa.acceptedAt)) throw new Error("QA requires report digest and acceptedAt");
  validateProvenance(manifest.provenance);
  if (!isObject(manifest.assets) || !manifest.assets.desktop) throw new Error("stage assets require desktop deliveries");
  assertObjectKeys(manifest.assets, ["desktop", "mobile"], "assets", { optional: true });
  for (const form of ["desktop", "mobile"]) {
    if (!manifest.assets[form]) continue;
    assertObjectKeys(manifest.assets[form], ASSET_KEYS, `${form} assets`);
    for (const kind of ASSET_KEYS) validateAssetRecord(manifest.assets[form][kind], form, kind);
  }
}

function validateHighlightMetadata(highlight) {
  assertObjectKeys(highlight, ["id", "title", "summary", "caption", "releaseVersion", "featureFlags", "docs", "mobileDeclaration"], "highlight");
  if (typeof highlight.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(highlight.id)) throw new Error("stage Highlight id must be kebab-case");
  for (const field of ["title", "summary", "caption", "mobileDeclaration"]) if (typeof highlight[field] !== "string" || !highlight[field].trim()) throw new Error(`stage Highlight requires ${field}`);
  if (!/^\d+\.\d+\.\d+$/.test(highlight.releaseVersion)) throw new Error("stage Highlight releaseVersion is invalid");
  if (!Array.isArray(highlight.featureFlags) || highlight.featureFlags.length === 0 || !highlight.featureFlags.every((flag) => typeof flag === "string" && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(flag))) throw new Error("stage Highlight requires featureFlags");
  assertObjectKeys(highlight.docs, ["page", "section"], "Highlight docs");
  if (typeof highlight.docs.page !== "string" || typeof highlight.docs.section !== "string" || !highlight.docs.section.trim()) throw new Error("stage Highlight requires docs ownership");
}

function validateProvenance(provenance) {
  const common = ["captureMode", "sourceSha", "capturedAt", "seedId", "seedDigest", "toolVersion", "landingAdapter"];
  const pr = ["prNumber", "prBaseSha", "prHeadSha"];
  const main = ["sourceRef"];
  assertObjectKeys(provenance, [...common, ...pr, ...main], "provenance", { optional: true });
  if (!["pr_head", "current_main"].includes(provenance.captureMode)) throw new Error("stage provenance captureMode is invalid");
  if (!SHA_PATTERN.test(provenance.sourceSha) || !validDate(provenance.capturedAt) || typeof provenance.seedId !== "string" || !provenance.seedId.trim() || !DIGEST_PATTERN.test(provenance.seedDigest) || typeof provenance.toolVersion !== "string" || !provenance.toolVersion.trim()) throw new Error("stage provenance is incomplete");
  assertObjectKeys(provenance.landingAdapter, ["sourceSha", "contractVersion"], "landing adapter provenance");
  if (!ADAPTER_SHA_PATTERN.test(provenance.landingAdapter.sourceSha)) {
    throw new Error("landing adapter provenance requires exact lowercase Git SHA");
  }
  if (typeof provenance.landingAdapter.contractVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(provenance.landingAdapter.contractVersion)) {
    throw new Error("landing adapter provenance requires a stable contract version");
  }
  if (provenance.captureMode === "pr_head") {
    if (!Number.isInteger(provenance.prNumber) || provenance.prNumber < 1 || !SHA_PATTERN.test(provenance.prBaseSha) || provenance.prHeadSha !== provenance.sourceSha) throw new Error("pr_head stage provenance is invalid");
  } else if (provenance.sourceRef !== "origin/main") {
    throw new Error("current_main stage provenance requires origin/main");
  }
}

function validateAssetRecord(record, form, kind) {
  assertObjectKeys(record, ["path", "bytes", "sha256", "codec", "width", "height", "fps", "duration", "audio"], `${form} ${kind}`);
  assertSafeRelative(record.path, `${form} ${kind} path`);
  if (!record.path.endsWith(ASSET_EXTENSIONS[kind])) throw new Error(`${form} ${kind} must use ${ASSET_EXTENSIONS[kind]}`);
  if (!Number.isInteger(record.bytes) || record.bytes <= 0 || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error(`${form} ${kind} requires exact bytes and SHA-256`);
  const expectedCodec = kind === "webm" ? "vp9" : kind === "mp4" ? "h264" : "webp";
  if (record.codec !== expectedCodec || !Number.isInteger(record.width) || !Number.isInteger(record.height) || record.audio !== false) throw new Error(`${form} ${kind} media metadata is invalid`);
  const expectedDimensions = form === "desktop" ? [1920, 1200] : [1290, 2796];
  if (record.width !== expectedDimensions[0] || record.height !== expectedDimensions[1]) {
    throw new Error(`${form} ${kind} dimensions must be ${expectedDimensions[0]}x${expectedDimensions[1]}`);
  }
  if (kind === "poster") {
    if (record.fps !== null || record.duration !== null) throw new Error(`${form} poster must not declare video timing`);
  } else if (record.fps !== 25 || typeof record.duration !== "number" || record.duration < 1 || record.duration > 15) {
    throw new Error(`${form} ${kind} timing is invalid`);
  }
}

async function copyAssetSet(assetSet, revisionDir, revision, form) {
  const result = {};
  for (const kind of ASSET_KEYS) {
    const source = assetSet[kind];
    const name = `${form}.${ASSET_NAMES[kind]}`;
    await fs.copyFile(source.filePath, path.join(revisionDir, name), fsConstants.COPYFILE_EXCL);
    result[kind] = { ...source.record, path: `revisions/${revision}/${name}` };
  }
  return result;
}

async function copyTrackedFile(source, destination, relativePath) {
  await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  const bytes = await fs.readFile(destination);
  return fileRecord(relativePath, bytes);
}

function buildCompactProvenance(manifest) {
  return {
    schema_version: 1,
    scenario_digest: manifest.scenario.digest,
    capture_digest: manifest.capture.digest,
    stage_digest: manifest.stageDigest,
    source_sha: manifest.provenance.sourceSha,
    capture_mode: manifest.provenance.captureMode,
    captured_at: manifest.provenance.capturedAt,
    seed_id: manifest.provenance.seedId,
    seed_digest: manifest.provenance.seedDigest,
    tool_version: manifest.provenance.toolVersion,
    landing_adapter: {
      source_sha: manifest.provenance.landingAdapter.sourceSha,
      contract_version: manifest.provenance.landingAdapter.contractVersion,
    },
    qa: {
      status: "accepted",
      report_digest: manifest.qa.reportDigest,
      accepted_at: manifest.qa.acceptedAt,
    },
  };
}

function buildDescriptor({ manifest, existingDescriptor, desktop, mobileAssets, scenarioRecord, provenanceRecord, revisionHistory, now }) {
  const provenance = {
    capture_mode: manifest.provenance.captureMode,
    source_sha: manifest.provenance.sourceSha,
    captured_at: manifest.provenance.capturedAt,
    seed_id: manifest.provenance.seedId,
    seed_digest: manifest.provenance.seedDigest,
    tool_version: manifest.provenance.toolVersion,
    landing_adapter: {
      source_sha: manifest.provenance.landingAdapter.sourceSha,
      contract_version: manifest.provenance.landingAdapter.contractVersion,
    },
    scenario_digest: manifest.scenario.digest,
    capture_digest: manifest.capture.digest,
    stage_digest: manifest.stageDigest,
    ...(manifest.provenance.captureMode === "pr_head" ? {
      pr_number: manifest.provenance.prNumber,
      pr_base_sha: manifest.provenance.prBaseSha,
      pr_head_sha: manifest.provenance.prHeadSha,
    } : { source_ref: manifest.provenance.sourceRef }),
  };
  return {
    schema_version: 1,
    id: manifest.highlight.id,
    title: manifest.highlight.title,
    summary: manifest.highlight.summary,
    caption: manifest.highlight.caption,
    status: "queued",
    release_version: manifest.highlight.releaseVersion,
    feature_flags: manifest.highlight.featureFlags,
    qa_status: "accepted",
    docs: manifest.highlight.docs,
    mobile: {
      available: Boolean(mobileAssets),
      declaration: manifest.highlight.mobileDeclaration,
    },
    active_revision: manifest.revision,
    source_digest: `sha256:${"0".repeat(64)}`,
    promoted_at: new Date(now).toISOString(),
    provenance,
    desktop,
    ...(mobileAssets ? { mobile_assets: mobileAssets } : {}),
    scenario: scenarioRecord,
    provenance_record: provenanceRecord,
    revision_history: revisionHistory,
    ...(existingDescriptor?.published_at ? { published_at: existingDescriptor.published_at } : {}),
  };
}

function deriveLegacyRevisionHistory(descriptor) {
  const files = [
    ...Object.values(descriptor.desktop ?? descriptor.desktop_assets ?? {}),
    ...Object.values(descriptor.mobile_assets ?? {}),
    descriptor.scenario,
    descriptor.provenance_record,
  ].filter(Boolean).map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 }));
  return files.length > 0 ? [{ revision: descriptor.active_revision, files }] : [];
}

function fileRecord(relativePath, bytes) {
  return {
    path: relativePath,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function assertExternalStage(stageDir, repoRoot) {
  const [root, stage] = await Promise.all([
    fs.realpath(path.resolve(repoRoot)),
    fs.realpath(path.resolve(stageDir)),
  ]);
  if (isInside(root, stage)) {
    throw new Error("stage directory must stay outside the repository");
  }
  return stage;
}

function resolveStageFile(stageDir, relativePath, label) {
  assertSafeRelative(relativePath, `${label} path`);
  const filePath = path.resolve(stageDir, relativePath);
  const relative = path.relative(stageDir, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay inside stage directory`);
  return filePath;
}

async function resolveStageRegularFile(stageDir, stageRealDir, relativePath, label) {
  const filePath = resolveStageFile(stageDir, relativePath, label);
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`${label} must be a regular file inside stage directory`);
  const realPath = await fs.realpath(filePath);
  if (!isInside(stageRealDir, realPath) || realPath === stageRealDir) {
    throw new Error(`${label} must stay inside stage directory; symlinked parent directories are not allowed`);
  }
  return realPath;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSafeRelative(value, label) {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.includes("\0") || value.split("/").includes("..")) throw new Error(`${label} must be a safe relative path`);
}

function assertObjectKeys(value, allowed, label, { optional = false } = {}) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) throw new Error(`${label} contains unknown property ${key}`);
  if (!optional) for (const key of allowed) if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing ${key}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

async function hashFile(filePath) {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`stage source must be a regular file: ${filePath}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
