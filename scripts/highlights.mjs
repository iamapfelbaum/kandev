import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  compileTimeline,
  computeScenarioDigest,
  readScenario,
  renderStoryboard,
  writeScenarioScaffold,
} from "./highlights/scenario.mjs";

const execFileAsync = promisify(execFile);

export const HIGHLIGHTS_RELATIVE_DIR = "docs/public/media/highlights";
export const HIGHLIGHT_SCHEMA_VERSION = 1;
export const MAX_HIGHLIGHT_AGE_DAYS = 180;
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_HIGHLIGHT_BYTES = 100 * 1024 * 1024;
export const MIN_DURATION_SECONDS = 1;
export const MAX_DURATION_SECONDS = 15;
export const ALLOWED_CAPTURE_MODES = new Set(["pr_head", "current_main"]);
export const ALLOWED_HIGHLIGHT_LABELS = new Set([
  "highlight:required",
  "highlight:approved",
]);
const LANDING_ADAPTER_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONTRACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// Keep both legacy docs deliveries and current declarative production
// deliveries valid. New staged production capture is pinned to 1920x1200.
const DESKTOP_DIMENSIONS = [[960, 600], [1920, 1200]];
const MOBILE_WIDTH = 1290;
const MOBILE_HEIGHT = 2796;
const FPS = 25;
const MEDIA_KINDS = ["webm", "mp4", "poster"];
const MEDIA_EXTENSIONS = { webm: ".webm", mp4: ".mp4", poster: ".webp" };
const MEDIA_CODECS = { webm: "vp9", mp4: "h264", poster: "webp" };
const ALLOWED_STATUS = new Set(["queued", "active", "withdrawn", "docs_only"]);
const DERIVED_DESCRIPTOR_FIELDS = new Set([
  "status",
  "source_digest",
  "promoted_at",
  "activated_at",
  "withdrawn_at",
  "withdrawal_reason",
]);

/**
 * Parse one descriptor, without trusting paths from its JSON.
 *
 * @param {string} descriptorPath Absolute or repository-relative descriptor path.
 * @returns {Promise<object>} Parsed descriptor.
 */
