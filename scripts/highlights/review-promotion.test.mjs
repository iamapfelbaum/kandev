import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const SENSITIVE_COVERAGE = Object.freeze({
  metadata: true,
  visibleDomText: true,
  browserConsole: true,
  runtimeLogs: false,
  renderedPixelOcr: false,
});

function runtimeProvenance(sourceSha, overrides = {}) {
  return {
    contract: "kandev-highlight-runtime-provenance-v1",
    runtimeId: "kandev-isolated-e2e",
    receiptDigest: `sha256:${"2".repeat(64)}`,
    buildManifestDigest: `sha256:${"3".repeat(64)}`,
    buildContentDigest: `sha256:${"a".repeat(64)}`,
    captureEvidenceDigest: `sha256:${"4".repeat(64)}`,
    runtimeLogDigest: `sha256:${"5".repeat(64)}`,
    source: { mode: "pr_head", selectedSha: sourceSha },
    scanner: {
      contract: "kandev-highlight-sensitive-scan-v1",
      coverage: structuredClone(SENSITIVE_COVERAGE),
    },
    ...overrides,
  };
}

function delivery(mobileRequired) {
  return {
    revision: "r1",
    releaseVersion: "1.2.3",
    summary: "Show one exact deterministic interaction.",
    caption: "Open the composer and hold the result.",
    featureFlags: ["features.highlights"],
    docs: { page: "guide.md", section: "Paired demo" },
    mobileDeclaration: mobileRequired
      ? "Feature has a native mobile surface."
      : "Desktop-only workflow in this revision.",
    mobileRequired,
  };
}

function scenario(form, mobileRequired) {
  const mobile = form === "mobile";
  return {
    $schema: "https://kandev.com/schemas/highlight-scenario-v1.json",
    schemaVersion: 1,
    id: "paired-demo",
    title: "Paired demo",
    profile: mobile
      ? { kind: "native-mobile", viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 }
      : { kind: "desktop", viewport: { width: 1920, height: 1200 }, deviceScaleFactor: 2 },
    seed: { recipe: "kandev.highlight.paired", parameters: {} },
    setup: { route: "workspace.board", primitives: [] },
    story: {
      openingSettleMs: 500,
      actions: [{ kind: "pause", durationMs: 1_000, label: "Show seeded state" }],
      endingSettleMs: 500,
    },
    delivery: delivery(mobileRequired),
  };
}

