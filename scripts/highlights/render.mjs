import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertExternalArtifactRoot,
  assertPathInside,
} from "./source-gate.mjs";

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;
const REQUIRED_ARTIFACT_KINDS = ["mp4", "poster", "webm"];

function requireSegment(value, label) {
  if (
    typeof value !== "string" ||
    !SAFE_SEGMENT.test(value) ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`${label} must be a safe path segment`);
  }
  return value;
}

function encodingInput({ scenario, capture, camera, track, stageDir }) {
  const profile = camera.captureProfile;
  if (
    !profile ||
    !Number.isInteger(profile.sourceWidth) ||
    !Number.isInteger(profile.deliveryWidth)
  ) {
    throw new Error("camera plan needs exact captureProfile dimensions");
  }
  const mobile =
    camera.profile === "native-mobile" ||
    scenario.profile?.kind === "native-mobile";
  return {
    slug: `${mobile ? "mobile" : "desktop"}-${scenario.id}`,
    rawPath: capture.rawPath,
    outputDir: stageDir,
    trimStartMs: capture.storyStartOffsetMs ?? 0,
    posterAtMs:
      capture.posterAtMs ??
      Math.max(
        camera.openingSettleMs ?? 400,
        camera.durationMs - (camera.endingSettleMs ?? 400),
      ),
    sourceWidth: profile.sourceWidth,
    sourceHeight: profile.sourceHeight,
    outputWidth: profile.deliveryWidth,
    outputHeight: profile.deliveryHeight,
    track,
  };
}

function artifactPath(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return (
    value.path ??
    value.outputPath ??
    value.output?.path ??
    value.output?.outputPath ??
    null
  );
}

function artifactsFromResult(result) {
  const artifacts = [];
  for (const [kind, aliases] of Object.entries({
    mp4: ["mp4"],
    poster: ["poster", "webp"],
    webm: ["webm"],
  })) {
    let candidate = null;
    for (const alias of aliases) {
      candidate =
        artifactPath(result?.[alias]) ??
        artifactPath(result?.plan?.[alias]) ??
        artifactPath(result?.outputs?.[alias]);
      if (candidate) break;
    }
    if (candidate) artifacts.push({ kind, path: candidate });
  }
  if (artifacts.length === 0 && Array.isArray(result?.artifacts)) {
    for (const artifact of result.artifacts) {
      if (artifact?.kind && artifactPath(artifact))
        artifacts.push({ kind: artifact.kind, path: artifactPath(artifact) });
    }
  }
  if (artifacts.length === 0)
    throw new Error("landing encoder returned no delivery artifact paths");
  return artifacts.sort((left, right) => left.kind.localeCompare(right.kind));
}

function requireExactArtifacts(artifacts) {
  const counts = new Map();
  for (const artifact of artifacts) {
    counts.set(artifact.kind, (counts.get(artifact.kind) ?? 0) + 1);
  }
  const exact =
    artifacts.length === REQUIRED_ARTIFACT_KINDS.length &&
    REQUIRED_ARTIFACT_KINDS.every((kind) => counts.get(kind) === 1) &&
    [...counts.keys()].every((kind) => REQUIRED_ARTIFACT_KINDS.includes(kind));
  if (!exact) {
    throw new Error(
      "landing encoder must return exactly one mp4, poster, and webm artifact",
    );
  }
}

async function lstatOrNull(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

async function inspectArtifacts(
  root,
  artifacts,
  { verifyEvidence = false } = {},
) {
  const lexical = artifacts.map((artifact) => {
    if (verifyEvidence && path.isAbsolute(artifact.path)) {
      throw new Error(
        `${artifact.kind} artifact manifest path is not relative`,
      );
    }
    const candidate = verifyEvidence
      ? path.resolve(root, artifact.path)
      : artifact.path;
    return {
      artifact,
      absolute: assertPathInside(root, candidate, `${artifact.kind} artifact`),
    };
  });
  requireExactArtifacts(artifacts);
  if (
    new Set(lexical.map(({ absolute }) => absolute)).size !== lexical.length
  ) {
    throw new Error(
      "landing encoder delivery artifacts must use distinct files",
    );
  }

  const canonicalRoot = await realpath(root);
  const evidence = [];
  for (const { artifact, absolute } of lexical) {
    const stat = await lstatOrNull(absolute);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        `${artifact.kind} artifact must be a regular non-symlink file`,
      );
    }
    const canonical = await realpath(absolute);
    if (!isInside(canonicalRoot, canonical)) {
      throw new Error(
        `${artifact.kind} artifact resolves outside reserved stage`,
      );
    }
    const relative = path.relative(root, absolute);
    if (verifyEvidence && artifact.path !== relative) {
      throw new Error(
        `${artifact.kind} artifact manifest path is not canonical`,
      );
    }
    const actual = {
      kind: artifact.kind,
      path: relative,
      bytes: stat.size,
      digest: await sha256(absolute),
    };
    if (verifyEvidence && artifact.bytes !== actual.bytes) {
      throw new Error(
        `${artifact.kind} artifact bytes do not match render manifest`,
      );
    }
    if (verifyEvidence && artifact.digest !== actual.digest) {
      throw new Error(
        `${artifact.kind} artifact digest does not match render manifest`,
      );
    }
    evidence.push(actual);
  }
  return evidence.sort((left, right) => left.kind.localeCompare(right.kind));
}

