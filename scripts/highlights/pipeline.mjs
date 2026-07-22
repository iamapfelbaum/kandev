import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  compileCamera as defaultCompileCamera,
  resolveCaptureProfile,
} from "./camera-compiler.mjs";
import { loadLandingAdapter as defaultLoadLandingAdapter } from "./landing-adapter.mjs";
import {
  normalizeExecutionGeometry,
  runQualityAssurance as defaultRunQualityAssurance,
} from "./qa.mjs";
import { renderHighlight as defaultRenderHighlight } from "./render.mjs";
import { runHighlightPipeline } from "./runner.mjs";
import * as scenarioContract from "./scenario.mjs";
import { computeStageManifestDigest } from "./stage.mjs";
import {
  assertExternalArtifactRoot,
  verifySourceGate as defaultVerifySourceGate,
} from "./source-gate.mjs";
import { runBrowserPlaybackQa } from "./browser-qa.mjs";

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REQUIRED_DELIVERY_KINDS = Object.freeze(["mp4", "poster", "webm"]);

export const HIGHLIGHT_PIPELINE_VERSION = "1.0.0";

async function defaultCommandRunner(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return { ...result, exitCode: 0 };
}

async function defaultCaptureScenario(input) {
  let capture;
  try {
    capture = await import("./capture-source.mjs");
  } catch (error) {
    throw new Error(
      `permanent Highlight capture harness is unavailable: ${error.message}`,
      { cause: error },
    );
  }
  if (typeof capture.captureScenario !== "function") {
    throw new Error(
      "permanent Highlight capture harness must export captureScenario",
    );
  }
  return capture.captureScenario(input);
}

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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath) {
  return sha256(await fs.readFile(filePath));
}

function requireSafeSegment(value, label) {
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

function dependenciesWithDefaults(dependencies) {
  return {
    readScenario: scenarioContract.readScenario,
    compileTimeline: scenarioContract.compileTimeline,
    computeScenarioDigest: scenarioContract.computeScenarioDigest,
    requireDeliveryMetadata: scenarioContract.requireDeliveryMetadata,
    verifySourceGate: defaultVerifySourceGate,
    loadLandingAdapter: defaultLoadLandingAdapter,
    compileCamera: defaultCompileCamera,
    captureScenario: defaultCaptureScenario,
    renderHighlight: defaultRenderHighlight,
    runQualityAssurance: defaultRunQualityAssurance,
    browserPlayback: runBrowserPlaybackQa,
    commandRunner: defaultCommandRunner,
    readFile: fs.readFile,
    clock: () => new Date(),
    ...dependencies,
  };
}

function requireDelivery(deps, scenario) {
  if (typeof deps.requireDeliveryMetadata !== "function") {
    throw new Error(
      "scenario delivery metadata contract is unavailable; update scripts/highlights/scenario.mjs",
    );
  }
  return deps.requireDeliveryMetadata(scenario);
}

function requiredPrimitiveIds(scenario) {
  return [
    ...(scenario.setup?.primitives ?? []).map(
      (primitive) => primitive.primitiveId,
    ),
    ...(scenario.story?.actions ?? [])
      .filter((action) => action.kind === "extension")
      .map((action) => action.primitiveId),
  ];
}

function validateCaptureBindings({ scenario, bindings, allowedExtensionIds }) {
  if (!bindings || typeof bindings !== "object") {
    throw new Error(
      "capture requires checked-in app bindings with seedRegistry, primitiveRegistry, and navigateRoute",
    );
  }
  if (typeof bindings.seedRegistry?.[scenario.seed.recipe] !== "function") {
    throw new Error(
      `capture seed recipe '${scenario.seed.recipe}' has no checked-in binding`,
    );
  }
  if (scenario.setup?.route && typeof bindings.navigateRoute !== "function") {
    throw new Error(
      `capture route '${scenario.setup.route}' has no allowlisted navigateRoute binding`,
    );
  }
  if (
    bindings.buildProvenance?.contract !==
    "kandev-highlight-build-provenance-v1"
  ) {
    throw new Error(
      "capture bindings need exact current-checkout buildProvenance",
    );
  }
  const allowed = new Set(allowedExtensionIds);
  for (const primitiveId of requiredPrimitiveIds(scenario)) {
    if (!allowed.has(primitiveId))
      throw new Error(
        `primitive '${primitiveId}' is not present in --allow-extension`,
      );
    if (typeof bindings.primitiveRegistry?.[primitiveId] !== "function") {
      throw new Error(
        `primitive '${primitiveId}' has no checked-in binding function`,
      );
    }
  }
  return bindings;
}

function defaultRunId(scenarioDigest) {
  return `run-${scenarioDigest.slice("sha256:".length, "sha256:".length + 12)}`;
}

function pipelinePaths({ artifactRoot, scenarioId, runId }) {
  const runsRoot = path.join(artifactRoot, scenarioId, "runs");
  const attemptRoot = path.join(runsRoot, runId);
  return {
    artifactRoot,
    runsRoot,
    attemptRoot,
    evidenceRoot: path.join(attemptRoot, "evidence"),
    captureRoot: path.join(attemptRoot, "capture"),
    renderRoot: path.join(attemptRoot, "render"),
    qaRoot: path.join(attemptRoot, "qa"),
    stageRoot: path.join(artifactRoot, scenarioId, "stages"),
  };
}

async function rejectSymlinkComponents(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs
      .lstat(current)
      .catch((error) =>
        error.code === "ENOENT" ? null : Promise.reject(error),
      );
    if (!stat) return;
    if (stat.isSymbolicLink())
      throw new Error(
        `artifact path cannot contain symlink components: ${current}`,
      );
  }
}