async function writeReview({
  form = "desktop",
  mobileRequired = false,
  existing,
  sourceSha = "0123456789abcdef0123456789abcdef01234567",
  seedDigest = `sha256:${"1".repeat(64)}`,
  capturedAt = "2026-07-22T10:00:00.000Z",
  revision = "r1",
  payloadSuffix = "",
  runtime = runtimeProvenance(sourceSha),
  sensitiveCoverage,
  reviewContract = "kandev-highlight-review-stage-v2",
  schemaVersion = 2,
  reportScenarioId,
} = {}) {
  let base;
  let repoRoot;
  let highlightsDir;
  let reviewsRoot;
  if (existing) {
    ({ base, repoRoot, highlightsDir, reviewsRoot } = existing);
  } else {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "kandev-highlight-review-"));
    repoRoot = path.join(base, "repo");
    highlightsDir = path.join(repoRoot, "docs/public/media/highlights");
    reviewsRoot = path.join(base, "reviews");
    await fs.mkdir(highlightsDir, { recursive: true });
    await fs.mkdir(reviewsRoot, { recursive: true });
    await fs.writeFile(path.join(repoRoot, "docs/public/guide.md"), "# Guide\n\n## Paired demo\n\nDocs.\n");
  }

  const mobile = form === "mobile";
  const profile = mobile ? "native-mobile" : "desktop";
  const width = mobile ? 1290 : 1920;
  const height = mobile ? 2796 : 1200;
  const value = scenario(form, mobileRequired);
  value.delivery.revision = revision;
  const workDir = await fs.mkdtemp(path.join(reviewsRoot, ".building-"));
  const scenarioBytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const rawBytes = Buffer.from(`${form}-raw${payloadSuffix}`);
  const reportBytes = Buffer.from(`${JSON.stringify({
    status: "technical_pass",
    passed: true,
    scenarioId: reportScenarioId ?? value.id,
    checks: ["codec", "containment"],
    ...(runtime
      ? {
          runtime,
          sensitiveData: {
            contract: "kandev-highlight-sensitive-scan-v1",
            passed: true,
            coverage: structuredClone(sensitiveCoverage ?? runtime.scanner.coverage),
            findings: [],
          },
        }
      : {}),
  })}\n`);
  const mediaBytes = {
    webm: Buffer.from(`${form}-webm${payloadSuffix}`),
    mp4: Buffer.from(`${form}-mp4${payloadSuffix}`),
    poster: Buffer.from(`${form}-poster${payloadSuffix}`),
  };
  const files = {
    "scenario.json": scenarioBytes,
    [`raw/${form}.source.mp4`]: rawBytes,
    "qa/report.json": reportBytes,
    [`deliveries/${form}.webm`]: mediaBytes.webm,
    [`deliveries/${form}.mp4`]: mediaBytes.mp4,
    [`deliveries/${form}.webp`]: mediaBytes.poster,
  };
  await Promise.all(Object.entries(files).map(async ([relative, bytes]) => {
    const destination = path.join(workDir, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes);
  }));

  const { computeScenarioDigest } = await import("./scenario.mjs");
  const scenarioDigest = computeScenarioDigest(value);
  const record = (kind) => {
    const extension = kind === "poster" ? "webp" : kind;
    const relative = `deliveries/${form}.${extension}`;
    const bytes = files[relative];
    return {
      path: relative,
      bytes: bytes.length,
      sha256: sha(bytes),
      codec: kind === "poster" ? "webp" : kind === "webm" ? "vp9" : "h264",
      width,
      height,
      fps: kind === "poster" ? null : 25,
      duration: kind === "poster" ? null : 2,
      audio: false,
    };
  };
  const manifest = {
    contract: reviewContract,
    schemaVersion,
    revision,
    highlight: {
      id: value.id,
      title: value.title,
      summary: value.delivery.summary,
      caption: value.delivery.caption,
      releaseVersion: value.delivery.releaseVersion,
      featureFlags: value.delivery.featureFlags,
      docs: value.delivery.docs,
      mobileDeclaration: value.delivery.mobileDeclaration,
      mobileRequired,
    },
    scenario: { path: "scenario.json", digest: scenarioDigest },
    capture: { path: `raw/${form}.source.mp4`, digest: `sha256:${sha(rawBytes)}` },
    qa: {
      status: "technical_pass",
      passed: true,
      reportPath: "qa/report.json",
      reportDigest: `sha256:${sha(reportBytes)}`,
      completedAt: "2026-07-22T11:00:00.000Z",
    },
    provenance: {
      captureMode: "pr_head",
      sourceSha,
      capturedAt,
      seedId: value.seed.recipe,
      seedDigest,
      toolVersion: "kandev-highlights/1.0.0",
      landingAdapter: {
        sourceSha: "89abcdef0123456789abcdef0123456789abcdef",
        contractVersion: "1.0.0",
      },
      prNumber: 42,
      prBaseSha: "fedcba9876543210fedcba9876543210fedcba98",
      prHeadSha: sourceSha,
      ...(runtime ? { runtime } : {}),
    },
    profile,
    promotable: false,
    readyForReview: true,
    reason: mobile ? "desktop-stage-required" : "explicit-acceptance-required",
    assets: {
      [form]: { webm: record("webm"), mp4: record("mp4"), poster: record("poster") },
    },
  };
  const { computeStageManifestDigest } = await import("./stage.mjs");
  manifest.stageDigest = computeStageManifestDigest(manifest);
  await fs.writeFile(path.join(workDir, "review.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const reviewDir = path.join(reviewsRoot, manifest.stageDigest.slice("sha256:".length));
  await fs.rename(workDir, reviewDir);
  return {
    base,
    repoRoot,
    highlightsDir,
    reviewsRoot,
    reviewDir,
    manifest,
    manifestPath: path.join(reviewDir, "review.json"),
  };
}

test("technical review refuses missing runtime and scanner provenance", async (t) => {
  const fixture = await writeReview({ runtime: null });
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const { readReviewManifest } = await import("./stage.mjs");

  await assert.rejects(
    () => readReviewManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot }),
    /runtime|scanner|sensitive/i,
  );
});