export async function parseHighlightDescriptor(descriptorPath) {
  let descriptor;
  try {
    descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot parse Highlight descriptor ${descriptorPath}: ${error.message}`);
  }
  assertDescriptorShape(descriptor);
  const directoryId = path.basename(path.dirname(descriptorPath));
  if (descriptor.id !== directoryId) {
    throw new Error(`Highlight descriptor id ${descriptor.id} does not match directory ${directoryId}`);
  }
  return descriptor;
}

/**
 * Validate all checked-in Highlights, including media bytes and real ffprobe output.
 *
 * @param {{repoRoot?: string, highlightsDir?: string, probe?: Function, now?: Date|string}} options
 * @returns {Promise<{count: number, activeCount: number, queuedCount: number, ids: string[]}>}
 */
export async function validateHighlights({
  repoRoot = process.cwd(),
  highlightsDir = path.join(repoRoot, HIGHLIGHTS_RELATIVE_DIR),
  probe = probeMedia,
  now = new Date(),
  allowedExtensionIds = [],
} = {}) {
  const directories = await discoverHighlightDirectories(highlightsDir);
  const seenIds = new Set();
  let activeCount = 0;
  let queuedCount = 0;
  const ids = [];

  for (const highlightDir of directories) {
    const descriptor = await parseHighlightDescriptor(
      path.join(highlightDir, "highlight.json"),
    );
    if (seenIds.has(descriptor.id)) {
      throw new Error(`duplicate Highlight id: ${descriptor.id}`);
    }
    seenIds.add(descriptor.id);
    ids.push(descriptor.id);
    if (descriptor.status === "active") activeCount += 1;
    if (descriptor.status === "queued") queuedCount += 1;

    const pagePath = resolveInside(
      path.join(repoRoot, "docs/public"),
      descriptor.docs.page,
      `${descriptor.id} docs owner`,
    );
    if (!/\.mdx?$/i.test(pagePath)) {
      throw new Error(`${descriptor.id} docs owner must be Markdown`);
    }
    const markdown = await fs.readFile(pagePath, "utf8");
    if (!collectHeadings(markdown).has(descriptor.docs.section)) {
      throw new Error(
        `${descriptor.id} docs owner section is missing: ${descriptor.docs.section}`,
      );
    }

    const activeFiles = await validateAssets({ highlightDir, descriptor, probe });
    const revisionFiles = await validateRevisionFiles({ highlightDir, descriptor, allowedExtensionIds });
    const files = revisionFiles.length > 0 ? revisionFiles : activeFiles;
    const highlightBytes = files.reduce((sum, file) => sum + file.bytes, 0);
    if (highlightBytes > MAX_HIGHLIGHT_BYTES) {
      throw new Error(`Highlight media exceeds total size limit of ${MAX_HIGHLIGHT_BYTES} bytes`);
    }
    const expectedSourceDigest = await computeSourceDigest(highlightDir);
    if (descriptor.source_digest !== expectedSourceDigest) {
      throw new Error(`${descriptor.id} source_digest does not match source files`);
    }
    validateFreshness(descriptor, now);
    await validatePublishedHistory(highlightDir, descriptor);
    await validateOrphans(highlightDir, descriptor);
  }

  return { count: directories.length, activeCount, queuedCount, ids };
}

/**
 * Compute a stable digest of source metadata and revisioned media.
 * Derived descriptor fields and publication history are excluded.
 *
 * @param {string} highlightDir Highlight directory.
 * @returns {Promise<string>} sha256-prefixed digest.
 */
export async function computeSourceDigest(highlightDir) {
  const descriptorPath = path.join(highlightDir, "highlight.json");
  const descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
  const sourceDescriptor = structuredClone(descriptor);
  for (const field of DERIVED_DESCRIPTOR_FIELDS) delete sourceDescriptor[field];
  const entries = [`highlight.json\0${canonicalJson(sourceDescriptor)}`];
  for (const file of await collectFiles(path.join(highlightDir, "revisions"))) {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error(`revision file must be a regular file: ${path.relative(highlightDir, file)}`);
    const relative = path.relative(highlightDir, file).split(path.sep).join("/");
    entries.push(`${relative}\0${(await fs.readFile(file)).toString("base64")}`);
  }
  entries.sort();
  return `sha256:${createHash("sha256").update(entries.join("\n")).digest("hex")}`;
}

/**
 * Promote a reviewed candidate by recording its source digest and queued status.
 * It never overwrites a revisioned asset and refuses a changed digest.
 *
 * @param {{highlightDir: string, sourceDigest?: string, now?: Date|string}} options
 * @returns {Promise<object>} Updated descriptor.
 */
export async function promoteHighlight({ highlightDir, sourceDigest, now = new Date() }) {
  const descriptorPath = path.join(highlightDir, "highlight.json");
  const descriptor = await parseHighlightDescriptor(descriptorPath);
  if (descriptor.status !== "queued") {
    throw new Error(`cannot promote Highlight ${descriptor.id} from ${descriptor.status}`);
  }
  const digest = await computeSourceDigest(highlightDir);
  if (sourceDigest && sourceDigest !== digest) {
    throw new Error(`source digest changed for ${descriptor.id}`);
  }
  descriptor.source_digest = digest;
  descriptor.promoted_at = new Date(now).toISOString();
  await writeJson(descriptorPath, descriptor);
  return descriptor;
}

/**
 * Activate one queued Highlight for its declared release.
 *
 * @param {{highlightDir: string, releaseVersion: string, now?: Date|string}} options
 * @returns {Promise<object>} Updated descriptor.
 */
export async function activateHighlight({ highlightDir, releaseVersion, now = new Date() }) {
  const descriptorPath = path.join(highlightDir, "highlight.json");
  const descriptor = await parseHighlightDescriptor(descriptorPath);
  if (descriptor.status !== "queued") {
    throw new Error(`Highlight ${descriptor.id} must be queued before activation`);
  }
  if (descriptor.release_version !== releaseVersion) {
    throw new Error(
      `Highlight ${descriptor.id} targets release ${descriptor.release_version}, not ${releaseVersion}`,
    );
  }
  const digest = await computeSourceDigest(highlightDir);
  if (descriptor.source_digest !== digest) {
    throw new Error(`source digest changed for ${descriptor.id}`);
  }
  const timestamp = new Date(now).toISOString();
  descriptor.status = "active";
  descriptor.activated_at = timestamp;
  delete descriptor.withdrawn_at;
  delete descriptor.withdrawal_reason;
  await writeJson(descriptorPath, descriptor);
  await appendPublishedHistory(highlightDir, {
    id: descriptor.id,
    status: "active",
    release_version: releaseVersion,
    at: timestamp,
  });
  return descriptor;
}

/**
 * Activate every queued Highlight targeting one release. Other queued releases
 * remain queued; no presentation-size cap is applied.
 *
 * @param {{highlightsDir: string, releaseVersion: string, now?: Date|string}} options
 * @returns {Promise<{releaseVersion: string, count: number, ids: string[]}>}
 */
export async function activateHighlightsForRelease({ highlightsDir, releaseVersion, now = new Date() }) {
  if (typeof releaseVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(releaseVersion)) {
    throw new Error(`invalid release version: ${releaseVersion}`);
  }
  const candidates = [];
  for (const highlightDir of await discoverHighlightDirectories(highlightsDir)) {
    const descriptor = await parseHighlightDescriptor(path.join(highlightDir, "highlight.json"));
    if (descriptor.status === "queued" && descriptor.release_version === releaseVersion) {
      const digest = await computeSourceDigest(highlightDir);
      if (descriptor.source_digest !== digest) {
        throw new Error(`source digest changed for ${descriptor.id}`);
      }
      candidates.push({ highlightDir, id: descriptor.id });
    }
  }
  const ids = [];
  for (const candidate of candidates) {
    await activateHighlight({ highlightDir: candidate.highlightDir, releaseVersion, now });
    ids.push(candidate.id);
  }
  return { releaseVersion, count: ids.length, ids };
}

/**
 * Withdraw an active Highlight with an explicit human-readable reason.
 *
 * @param {{highlightDir: string, reason: string, now?: Date|string}} options
 * @returns {Promise<object>} Updated descriptor.
 */
export async function withdrawHighlight({ highlightDir, reason, now = new Date() }) {
  if (typeof reason !== "string" || reason.trim().length < 10) {
    throw new Error("withdrawal reason must be explicit and at least 10 characters");
  }
  const descriptorPath = path.join(highlightDir, "highlight.json");
  const descriptor = await parseHighlightDescriptor(descriptorPath);
  if (descriptor.status !== "active") {
    throw new Error(`Highlight ${descriptor.id} must be active before withdrawal`);
  }
  const timestamp = new Date(now).toISOString();
  descriptor.status = "withdrawn";
  descriptor.withdrawn_at = timestamp;
  descriptor.withdrawal_reason = reason.trim();
  await writeJson(descriptorPath, descriptor);
  await appendPublishedHistory(highlightDir, {
    id: descriptor.id,
    status: "withdrawn",
    release_version: descriptor.release_version,
    at: timestamp,
    reason: descriptor.withdrawal_reason,
  });
  return descriptor;
}

/**
 * Build durable PR Markdown pointing to the exact feature-PR revision.
 *
 * @param {{descriptor: object, owner: string, repo: string, headSha: string, repoPath?: string}} options
 * @returns {string} Markdown snippet.
 */
export function buildPrSnippet({ descriptor, owner, repo, headSha, repoPath = HIGHLIGHTS_RELATIVE_DIR }) {
  assertSha(headSha, "head SHA");
  const base = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${headSha}`;
  const relativeRoot = `${repoPath}/${descriptor.id}`;
  const media = descriptor.desktop ?? descriptor.desktop_assets;
  if (!media?.poster?.path || !media?.mp4?.path) throw new Error(`${descriptor.id} is missing PR snippet media`);
  assertImmutableAssetPath(media.poster.path, descriptor.active_revision, `${descriptor.id} poster`);
  assertImmutableAssetPath(media.mp4.path, descriptor.active_revision, `${descriptor.id} mp4`);
  const poster = `${base}/${relativeRoot}/${media.poster.path}`;
  const video = `${base}/${relativeRoot}/${media.mp4.path}`;
  return [
    `<!-- highlight:${descriptor.id} head:${headSha} -->`,
    `### Highlight: ${descriptor.title}`,
    "",
    descriptor.summary,
    "",
    `[![${escapeMarkdown(descriptor.caption)}](${poster})](${video})`,
    "",
    `Play the [SHA-pinned Highlight video](${video}).`,
  ].join("\n");
}

/**
 * Evaluate label and head state for the opt-in PR gate.
 *
 * @param {{labels?: string[], changedFiles?: string[], headSha?: string, approvedHeadSha?: string, approvalHeadSha?: string, highlightIds?: string[]}} options
 * @returns {{ok: boolean, exempt: boolean, reasons: string[]}}
 */
export function evaluatePrGate({
  labels = [],
  changedFiles = [],
  headSha,
  approvedHeadSha,
  approvalHeadSha,
  prBody,
  highlightIds,
} = {}) {
  const highlightLabels = labels.filter((label) => label.startsWith("highlight:"));
  const unknown = highlightLabels.filter((label) => !ALLOWED_HIGHLIGHT_LABELS.has(label));
  const required = labels.includes("highlight:required");
  const approved = labels.includes("highlight:approved");
  const assetsChanged = changedFiles.some((file) =>
    file === HIGHLIGHTS_RELATIVE_DIR ||
    file.startsWith(`${HIGHLIGHTS_RELATIVE_DIR}/`),
  );
  const reasons = [];

  if (unknown.length > 0) reasons.push(`unsupported Highlight labels: ${unknown.join(", ")}`);
  if (!required && !approved && !assetsChanged && unknown.length === 0) {
    return { ok: true, exempt: true, reasons: [] };
  }
  if (approved && !required) reasons.push("highlight:approved requires highlight:required");
  if (assetsChanged && !required) reasons.push("Highlight asset changes require highlight:required");
  if (required && !approved) reasons.push("highlight:required awaits highlight:approved");
  if (required && typeof prBody === "string" && headSha) {
    const knownIds = highlightIds ? new Set(highlightIds) : null;
    const changedIds = [...new Set(changedFiles
      .filter((file) => file.startsWith(`${HIGHLIGHTS_RELATIVE_DIR}/`))
      .map((file) => file.slice(`${HIGHLIGHTS_RELATIVE_DIR}/`.length).split("/")[0])
      .filter(Boolean))];
    const markerMatches = [...prBody.matchAll(new RegExp(
      `<!--\\s*highlight:([a-z0-9]+(?:-[a-z0-9]+)*)\\s+head:${escapeRegExp(headSha)}\\s*-->`,
      "g",
    ))];
    const snippets = markerMatches.map((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = markerMatches[index + 1]?.index ?? prBody.length;
      return { id: match[1], body: prBody.slice(start, end) };
    });
    const requiredSnippetIds = changedIds.length > 0 ? changedIds : [null];
    for (const id of requiredSnippetIds) {
      if (id && knownIds && !knownIds.has(id)) {
        reasons.push(`changed Highlight ${id} is missing from the validated catalog`);
        continue;
      }
      const hasMatchingSnippet = id
        ? snippets.some((snippet) => snippet.id === id && knownIds?.has(snippet.id) !== false && new RegExp(
            `raw\\.githubusercontent\\.com/[^/\\s]+/[^/\\s]+/${escapeRegExp(headSha)}/docs/public/media/highlights/${escapeRegExp(id)}/`,
          ).test(snippet.body))
        : snippets.some((snippet) => knownIds?.has(snippet.id) !== false && new RegExp(
            `raw\\.githubusercontent\\.com/[^/\\s]+/[^/\\s]+/${escapeRegExp(headSha)}/docs/public/media/highlights/${escapeRegExp(snippet.id)}/`,
          ).test(snippet.body));
      if (!hasMatchingSnippet) {
        reasons.push(id
          ? `required Highlight PR body must contain a SHA-pinned snippet for ${id}`
          : "required Highlight PR body must contain its SHA-pinned snippet");
      }
    }
  }
  const priorHead = approvedHeadSha ?? approvalHeadSha;
  if (required && approved && headSha && priorHead && priorHead !== headSha) {
    reasons.push("highlight:approved is invalid after the PR head changed");
  }
  return { ok: reasons.length === 0, exempt: false, reasons };
}

/**
 * Probe a media file with ffprobe. This is deliberately not a metadata-only check:
 * every delivery is decoded by the real media tool on validation.
 *
 * @param {string} filePath Media path.
 * @returns {Promise<object>} Normalized ffprobe evidence.
 */
export async function probeMedia(filePath) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.env.FFPROBE ?? "ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      filePath,
    ]));
  } catch (error) {
    throw new Error(`ffprobe failed for ${filePath}: ${error.stderr || error.message}`);
  }
  const report = JSON.parse(stdout);
  const video = report.streams?.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error(`${filePath} has no video stream`);
  return {
    codec: String(video.codec_name ?? "").toLowerCase(),
    width: Number(video.width),
    height: Number(video.height),
    fps: parseFps(video.avg_frame_rate || video.r_frame_rate),
    duration: Number(video.duration ?? report.format?.duration ?? 0) || null,
    audio: report.streams.some((stream) => stream.codec_type === "audio"),
  };
}