async function reserveAttempt(paths) {
  await rejectSymlinkComponents(paths.artifactRoot);
  await fs.mkdir(paths.runsRoot, { recursive: true });
  try {
    await fs.mkdir(paths.attemptRoot);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `refusing to overwrite existing Highlight run ${paths.attemptRoot}`,
      );
    throw error;
  }
  await fs.mkdir(paths.evidenceRoot);
}

async function writeJsonExclusive(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`refusing to overwrite immutable manifest: ${filePath}`);
    throw error;
  }
  return filePath;
}

async function writePhaseRecord(paths, phase, value, deps) {
  const record = {
    contract: `kandev-highlight-${phase}-phase-v1`,
    phase,
    completedAt: deps.clock().toISOString(),
    value,
  };
  const manifestPath = await writeJsonExclusive(
    path.join(paths.evidenceRoot, `${phase}.json`),
    record,
  );
  return { ...value, phaseManifestPath: manifestPath };
}

async function readJsonRegular(filePath, label) {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink())
    throw new Error(
      `${label} is missing or is not a regular file: ${filePath}`,
    );
  if ((await fs.realpath(filePath)) !== path.resolve(filePath))
    throw new Error(`${label} cannot resolve through symlinks: ${filePath}`);
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label} ${filePath}: ${error.message}`);
  }
}

export async function resolveAttemptDirectory({
  artifactRoot,
  scenarioId,
  runId,
} = {}) {
  requireSafeSegment(scenarioId, "scenarioId");
  const root = path.join(path.resolve(artifactRoot), scenarioId, "runs");
  if (runId) {
    requireSafeSegment(runId, "runId");
    const selected = path.join(root, runId);
    const stat = await fs.lstat(selected).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Highlight run '${runId}' does not exist: ${selected}`);
    if ((await fs.realpath(selected)) !== path.resolve(selected))
      throw new Error(`Highlight run '${runId}' resolves through a symlink`);
    return selected;
  }
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch((error) => {
      if (error.code === "ENOENT")
        throw new Error(`no recoverable Highlight runs found under ${root}`);
      throw error;
    });
  const runs = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  if (runs.length === 0)
    throw new Error(`no recoverable Highlight runs found under ${root}`);
  if (runs.length > 1)
    throw new Error(
      `multiple Highlight runs found (${runs.join(", ")}); select one with --run-id`,
    );
  return path.join(root, runs[0]);
}