test("technical review requires stable build content identity", async (t) => {
  const sourceSha = "0123456789abcdef0123456789abcdef01234567";
  const runtime = runtimeProvenance(sourceSha);
  delete runtime.buildContentDigest;
  const fixture = await writeReview({
    sourceSha,
    runtime,
  });
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const { readReviewManifest } = await import("./stage.mjs");

  await assert.rejects(
    readReviewManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot }),
    /runtime provenance.*buildContentDigest|build content digest.*required/i,
  );
});

test("technical review binds QA sensitive coverage to runtime policy", async (t) => {
  const sourceSha = "0123456789abcdef0123456789abcdef01234567";
  const runtime = runtimeProvenance(sourceSha);
  const fixture = await writeReview({
    runtime,
    sensitiveCoverage: { ...SENSITIVE_COVERAGE, browserConsole: false },
  });
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const { readReviewManifest } = await import("./stage.mjs");

  await assert.rejects(
    () => readReviewManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot }),
    /coverage|scanner|sensitive/i,
  );
});

test("technical review binds the QA report to the staged scenario", async (t) => {
  const fixture = await writeReview({ reportScenarioId: "different-story" });
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const { readReviewManifest } = await import("./stage.mjs");

  await assert.rejects(
    () => readReviewManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot }),
    /QA report.*scenario|scenario.*QA report/i,
  );
});

test("review contract version is fail-closed even with a self-consistent digest", async (t) => {
  const fixture = await writeReview({
    reviewContract: "kandev-highlight-review-stage-v1",
    schemaVersion: 1,
  });
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const { readReviewManifest } = await import("./stage.mjs");

  await assert.rejects(
    () => readReviewManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot }),
    /review.*contract.*v2|schemaVersion.*2/i,
  );
});

test("reads one immutable technical review without treating it as accepted", async (t) => {
  const fixture = await writeReview();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const stage = await import("./stage.mjs");
  const declarations = await fs.readFile(new URL("./stage.d.ts", import.meta.url), "utf8");

  assert.equal(typeof stage.readReviewManifest, "function");
  assert.match(declarations, /export interface HighlightReviewManifestV2/);
  assert.match(declarations, /export function readReviewManifest/);
  assert.match(declarations, /export function promoteReviewedHighlight/);
  const reviewed = await stage.readReviewManifest(fixture.manifestPath, { repoRoot: fixture.repoRoot });
  assert.equal(reviewed.form, "desktop");
  assert.equal(reviewed.manifest.qa.status, "technical_pass");
  assert.equal(reviewed.manifest.promotable, false);
  assert.equal(reviewed.scenario.profile.kind, "desktop");
});

test("technical_pass review cannot promote without explicit stable reviewer acceptance", async (t) => {
  const fixture = await writeReview();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const stage = await import("./stage.mjs");

  assert.equal(typeof stage.promoteReviewedHighlight, "function");
  await assert.rejects(
    () => stage.promoteReviewedHighlight({
      desktopManifestPath: fixture.manifestPath,
      repoRoot: fixture.repoRoot,
      highlightsDir: fixture.highlightsDir,
      dryRun: true,
    }),
    /acceptedBy|accept-reviewed-by/i,
  );
  await assert.rejects(
    () => stage.promoteReviewedHighlight({
      desktopManifestPath: fixture.manifestPath,
      acceptedBy: "Display Name With Spaces",
      repoRoot: fixture.repoRoot,
      highlightsDir: fixture.highlightsDir,
      dryRun: true,
    }),
    /stable reviewer/i,
  );
  assert.deepEqual(await fs.readdir(fixture.highlightsDir), []);
});