async function validateAssets({ highlightDir, descriptor, probe }) {
  const desktop = descriptor.desktop ?? descriptor.desktop_assets;
  const mobile = descriptor.mobile_assets;
  const files = [];
  files.push(...(await validateAssetSet({
    highlightDir,
    descriptor,
    assets: desktop,
    form: "desktop",
    dimensions: DESKTOP_DIMENSIONS,
    probe,
  })));
  if (descriptor.mobile.available) {
    files.push(...(await validateAssetSet({
      highlightDir,
      descriptor,
      assets: mobile,
      form: "mobile",
      dimensions: [MOBILE_WIDTH, MOBILE_HEIGHT],
      probe,
    })));
  }
  return files;
}

async function validateAssetSet({ highlightDir, descriptor, assets, form, dimensions, probe }) {
  if (!assets || typeof assets !== "object") {
    throw new Error(`${descriptor.id} is missing ${form} media assets`);
  }
  const records = [];
  for (const kind of MEDIA_KINDS) {
    const record = assets[kind];
    if (!record || typeof record.path !== "string") {
      throw new Error(`${descriptor.id} is missing ${form} ${kind}`);
    }
    assertImmutableAssetPath(record.path, descriptor.active_revision, `${descriptor.id} ${form} ${kind}`);
    const expectedExtension = MEDIA_EXTENSIONS[kind];
    if (!record.path.endsWith(expectedExtension)) {
      throw new Error(`${descriptor.id} ${form} ${kind} must use ${expectedExtension}`);
    }
    const filePath = resolveInside(highlightDir, record.path, `${descriptor.id} ${form} ${kind}`);
    const stat = await fs.lstat(filePath).catch(() => null);
    if (!stat?.isFile()) throw new Error(`${descriptor.id} is missing media file ${record.path}`);
    if (stat.size <= 0 || stat.size > MAX_ASSET_BYTES) {
      throw new Error(`${descriptor.id} ${record.path} exceeds media size limit`);
    }
    const bytes = await fs.readFile(filePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (record.bytes !== stat.size || record.sha256 !== sha256) {
      throw new Error(`${descriptor.id} ${record.path} hash/bytes do not match descriptor`);
    }
    const evidence = await probe(filePath);
    const acceptedDimensions = Array.isArray(dimensions[0]) ? dimensions : [dimensions];
    if (evidence.codec !== MEDIA_CODECS[kind]) {
      throw new Error(`${descriptor.id} ${record.path} codec must be ${MEDIA_CODECS[kind]}`);
    }
    if (!acceptedDimensions.some(([width, height]) => evidence.width === width && evidence.height === height)) {
      const expected = acceptedDimensions.map(([width, height]) => `${width}x${height}`).join(" or ");
      throw new Error(`${descriptor.id} ${record.path} dimensions must be ${expected}`);
    }
    if (kind !== "poster") {
      if (evidence.fps !== FPS) throw new Error(`${descriptor.id} ${record.path} FPS must be ${FPS}`);
      if (!Number.isFinite(evidence.duration) || evidence.duration < MIN_DURATION_SECONDS || evidence.duration > MAX_DURATION_SECONDS) {
        throw new Error(`${descriptor.id} ${record.path} duration is outside ${MIN_DURATION_SECONDS}-${MAX_DURATION_SECONDS}s`);
      }
      if (evidence.audio) throw new Error(`${descriptor.id} ${record.path} must not contain audio`);
      if (record.duration !== undefined && Math.abs(record.duration - evidence.duration) > 0.1) {
        throw new Error(`${descriptor.id} ${record.path} duration metadata does not match ffprobe`);
      }
    }
    records.push({ path: record.path, bytes: stat.size });
  }
  return records;
}

function assertDescriptorShape(descriptor) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("Highlight descriptor must be an object");
  }
  if (descriptor.schema_version !== HIGHLIGHT_SCHEMA_VERSION) {
    throw new Error(`Highlight descriptor schema_version must be ${HIGHLIGHT_SCHEMA_VERSION}`);
  }
  if (typeof descriptor.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(descriptor.id)) {
    throw new Error("Highlight id must use lowercase kebab-case");
  }
  for (const [field, min] of [["title", 1], ["summary", 1], ["caption", 1]]) {
    if (typeof descriptor[field] !== "string" || descriptor[field].trim().length < min) {
      throw new Error(`Highlight ${descriptor.id ?? "<unknown>"} requires ${field}`);
    }
  }
  if (!ALLOWED_STATUS.has(descriptor.status)) throw new Error(`${descriptor.id} has unsupported status ${descriptor.status}`);
  if (!/^\d+\.\d+\.\d+$/.test(descriptor.release_version)) throw new Error(`${descriptor.id} has invalid release_version`);
  if (!Array.isArray(descriptor.feature_flags) || descriptor.feature_flags.length === 0 || !descriptor.feature_flags.every((flag) => typeof flag === "string" && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(flag))) {
    throw new Error(`${descriptor.id} requires feature flags`);
  }
  if (descriptor.qa_status !== "accepted") throw new Error(`${descriptor.id} requires accepted QA status`);
  if (!descriptor.docs || typeof descriptor.docs.page !== "string" || typeof descriptor.docs.section !== "string" || !descriptor.docs.section.trim()) {
    throw new Error(`${descriptor.id} requires docs ownership`);
  }
  if (!descriptor.mobile || typeof descriptor.mobile.available !== "boolean" || typeof descriptor.mobile.declaration !== "string" || !descriptor.mobile.declaration.trim()) {
    throw new Error(`${descriptor.id} requires a mobile declaration`);
  }
  if (typeof descriptor.active_revision !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(descriptor.active_revision)) throw new Error(`${descriptor.id} has invalid active_revision`);
  if (!/^sha256:[a-f0-9]{64}$/.test(descriptor.source_digest)) throw new Error(`${descriptor.id} has invalid source_digest`);
  assertProvenance(descriptor);
  if (descriptor.status === "withdrawn" && typeof descriptor.withdrawal_reason !== "string") {
    throw new Error(`${descriptor.id} withdrawn status requires withdrawal_reason`);
  }
  if (descriptor.mobile.available && !descriptor.mobile_assets) throw new Error(`${descriptor.id} mobile declaration requires mobile assets`);
  if (!descriptor.mobile.available && descriptor.mobile_assets) throw new Error(`${descriptor.id} declares mobile assets but mobile is unavailable`);
  const companionFields = [descriptor.scenario, descriptor.provenance_record, descriptor.revision_history];
  if (companionFields.some(Boolean) && !companionFields.every(Boolean)) {
    throw new Error(`${descriptor.id} durable scenario, provenance record, and revision_history must be declared together`);
  }
  if (descriptor.scenario) {
    assertCompanionRecord(descriptor.scenario, descriptor.active_revision, "scenario", "scenario.json");
    if (!isDigest(descriptor.scenario.digest)) throw new Error(`${descriptor.id} scenario requires canonical digest`);
    assertCompanionRecord(descriptor.provenance_record, descriptor.active_revision, "provenance record", "provenance.json");
    if (!Array.isArray(descriptor.revision_history) || descriptor.revision_history.length === 0) throw new Error(`${descriptor.id} requires revision_history`);
  }
}