function parsePositiveInteger(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

async function defaultResolvePrMetadata({
  repoRoot,
  sourceSha,
  prNumber,
  prBaseSha,
  env,
  runner,
}) {
  const explicitNumber = parsePositiveInteger(
    prNumber ?? env.KANDEV_HIGHLIGHT_PR_NUMBER,
  );
  const explicitBase = prBaseSha ?? env.KANDEV_HIGHLIGHT_PR_BASE_SHA;
  if (explicitNumber && SHA_PATTERN.test(explicitBase ?? "")) {
    return {
      prNumber: explicitNumber,
      prBaseSha: explicitBase,
      prHeadSha: sourceSha,
    };
  }
  try {
    const result = await runner(
      "gh",
      ["pr", "view", "--json", "number,baseRefOid,headRefOid"],
      { cwd: repoRoot },
    );
    const parsed = JSON.parse(result.stdout);
    if (
      !parsePositiveInteger(parsed.number) ||
      !SHA_PATTERN.test(parsed.baseRefOid ?? "") ||
      parsed.headRefOid !== sourceSha
    ) {
      throw new Error("GitHub PR metadata does not match checked-out HEAD");
    }
    return {
      prNumber: parsed.number,
      prBaseSha: parsed.baseRefOid,
      prHeadSha: parsed.headRefOid,
    };
  } catch (error) {
    const missing = [];
    if (!explicitNumber) missing.push("--pr-number <number>");
    if (!SHA_PATTERN.test(explicitBase ?? ""))
      missing.push("--pr-base-sha <40-char-sha>");
    throw new Error(
      `pr_head provenance needs ${missing.join(" and ")}; automatic 'gh pr view' lookup failed: ${error.message}`,
      { cause: error },
    );
  }
}

async function resolveSourceProvenance({
  source,
  repoRoot,
  prNumber,
  prBaseSha,
  env,
  deps,
  capturedAt,
}) {
  const gate = await deps.verifySourceGate({
    repoRoot,
    source,
    runner: deps.commandRunner,
  });
  if (!SHA_PATTERN.test(gate?.selectedSha ?? "") || gate.clean !== true) {
    throw new Error("source gate must return an exact clean selected SHA");
  }
  if (source === "pr_head") {
    const resolver = deps.resolvePrMetadata ?? defaultResolvePrMetadata;
    const pr = await resolver({
      repoRoot,
      sourceSha: gate.selectedSha,
      prNumber,
      prBaseSha,
      env,
      runner: deps.commandRunner,
    });
    if (
      !parsePositiveInteger(pr?.prNumber) ||
      !SHA_PATTERN.test(pr?.prBaseSha ?? "") ||
      pr?.prHeadSha !== gate.selectedSha
    ) {
      throw new Error(
        "pr_head metadata must include matching PR number, base SHA, and head SHA",
      );
    }
    return {
      captureMode: source,
      sourceSha: gate.selectedSha,
      capturedAt,
      prNumber: pr.prNumber,
      prBaseSha: pr.prBaseSha,
      prHeadSha: gate.selectedSha,
      gate,
    };
  }
  return {
    captureMode: source,
    sourceSha: gate.selectedSha,
    sourceRef: "origin/main",
    capturedAt,
    gate,
  };
}

function computeSourceCaptureDigest(provenance) {
  const source = {
    captureMode: provenance.captureMode,
    sourceSha: provenance.sourceSha,
    ...(provenance.captureMode === "pr_head"
      ? {
          prNumber: provenance.prNumber,
          prBaseSha: provenance.prBaseSha,
          prHeadSha: provenance.prHeadSha,
        }
      : { sourceRef: provenance.sourceRef }),
  };
  return `sha256:${sha256(canonicalJson(source))}`;
}

function landingEvidence(adapter) {
  const sourceSha = adapter?.provenance?.sha;
  const contractVersion =
    adapter?.contracts?.camera?.version ??
    adapter?.contracts?.cameraDirectives?.version ??
    adapter?.provenance?.contracts?.camera?.version;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceSha ?? "")) {
    throw new Error("landing adapter provenance needs exact clean source SHA");
  }
  if (typeof contractVersion !== "string" || !contractVersion.trim()) {
    throw new Error("landing adapter provenance needs camera contract version");
  }
  return { sourceSha, contractVersion, contracts: adapter.contracts };
}

function buildEncodingConfig({
  scenario,
  timeline,
  camera,
  track,
  paths,
  runId,
}) {
  const profile = camera.captureProfile;
  const mobile = scenario.profile.kind === "native-mobile";
  const outputDir = path.join(paths.renderRoot, scenario.id, runId);
  return {
    slug: `${mobile ? "mobile" : "desktop"}-${scenario.id}`,
    rawPath: path.join(paths.captureRoot, "raw", `${scenario.id}.source.mp4`),
    outputDir,
    trimStartMs: 0,
    posterAtMs: Math.max(
      camera.openingSettleMs,
      timeline.totalDurationMs - camera.endingSettleMs,
    ),
    sourceWidth: profile.sourceWidth,
    sourceHeight: profile.sourceHeight,
    outputWidth: profile.deliveryWidth,
    outputHeight: profile.deliveryHeight,
    track,
  };
}

