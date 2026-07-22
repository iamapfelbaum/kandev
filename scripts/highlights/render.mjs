import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { assertExternalArtifactRoot, assertPathInside } from "./source-gate.mjs";

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

function requireSegment(value, label) {
  if (typeof value !== "string" || !SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`${label} must be a safe path segment`);
  }
  return value;
}

function encodingInput({ scenario, capture, camera, track, stageDir }) {
  const profile = camera.captureProfile;
  if (!profile || !Number.isInteger(profile.sourceWidth) || !Number.isInteger(profile.deliveryWidth)) {
    throw new Error("camera plan needs exact captureProfile dimensions");
  }
  const mobile = camera.profile === "native-mobile" || scenario.profile?.kind === "native-mobile";
  return {
    slug: `${mobile ? "mobile" : "desktop"}-${scenario.id}`,
    rawPath: capture.rawPath,
    outputDir: stageDir,
    trimStartMs: capture.storyStartOffsetMs ?? 0,
    posterAtMs: capture.posterAtMs ?? Math.max(
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
  return value.path ?? value.outputPath ?? value.output?.path ?? value.output?.outputPath ?? null;
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
      candidate = artifactPath(result?.[alias])
        ?? artifactPath(result?.plan?.[alias])
        ?? artifactPath(result?.outputs?.[alias]);
      if (candidate) break;
    }
    if (candidate) artifacts.push({ kind, path: candidate });
  }
  if (artifacts.length === 0 && Array.isArray(result?.artifacts)) {
    for (const artifact of result.artifacts) {
      if (artifact?.kind && artifactPath(artifact)) artifacts.push({ kind: artifact.kind, path: artifactPath(artifact) });
    }
  }
  if (artifacts.length === 0) throw new Error("landing encoder returned no delivery artifact paths");
  return artifacts.sort((left, right) => left.kind.localeCompare(right.kind));
}

async function reserveStage(stageDir) {
  await mkdir(path.dirname(stageDir), { recursive: true });
  try {
    await mkdir(stageDir);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`refusing to overwrite existing render stage: ${stageDir}`);
    throw error;
  }
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
} = {}) {
  if (!scenario || typeof scenario !== "object") throw new Error("render needs scenario");
  requireSegment(scenario.id, "scenario id");
  requireSegment(runId, "runId");
  if (!capture || typeof capture.rawPath !== "string" || capture.rawPath.trim() === "") {
    throw new Error("render needs capture.rawPath");
  }
  if (camera?.contract !== "kandev-highlight-camera-plan-v1") {
    throw new Error("render needs kandev-highlight-camera-plan-v1");
  }
  if (!landingAdapter || typeof landingAdapter.materializeCameraTrack !== "function") {
    throw new Error("render needs landing Highlight camera materializer");
  }
  if (landingAdapter.provenance?.clean === false) throw new Error("landing adapter worktree must be clean");
  const externalRoot = assertExternalArtifactRoot({ artifactRoot, repoRoots });
  const stageDir = path.join(externalRoot, scenario.id, runId);
  const track = landingAdapter.materializeCameraTrack(camera);
  if (!track || typeof track !== "object") throw new Error("landing camera materializer returned no track");
  const config = encodingInput({ scenario, capture, camera, track, stageDir });

  if (dryRun) {
    if (typeof landingAdapter.buildHighlightEncodingPlan !== "function") {
      throw new Error("dry-run needs landing buildHighlightEncodingPlan export");
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
  await reserveStage(stageDir);
  const encoded = await landingAdapter.encodeHighlight(config);
  const artifacts = artifactsFromResult(encoded);
  const normalizedArtifacts = [];
  for (const artifact of artifacts) {
    const absolute = assertPathInside(stageDir, artifact.path, `${artifact.kind} artifact`);
    await access(absolute);
    normalizedArtifacts.push({ kind: artifact.kind, path: path.relative(stageDir, absolute) });
  }
  const manifest = {
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
    artifacts: normalizedArtifacts,
  };
  const manifestPath = path.join(stageDir, "render-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { stageDir, manifestPath, manifest, cameraTrack: track, encoded };
}