function assertProvenance(descriptor) {
  const provenance = descriptor.provenance;
  if (!provenance || !ALLOWED_CAPTURE_MODES.has(provenance.capture_mode)) {
    throw new Error(`${descriptor.id} has invalid provenance capture_mode`);
  }
  assertSha(provenance.source_sha, `${descriptor.id} provenance source_sha`);
  if (typeof provenance.captured_at !== "string" || !Number.isFinite(Date.parse(provenance.captured_at))) throw new Error(`${descriptor.id} has invalid provenance captured_at`);
  if (typeof provenance.seed_id !== "string" || !provenance.seed_id.trim()) throw new Error(`${descriptor.id} has invalid provenance seed_id`);
  if (!/^sha256:[a-f0-9]{64}$/.test(provenance.seed_digest)) throw new Error(`${descriptor.id} has invalid provenance seed_digest`);
  if (typeof provenance.tool_version !== "string" || !provenance.tool_version.trim()) throw new Error(`${descriptor.id} has invalid provenance tool_version`);
  if (provenance.capture_mode === "pr_head") {
    if (!Number.isInteger(provenance.pr_number) || provenance.pr_number < 1) throw new Error(`${descriptor.id} pr_head provenance requires pr_number`);
    assertSha(provenance.pr_base_sha, `${descriptor.id} provenance pr_base_sha`);
    assertSha(provenance.pr_head_sha, `${descriptor.id} provenance pr_head_sha`);
    if (provenance.pr_head_sha !== provenance.source_sha) throw new Error(`${descriptor.id} PR head SHA must match source_sha`);
  }
  if (provenance.capture_mode === "current_main" && provenance.source_ref !== "origin/main") {
    throw new Error(`${descriptor.id} current_main provenance requires source_ref origin/main`);
  }
  if (descriptor.scenario) {
    for (const field of ["scenario_digest", "capture_digest", "stage_digest"]) {
      if (!isDigest(provenance[field])) throw new Error(`${descriptor.id} provenance requires ${field}`);
    }
    if (provenance.scenario_digest !== descriptor.scenario.digest) throw new Error(`${descriptor.id} scenario digest does not match provenance`);
    const landing = provenance.landing_adapter;
    if (!landing || !LANDING_ADAPTER_SHA_PATTERN.test(landing.source_sha ?? "") || !CONTRACT_VERSION_PATTERN.test(landing.contract_version ?? "")) {
      throw new Error(`${descriptor.id} declarative provenance requires exact landing adapter SHA and contract version`);
    }
  }
}