function buildDryRunPlan({
  command,
  scenario,
  scenarioPath,
  scenarioDigest,
  timeline,
  profile,
  sourceProvenance,
  sourceDigest,
  landing,
  paths,
  runId,
  deps,
}) {
  let camera = null;
  let cameraDeferred = null;
  let encodingPlan = null;
  if (landing) {
    try {
      camera = deps.compileCamera({ scenario, timeline });
      const track = landing.materializeCameraTrack(camera);
      encodingPlan = landing.buildHighlightEncodingPlan(
        buildEncodingConfig({
          scenario,
          timeline,
          camera,
          track,
          paths,
          runId,
        }),
      );
    } catch (error) {
      if (
        scenario.story.actions.some((action) => action.kind === "cameraFocus")
      ) {
        cameraDeferred = `runtime semantic focus geometry required: ${error.message}`;
      } else {
        throw error;
      }
    }
  }
  const encodingCommands = Object.values(encodingPlan ?? {}).map((step) => ({
    kind: path.extname(step.outputPath ?? "").slice(1) || null,
    argv: [step.command, ...step.args],
    outputPath: step.outputPath,
  }));
  return {
    contract: "kandev-highlight-dry-run-v1",
    command,
    dryRun: true,
    runId,
    scenario: {
      id: scenario.id,
      path: scenarioPath,
      digest: scenarioDigest,
      title: scenario.title,
    },
    timeline,
    profile: {
      kind: profile.kind,
      nativeMobile: profile.nativeMobile,
      viewport: {
        width: profile.cssWidth,
        height: profile.cssHeight,
        dpr: profile.dpr,
      },
      source: {
        width: profile.sourceWidth,
        height: profile.sourceHeight,
        fps: profile.fps,
      },
      delivery: {
        width: profile.deliveryWidth,
        height: profile.deliveryHeight,
        fps: profile.fps,
      },
    },
    source: sourceProvenance
      ? {
          sourceSha: sourceProvenance.sourceSha,
          mode: sourceProvenance.captureMode,
          digest: sourceDigest,
        }
      : null,
    landing: landing
      ? {
          ...landingEvidence(landing),
          root: landing.root ?? landing.provenance?.root ?? null,
        }
      : null,
    camera: camera ?? { status: "runtime-required", reason: cameraDeferred },
    prerequisites: {
      app: { status: "required", frontendUrl: deps.frontendUrl ?? null },
      capture: {
        executables: ["Xvfb", "Chromium", "ffmpeg", "ffprobe"],
        sourceEncoder: "runtime-readiness-probe",
      },
      selectors: {
        status: "runtime-required",
        claim: "not-resolved-by-static-dry-run",
      },
      browserPlayback: {
        status: "required",
        engine: "Playwright Chromium",
        speed: 1,
      },
      sensitiveScan: {
        defaultCoverage: ["scenario", "camera-metadata"],
        pixelScan: false,
        logScan: false,
        extensionHook: "capture bindings may provide sensitiveScanner",
      },
    },
    captureCommand: [
      "ffmpeg",
      "-f",
      "x11grab",
      "-draw_mouse",
      "0",
      "-framerate",
      String(profile.fps),
      "-video_size",
      `${profile.sourceWidth}x${profile.sourceHeight}`,
      "-i",
      "<allocated-x-display>",
      "-an",
      "<verified-h264-encoder>",
      "-n",
      path.join(paths.captureRoot, "raw", `${scenario.id}.source.mp4`),
    ],
    encodingCommands,
    paths: {
      attempt: paths.attemptRoot,
      capture: paths.captureRoot,
      render: paths.renderRoot,
      qa: paths.qaRoot,
      stagePattern: path.join(paths.stageRoot, "<sha256-manifest-digest>"),
    },
  };
}