test("explicitly accepted desktop review promotes and records acceptance without raw or QA files", async (t) => {
  const fixture = await writeReview();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const { promoteReviewedHighlight } = await import("./stage.mjs");

  const result = await promoteReviewedHighlight({
    desktopManifestPath: fixture.manifestPath,
    acceptedBy: "reviewer-42",
    repoRoot: fixture.repoRoot,
    highlightsDir: fixture.highlightsDir,
    probe: probeReviewFixture,
    now: "2026-07-22T12:00:00.000Z",
  });

  assert.equal(result.descriptor.qa_status, "accepted");
  assert.deepEqual(result.descriptor.provenance.acceptance, {
    status: "accepted",
    accepted_by: "reviewer-42",
    accepted_at: "2026-07-22T12:00:00.000Z",
    desktop_review_digest: fixture.manifest.stageDigest,
  });
  assert.equal(result.descriptor.mobile.available, false);
  const revisionDir = path.join(fixture.highlightsDir, "paired-demo/revisions/r1");
  const files = (await fs.readdir(revisionDir)).sort();
  assert.deepEqual(files, ["desktop.mp4", "desktop.webm", "desktop.webp", "provenance.json", "scenario.json"]);
  const compact = JSON.parse(await fs.readFile(path.join(revisionDir, "provenance.json"), "utf8"));
  assert.equal(compact.schema_version, 2);
  assert.deepEqual(compact.runtime, result.descriptor.provenance.runtime);
  assert.deepEqual(compact.acceptance, result.descriptor.provenance.acceptance);
  assert.equal(compact.forms.desktop.review_digest, fixture.manifest.stageDigest);
  assert.equal(compact.forms.desktop.scenario_digest, fixture.manifest.scenario.digest);
  assert.equal(compact.forms.desktop.capture_digest, fixture.manifest.capture.digest);
  assert.equal(compact.forms.desktop.qa.report_digest, fixture.manifest.qa.reportDigest);
  assert.equal(compact.forms.desktop.provenance.source_sha, fixture.manifest.provenance.sourceSha);
  assert.equal(compact.forms.mobile, undefined);
  assert.doesNotMatch(
    JSON.stringify({ descriptor: result.descriptor, compact }),
    /playwright\.log|runtimeEvidence|applicationRuntime|Safe seeded board|fixed Playwright|Review API|\/raw\//i,
  );
});

test("mobile-required desktop review refuses promotion without an exact native-mobile review", async (t) => {
  const fixture = await writeReview({ mobileRequired: true });
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const { promoteReviewedHighlight } = await import("./stage.mjs");

  await assert.rejects(
    () => promoteReviewedHighlight({
      desktopManifestPath: fixture.manifestPath,
      acceptedBy: "reviewer-42",
      repoRoot: fixture.repoRoot,
      highlightsDir: fixture.highlightsDir,
      dryRun: true,
    }),
    /mobile.*required.*review|native-mobile.*required/i,
  );
  assert.deepEqual(await fs.readdir(fixture.highlightsDir), []);
});

test("desktop and mobile reviews with mismatched source provenance cannot be paired", async (t) => {
  const desktop = await writeReview({ mobileRequired: true });
  const mobile = await writeReview({
    form: "mobile",
    mobileRequired: true,
    existing: desktop,
    sourceSha: "a".repeat(40),
    payloadSuffix: "-mobile",
  });
  t.after(() => fs.rm(desktop.base, { recursive: true, force: true }));
  const { promoteReviewedHighlight } = await import("./stage.mjs");

  await assert.rejects(
    () => promoteReviewedHighlight({
      desktopManifestPath: desktop.manifestPath,
      mobileManifestPath: mobile.manifestPath,
      acceptedBy: "reviewer-42",
      repoRoot: desktop.repoRoot,
      highlightsDir: desktop.highlightsDir,
      dryRun: true,
    }),
    /sourceSha|source.*(?:match|pair)|paired.*source/i,
  );
  assert.deepEqual(await fs.readdir(desktop.highlightsDir), []);
});