function validateFreshness(descriptor, now) {
  const capturedAt = Date.parse(descriptor.provenance.captured_at);
  const current = new Date(now).getTime();
  if (capturedAt > current + 5 * 60 * 1000) throw new Error(`${descriptor.id} provenance timestamp is in the future`);
  if (current - capturedAt > MAX_HIGHLIGHT_AGE_DAYS * 24 * 60 * 60 * 1000) throw new Error(`${descriptor.id} capture provenance is stale`);
}

async function validateOrphans(highlightDir, descriptor) {
  const expected = new Set(["highlight.json", "published-history.json"]);
  for (const set of [descriptor.desktop ?? descriptor.desktop_assets, descriptor.mobile_assets]) {
    if (!set) continue;
    for (const kind of MEDIA_KINDS) expected.add(set[kind].path);
  }
  for (const revision of descriptor.revision_history ?? []) {
    for (const record of revision.files ?? []) expected.add(record.path);
  }
  const files = await collectFiles(highlightDir);
  for (const file of files) {
    const relative = path.relative(highlightDir, file).split(path.sep).join("/");
    if (!expected.has(relative)) throw new Error(`${descriptor.id} contains orphan or untracked file: ${relative}`);
  }
}

async function validateRevisionFiles({ highlightDir, descriptor, allowedExtensionIds }) {
  if (!descriptor.revision_history) return [];
  const revisions = new Set();
  const recordsByPath = new Map();
  for (const [index, revision] of descriptor.revision_history.entries()) {
    if (!revision || typeof revision !== "object" || !/^[a-z0-9][a-z0-9._-]*$/.test(revision.revision)) {
      throw new Error(`${descriptor.id} revision_history[${index}] has invalid revision`);
    }
    if (revisions.has(revision.revision)) throw new Error(`${descriptor.id} revision_history contains duplicate revision ${revision.revision}`);
    revisions.add(revision.revision);
    if (!Array.isArray(revision.files) || revision.files.length === 0) throw new Error(`${descriptor.id} revision ${revision.revision} requires tracked files`);
    for (const record of revision.files) {
      assertFileRecord(record, `${descriptor.id} revision ${revision.revision}`);
      assertImmutableAssetPath(record.path, revision.revision, `${descriptor.id} revision file`);
      const basename = path.posix.basename(record.path);
      if (!["desktop.webm", "desktop.mp4", "desktop.webp", "mobile.webm", "mobile.mp4", "mobile.webp", "scenario.json", "provenance.json"].includes(basename)) {
        throw new Error(`${descriptor.id} revision contains unsupported file ${record.path}`);
      }
      if (recordsByPath.has(record.path)) throw new Error(`${descriptor.id} revision_history contains duplicate path ${record.path}`);
      const filePath = resolveInside(highlightDir, record.path, `${descriptor.id} revision file`);
      const stat = await fs.lstat(filePath).catch(() => null);
      if (!stat?.isFile()) throw new Error(`${descriptor.id} is missing tracked revision file ${record.path}`);
      if (stat.size !== record.bytes) throw new Error(`${descriptor.id} ${record.path} bytes do not match revision_history`);
      const sha256 = createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
      if (sha256 !== record.sha256) throw new Error(`${descriptor.id} ${record.path} hash does not match revision_history`);
      recordsByPath.set(record.path, { path: record.path, bytes: stat.size });
    }
  }
  if (!revisions.has(descriptor.active_revision)) throw new Error(`${descriptor.id} revision_history must include active_revision`);

  const activeRecords = [
    ...Object.values(descriptor.desktop ?? descriptor.desktop_assets),
    ...Object.values(descriptor.mobile_assets ?? {}),
    descriptor.scenario,
    descriptor.provenance_record,
  ].filter(Boolean);
  for (const record of activeRecords) {
    const tracked = descriptor.revision_history.flatMap((revision) => revision.files).find((item) => item.path === record.path);
    if (!tracked || tracked.bytes !== record.bytes || tracked.sha256 !== record.sha256) {
      throw new Error(`${descriptor.id} active file ${record.path} must match revision_history`);
    }
  }

  const scenarioPath = resolveInside(highlightDir, descriptor.scenario.path, `${descriptor.id} scenario`);
  const scenario = await readScenario(scenarioPath, { allowedExtensionIds });
  const scenarioDigest = computeScenarioDigest(scenario, { allowedExtensionIds });
  if (scenarioDigest !== descriptor.scenario.digest) throw new Error(`${descriptor.id} durable scenario digest does not match scenario file`);
  const provenancePath = resolveInside(highlightDir, descriptor.provenance_record.path, `${descriptor.id} provenance record`);
  let compact;
  try {
    compact = JSON.parse(await fs.readFile(provenancePath, "utf8"));
  } catch (error) {
    throw new Error(`${descriptor.id} compact provenance is invalid JSON: ${error.message}`);
  }
  if (compact?.schema_version !== 1 || compact.scenario_digest !== descriptor.provenance.scenario_digest || compact.capture_digest !== descriptor.provenance.capture_digest || compact.stage_digest !== descriptor.provenance.stage_digest) {
    throw new Error(`${descriptor.id} compact provenance does not match descriptor digests`);
  }
  if (compact.source_sha !== descriptor.provenance.source_sha || compact.qa?.status !== "accepted" || !isDigest(compact.qa?.report_digest)) {
    throw new Error(`${descriptor.id} compact provenance requires accepted QA and matching source SHA`);
  }
  const compactLanding = compact.landing_adapter;
  const descriptorLanding = descriptor.provenance.landing_adapter;
  if (
    !compactLanding ||
    compactLanding.source_sha !== descriptorLanding.source_sha ||
    compactLanding.contract_version !== descriptorLanding.contract_version
  ) {
    throw new Error(`${descriptor.id} compact landing adapter provenance must match descriptor SHA and contract version`);
  }
  return [...recordsByPath.values()];
}

