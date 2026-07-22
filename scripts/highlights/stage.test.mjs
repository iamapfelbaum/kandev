import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";

const tempDirs = [];

after(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test("reads a content-addressed external stage and verifies source, capture, QA, and deliveries", async () => {
  const fixture = await createStage();
  const declarations = await fs.readFile(new URL("./stage.d.ts", import.meta.url), "utf8");
  const { readStageManifest } = await import("./stage.mjs");
  const result = await readStageManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot });
  assert.equal(result.manifest.highlight.id, "stage-demo");
  assert.equal(result.manifest.stageDigest, `sha256:${path.basename(fixture.stageDir)}`);
  assert.equal(result.scenario.id, "quick-start");
  assert.match(declarations, /export interface HighlightStageManifestV1/);

  await fs.appendFile(path.join(fixture.stageDir, fixture.manifest.capture.path), "tampered");
  await assert.rejects(
    readStageManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot }),
    /capture.*digest|hash/i,
  );
});

test("staged provenance seed identity must match the declarative scenario", async () => {
  const fixture = await createStage({ seedId: "kandev.different-workspace" });
  const { readStageManifest } = await import("./stage.mjs");
  await assert.rejects(
    readStageManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot }),
    /seed.*scenario|scenario.*seed/i,
  );
});

test("rejects non-accepted QA even when the stage digest is internally consistent", async () => {
  const fixture = await createStage({ qaStatus: "pending" });
  const { readStageManifest } = await import("./stage.mjs");
  await assert.rejects(
    readStageManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot }),
    /accepted QA|QA.*accepted/i,
  );
});

test("manifest acceptance cannot override a rejected staged QA report", async () => {
  const fixture = await createStage({ qaStatus: "accepted", reportStatus: "rejected" });
  const { readStageManifest } = await import("./stage.mjs");
  await assert.rejects(
    readStageManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot }),
    /QA report.*accepted|accepted.*QA report/i,
  );
});

test("new declarative stages reject legacy-sized desktop deliveries", async () => {
  const fixture = await createStage({ desktopWidth: 960, desktopHeight: 600 });
  const { readStageManifest } = await import("./stage.mjs");
  await assert.rejects(
    readStageManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot }),
    /1920x1200|desktop.*dimensions/i,
  );
});

test("stage sources must be regular files and cannot escape through symlinks", async () => {
  const fixture = await createStage();
  const scenarioPath = path.join(fixture.stageDir, fixture.manifest.scenario.path);
  const outside = path.join(fixture.base, "outside-scenario.json");
  await fs.rename(scenarioPath, outside);
  await fs.symlink(outside, scenarioPath);
  const { readStageManifest } = await import("./stage.mjs");
  await assert.rejects(
    readStageManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot }),
    /scenario.*regular file|regular file.*scenario/i,
  );
});

test("external stage path is rejected when its real path resolves inside the repository", async () => {
  const fixture = await createStage();
  const inRepoParent = path.join(fixture.repoRoot, "hidden-stage");
  const inRepoStage = path.join(inRepoParent, path.basename(fixture.stageDir));
  await fs.mkdir(inRepoParent, { recursive: true });
  await fs.rename(fixture.stageDir, inRepoStage);
  await fs.symlink(inRepoStage, fixture.stageDir, "dir");

  const { readStageManifest } = await import("./stage.mjs");
  await assert.rejects(
    readStageManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot }),
    /outside the repository|external stage/i,
  );
});

test("stage files cannot escape through a symlinked parent directory", async () => {
  const fixture = await createStage();
  const inRepoRaw = path.join(fixture.repoRoot, "escaped-raw");
  await fs.rename(path.join(fixture.stageDir, "raw"), inRepoRaw);
  await fs.symlink(inRepoRaw, path.join(fixture.stageDir, "raw"), "dir");

  const { readStageManifest } = await import("./stage.mjs");
  await assert.rejects(
    readStageManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot }),
    /inside stage directory|symlink/i,
  );
});