test("desktop and mobile reviews require one runtime, build, and scanner policy", async (t) => {
  const cases = [
    {
      name: "runtime",
      overrides: { runtimeId: "unregistered-runtime" },
      pattern: /unknown Highlight runtime|runtime.*match/i,
    },
    {
      name: "build",
      overrides: { buildContentDigest: `sha256:${"9".repeat(64)}` },
      pattern: /runtime.*build|build.*match/i,
    },
    {
      name: "scanner",
      overrides: {
        scanner: {
          contract: "kandev-highlight-sensitive-scan-v1",
          coverage: { ...SENSITIVE_COVERAGE, browserConsole: false },
        },
      },
      pattern: /scanner|coverage/i,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async (subtest) => {
      const desktop = await writeReview({ mobileRequired: true });
      const mobile = await writeReview({
        form: "mobile",
        mobileRequired: true,
        existing: desktop,
        payloadSuffix: `-${item.name}`,
        runtime: runtimeProvenance(
          desktop.manifest.provenance.sourceSha,
          item.overrides,
        ),
      });
      subtest.after(() => fs.rm(desktop.base, { recursive: true, force: true }));
      const { promoteReviewedHighlight } = await import("./stage.mjs");
      await assert.rejects(
        () =>
          promoteReviewedHighlight({
            desktopManifestPath: desktop.manifestPath,
            mobileManifestPath: mobile.manifestPath,
            acceptedBy: "reviewer-42",
            repoRoot: desktop.repoRoot,
            highlightsDir: desktop.highlightsDir,
            dryRun: true,
          }),
        item.pattern,
      );
    });
  }
});

test("paired reviews may retain independent receipt and evidence digests", async (t) => {
  const desktop = await writeReview({ mobileRequired: true });
  const sourceSha = desktop.manifest.provenance.sourceSha;
  const mobile = await writeReview({
    form: "mobile",
    mobileRequired: true,
    existing: desktop,
    payloadSuffix: "-independent-evidence",
    runtime: runtimeProvenance(sourceSha, {
      receiptDigest: `sha256:${"6".repeat(64)}`,
      captureEvidenceDigest: `sha256:${"7".repeat(64)}`,
      runtimeLogDigest: `sha256:${"8".repeat(64)}`,
    }),
  });
  t.after(() => fs.rm(desktop.base, { recursive: true, force: true }));
  const { promoteReviewedHighlight } = await import("./stage.mjs");

  const result = await promoteReviewedHighlight({
    desktopManifestPath: desktop.manifestPath,
    mobileManifestPath: mobile.manifestPath,
    acceptedBy: "reviewer-42",
    repoRoot: desktop.repoRoot,
    highlightsDir: desktop.highlightsDir,
    dryRun: true,
  });
  assert.equal(result.dryRun, true);
});

test("paired reviews may retain independent build manifests for identical build content", async (t) => {
  const buildContentDigest = `sha256:${"a".repeat(64)}`;
  const desktop = await writeReview({
    mobileRequired: true,
    runtime: runtimeProvenance("0123456789abcdef0123456789abcdef01234567", {
      buildContentDigest,
    }),
  });
  const sourceSha = desktop.manifest.provenance.sourceSha;
  const mobile = await writeReview({
    form: "mobile",
    mobileRequired: true,
    existing: desktop,
    payloadSuffix: "-independent-build-manifest",
    runtime: runtimeProvenance(sourceSha, {
      buildManifestDigest: `sha256:${"9".repeat(64)}`,
      buildContentDigest,
    }),
  });
  t.after(() => fs.rm(desktop.base, { recursive: true, force: true }));
  const { promoteReviewedHighlight } = await import("./stage.mjs");

  const result = await promoteReviewedHighlight({
    desktopManifestPath: desktop.manifestPath,
    mobileManifestPath: mobile.manifestPath,
    acceptedBy: "reviewer-42",
    repoRoot: desktop.repoRoot,
    highlightsDir: desktop.highlightsDir,
    dryRun: true,
  });
  assert.equal(result.dryRun, true);
});

