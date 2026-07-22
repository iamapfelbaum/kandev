import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const REQUIRED_EXPORTS = Object.freeze([
  "HIGHLIGHT_CAMERA_DIRECTIVE_CONTRACT",
  "HIGHLIGHT_CAMERA_CONTRACT",
  "HIGHLIGHT_ENCODER_CONTRACT",
  "createHighlightCameraTrack",
  "auditHighlightCameraMotion",
  "assertHighlightCameraMotion",
  "buildHighlightEncodingPlan",
  "encodeHighlight",
]);

async function defaultRunner(command, args) {
  const result = await execFileAsync(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return { ...result, exitCode: 0 };
}

async function requireFile(filePath, label) {
  try {
    await access(filePath);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing: ${filePath}`);
    throw error;
  }
}

async function gitOutput(runner, root, args) {
  const result = await runner("git", ["-C", root, ...args]);
  return String(result?.stdout ?? result?.output ?? "").trim();
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function assertNamedExports(module) {
  for (const name of REQUIRED_EXPORTS) {
    const value = module?.[name];
    const expectedFunction = !name.startsWith("HIGHLIGHT_");
    const validContract = value && typeof value === "object" && !Array.isArray(value)
      && typeof value.id === "string" && value.id.startsWith("kandev.highlight-")
      && typeof value.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.version);
    if ((expectedFunction && typeof value !== "function") || (!expectedFunction && !validContract)) {
      throw new Error(`landing Highlight export ${name} is required`);
    }
  }
}

export async function loadLandingAdapter({
  landingRoot,
  env = process.env,
  runner = defaultRunner,
  importer = (url) => import(url.href),
  allowDirty = false,
} = {}) {
  const requestedRoot = landingRoot ?? env.KANDEV_LANDING_REPO;
  if (typeof requestedRoot !== "string" || requestedRoot.trim() === "") {
    throw new Error("explicit landingRoot (or KANDEV_LANDING_REPO) is required");
  }
  const root = path.resolve(requestedRoot);
  const paths = {
    camera: path.join(root, "scripts/product-loop-camera.mjs"),
    encoder: path.join(root, "scripts/product-loop-encoder.mjs"),
    highlight: path.join(root, "scripts/product-loop-highlight.mjs"),
  };
  await requireFile(paths.camera, "product-loop-camera.mjs marker");
  await requireFile(paths.encoder, "product-loop-encoder.mjs marker");
  try {
    await requireFile(paths.highlight, "product-loop-highlight.mjs named adapter");
  } catch (error) {
    throw new Error(`${error.message}; upgrade landing checkout to Highlight adapter contract`);
  }
  const [sha, status] = await Promise.all([
    gitOutput(runner, root, ["rev-parse", "HEAD"]),
    gitOutput(runner, root, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (!SHA_PATTERN.test(sha)) throw new Error(`landing HEAD is not an exact Git SHA: ${sha || "missing"}`);
  if (status && !allowDirty) throw new Error(`landing worktree must be clean; status: ${status}`);

  const named = await importer(pathToFileURL(paths.highlight));
  assertNamedExports(named);
  const contracts = {
    cameraDirectives: named.HIGHLIGHT_CAMERA_DIRECTIVE_CONTRACT,
    camera: named.HIGHLIGHT_CAMERA_CONTRACT,
    encoder: named.HIGHLIGHT_ENCODER_CONTRACT,
  };
  const materializeCameraTrack = (plan) => {
    if (plan?.contract !== "kandev-highlight-camera-plan-v1") {
      throw new Error("materializeCameraTrack needs kandev-highlight-camera-plan-v1");
    }
    const input = cleanObject({
      cameraDirectives: plan.cameraDirectives,
      durationMs: plan.durationMs,
      endingSettleMs: plan.endingSettleMs,
      openingSettleMs: plan.openingSettleMs,
      pointerGlyph: plan.pointerGlyph,
      pointerSafeMargin: plan.pointerSafeMargin,
      pointerTrack: plan.pointerTrack,
      profile: plan.profile,
    });
    return named.createHighlightCameraTrack(input);
  };
  return Object.freeze({
    contract: "kandev-highlight-landing-adapter-v1",
    root,
    paths,
    contracts,
    provenance: Object.freeze({
      root,
      sha,
      clean: status === "",
      status,
      namedAdapter: paths.highlight,
      contracts,
    }),
    materializeCameraTrack,
    createHighlightCameraTrack: named.createHighlightCameraTrack,
    auditHighlightCameraMotion: named.auditHighlightCameraMotion,
    assertHighlightCameraMotion: named.assertHighlightCameraMotion,
    buildHighlightEncodingPlan: named.buildHighlightEncodingPlan,
    encodeHighlight: named.encodeHighlight,
  });
}
