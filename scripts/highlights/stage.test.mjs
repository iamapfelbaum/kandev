import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  createStage,
  fixtureSeedDigest,
  probeFixture,
  relativeFiles,
} from "./stage.test-fixtures.mjs";

test("reads a content-addressed external stage and verifies source, capture, QA, and deliveries", async () => {
  const fixture = await createStage();
  const declarations = await fs.readFile(
    new URL("./stage.d.ts", import.meta.url),
    "utf8",
  );
  const { readStageManifest } = await import("./stage.mjs");
  const result = await readStageManifest(fixture.manifestPath, {
    repoRoot: fixture.repoRoot,
  });
  assert.equal(result.manifest.highlight.id, "stage-demo");
  assert.equal(
    result.manifest.stageDigest,
    `sha256:${path.basename(fixture.stageDir)}`,
  );
  assert.equal(result.scenario.id, "quick-start");
  assert.equal(result.manifest.provenance.seedId, result.scenario.seed.recipe);
  assert.equal(
    result.manifest.provenance.seedDigest,
    fixtureSeedDigest(result.scenario.seed),
  );
  assert.match(declarations, /export interface HighlightStageManifestV1/);
  assert.match(
    declarations,
    /landingAdapter: \{ sourceSha: string; contractVersion: string \}/,
  );

  await fs.appendFile(
    path.join(fixture.stageDir, fixture.manifest.capture.path),
    "tampered",
  );
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

test("stage provenance requires exact landing adapter SHA and contract version", async () => {
  const missing = await createStage({ landingAdapter: null });
  const malformed = await createStage({
    payloadSuffix: "-malformed-landing",
    landingAdapter: { sourceSha: "dirty", contractVersion: "" },
  });
  const { readStageManifest } = await import("./stage.mjs");
  await assert.rejects(
    readStageManifest(missing.manifestPath, { repoRoot: missing.repoRoot }),
    /landing adapter.*(?:required|object)|landingAdapter/i,
  );
  await assert.rejects(
    readStageManifest(malformed.manifestPath, { repoRoot: malformed.repoRoot }),
    /landing adapter.*SHA|contract version|landingAdapter/i,
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
  const fixture = await createStage({
    qaStatus: "accepted",
    reportStatus: "rejected",
  });
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
  const scenarioPath = path.join(
    fixture.stageDir,
    fixture.manifest.scenario.path,
  );
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
  assert.equal(
    result.descriptor.mobile.declaration,
    "Feature has a native mobile surface.",
  );
  assert.equal(
    result.descriptor.provenance.scenario_digest,
    fixture.manifest.scenario.digest,
  );
  assert.equal(
    result.descriptor.provenance.capture_digest,
    fixture.manifest.capture.digest,
  );
  assert.equal(
    result.descriptor.provenance.stage_digest,
    fixture.manifest.stageDigest,
  );
  assert.deepEqual(result.descriptor.provenance.landing_adapter, {
    source_sha: "89abcdef0123456789abcdef0123456789abcdef",
    contract_version: "1.0.0",
  });
  assert.match(result.descriptor.source_digest, /^sha256:[a-f0-9]{64}$/);

  const promotedFiles = await relativeFiles(
    path.join(fixture.highlightsDir, "stage-demo"),
  );
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
  assert(
    !promotedFiles.some((file) => file.includes("raw") || file.includes("qa")),
  );

  const retried = await promoteStagedHighlight({
    manifestPath: fixture.manifestPath,
    repoRoot: fixture.repoRoot,
    highlightsDir: fixture.highlightsDir,
    probe: probeFixture,
  });
  assert.equal(retried.recovered, true);
  assert.equal(
    retried.descriptor.source_digest,
    result.descriptor.source_digest,
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
      probe: async () => {
        throw new Error("decode failed");
      },
    }),
    /decode failed/,
  );
  await assert.rejects(
    fs.access(path.join(fixture.highlightsDir, "stage-demo")),
  );
  assert.equal(
    (await fs.readdir(fixture.highlightsDir)).filter((name) =>
      name.startsWith(".promote-"),
    ).length,
    0,
  );
});

test("promotion reclaims a lock whose recorded owner is provably gone", async () => {
  const fixture = await createStage();
  const lockPath = promotionLockPath(fixture);
  await writePromotionLock(lockPath, {
    pid: 2_147_483_647,
    startToken: "1",
  });
  const { promoteStagedHighlight } = await import("./stage.mjs");

  const result = await promoteStagedHighlight({
    manifestPath: fixture.manifestPath,
    repoRoot: fixture.repoRoot,
    highlightsDir: fixture.highlightsDir,
    probe: probeFixture,
    now: "2026-07-22T12:00:00.000Z",
  });

  assert.equal(result.descriptor.id, "stage-demo");
  await assert.rejects(fs.access(lockPath));
});

test("promotion refuses a lock owned by the active PID and start token", async () => {
  const fixture = await createStage();
  const lockPath = promotionLockPath(fixture);
  const { processStartToken } = await import("./capture-runtime.mjs");
  const startToken = await processStartToken(process.pid);
  assert.equal(typeof startToken, "string");
  await writePromotionLock(lockPath, { pid: process.pid, startToken });
  const { promoteStagedHighlight } = await import("./stage.mjs");

  await assert.rejects(
    promoteStagedHighlight({
      manifestPath: fixture.manifestPath,
      repoRoot: fixture.repoRoot,
      highlightsDir: fixture.highlightsDir,
      probe: probeFixture,
    }),
    new RegExp(
      `active.*promotion.*lock.*PID ${process.pid}|promotion.*lock.*PID ${process.pid}.*active`,
      "i",
    ),
  );
  await assert.rejects(
    fs.access(path.join(fixture.highlightsDir, "stage-demo")),
  );
  assert.equal(
    JSON.parse(await fs.readFile(lockPath, "utf8")).owner.startToken,
    startToken,
  );
});

test("promotion refuses malformed or ambiguous lock ownership", async () => {
  const fixture = await createStage();
  const lockPath = promotionLockPath(fixture);
  await fs.writeFile(lockPath, '{"contract":"unknown"}\n', { flag: "wx" });
  const { promoteStagedHighlight } = await import("./stage.mjs");

  await assert.rejects(
    promoteStagedHighlight({
      manifestPath: fixture.manifestPath,
      repoRoot: fixture.repoRoot,
      highlightsDir: fixture.highlightsDir,
      probe: probeFixture,
    }),
    /malformed|ambiguous|cannot prove.*owner/i,
  );
  assert.equal(await fs.readFile(lockPath, "utf8"), '{"contract":"unknown"}\n');
});

test("promotion refuses a symlinked lock without touching its target", async () => {
  const fixture = await createStage();
  const lockPath = promotionLockPath(fixture);
  const outside = path.join(fixture.base, "outside-promotion.lock");
  await writePromotionLock(outside, {
    pid: 2_147_483_647,
    startToken: "1",
  });
  await fs.symlink(outside, lockPath);
  const { promoteStagedHighlight } = await import("./stage.mjs");

  await assert.rejects(
    promoteStagedHighlight({
      manifestPath: fixture.manifestPath,
      repoRoot: fixture.repoRoot,
      highlightsDir: fixture.highlightsDir,
      probe: probeFixture,
    }),
    /symlink|ambiguous|regular.*lock/i,
  );
  assert.equal(
    JSON.parse(await fs.readFile(outside, "utf8")).owner.pid,
    2_147_483_647,
  );
});

test("promotion surfaces lock cleanup failure after successful promotion", async () => {
  const fixture = await createStage();
  const lockPath = promotionLockPath(fixture);
  let replaced = false;
  const { promoteStagedHighlight } = await import("./stage.mjs");

  await assert.rejects(
    promoteStagedHighlight({
      manifestPath: fixture.manifestPath,
      repoRoot: fixture.repoRoot,
      highlightsDir: fixture.highlightsDir,
      probe: async (filePath) => {
        if (!replaced) {
          replaced = true;
          await replacePromotionLock(lockPath);
        }
        return probeFixture(filePath);
      },
      now: "2026-07-22T12:00:00.000Z",
    }),
    /promotion.*lock.*cleanup|cleanup.*promotion.*lock/i,
  );
  await fs.access(
    path.join(fixture.highlightsDir, "stage-demo/highlight.json"),
  );
  assert.equal(
    await fs.readFile(path.join(lockPath, "foreign-owner"), "utf8"),
    "preserve",
  );
});

test("promotion aggregates primary and lock cleanup failures", async () => {
  const fixture = await createStage();
  const lockPath = promotionLockPath(fixture);
  const { promoteStagedHighlight } = await import("./stage.mjs");
  let failure;
  try {
    await promoteStagedHighlight({
      manifestPath: fixture.manifestPath,
      repoRoot: fixture.repoRoot,
      highlightsDir: fixture.highlightsDir,
      probe: async () => {
        await replacePromotionLock(lockPath);
        throw new Error("decode failed before promotion");
      },
      now: "2026-07-22T12:00:00.000Z",
    });
  } catch (error) {
    failure = error;
  }

  assert(failure instanceof AggregateError);
  assert.match(failure.message, /promotion.*cleanup/i);
  assert(
    failure.errors.some((error) =>
      /decode failed before promotion/.test(error.message),
    ),
  );
  assert(
    failure.errors.some((error) =>
      /lock.*changed|lock.*cleanup|cleanup.*lock/i.test(error.message),
    ),
  );
  await assert.rejects(
    fs.access(path.join(fixture.highlightsDir, "stage-demo")),
  );
  assert.equal(
    await fs.readFile(path.join(lockPath, "foreign-owner"), "utf8"),
    "preserve",
  );
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
  const oldBytes = await fs.readFile(
    path.join(first.highlightsDir, "stage-demo/revisions/r1/desktop.mp4"),
  );
  const second = await createStage({
    revision: "r2",
    existing: first,
    payloadSuffix: "-r2",
  });
  const result = await promoteStagedHighlight({
    manifestPath: second.manifestPath,
    repoRoot: first.repoRoot,
    highlightsDir: first.highlightsDir,
    probe: probeFixture,
    now: "2026-07-22T13:00:00.000Z",
  });

  assert.equal(result.descriptor.active_revision, "r2");
  assert.deepEqual(
    result.descriptor.revision_history.map((entry) => entry.revision),
    ["r1", "r2"],
  );
  assert.deepEqual(
    await fs.readFile(
      path.join(first.highlightsDir, "stage-demo/revisions/r1/desktop.mp4"),
    ),
    oldBytes,
  );
  assert.notDeepEqual(
    await fs.readFile(
      path.join(first.highlightsDir, "stage-demo/revisions/r2/desktop.mp4"),
    ),
    oldBytes,
  );
});

test("CLI promote refuses a legacy accepted-stage manifest", async () => {
  const fixture = await createStage();
  const script = path.resolve("scripts/highlights.mjs");
  const result = spawnSync(
    process.execPath,
    [script, "promote", fixture.manifestPath, "--dry-run"],
    {
      cwd: fixture.repoRoot,
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /promote.*review.*v2|review.*manifest.*only/i);
  await assert.rejects(
    fs.access(path.join(fixture.highlightsDir, "stage-demo")),
  );
});

test("CLI promote refuses a self-hashed legacy stage backed only by technical_pass", async () => {
  const fixture = await createStage({
    payloadSuffix: "-technical-pass-bypass",
    qaStatus: "accepted",
    reportStatus: "technical_pass",
    reportPassed: true,
  });
  const script = path.resolve("scripts/highlights.mjs");
  const result = spawnSync(
    process.execPath,
    [script, "promote", fixture.manifestPath, "--dry-run"],
    {
      cwd: fixture.repoRoot,
      encoding: "utf8",
    },
  );

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /promote.*review.*v2|review.*manifest.*only/i);
  await assert.rejects(
    fs.access(path.join(fixture.highlightsDir, "stage-demo")),
  );
});

function promotionLockPath(fixture) {
  return path.join(fixture.highlightsDir, ".promote-stage-demo.lock");
}

async function writePromotionLock(lockPath, { pid, startToken }) {
  await fs.writeFile(
    lockPath,
    `${JSON.stringify({
      contract: "kandev-highlight-promotion-lock-v1",
      highlightId: "stage-demo",
      owner: { pid, startToken },
      createdAt: "2026-07-22T09:00:00.000Z",
    })}\n`,
    { flag: "wx" },
  );
}

async function replacePromotionLock(lockPath) {
  await fs.rm(lockPath, { recursive: true, force: true });
  await fs.mkdir(lockPath);
  await fs.writeFile(path.join(lockPath, "foreign-owner"), "preserve");
}