test("atomically promotes only deliveries, scenario, and compact provenance", async () => {
  const fixture = await createStage();
  const { promoteStagedHighlight } = await import("./stage.mjs");
  const result = await promoteStagedHighlight({
    manifestPath: fixture.manifestPath,
    repoRoot: fixture.repoRoot,
    highlightsDir: fixture.highlightsDir,
    now: "2026-07-22T12:00:00.000Z",
    probe: probeFixture,
  });

  assert.equal(result.descriptor.id, "stage-demo");
  assert.equal(result.descriptor.status, "queued");
  assert.equal(result.descriptor.qa_status, "accepted");
  assert.equal(result.descriptor.mobile.available, true);
  assert.equal(result.descriptor.mobile.declaration, "Feature has a native mobile surface.");
  assert.equal(result.descriptor.provenance.scenario_digest, fixture.manifest.scenario.digest);
  assert.equal(result.descriptor.provenance.capture_digest, fixture.manifest.capture.digest);
  assert.equal(result.descriptor.provenance.stage_digest, fixture.manifest.stageDigest);
  assert.match(result.descriptor.source_digest, /^sha256:[a-f0-9]{64}$/);

  const promotedFiles = await relativeFiles(path.join(fixture.highlightsDir, "stage-demo"));
  assert.deepEqual(promotedFiles, [
    "highlight.json",
    "revisions/r1/desktop.mp4",
    "revisions/r1/desktop.webm",
    "revisions/r1/desktop.webp",
    "revisions/r1/mobile.mp4",
    "revisions/r1/mobile.webm",
    "revisions/r1/mobile.webp",
    "revisions/r1/provenance.json",
    "revisions/r1/scenario.json",
  ]);
  assert(!promotedFiles.some((file) => file.includes("raw") || file.includes("qa")));

  await assert.rejects(
    promoteStagedHighlight({
      manifestPath: fixture.manifestPath,
      repoRoot: fixture.repoRoot,
      highlightsDir: fixture.highlightsDir,
      probe: probeFixture,
    }),
    /revision.*exists|collision|overwrite/i,
  );
});

test("failed validation leaves no partial destination", async () => {
  const fixture = await createStage();
  const { promoteStagedHighlight } = await import("./stage.mjs");
  await assert.rejects(
    promoteStagedHighlight({
      manifestPath: fixture.manifestPath,
      repoRoot: fixture.repoRoot,
      highlightsDir: fixture.highlightsDir,
      probe: async () => { throw new Error("decode failed"); },
    }),
    /decode failed/,
  );
  await assert.rejects(fs.access(path.join(fixture.highlightsDir, "stage-demo")));
  assert.equal((await fs.readdir(fixture.highlightsDir)).filter((name) => name.startsWith(".promote-")).length, 0);
});

test("promotion refuses an existing per-Highlight lock before changing the repository", async () => {
  const fixture = await createStage();
  const lockPath = path.join(fixture.highlightsDir, ".promote-stage-demo.lock");
  await fs.mkdir(lockPath);
  const { promoteStagedHighlight } = await import("./stage.mjs");

  await assert.rejects(
    promoteStagedHighlight({
      manifestPath: fixture.manifestPath,
      repoRoot: fixture.repoRoot,
      highlightsDir: fixture.highlightsDir,
      probe: probeFixture,
    }),
    /promotion.*progress|lock/i,
  );
  await assert.rejects(fs.access(path.join(fixture.highlightsDir, "stage-demo")));
  assert.deepEqual(await fs.readdir(lockPath), []);
});

test("adds a new immutable revision without changing prior revision bytes", async () => {
  const first = await createStage({ revision: "r1" });
  const { promoteStagedHighlight } = await import("./stage.mjs");
  await promoteStagedHighlight({
    manifestPath: first.manifestPath,
    repoRoot: first.repoRoot,
    highlightsDir: first.highlightsDir,
    probe: probeFixture,
    now: "2026-07-22T12:00:00.000Z",
  });
  const oldBytes = await fs.readFile(path.join(first.highlightsDir, "stage-demo/revisions/r1/desktop.mp4"));
  const second = await createStage({ revision: "r2", existing: first, payloadSuffix: "-r2" });
  const result = await promoteStagedHighlight({
    manifestPath: second.manifestPath,
    repoRoot: first.repoRoot,
    highlightsDir: first.highlightsDir,
    probe: probeFixture,
    now: "2026-07-22T13:00:00.000Z",
  });

  assert.equal(result.descriptor.active_revision, "r2");
  assert.deepEqual(result.descriptor.revision_history.map((entry) => entry.revision), ["r1", "r2"]);
  assert.deepEqual(await fs.readFile(path.join(first.highlightsDir, "stage-demo/revisions/r1/desktop.mp4")), oldBytes);
  assert.notDeepEqual(await fs.readFile(path.join(first.highlightsDir, "stage-demo/revisions/r2/desktop.mp4")), oldBytes);
});