async function walkTree(
  root,
  current = root,
  result = { files: [], directories: [] },
) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      throw new Error(`render stage contains symlink: ${relative}`);
    }
    if (stat.isDirectory()) {
      result.directories.push(relative);
      await walkTree(root, absolute, result);
    } else if (stat.isFile()) {
      result.files.push(relative);
    } else {
      throw new Error(
        `render stage contains unsupported filesystem entry: ${relative}`,
      );
    }
  }
  return result;
}

function expectedDirectories(files) {
  const directories = new Set();
  for (const file of files) {
    let directory = path.dirname(file);
    while (directory !== ".") {
      directories.add(directory);
      directory = path.dirname(directory);
    }
  }
  return directories;
}

async function requireExactTree(root, expectedFiles) {
  const expected = new Set(expectedFiles);
  const allowedDirectories = expectedDirectories(expectedFiles);
  const tree = await walkTree(root);
  for (const file of tree.files) {
    if (!expected.has(file)) throw new Error(`unexpected render file: ${file}`);
  }
  for (const file of expected) {
    if (!tree.files.includes(file))
      throw new Error(`missing render file: ${file}`);
  }
  for (const directory of tree.directories) {
    if (!allowedDirectories.has(directory)) {
      throw new Error(`unexpected render directory: ${directory}`);
    }
  }
}

function manifestFor({
  scenario,
  runId,
  capture,
  camera,
  track,
  landingAdapter,
  config,
  artifacts,
}) {
  return {
    contract: "kandev-highlight-render-v1",
    scenarioId: scenario.id,
    runId,
    capture: {
      rawPath: capture.rawPath,
      digest: capture.digest ?? null,
      storyStartOffsetMs: config.trimStartMs,
    },
    cameraPlanContract: camera.contract,
    cameraTrackContract: track.contract ?? null,
    landingSha: landingAdapter.provenance?.sha ?? null,
    profile: camera.profile,
    dimensions: {
      source: { width: config.sourceWidth, height: config.sourceHeight },
      delivery: { width: config.outputWidth, height: config.outputHeight },
    },
    artifacts,
  };
}

function normalizedEncoded(stageDir, artifacts) {
  return Object.fromEntries(
    artifacts.map((artifact) => [
      artifact.kind,
      { path: path.join(stageDir, artifact.path) },
    ]),
  );
}

async function cleanupOwnedBuild(buildDir, ownership) {
  const current = await lstatOrNull(buildDir);
  if (!current) return;
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== ownership.dev ||
    current.ino !== ownership.ino
  ) {
    throw new Error(
      `refusing to clean replaced render build directory: ${buildDir}`,
    );
  }
  await rm(buildDir, { recursive: true, force: true });
}

async function requireOwnedBuild(buildDir, ownership) {
  const current = await lstatOrNull(buildDir);
  if (
    !current?.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== ownership.dev ||
    current.ino !== ownership.ino
  ) {
    throw new Error(
      `refusing to use replaced render build directory: ${buildDir}`,
    );
  }
}

async function recoverStage({
  stageDir,
  scenario,
  runId,
  capture,
  camera,
  track,
  landingAdapter,
  config,
}) {
  const stageStat = await lstatOrNull(stageDir);
  if (!stageStat)
    throw new Error(`published render stage does not exist: ${stageDir}`);
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) {
    throw new Error(
      `published render stage must be a regular directory: ${stageDir}`,
    );
  }
  const manifestPath = path.join(stageDir, "render-manifest.json");
  const manifestStat = await lstatOrNull(manifestPath);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error(
      "published render manifest must be a regular non-symlink file",
    );
  }
  const canonicalStage = await realpath(stageDir);
  const canonicalManifest = await realpath(manifestPath);
  if (!isInside(canonicalStage, canonicalManifest)) {
    throw new Error("published render manifest resolves outside render stage");
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `published render manifest is invalid JSON: ${error.message}`,
    );
  }
  if (!Array.isArray(manifest?.artifacts)) {
    throw new Error("published render manifest needs delivery artifacts");
  }
  const expectedIdentity = manifestFor({
    scenario,
    runId,
    capture,
    camera,
    track,
    landingAdapter,
    config,
    artifacts: [],
  });
  if (!isDeepStrictEqual({ ...manifest, artifacts: [] }, expectedIdentity)) {
    throw new Error(
      "published render manifest identity does not match requested render",
    );
  }
  const artifacts = await inspectArtifacts(stageDir, manifest.artifacts, {
    verifyEvidence: true,
  });
  if (!isDeepStrictEqual(manifest.artifacts, artifacts)) {
    throw new Error(
      "published render manifest artifact evidence is not canonical",
    );
  }
  await requireExactTree(stageDir, [
    ...artifacts.map((artifact) => artifact.path),
    "render-manifest.json",
  ]);
  return {
    stageDir,
    manifestPath,
    manifest,
    cameraTrack: track,
    encoded: normalizedEncoded(stageDir, artifacts),
    recovered: true,
  };
}