test("paired reviews reject different build content under the same source", async (t) => {
  const sourceSha = "0123456789abcdef0123456789abcdef01234567";
  const desktop = await writeReview({
    mobileRequired: true,
    sourceSha,
    runtime: runtimeProvenance(sourceSha, {
      buildContentDigest: `sha256:${"a".repeat(64)}`,
    }),
  });
  const mobile = await writeReview({
    form: "mobile",
    mobileRequired: true,
    existing: desktop,
    sourceSha,
    payloadSuffix: "-different-build-content",
    runtime: runtimeProvenance(sourceSha, {
      buildManifestDigest: `sha256:${"9".repeat(64)}`,
      buildContentDigest: `sha256:${"b".repeat(64)}`,
    }),
  });
  t.after(() => fs.rm(desktop.base, { recursive: true, force: true }));
  const { promoteReviewedHighlight } = await import("./stage.mjs");

  await assert.rejects(
    promoteReviewedHighlight({
      desktopManifestPath: desktop.manifestPath,
      mobileManifestPath: mobile.manifestPath,
      acceptedBy: "reviewer-42",
      repoRoot: desktop.repoRoot,
      highlightsDir: desktop.highlightsDir,
      dryRun: true,
    }),
    /paired.*build content identity.*match/i,
  );
});

test("accepted exact desktop/mobile pair preserves both scenarios and per-form review provenance", async (t) => {
  const desktop = await writeReview({ mobileRequired: true });
  const mobileRuntime = runtimeProvenance(desktop.manifest.provenance.sourceSha, {
    receiptDigest: `sha256:${"6".repeat(64)}`,
    buildManifestDigest: `sha256:${"9".repeat(64)}`,
    captureEvidenceDigest: `sha256:${"7".repeat(64)}`,
    runtimeLogDigest: `sha256:${"8".repeat(64)}`,
  });
  const mobile = await writeReview({
    form: "mobile",
    mobileRequired: true,
    existing: desktop,
    capturedAt: "2026-07-22T10:05:00.000Z",
    payloadSuffix: "-mobile",
    runtime: mobileRuntime,
  });
  t.after(() => fs.rm(desktop.base, { recursive: true, force: true }));
  const { promoteReviewedHighlight } = await import("./stage.mjs");

  const result = await promoteReviewedHighlight({
    desktopManifestPath: desktop.manifestPath,
    mobileManifestPath: mobile.manifestPath,
    acceptedBy: "reviewer-42",
    repoRoot: desktop.repoRoot,
    highlightsDir: desktop.highlightsDir,
    probe: probeReviewFixture,
    now: "2026-07-22T12:00:00.000Z",
  });

  assert.equal(result.descriptor.mobile.available, true);
  assert.equal(result.descriptor.mobile_scenario.digest, mobile.manifest.scenario.digest);
  assert.equal(result.descriptor.mobile_scenario.path, "revisions/r1/scenario.mobile.json");
  assert.equal(result.descriptor.provenance.acceptance.mobile_review_digest, mobile.manifest.stageDigest);
  assert.equal(result.descriptor.provenance.forms.mobile.review_digest, mobile.manifest.stageDigest);
  assert.equal(result.descriptor.provenance.forms.mobile.qa.report_digest, mobile.manifest.qa.reportDigest);
  assert.equal(result.descriptor.provenance.forms.mobile.provenance.seed_digest, mobile.manifest.provenance.seedDigest);
  const revisionDir = path.join(desktop.highlightsDir, "paired-demo/revisions/r1");
  const promotedMobileScenario = JSON.parse(await fs.readFile(path.join(revisionDir, "scenario.mobile.json"), "utf8"));
  assert.equal(promotedMobileScenario.profile.kind, "native-mobile");
  const compact = JSON.parse(await fs.readFile(path.join(revisionDir, "provenance.json"), "utf8"));
  assert.equal(compact.forms.desktop.qa.status, "technical_pass");
  assert.equal(compact.forms.desktop.provenance.captured_at, "2026-07-22T10:00:00.000Z");
  assert.equal(compact.forms.mobile.qa.report_digest, mobile.manifest.qa.reportDigest);
  assert.equal(compact.forms.mobile.provenance.captured_at, "2026-07-22T10:05:00.000Z");
  assert.equal(compact.forms.mobile.provenance.source_sha, mobile.manifest.provenance.sourceSha);
  assert.equal(
    compact.forms.desktop.provenance.runtime.build_manifest_digest,
    desktop.manifest.provenance.runtime.buildManifestDigest,
  );
  assert.equal(
    compact.forms.mobile.provenance.runtime.build_manifest_digest,
    mobileRuntime.buildManifestDigest,
  );
  assert.equal(
    compact.forms.desktop.provenance.runtime.build_content_digest,
    compact.forms.mobile.provenance.runtime.build_content_digest,
  );
  for (const [compactKey, runtimeKey] of [
    ["receipt_digest", "receiptDigest"],
    ["capture_evidence_digest", "captureEvidenceDigest"],
    ["runtime_log_digest", "runtimeLogDigest"],
  ]) {
    assert.equal(
      compact.forms.desktop.provenance.runtime[compactKey],
      desktop.manifest.provenance.runtime[runtimeKey],
    );
    assert.equal(
      compact.forms.mobile.provenance.runtime[compactKey],
      mobileRuntime[runtimeKey],
    );
  }
  assert.doesNotMatch(
    JSON.stringify(compact),
    /builtAt|commands|environment|apps\/backend\/bin|apps\/web\/dist/,
  );
});