async function validatePublishedHistory(highlightDir, descriptor) {
  const historyPath = path.join(highlightDir, "published-history.json");
  const hasHistory = await exists(historyPath);
  if (!hasHistory) {
    if (descriptor.status === "active" || descriptor.status === "withdrawn") {
      throw new Error(`${descriptor.id} ${descriptor.status} Highlight requires published history`);
    }
    return;
  }
  let history;
  try {
    history = JSON.parse(await fs.readFile(historyPath, "utf8"));
  } catch (error) {
    throw new Error(`${descriptor.id} published history is not valid JSON: ${error.message}`);
  }
  if (history?.schema_version !== 1 || !Array.isArray(history.events)) {
    throw new Error(`${descriptor.id} published history must use schema version 1 and contain events`);
  }
  let previousAt = -Infinity;
  let previousStatus;
  for (const event of history.events) {
    if (!event || event.id !== descriptor.id || !["active", "withdrawn"].includes(event.status)) {
      throw new Error(`${descriptor.id} published history contains an invalid event`);
    }
    if (event.release_version !== descriptor.release_version || typeof event.at !== "string") {
      throw new Error(`${descriptor.id} published history event has invalid release metadata`);
    }
    const at = Date.parse(event.at);
    if (!Number.isFinite(at) || at < previousAt) throw new Error(`${descriptor.id} published history is not append-only in time order`);
    if (previousStatus === event.status || (previousStatus === undefined && event.status !== "active")) {
      throw new Error(`${descriptor.id} published history has an invalid lifecycle transition`);
    }
    previousAt = at;
    previousStatus = event.status;
    if (event.status === "withdrawn" && (typeof event.reason !== "string" || event.reason.trim().length < 10)) {
      throw new Error(`${descriptor.id} withdrawal history event requires an explicit reason`);
    }
  }
  const last = history.events.at(-1);
  if (descriptor.status === "active" && last?.status !== "active") throw new Error(`${descriptor.id} active status does not match published history`);
  if (descriptor.status === "withdrawn" && last?.status !== "withdrawn") throw new Error(`${descriptor.id} withdrawn status does not match published history`);
}