test("CLI promote dry-run verifies an external stage without touching the repository", async () => {
  const fixture = await createStage();
  const script = path.resolve("scripts/highlights.mjs");
  const result = spawnSync(process.execPath, [script, "promote", fixture.manifestPath, "--dry-run"], {
    cwd: fixture.repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run:.*stage-demo.*accepted/i);
  await assert.rejects(fs.access(path.join(fixture.highlightsDir, "stage-demo")));
});

async function createStage({ revision = "r1", qaStatus = "accepted", reportStatus = qaStatus, seedId = "kandev.empty-workspace", existing, payloadSuffix = "", desktopWidth = 1920, desktopHeight = 1200 } = {}) {
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
    await fs.writeFile(path.join(repoRoot, "docs/public/guide.md"), "# Guide\n\n## Create a task\n\nDocs.\n");
  }

  const workDir = await fs.mkdtemp(path.join(stagesRoot, ".building-"));
  const files = {
    "scenario.json": await fs.readFile(path.resolve("scripts/highlights/examples/quick-start.scenario.json")),
    "raw/capture.webm": Buffer.from(`raw-capture${payloadSuffix}`),
    "qa/report.json": Buffer.from(`${JSON.stringify({ status: reportStatus, checks: ["codec", "containment"] })}\n`),
    "deliveries/desktop.webm": Buffer.from(`desktop-webm${payloadSuffix}`),
    "deliveries/desktop.mp4": Buffer.from(`desktop-mp4${payloadSuffix}`),
    "deliveries/desktop.webp": Buffer.from(`desktop-webp${payloadSuffix}`),
    "deliveries/mobile.webm": Buffer.from(`mobile-webm${payloadSuffix}`),
    "deliveries/mobile.mp4": Buffer.from(`mobile-mp4${payloadSuffix}`),
    "deliveries/mobile.webp": Buffer.from(`mobile-webp${payloadSuffix}`),
    "raw/secret.txt": Buffer.from("must stay outside repository"),
  };
  await Promise.all(Object.entries(files).map(async ([relative, bytes]) => {
    const target = path.join(workDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }));
  const { computeScenarioDigest } = await import("./scenario.mjs");
  const scenarioDigest = computeScenarioDigest(JSON.parse(files["scenario.json"]));
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
    capture: { path: "raw/capture.webm", digest: `sha256:${sha(files["raw/capture.webm"])}` },
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
      seedId,
      seedDigest: `sha256:${"1".repeat(64)}`,
      toolVersion: "highlights/1",
      prNumber: 42,
      prBaseSha: "fedcba9876543210fedcba9876543210fedcba98",
      prHeadSha: "0123456789abcdef0123456789abcdef01234567",
    },
    assets: {
      desktop: {
        webm: mediaRecord("deliveries/desktop.webm", "vp9", desktopWidth, desktopHeight, 25, 6.2),
        mp4: mediaRecord("deliveries/desktop.mp4", "h264", desktopWidth, desktopHeight, 25, 6.2),
        poster: mediaRecord("deliveries/desktop.webp", "webp", desktopWidth, desktopHeight, null, null),
      },
      mobile: {
        webm: mediaRecord("deliveries/mobile.webm", "vp9", 1290, 2796, 25, 6.2),
        mp4: mediaRecord("deliveries/mobile.mp4", "h264", 1290, 2796, 25, 6.2),
        poster: mediaRecord("deliveries/mobile.webp", "webp", 1290, 2796, null, null),
      },
    },
  };
  const { computeStageManifestDigest } = await import("./stage.mjs");
  manifest.stageDigest = computeStageManifestDigest(manifest);
  await fs.writeFile(path.join(workDir, "stage.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const stageDir = path.join(stagesRoot, manifest.stageDigest.slice("sha256:".length));
  await fs.rename(workDir, stageDir);
  return { base, repoRoot, highlightsDir, stagesRoot, stageDir, manifestPath: path.join(stageDir, "stage.json"), manifest };
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function probeFixture(filePath) {
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

async function relativeFiles(root) {
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