test("CLI review promotion requires explicit acceptance and dry-run stays read-only", async (t) => {
  const fixture = await writeReview();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const script = path.resolve("scripts/highlights.mjs");

  const missingAcceptance = spawnSync(process.execPath, [
    script,
    "promote",
    fixture.manifestPath,
    "--dry-run",
  ], { cwd: fixture.repoRoot, encoding: "utf8" });
  assert.notEqual(missingAcceptance.status, 0);
  assert.match(missingAcceptance.stderr, /accept-reviewed-by|explicit.*acceptance/i);

  const acceptedDryRun = spawnSync(process.execPath, [
    script,
    "promote",
    fixture.manifestPath,
    "--accept-reviewed-by",
    "reviewer-42",
    "--dry-run",
  ], { cwd: fixture.repoRoot, encoding: "utf8" });
  assert.equal(acceptedDryRun.status, 0, acceptedDryRun.stderr);
  assert.match(acceptedDryRun.stdout, /Dry run:.*paired-demo.*reviewer-42/i);
  assert.deepEqual(await fs.readdir(fixture.highlightsDir), []);
});

test("review acceptance rejects an invalid timestamp before repository mutation", async (t) => {
  const fixture = await writeReview();
  t.after(() => fs.rm(fixture.base, { recursive: true, force: true }));
  const { promoteReviewedHighlight } = await import("./stage.mjs");

  await assert.rejects(
    () => promoteReviewedHighlight({
      desktopManifestPath: fixture.manifestPath,
      acceptedBy: "reviewer-42",
      repoRoot: fixture.repoRoot,
      highlightsDir: fixture.highlightsDir,
      dryRun: true,
      now: "not-a-date",
    }),
    /acceptance timestamp must be a valid date/i,
  );
  assert.deepEqual(await fs.readdir(fixture.highlightsDir), []);
});

