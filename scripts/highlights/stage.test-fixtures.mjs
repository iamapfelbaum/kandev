import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

const tempDirs = [];

after(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

export async function createStage({
  revision = "r1",
  qaStatus = "accepted",
  reportStatus = qaStatus,
  reportPassed,
  seedId,
  seedDigest,
  existing,
  payloadSuffix = "",
  desktopWidth = 1920,
  desktopHeight = 1200,
  landingAdapter = {
    sourceSha: "89abcdef0123456789abcdef0123456789abcdef",
    contractVersion: "1.0.0",
  },
} = {}) {
  let base;
  let repoRoot;
  let highlightsDir;
  let stagesRoot;
  if (existing) {
    ({ base, repoRoot, highlightsDir, stagesRoot } = existing);
  } else {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "kandev-highlight-stage-"));
    tempDirs.push(base);
    repoRoot = path.join(base, "repo");
    highlightsDir = path.join(repoRoot, "docs/public/media/highlights");
    stagesRoot = path.join(base, "stages");
    await fs.mkdir(highlightsDir, { recursive: true });
    await fs.mkdir(stagesRoot, { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "docs/public/guide.md"),
      "# Guide\n\n## Create a task\n\nDocs.\n",
    );
  }

  const workDir = await fs.mkdtemp(path.join(stagesRoot, ".building-"));
  const files = {
    "scenario.json": await fs.readFile(
      path.resolve("scripts/highlights/examples/quick-start.scenario.json"),
    ),
    "raw/capture.webm": Buffer.from(`raw-capture${payloadSuffix}`),
    "qa/report.json": Buffer.from(
      `${JSON.stringify({
        status: reportStatus,
        ...(reportPassed === undefined ? {} : { passed: reportPassed }),
        checks: ["codec", "containment"],
      })}\n`,
    ),
    "deliveries/desktop.webm": Buffer.from(`desktop-webm${payloadSuffix}`),
    "deliveries/desktop.mp4": Buffer.from(`desktop-mp4${payloadSuffix}`),
    "deliveries/desktop.webp": Buffer.from(`desktop-webp${payloadSuffix}`),
    "deliveries/mobile.webm": Buffer.from(`mobile-webm${payloadSuffix}`),
    "deliveries/mobile.mp4": Buffer.from(`mobile-mp4${payloadSuffix}`),
    "deliveries/mobile.webp": Buffer.from(`mobile-webp${payloadSuffix}`),
    "raw/secret.txt": Buffer.from("must stay outside repository"),
  };
  await Promise.all(
    Object.entries(files).map(async ([relative, bytes]) => {
      const target = path.join(workDir, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    }),
  );
  const { computeScenarioDigest } = await import("./scenario.mjs");
  const scenario = JSON.parse(files["scenario.json"]);
  const scenarioDigest = computeScenarioDigest(scenario);
  const mediaRecord = (relative, codec, width, height, fps, duration) => ({
    path: relative,
    bytes: files[relative].length,
    sha256: sha(files[relative]),
    codec,
    width,
    height,
    fps,
    duration,
    audio: false,
  });
  const manifest = {
    schemaVersion: 1,
    revision,
    highlight: {
      id: "stage-demo",
      title: "Create a task",
      summary: "Create focused work without leaving the board.",
      caption: "Open the task dialog, enter a title, and create the task.",
      releaseVersion: "0.99.0",
      featureFlags: ["features.highlights"],
      docs: { page: "guide.md", section: "Create a task" },
      mobileDeclaration: "Feature has a native mobile surface.",
    },
    scenario: { path: "scenario.json", digest: scenarioDigest },
    capture: {
      path: "raw/capture.webm",
      digest: `sha256:${sha(files["raw/capture.webm"])}`,
    },
    qa: {
      status: qaStatus,
      reportPath: "qa/report.json",
      reportDigest: `sha256:${sha(files["qa/report.json"])}`,
      acceptedAt: "2026-07-22T11:00:00.000Z",
    },
    provenance: {
      captureMode: "pr_head",
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
      capturedAt: "2026-07-22T10:00:00.000Z",
      seedId: seedId ?? scenario.seed.recipe,
      seedDigest: seedDigest ?? fixtureSeedDigest(scenario.seed),
      toolVersion: "highlights/1",
      ...(landingAdapter ? { landingAdapter } : {}),
      prNumber: 42,
      prBaseSha: "fedcba9876543210fedcba9876543210fedcba98",
      prHeadSha: "0123456789abcdef0123456789abcdef01234567",
    },
    assets: {
      desktop: {
        webm: mediaRecord(
          "deliveries/desktop.webm",
          "vp9",
          desktopWidth,
          desktopHeight,
          25,
          6.2,
        ),
        mp4: mediaRecord(
          "deliveries/desktop.mp4",
          "h264",
          desktopWidth,
          desktopHeight,
          25,
          6.2,
        ),
        poster: mediaRecord(
          "deliveries/desktop.webp",
          "webp",
          desktopWidth,
          desktopHeight,
          null,
          null,
        ),
      },
      mobile: {
        webm: mediaRecord("deliveries/mobile.webm", "vp9", 1290, 2796, 25, 6.2),
        mp4: mediaRecord("deliveries/mobile.mp4", "h264", 1290, 2796, 25, 6.2),
        poster: mediaRecord(
          "deliveries/mobile.webp",
          "webp",
          1290,
          2796,
          null,
          null,
        ),
      },
    },
  };
  const { computeStageManifestDigest } = await import("./stage.mjs");
  manifest.stageDigest = computeStageManifestDigest(manifest);
  await fs.writeFile(
    path.join(workDir, "stage.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const stageDir = path.join(
    stagesRoot,
    manifest.stageDigest.slice("sha256:".length),
  );
  await fs.rename(workDir, stageDir);
  return {
    base,
    repoRoot,
    highlightsDir,
    stagesRoot,
    stageDir,
    manifestPath: path.join(stageDir, "stage.json"),
    manifest,
  };
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fixtureSeedDigest(seed) {
  return `sha256:${sha(Buffer.from(canonicalJson(seed)))}`;
}

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

export async function probeFixture(filePath) {
  const mobile = filePath.includes("mobile.");
  const poster = filePath.endsWith(".webp");
  return {
    codec: poster ? "webp" : filePath.endsWith(".webm") ? "vp9" : "h264",
    width: mobile ? 1290 : 1920,
    height: mobile ? 2796 : 1200,
    fps: poster ? null : 25,
    duration: poster ? null : 6.2,
    audio: false,
  };
}

export async function relativeFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else files.push(path.relative(root, target).split(path.sep).join("/"));
    }
  }
  await visit(root);
  return files.sort();
}