async function discoverHighlightDirectories(highlightsDir) {
  const entries = await fs.readdir(highlightsDir, { withFileTypes: true }).catch(() => []);
  const directories = [];
  for (const entry of entries) {
    if (entry.name === "README.md" || entry.name === "published-history.json" || entry.name === ".gitkeep") continue;
    if (entry.name.startsWith("_")) continue;
    if (!entry.isDirectory()) throw new Error(`Highlights root contains orphan or untracked file: ${entry.name}`);
    const directory = path.join(highlightsDir, entry.name);
    if (entry.name === ".git") continue;
    if (!(await exists(path.join(directory, "highlight.json")))) throw new Error(`Highlight directory ${entry.name} is missing highlight.json`);
    directories.push(directory);
  }
  return directories.sort();
}

async function appendPublishedHistory(highlightDir, event) {
  const historyPath = path.join(highlightDir, "published-history.json");
  const history = (await exists(historyPath)) ? JSON.parse(await fs.readFile(historyPath, "utf8")) : { schema_version: 1, events: [] };
  if (history.schema_version !== 1 || !Array.isArray(history.events)) throw new Error("published history must contain schema_version 1 and events");
  history.events.push(event);
  await writeJson(historyPath, history);
}

async function collectFiles(directory) {
  if (!(await exists(directory))) return [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(target)));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(target);
  }
  return files;
}