test("catalog validation rejects re-hashed tampering of per-form review provenance", async (t) => {
  const desktop = await writeReview({ mobileRequired: true });
  const mobile = await writeReview({
    form: "mobile",
    mobileRequired: true,
    existing: desktop,
    payloadSuffix: "-mobile",
  });
  t.after(() => fs.rm(desktop.base, { recursive: true, force: true }));
  const { promoteReviewedHighlight } = await import("./stage.mjs");
  await promoteReviewedHighlight({
    desktopManifestPath: desktop.manifestPath,
    mobileManifestPath: mobile.manifestPath,
    acceptedBy: "reviewer-42",
    repoRoot: desktop.repoRoot,
    highlightsDir: desktop.highlightsDir,
    probe: probeReviewFixture,
    now: "2026-07-22T12:00:00.000Z",
  });

  const highlightDir = path.join(desktop.highlightsDir, "paired-demo");
  const descriptorPath = path.join(highlightDir, "highlight.json");
  const descriptor = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
  const provenancePath = path.join(highlightDir, descriptor.provenance_record.path);
  const compact = JSON.parse(await fs.readFile(provenancePath, "utf8"));
  compact.forms.mobile.provenance.source_sha = "b".repeat(40);
  const compactBytes = Buffer.from(`${JSON.stringify(compact, null, 2)}\n`);
  await fs.writeFile(provenancePath, compactBytes);
  const compactRecord = {
    ...descriptor.provenance_record,
    bytes: compactBytes.length,
    sha256: sha(compactBytes),
  };
  descriptor.provenance_record = compactRecord;
  const tracked = descriptor.revision_history
    .flatMap((entry) => entry.files)
    .find((record) => record.path === compactRecord.path);
  tracked.bytes = compactRecord.bytes;
  tracked.sha256 = compactRecord.sha256;
  await fs.writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  const highlights = await import("../highlights.mjs");
  descriptor.source_digest = await highlights.computeSourceDigest(highlightDir);
  await fs.writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);

  await assert.rejects(
    () => highlights.validateHighlights({
      repoRoot: desktop.repoRoot,
      highlightsDir: desktop.highlightsDir,
      probe: probeReviewFixture,
      now: "2026-07-22T12:00:00.000Z",
    }),
    /forms?.*source|per-form.*provenance|review provenance.*match/i,
  );
});

test("descriptor rejects mobile_scenario without the full durable companion set", async (t) => {
  const desktop = await writeReview({ mobileRequired: true });
  const mobile = await writeReview({ form: "mobile", mobileRequired: true, existing: desktop, payloadSuffix: "-mobile" });
  t.after(() => fs.rm(desktop.base, { recursive: true, force: true }));
  const { promoteReviewedHighlight } = await import("./stage.mjs");
  const result = await promoteReviewedHighlight({
    desktopManifestPath: desktop.manifestPath,
    mobileManifestPath: mobile.manifestPath,
    acceptedBy: "reviewer-42",
    repoRoot: desktop.repoRoot,
    highlightsDir: desktop.highlightsDir,
    probe: probeReviewFixture,
    now: "2026-07-22T12:00:00.000Z",
  });
  const descriptor = structuredClone(result.descriptor);
  delete descriptor.scenario;
  delete descriptor.provenance_record;
  delete descriptor.revision_history;
  const descriptorPath = path.join(desktop.highlightsDir, "paired-demo/highlight.json");
  await fs.writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  const { parseHighlightDescriptor } = await import("../highlights.mjs");

  await assert.rejects(
    () => parseHighlightDescriptor(descriptorPath),
    /mobile scenario.*durable|durable.*declared together/i,
  );
});

async function probeReviewFixture(filePath) {
  const mobile = filePath.includes("mobile.");
  const poster = filePath.endsWith(".webp");
  return {
    codec: poster ? "webp" : filePath.endsWith(".webm") ? "vp9" : "h264",
    width: mobile ? 1290 : 1920,
    height: mobile ? 2796 : 1200,
    fps: poster ? null : 25,
    duration: poster ? null : 2,
    audio: false,
  };
}