export async function renderHighlight({
  scenario,
  capture,
  camera,
  artifactRoot,
  runId,
  repoRoots = [],
  landingAdapter,
  dryRun = false,
  recoverPublished = false,
} = {}) {
  if (!scenario || typeof scenario !== "object")
    throw new Error("render needs scenario");
  requireSegment(scenario.id, "scenario id");
  requireSegment(runId, "runId");
  if (
    !capture ||
    typeof capture.rawPath !== "string" ||
    capture.rawPath.trim() === ""
  ) {
    throw new Error("render needs capture.rawPath");
  }
  if (camera?.contract !== "kandev-highlight-camera-plan-v1") {
    throw new Error("render needs kandev-highlight-camera-plan-v1");
  }
  if (
    !landingAdapter ||
    typeof landingAdapter.materializeCameraTrack !== "function"
  ) {
    throw new Error("render needs landing Highlight camera materializer");
  }
  if (landingAdapter.provenance?.clean === false)
    throw new Error("landing adapter worktree must be clean");
  const externalRoot = assertExternalArtifactRoot({ artifactRoot, repoRoots });
  const stageDir = path.join(externalRoot, scenario.id, runId);
  const track = landingAdapter.materializeCameraTrack(camera);
  if (!track || typeof track !== "object")
    throw new Error("landing camera materializer returned no track");
  const config = encodingInput({ scenario, capture, camera, track, stageDir });

  if (dryRun) {
    if (typeof landingAdapter.buildHighlightEncodingPlan !== "function") {
      throw new Error(
        "dry-run needs landing buildHighlightEncodingPlan export",
      );
    }
    return {
      contract: "kandev-highlight-render-dry-run-v1",
      dryRun: true,
      stageDir,
      cameraTrack: track,
      encodingInput: config,
      encodingPlan: landingAdapter.buildHighlightEncodingPlan(config),
    };
  }
  if (typeof landingAdapter.encodeHighlight !== "function") {
    throw new Error("render needs landing encodeHighlight export");
  }
  const existing = await lstatOrNull(stageDir);
  if (recoverPublished && existing) {
    return recoverStage({
      stageDir,
      scenario,
      runId,
      capture,
      camera,
      track,
      landingAdapter,
      config,
    });
  }
  if (existing)
    throw new Error(`refusing to overwrite existing render stage: ${stageDir}`);

  const stageParent = path.dirname(stageDir);
  await mkdir(stageParent, { recursive: true });
  if (await lstatOrNull(stageDir)) {
    throw new Error(`refusing to overwrite existing render stage: ${stageDir}`);
  }
  let buildDir = await mkdtemp(path.join(stageParent, ".building-"));
  const ownership = await lstat(buildDir);
  try {
    const buildConfig = encodingInput({
      scenario,
      capture,
      camera,
      track,
      stageDir: buildDir,
    });
    const encoded = await landingAdapter.encodeHighlight(buildConfig);
    await requireOwnedBuild(buildDir, ownership);
    const artifacts = artifactsFromResult(encoded);
    const normalizedArtifacts = await inspectArtifacts(buildDir, artifacts);
    await requireExactTree(
      buildDir,
      normalizedArtifacts.map((artifact) => artifact.path),
    );
    const manifest = manifestFor({
      scenario,
      runId,
      capture,
      camera,
      track,
      landingAdapter,
      config: buildConfig,
      artifacts: normalizedArtifacts,
    });
    const buildManifestPath = path.join(buildDir, "render-manifest.json");
    await writeFile(
      buildManifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    await requireExactTree(buildDir, [
      ...normalizedArtifacts.map((artifact) => artifact.path),
      "render-manifest.json",
    ]);
    await requireOwnedBuild(buildDir, ownership);
    if (await lstatOrNull(stageDir)) {
      throw new Error(
        `refusing to overwrite existing render stage: ${stageDir}`,
      );
    }
    try {
      await rename(buildDir, stageDir);
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY", "EISDIR"].includes(error.code)) {
        throw new Error(
          `refusing to overwrite existing render stage: ${stageDir}`,
        );
      }
      throw error;
    }
    buildDir = null;
    const manifestPath = path.join(stageDir, "render-manifest.json");
    return {
      stageDir,
      manifestPath,
      manifest,
      cameraTrack: track,
      encoded: normalizedEncoded(stageDir, normalizedArtifacts),
    };
  } catch (error) {
    if (buildDir) {
      try {
        await cleanupOwnedBuild(buildDir, ownership);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "render transaction failed and its private build directory could not be cleaned",
        );
      }
    }
    throw error;
  }
}