function collectHeadings(markdown) {
  return new Set([...markdown.matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)\s*#*\s*$/gm)].map((match) => match[1].replace(/[`*_~]/g, "").trim()));
}

function resolveInside(root, relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.includes("\\") || relativePath.includes("\0")) throw new Error(`${label} must be a safe relative path`);
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay inside ${root}`);
  return target;
}

function assertImmutableAssetPath(assetPath, revision, label) {
  if (assetPath.startsWith("/") || assetPath.includes("\\") || assetPath.includes("..") || assetPath.includes("?") || assetPath.includes("#")) throw new Error(`${label} must use an immutable revision path`);
  if (!assetPath.startsWith(`revisions/${revision}/`)) throw new Error(`${label} must stay under revisions/${revision}`);
}

function parseFps(value) {
  if (typeof value !== "string") return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function assertSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new Error(`${label} must be a 40-character SHA`);
}

function isDigest(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function assertFileRecord(record, label) {
  if (!record || typeof record.path !== "string" || !Number.isInteger(record.bytes) || record.bytes <= 0 || typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) {
    throw new Error(`${label} requires path, positive bytes, and SHA-256`);
  }
}

function assertCompanionRecord(record, revision, label, fileName) {
  assertFileRecord(record, label);
  if (record.path !== `revisions/${revision}/${fileName}`) {
    throw new Error(`${label} must use revisions/${revision}/${fileName}`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function escapeMarkdown(value) {
  return String(value).replace(/[\\[\]]/g, "\\$&");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export async function runHighlightsCli(argv = process.argv.slice(2), {
  repoRoot = process.cwd(),
  log = console.log,
  pipelineRunner,
} = {}) {
  const [command, ...args] = argv;
  const highlightsDir = path.join(repoRoot, HIGHLIGHTS_RELATIVE_DIR);
  if (command === "validate") {
    const parsed = parseCliArgs(args, new Set(["scenario", "allow-extension", "dry-run"]));
    const scenarioPath = parsed.values.scenario ?? parsed.positionals[0];
    if (parsed.positionals.length > (parsed.values.scenario ? 0 : 1)) throw new Error("validate accepts at most one scenario path");
    if (scenarioPath) {
      const allowedExtensionIds = parsed.repeated["allow-extension"] ?? [];
      const scenario = await readScenario(path.resolve(repoRoot, scenarioPath), { allowedExtensionIds });
      const digest = computeScenarioDigest(scenario, { allowedExtensionIds });
      log(`Validated scenario ${scenario.id} (${digest}).`);
      if (parsed.flags.has("dry-run")) log("Dry run: validation completed; capture/render/QA were not started.");
    } else {
      const result = await validateHighlights({ repoRoot, highlightsDir });
      log(`Validated ${result.count} Highlights (${result.activeCount} active, ${result.queuedCount} queued).`);
    }
  } else if (command === "scaffold") {
    const parsed = parseCliArgs(args, new Set(["id", "title", "profile", "dry-run"]));
    if (parsed.positionals.length !== 1 || !parsed.values.id) throw new Error("usage: highlights.mjs scaffold <scenario.json> --id <id> [--title <title>] [--profile desktop|native-mobile] [--dry-run]");
    const result = await writeScenarioScaffold({
      destination: path.resolve(repoRoot, parsed.positionals[0]),
      id: parsed.values.id,
      title: parsed.values.title,
      profileKind: parsed.values.profile ?? "desktop",
      dryRun: parsed.flags.has("dry-run"),
    });
    if (result.dryRun) {
      log(`Dry run: would create ${result.destination}\n${result.contents}`);
    } else {
      log(`Created scenario ${result.scenario.id} at ${result.destination}.`);
    }
  } else if (command === "storyboard") {
    const parsed = parseCliArgs(args, new Set(["format", "output", "allow-extension", "dry-run"]));
    if (parsed.positionals.length !== 1) throw new Error("usage: highlights.mjs storyboard <scenario.json> [--format markdown|json] [--output <file>] [--dry-run]");
    const allowedExtensionIds = parsed.repeated["allow-extension"] ?? [];
    const scenario = await readScenario(path.resolve(repoRoot, parsed.positionals[0]), { allowedExtensionIds });
    const timeline = compileTimeline(scenario, { allowedExtensionIds });
    const format = parsed.values.format ?? "markdown";
    const output = renderStoryboard(timeline, { format });
    if (parsed.flags.has("dry-run")) log("Dry run: storyboard compiled; capture/render/QA were not started.");
    if (parsed.values.output && !parsed.flags.has("dry-run")) {
      const outputPath = path.resolve(repoRoot, parsed.values.output);
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      try {
        await fs.writeFile(outputPath, output, { flag: "wx" });
      } catch (error) {
        if (error.code === "EEXIST") throw new Error(`refusing to overwrite storyboard: ${outputPath}`);
        throw error;
      }
      log(`Wrote ${format} storyboard to ${outputPath}.`);
    } else {
      log(output.trimEnd());
    }
  } else if (["capture", "render", "qa", "run"].includes(command)) {
    const capturesSource = command === "capture" || command === "run";
    const allowed = capturesSource
      ? new Set(["artifact-root", "source", "landing-root", "run-id", "pr-number", "pr-base-sha", "allow-extension", "dry-run"])
      : new Set(["artifact-root", "landing-root", "run-id", "allow-extension", "dry-run"]);
    const parsed = parseCliArgs(args, allowed);
    if (parsed.positionals.length !== 1 || !parsed.values["artifact-root"] || (capturesSource && !parsed.values.source)) {
      throw new Error(`usage: highlights.mjs ${command} <scenario.json> --artifact-root <external-directory>${capturesSource ? " --source pr_head|current_main" : ""} [--landing-root <landing-repo>] [--run-id <id>] [--dry-run]`);
    }
    if (capturesSource && !ALLOWED_CAPTURE_MODES.has(parsed.values.source)) {
      throw new Error(`${command} --source must be pr_head or current_main`);
    }
    let prNumber;
    if (parsed.values["pr-number"] !== undefined) {
      prNumber = Number(parsed.values["pr-number"]);
      if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error("--pr-number must be a positive integer");
    }
    if (parsed.values["pr-base-sha"] !== undefined && !/^[a-f0-9]{40}$/.test(parsed.values["pr-base-sha"])) {
      throw new Error("--pr-base-sha must be an exact lowercase 40-character Git SHA");
    }
    const execute = pipelineRunner ?? (await import("./highlights/pipeline.mjs")).runDeclarativeHighlightCommand;
    const result = await execute({
      command,
      scenarioPath: path.resolve(repoRoot, parsed.positionals[0]),
      artifactRoot: path.resolve(repoRoot, parsed.values["artifact-root"]),
      source: parsed.values.source,
      landingRoot: parsed.values["landing-root"] ? path.resolve(repoRoot, parsed.values["landing-root"]) : undefined,
      runId: parsed.values["run-id"],
      prNumber,
      prBaseSha: parsed.values["pr-base-sha"],
      allowedExtensionIds: parsed.repeated["allow-extension"] ?? [],
      dryRun: parsed.flags.has("dry-run"),
      repoRoot,
    });
    log(JSON.stringify(result, null, 2));
  } else if (command === "digest") {
    if (!args[0]) throw new Error("usage: highlights.mjs digest <highlight-directory|scenario.json>");
    const target = path.resolve(repoRoot, args[0]);
    const stat = await fs.lstat(target);
    if (stat.isFile()) {
      const scenario = await readScenario(target);
      log(computeScenarioDigest(scenario));
    } else {
      log(await computeSourceDigest(target));
    }
  } else if (command === "promote") {
    const parsed = parseCliArgs(args, new Set(["allow-extension", "dry-run"]));
    if (parsed.positionals.length !== 1) throw new Error("usage: highlights.mjs promote <stage.json|legacy-highlight-directory> [--dry-run]");
    const target = path.resolve(repoRoot, parsed.positionals[0]);
    const stat = await fs.lstat(target);
    if (stat.isFile()) {
      const allowedExtensionIds = parsed.repeated["allow-extension"] ?? [];
      const { promoteStagedHighlight, readStageManifest } = await import("./highlights/stage.mjs");
      if (parsed.flags.has("dry-run")) {
        const staged = await readStageManifest(target, { repoRoot, allowedExtensionIds });
        log(`Dry run: stage ${staged.manifest.highlight.id}/${staged.manifest.revision} has accepted QA and verified digest ${staged.manifest.stageDigest}; repository unchanged.`);
      } else {
        log(JSON.stringify(await promoteStagedHighlight({ manifestPath: target, repoRoot, highlightsDir, allowedExtensionIds }), null, 2));
      }
    } else {
      if (parsed.flags.has("dry-run")) throw new Error("legacy directory promotion does not support --dry-run; use a content-addressed stage manifest");
      log(JSON.stringify(await promoteHighlight({ highlightDir: target }), null, 2));
    }
  } else if (command === "activate") {
    if (!args[0] || !args[1]) throw new Error("usage: highlights.mjs activate <highlight-directory> <release-version>");
    log(JSON.stringify(await activateHighlight({ highlightDir: path.resolve(repoRoot, args[0]), releaseVersion: args[1] }), null, 2));
  } else if (command === "activate-release") {
    if (!args[0]) throw new Error("usage: highlights.mjs activate-release <release-version>");
    log(JSON.stringify(await activateHighlightsForRelease({ highlightsDir, releaseVersion: args[0] }), null, 2));
  } else if (command === "withdraw") {
    if (!args[0] || args.length < 2) throw new Error("usage: highlights.mjs withdraw <highlight-directory> <reason>");
    log(JSON.stringify(await withdrawHighlight({ highlightDir: path.resolve(repoRoot, args[0]), reason: args.slice(1).join(" ") }), null, 2));
  } else {
    throw new Error("usage: highlights.mjs scaffold|validate [scenario]|storyboard|capture|render|qa|run|digest|promote|activate|activate-release|withdraw");
  }
}

function parseCliArgs(args, allowedOptions) {
  const positionals = [];
  const values = {};
  const repeated = {};
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!allowedOptions.has(name)) throw new Error(`unknown option --${name}`);
    if (name === "dry-run") {
      if (flags.has(name)) throw new Error(`--${name} may be specified only once`);
      flags.add(name);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    index += 1;
    if (name === "allow-extension") {
      (repeated[name] ??= []).push(value);
    } else if (values[name] !== undefined) {
      throw new Error(`--${name} may be specified only once`);
    } else {
      values[name] = value;
    }
  }
  return { positionals, values, repeated, flags };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runHighlightsCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