function absoluteRenderArtifacts(render) {
  const artifacts = render?.manifest?.artifacts;
  if (!Array.isArray(artifacts))
    throw new Error("render manifest contains no delivery artifacts");
  const seen = new Set();
  const normalized = artifacts.map((artifact) => {
    if (
      !REQUIRED_DELIVERY_KINDS.includes(artifact.kind) ||
      seen.has(artifact.kind)
    ) {
      throw new Error(
        `render artifacts must contain each of mp4, poster, and webm exactly once; invalid ${artifact.kind}`,
      );
    }
    seen.add(artifact.kind);
    const absolute = path.resolve(render.stageDir, artifact.path);
    const relative = path.relative(render.stageDir, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${artifact.kind} render artifact escapes render stage`);
    }
    return { kind: artifact.kind, path: absolute };
  });
  if (seen.size !== REQUIRED_DELIVERY_KINDS.length)
    throw new Error("render artifacts must contain mp4, poster, and webm");
  return normalized;
}

function expectedForArtifact(kind, profile, durationMs) {
  return {
    kind,
    width: profile.deliveryWidth,
    height: profile.deliveryHeight,
    fps: kind === "poster" ? null : profile.fps,
    durationMs: kind === "poster" ? null : durationMs,
    ...(kind === "poster"
      ? {}
      : { durationToleranceMs: Math.ceil(1_000 / profile.fps) }),
    codec: kind === "mp4" ? "h264" : kind === "webm" ? "vp9" : "webp",
    audio: false,
    ...(kind === "mp4" ? { faststart: true } : {}),
  };
}

function phaseAdapters(context) {
  const {
    deps,
    scenario,
    scenarioDigest,
    scenarioPath,
    timeline,
    profile,
    sourceProvenance,
    sourceDigest,
    landing,
    paths,
    runId,
    env,
  } = context;
  return {
    validate: async () =>
      writePhaseRecord(
        paths,
        "validate",
        {
          scenarioId: scenario.id,
          scenarioPath,
          scenarioDigest,
          source: sourceProvenance,
          profile,
        },
        deps,
      ),
    storyboard: async () =>
      writePhaseRecord(paths, "storyboard", { timeline }, deps),
    capture: async () => {
      const frontendUrl = deps.frontendUrl ?? env.KANDEV_HIGHLIGHT_FRONTEND_URL;
      if (!/^https?:\/\//.test(frontendUrl ?? "")) {
        throw new Error(
          "capture requires KANDEV_HIGHLIGHT_FRONTEND_URL (or injected frontendUrl) for isolated seeded app",
        );
      }
      const capture = await deps.captureScenario({
        ...context.captureBindings,
        scenario,
        timeline,
        source: sourceProvenance.gate,
        sourceDigest,
        frontendUrl,
        artifactRoot: paths.captureRoot,
        repositoryRoots: [context.repoRoot, landing?.root].filter(Boolean),
        runId,
      });
      if (capture?.receipt?.scenarioDigest !== scenarioDigest)
        throw new Error("capture receipt scenario digest mismatch");
      if (capture?.receipt?.sourceDigest !== sourceDigest)
        throw new Error("capture receipt source digest mismatch");
      if (
        capture?.receipt?.source?.selectedSha !==
        sourceProvenance.gate.selectedSha
      ) {
        throw new Error("capture receipt source gate proof mismatch");
      }
      if (
        capture?.receipt?.build?.sourceSha !==
          sourceProvenance.gate.selectedSha ||
        capture?.receipt?.build?.manifestDigest !==
          context.captureBindings.buildProvenance.manifestDigest
      ) {
        throw new Error("capture receipt build provenance mismatch");
      }
      if (!DIGEST_PATTERN.test(capture?.receipt?.rawMaster?.digest ?? ""))
        throw new Error("capture receipt needs raw master SHA-256");
      if (
        capture?.receipt?.seed?.seedId !== scenario.seed.recipe ||
        !DIGEST_PATTERN.test(capture?.receipt?.seed?.seedDigest ?? "")
      ) {
        throw new Error(
          "capture receipt needs exact declared seed identity and digest",
        );
      }
      return writePhaseRecord(paths, "capture", capture, deps);
    },
    render: async ({ phases }) => {
      const capture = phases.capture;
      const execution = capture.execution ?? capture.receipt?.execution;
      const camera = deps.compileCamera({
        scenario,
        timeline,
        semanticEvents: execution?.steps ?? [],
        execution,
      });
      const render = await deps.renderHighlight({
        scenario,
        capture: {
          rawPath: capture.rawMasterPath ?? capture.receipt.rawMaster.path,
          digest: capture.receipt.rawMaster.digest,
          storyStartOffsetMs: capture.receipt.storyStartOffsetMs,
        },
        camera,
        artifactRoot: paths.renderRoot,
        runId,
        repoRoots: [context.repoRoot, landing.root].filter(Boolean),
        landingAdapter: landing,
      });
      await writeJsonExclusive(path.join(paths.evidenceRoot, "camera.json"), {
        contract: "kandev-highlight-camera-evidence-v1",
        plan: camera,
        track: render.cameraTrack,
      });
      return writePhaseRecord(paths, "render", render, deps);
    },
    qa: async ({ phases }) => {
      const capture = phases.capture;
      const render = phases.render;
      const artifacts = absoluteRenderArtifacts(render).map((artifact) => ({
        ...artifact,
        expected: expectedForArtifact(
          artifact.kind,
          profile,
          timeline.totalDurationMs,
        ),
      }));
      const execution = capture.execution ?? capture.receipt?.execution;
      const geometry = normalizeExecutionGeometry({
        execution,
        captureProfile: profile,
        fps: profile.fps,
      });
      const sensitiveScanner =
        deps.sensitiveScanner ?? context.captureBindings?.sensitiveScanner;
      const report = await deps.runQualityAssurance({
        scenario,
        artifacts,
        camera: render.cameraTrack,
        pointerTrack: geometry.pointerTrack,
        targetIntervals: geometry.targetIntervals,
        runner: deps.commandRunner,
        readFile: deps.readFile,
        browserPlayback: ({ artifacts: reports }) =>
          deps.browserPlayback({
            artifacts: reports,
            webRoot: path.join(context.repoRoot, "apps/web"),
          }),
        cameraAuditor: landing.auditHighlightCameraMotion,
        qaOutputDir: paths.qaRoot,
        ...(typeof sensitiveScanner === "function" ? { sensitiveScanner } : {}),
      });
      if (report?.passed !== true) throw new Error("automatic QA did not pass");
      const completedAt = deps.clock().toISOString();
      const sensitiveData =
        typeof sensitiveScanner === "function"
          ? {
              ...report.sensitiveData,
              coverage: report.sensitiveData?.coverage ?? ["custom-hook"],
              hook: true,
            }
          : {
              ...report.sensitiveData,
              coverage: ["scenario", "camera-metadata"],
              pixelScan: false,
              logScan: false,
              limitation:
                "rendered pixels and process logs require a configured sensitiveScanner hook",
            };
      const technical = {
        ...report,
        sensitiveData,
        status: "technical_pass",
        passed: true,
        completedAt,
      };
      const reportPath = await writeJsonExclusive(
        path.join(paths.qaRoot, "report.json"),
        technical,
      );
      const reportDigest = `sha256:${await hashFile(reportPath)}`;
      return writePhaseRecord(
        paths,
        "qa",
        { ...technical, reportPath, reportDigest },
        deps,
      );
    },
    stage: async ({ phases }) =>
      writeContentAddressedStage({
        artifactRoot: paths.artifactRoot,
        scenario,
        scenarioPath,
        scenarioDigest,
        delivery: context.delivery,
        capture: phases.capture,
        render: phases.render,
        qa: phases.qa,
        sourceProvenance,
        landing: landingEvidence(landing),
        toolVersion: `kandev-highlights/${HIGHLIGHT_PIPELINE_VERSION}`,
      }),
  };
}

async function recoverContext(context) {
  const attemptRoot = await resolveAttemptDirectory({
    artifactRoot: context.paths.artifactRoot,
    scenarioId: context.scenario.id,
    runId: context.requestedRunId,
  });
  const recoveredRunId = path.basename(attemptRoot);
  const paths = pipelinePaths({
    artifactRoot: context.paths.artifactRoot,
    scenarioId: context.scenario.id,
    runId: recoveredRunId,
  });
  const captureRecord = await readJsonRegular(
    path.join(paths.evidenceRoot, "capture.json"),
    "capture phase manifest",
  );
  if (captureRecord.value?.receipt?.scenarioDigest !== context.scenarioDigest) {
    throw new Error(
      "scenario changed since capture; capture manifest digest does not match",
    );
  }
  return {
    ...context,
    runId: recoveredRunId,
    paths,
    capture: captureRecord.value,
  };
}

export async function runDeclarativeHighlightCommand({
  command,
  scenarioPath,
  artifactRoot,
  source,
  repoRoot = process.cwd(),
  landingRoot,
  runId,
  prNumber,
  prBaseSha,
  dryRun = false,
  allowedExtensionIds = [],
  env = process.env,
  dependencies = {},
} = {}) {
  if (!["capture", "render", "qa", "run"].includes(command))
    throw new Error("command must be capture, render, qa, or run");
  if (typeof scenarioPath !== "string" || !scenarioPath)
    throw new Error(`${command} requires scenarioPath`);
  if (typeof artifactRoot !== "string" || !artifactRoot)
    throw new Error(`${command} requires --artifact-root outside repositories`);
  if (
    ["capture", "run"].includes(command) &&
    !["pr_head", "current_main"].includes(source)
  ) {
    throw new Error(`${command} --source must be pr_head or current_main`);
  }
  const deps = dependenciesWithDefaults(dependencies);
  const absoluteScenario = path.resolve(scenarioPath);
  const scenarioOptions = { allowedExtensionIds };
  const scenario = await deps.readScenario(absoluteScenario, scenarioOptions);
  const scenarioDigest = deps.computeScenarioDigest(scenario, scenarioOptions);
  const timeline = deps.compileTimeline(scenario, scenarioOptions);
  if (timeline.scenarioDigest !== scenarioDigest)
    throw new Error("compiled timeline scenario digest mismatch");
  const profile = resolveCaptureProfile(scenario.profile);
  const delivery = command === "run" ? requireDelivery(deps, scenario) : null;
  let captureBindings = null;
  if (["capture", "run"].includes(command) && !dryRun) {
    const candidate =
      typeof deps.loadCaptureBindings === "function"
        ? await deps.loadCaptureBindings({
            scenario,
            repoRoot: path.resolve(repoRoot),
            allowedExtensionIds,
          })
        : deps.captureBindings;
    captureBindings = validateCaptureBindings({
      scenario,
      bindings: candidate,
      allowedExtensionIds,
    });
  }
  const selectedRunId = requireSafeSegment(
    runId ?? defaultRunId(scenarioDigest),
    "runId",
  );
  const externalRoot = assertExternalArtifactRoot({
    artifactRoot: path.resolve(artifactRoot),
    repoRoots: [repoRoot, landingRoot].filter(Boolean),
  });
  const paths = pipelinePaths({
    artifactRoot: externalRoot,
    scenarioId: scenario.id,
    runId: selectedRunId,
  });
  const capturedAt = deps.clock().toISOString();
  const sourceProvenance = ["capture", "run"].includes(command)
    ? await resolveSourceProvenance({
        source,
        repoRoot,
        prNumber,
        prBaseSha,
        env,
        deps,
        capturedAt,
      })
    : null;
  const sourceDigest = sourceProvenance
    ? computeSourceCaptureDigest(sourceProvenance)
    : null;
  const needsLanding = ["render", "qa", "run"].includes(command);
  const landing = needsLanding
    ? await deps.loadLandingAdapter({
        landingRoot,
        env,
        runner: deps.commandRunner,
      })
    : null;
  if (landing) landingEvidence(landing);
  const common = {
    command,
    scenario,
    scenarioPath: absoluteScenario,
    scenarioDigest,
    timeline,
    profile,
    delivery,
    sourceProvenance,
    sourceDigest,
    landing,
    paths,
    runId: selectedRunId,
    requestedRunId: runId,
    repoRoot: path.resolve(repoRoot),
    deps,
    env,
    allowedExtensionIds,
    captureBindings,
  };
  if (dryRun) return buildDryRunPlan(common);

  if (["capture", "run"].includes(command)) await reserveAttempt(paths);
  if (command === "run") {
    return runHighlightPipeline({
      scenario,
      adapters: phaseAdapters(common),
      context: common,
    });
  }
  if (command === "capture") {
    const adapters = phaseAdapters(common);
    const phases = {};
    phases.validate = await adapters.validate({ phases });
    phases.storyboard = await adapters.storyboard({ phases });
    phases.capture = await adapters.capture({ phases });
    return {
      contract: "kandev-highlight-command-v1",
      command,
      runId: selectedRunId,
      order: ["validate", "storyboard", "capture"],
      phases,
    };
  }

  const recovered = await recoverContext(common);
  const adapters = phaseAdapters(recovered);
  const phases = { capture: recovered.capture };
  if (command === "render") {
    phases.render = await adapters.render({ phases });
    return {
      contract: "kandev-highlight-command-v1",
      command,
      runId: recovered.runId,
      order: ["render"],
      phases,
    };
  }
  const renderRecord = await readJsonRegular(
    path.join(recovered.paths.evidenceRoot, "render.json"),
    "render phase manifest",
  );
  const cameraRecord = await readJsonRegular(
    path.join(recovered.paths.evidenceRoot, "camera.json"),
    "camera evidence",
  );
  phases.render = { ...renderRecord.value, cameraTrack: cameraRecord.track };
  phases.qa = await adapters.qa({ phases });
  return {
    contract: "kandev-highlight-command-v1",
    command,
    runId: recovered.runId,
    order: ["qa"],
    phases,
  };
}

async function copyRegular(source, destination, label) {
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink())
    throw new Error(`${label} must be a regular file: ${source}`);
  if ((await fs.realpath(source)) !== path.resolve(source))
    throw new Error(
      `${label} cannot resolve through symlinked parents: ${source}`,
    );
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.copyFile(
      source,
      destination,
      fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE,
    );
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(`refusing to overwrite staged ${label}: ${destination}`);
    throw error;
  }
}

function reportArtifacts(qa) {
  if (!Array.isArray(qa?.artifacts))
    throw new Error("accepted QA report needs delivery artifacts");
  const byKind = new Map();
  for (const artifact of qa.artifacts) {
    if (
      !REQUIRED_DELIVERY_KINDS.includes(artifact.kind) ||
      byKind.has(artifact.kind)
    ) {
      throw new Error(
        "accepted QA must report mp4, poster, and webm exactly once",
      );
    }
    byKind.set(artifact.kind, artifact);
  }
  if (byKind.size !== REQUIRED_DELIVERY_KINDS.length)
    throw new Error(
      "accepted QA must report mp4, poster, and webm exactly once",
    );
  return byKind;
}

async function copyDeliverySet({ qa, building, form }) {
  const result = {};
  for (const kind of REQUIRED_DELIVERY_KINDS) {
    const report = qa.get(kind);
    const extension = kind === "poster" ? "webp" : kind;
    const relative = `deliveries/${form}.${extension}`;
    const destination = path.join(building, relative);
    await copyRegular(report.path, destination, `${form} ${kind}`);
    const bytes = await fs.readFile(destination);
    const exactSha = sha256(bytes);
    if (report.bytes !== bytes.length || report.sha256 !== exactSha) {
      throw new Error(`${form} ${kind} QA hash/bytes do not match delivery`);
    }
    const probe = report.probe;
    result[kind] = {
      path: relative,
      bytes: bytes.length,
      sha256: exactSha,
      codec: probe.codec,
      width: probe.width,
      height: probe.height,
      fps: kind === "poster" ? null : probe.fps,
      duration: kind === "poster" ? null : probe.durationMs / 1_000,
      audio: probe.audioStreams !== 0,
    };
  }
  return result;
}

function stageProvenance(input) {
  const seed = input.capture.receipt.seed;
  const source = input.sourceProvenance;
  return {
    captureMode: source.captureMode,
    sourceSha: source.sourceSha,
    capturedAt: source.capturedAt,
    seedId: seed.seedId,
    seedDigest: seed.seedDigest,
    toolVersion: input.toolVersion,
    landingAdapter: {
      sourceSha: input.landing.sourceSha,
      contractVersion: input.landing.contractVersion,
    },
    ...(source.captureMode === "pr_head"
      ? {
          prNumber: source.prNumber,
          prBaseSha: source.prBaseSha,
          prHeadSha: source.prHeadSha,
        }
      : { sourceRef: source.sourceRef }),
  };
}

function assertStageInput(input) {
  if (!input?.delivery?.revision || !input.delivery.highlight)
    throw new Error("stage requires scenario delivery metadata");
  if (input.qa?.passed !== true || input.qa?.status !== "technical_pass")
    throw new Error(
      "review stage requires QA passed=true and status=technical_pass",
    );
  if (!DIGEST_PATTERN.test(input.scenarioDigest ?? ""))
    throw new Error("stage requires exact scenario digest");
  if (!DIGEST_PATTERN.test(input.capture?.receipt?.rawMaster?.digest ?? ""))
    throw new Error("stage requires exact raw capture digest");
  if (input.capture?.receipt?.seed?.seedId !== input.scenario.seed.recipe)
    throw new Error("stage seed identity must match scenario seed recipe");
  if (!DIGEST_PATTERN.test(input.capture?.receipt?.seed?.seedDigest ?? ""))
    throw new Error("stage needs exact seed digest");
  if (!DIGEST_PATTERN.test(input.qa?.reportDigest ?? ""))
    throw new Error("stage needs exact QA report digest");
  landingEvidence({
    provenance: { sha: input.landing?.sourceSha },
    contracts: { camera: { version: input.landing?.contractVersion } },
  });
}

export async function writeContentAddressedStage(input = {}) {
  assertStageInput(input);
  const artifactRoot = path.resolve(input.artifactRoot);
  const stageRoot = path.join(artifactRoot, input.scenario.id, "stages");
  await rejectSymlinkComponents(artifactRoot);
  await fs.mkdir(stageRoot, { recursive: true });
  const building = await fs.mkdtemp(path.join(stageRoot, ".building-"));
  try {
    const scenarioRelative = "scenario.json";
    const captureRelative = `raw/${input.scenario.id}.source.mp4`;
    const reportRelative = "qa/report.json";
    await copyRegular(
      input.scenarioPath,
      path.join(building, scenarioRelative),
      "scenario",
    );
    await copyRegular(
      input.capture.receipt.rawMaster.path,
      path.join(building, captureRelative),
      "raw master",
    );
    await copyRegular(
      input.qa.reportPath,
      path.join(building, reportRelative),
      "QA report",
    );
    const stagedScenario = JSON.parse(
      await fs.readFile(path.join(building, scenarioRelative), "utf8"),
    );
    if (
      `sha256:${sha256(canonicalJson(stagedScenario))}` !== input.scenarioDigest
    )
      throw new Error("canonical scenario digest changed before staging");
    if (
      `sha256:${await hashFile(path.join(building, captureRelative))}` !==
      input.capture.receipt.rawMaster.digest
    ) {
      throw new Error("raw capture digest changed before staging");
    }
    if (
      `sha256:${await hashFile(path.join(building, reportRelative))}` !==
      input.qa.reportDigest
    ) {
      throw new Error("QA report digest changed before staging");
    }
    const parsedReport = await readJsonRegular(
      path.join(building, reportRelative),
      "staged QA report",
    );
    if (
      parsedReport.passed !== true ||
      parsedReport.status !== "technical_pass"
    ) {
      throw new Error(
        "staged QA report must say passed=true and status=technical_pass consistently",
      );
    }
    const form =
      input.scenario.profile.kind === "native-mobile" ? "mobile" : "desktop";
    const assets = await copyDeliverySet({
      qa: reportArtifacts(input.qa),
      building,
      form,
    });
    const common = {
      schemaVersion: 1,
      revision: input.delivery.revision,
      highlight: input.delivery.highlight,
      scenario: { path: scenarioRelative, digest: input.scenarioDigest },
      capture: {
        path: captureRelative,
        digest: input.capture.receipt.rawMaster.digest,
      },
      qa: {
        status: "technical_pass",
        passed: true,
        reportPath: reportRelative,
        reportDigest: input.qa.reportDigest,
        completedAt: input.qa.completedAt,
      },
      provenance: stageProvenance(input),
    };
    const reason =
      form === "desktop"
        ? "explicit-acceptance-required"
        : "desktop-stage-required";
    const manifest = {
      contract: "kandev-highlight-review-stage-v1",
      ...common,
      profile: input.scenario.profile.kind,
      promotable: false,
      readyForReview: true,
      reason,
      assets: { [form]: assets },
    };
    manifest.stageDigest = computeStageManifestDigest(manifest);
    const manifestName = "review.json";
    await writeJsonExclusive(path.join(building, manifestName), manifest);
    const stageDir = path.join(
      stageRoot,
      manifest.stageDigest.slice("sha256:".length),
    );
    try {
      await fs.rename(building, stageDir);
    } catch (error) {
      if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
        throw new Error(
          `refusing to overwrite content-addressed stage collision: ${stageDir}`,
        );
      }
      throw error;
    }
    return {
      contract: "kandev-highlight-stage-result-v1",
      promotable: false,
      readyForReview: true,
      reason,
      stageDir,
      manifestPath: path.join(stageDir, manifestName),
      stageDigest: manifest.stageDigest,
      manifest,
      input,
    };
  } catch (error) {
    await fs.rm(building, { recursive: true, force: true });
    throw error;
  }
}
