import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempDirs = [];

async function fixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kandev-highlights-"));
  tempDirs.push(root);
  const mediaRoot = path.join(root, "docs/public/media/highlights");
  await fs.mkdir(mediaRoot, { recursive: true });
  return { root, mediaRoot };
}

function record(bytes, codec, width, height, fps, duration, audio = false) {
  return {
    bytes: Buffer.byteLength(bytes),
    codec,
    width,
    height,
    fps,
    duration,
    audio,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function writeHighlight({ root, id = "task-messaging", status = "queued", mobile = true, desktopWidth = 1920, desktopHeight = 1200 } = {}) {
  const highlightDir = path.join(root, "docs/public/media/highlights", id);
  const revisionDir = path.join(highlightDir, "revisions", "r1");
  await fs.mkdir(revisionDir, { recursive: true });

  const files = {
    "desktop.webm": "webm-bytes",
    "desktop.mp4": "mp4-bytes",
    "desktop.webp": "poster-bytes",
  };
  if (mobile) {
    files["mobile.webm"] = "mobile-webm-bytes";
    files["mobile.mp4"] = "mobile-mp4-bytes";
    files["mobile.webp"] = "mobile-poster-bytes";
  }
  await Promise.all(
    Object.entries(files).map(([name, contents]) =>
      fs.writeFile(path.join(revisionDir, name), contents),
    ),
  );

  const desktop = {
    webm: { path: `revisions/r1/desktop.webm`, ...record(files["desktop.webm"], "vp9", desktopWidth, desktopHeight, 25, 8.2) },
    mp4: { path: `revisions/r1/desktop.mp4`, ...record(files["desktop.mp4"], "h264", desktopWidth, desktopHeight, 25, 8.2) },
    poster: { path: `revisions/r1/desktop.webp`, ...record(files["desktop.webp"], "webp", desktopWidth, desktopHeight, null, null) },
  };
  const descriptor = {
    schema_version: 1,
    id,
    title: "Tasks talk to each other",
    summary: "Coordinate related work without losing context.",
    caption: "Send a message to a related task and keep work coordinated.",
    status,
    release_version: "0.81.0",
    feature_flags: ["features.highlights"],
    qa_status: "accepted",
    docs: { page: "tasks-and-workflows.md", section: "Coordinate related tasks" },
    mobile: {
      available: mobile,
      declaration: mobile ? "Feature has a native mobile surface." : "Feature has no native mobile surface.",
    },
    active_revision: "r1",
    source_digest: `sha256:${"0".repeat(64)}`,
    provenance: {
      capture_mode: "pr_head",
      source_sha: "0123456789abcdef0123456789abcdef01234567",
      captured_at: "2026-07-20T00:00:00.000Z",
      seed_id: "seed-task-messaging-v1",
      seed_digest: `sha256:${"1".repeat(64)}`,
      tool_version: "1.0.0",
      pr_number: 42,
      pr_base_sha: "fedcba9876543210fedcba9876543210fedcba98",
      pr_head_sha: "0123456789abcdef0123456789abcdef01234567",
    },
    desktop,
    ...(mobile
      ? {
          mobile_assets: {
            webm: { path: "revisions/r1/mobile.webm", ...record(files["mobile.webm"], "vp9", 1290, 2796, 25, 8.2) },
            mp4: { path: "revisions/r1/mobile.mp4", ...record(files["mobile.mp4"], "h264", 1290, 2796, 25, 8.2) },
            poster: { path: "revisions/r1/mobile.webp", ...record(files["mobile.webp"], "webp", 1290, 2796, null, null) },
          },
        }
      : {}),
  };
  await fs.writeFile(
    path.join(highlightDir, "highlight.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(root, "docs/public/tasks-and-workflows.md"),
    "# Tasks\n\n## Coordinate related tasks\n\nDocs.\n",
  );
  const { computeSourceDigest } = await import("./highlights.mjs");
  descriptor.source_digest = await computeSourceDigest(highlightDir);
  await fs.writeFile(
    path.join(highlightDir, "highlight.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  );
  return { descriptor, highlightDir };
}

after(async () => {
  await Promise.all(
    tempDirs.map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

test("capture and run CLI use the closed runtime while render and QA use pipeline recovery", async () => {
  const { runHighlightsCli } = await import("./highlights.mjs");
  const pipelineCalls = [];
  const runtimeCalls = [];
  const pipelineRunner = async (options) => {
    pipelineCalls.push(options);
    return { contract: "test-result", command: options.command };
  };
  const runtimeRunner = async (options) => {
    runtimeCalls.push(options);
    return { contract: "test-runtime-result", command: options.command };
  };
  const common = {
    repoRoot: "/repo",
    log: () => {},
    pipelineRunner,
    runtimeRunner,
  };

  await runHighlightsCli([
    "capture", "story.json", "--artifact-root", "/external/story", "--source", "pr_head",
    "--landing-root", "/landing", "--run-id", "ci-42", "--pr-number", "42",
    "--pr-base-sha", "b".repeat(40), "--allow-extension", "fixture.open",
    "--allow-extension", "fixture.close", "--runtime", "kandev-isolated-e2e", "--dry-run",
  ], common);
  await runHighlightsCli([
    "render", "story.json", "--artifact-root", "/external/story", "--landing-root", "/landing", "--run-id", "ci-42",
  ], common);
  await runHighlightsCli([
    "qa", "story.json", "--artifact-root", "/external/story", "--landing-root", "/landing", "--run-id", "ci-42",
  ], common);
  await runHighlightsCli([
    "run", "story.json", "--artifact-root", "/external/story", "--source", "current_main", "--landing-root", "/landing",
  ], common);

  assert.deepEqual(runtimeCalls.map(({ command }) => command), ["capture", "run"]);
  assert.deepEqual(pipelineCalls.map(({ command }) => command), ["render", "qa"]);
  assert.equal(runtimeCalls[0].scenarioPath, "/repo/story.json");
  assert.equal(runtimeCalls[0].artifactRoot, "/external/story");
  assert.equal(runtimeCalls[0].source, "pr_head");
  assert.equal(runtimeCalls[0].prNumber, 42);
  assert.equal(runtimeCalls[0].prBaseSha, "b".repeat(40));
  assert.equal(runtimeCalls[0].dryRun, true);
  assert.equal(runtimeCalls[0].runtimeId, "kandev-isolated-e2e");
  assert.deepEqual(runtimeCalls[0].allowedExtensionIds, ["fixture.open", "fixture.close"]);
  assert.equal(pipelineCalls[0].source, undefined);
  assert.equal(runtimeCalls[1].source, "current_main");
  assert.equal(runtimeCalls[1].runtimeId, "kandev-isolated-e2e");
});

test("capture CLI cannot fall back to an injected in-process pipeline capture", async () => {
  const { runHighlightsCli } = await import("./highlights.mjs");
  let runtimeCalls = 0;
  await runHighlightsCli([
    "capture",
    "story.json",
    "--artifact-root",
    "/external/story",
    "--source",
    "pr_head",
    "--pr-number",
    "42",
    "--pr-base-sha",
    "b".repeat(40),
  ], {
    repoRoot: "/repo",
    log: () => {},
    pipelineRunner: async () => {
      throw new Error("in-process capture fallback executed");
    },
    runtimeRunner: async () => {
      runtimeCalls += 1;
      return { contract: "test-runtime-result" };
    },
  });
  assert.equal(runtimeCalls, 1);
});

test("stage CLI delegates an exact zero-write dry-run to the declarative pipeline", async () => {
  const { root } = await fixtureRoot();
  const { runHighlightsCli } = await import("./highlights.mjs");
  const before = await fs.readdir(root, { recursive: true });
  const received = [];

  await runHighlightsCli(
    [
      "stage",
      "story.json",
      "--artifact-root",
      "/external/story",
      "--run-id",
      "ci-42",
      "--allow-extension",
      "fixture.open",
      "--allow-extension",
      "fixture.close",
      "--dry-run",
    ],
    {
      repoRoot: root,
      log: () => {},
      pipelineRunner: async (options) => {
        received.push(options);
        return { contract: "kandev-highlight-stage-dry-run-v1", dryRun: true };
      },
    },
  );

  assert.deepEqual(received, [
    {
      command: "stage",
      scenarioPath: path.join(root, "story.json"),
      artifactRoot: "/external/story",
      runId: "ci-42",
      allowedExtensionIds: ["fixture.open", "fixture.close"],
      dryRun: true,
      repoRoot: root,
    },
  ]);
  assert.deepEqual(await fs.readdir(root, { recursive: true }), before);
});

test("stage CLI rejects options outside its recovery contract", async () => {
  const { runHighlightsCli } = await import("./highlights.mjs");
  const options = {
    repoRoot: "/repo",
    log: () => {},
    pipelineRunner: async () => ({}),
  };

  for (const [name, value] of [
    ["source", "pr_head"],
    ["runtime", "kandev-isolated-e2e"],
    ["landing-root", "/landing"],
  ]) {
    await assert.rejects(
      runHighlightsCli(
        ["stage", "story.json", "--artifact-root", "/external/story", `--${name}`, value],
        options,
      ),
      new RegExp(`unknown option --${name}`),
    );
  }

  await assert.rejects(
    runHighlightsCli(["stage", "story.json"], options),
    /usage: highlights\.mjs stage <scenario\.json> --artifact-root <external-directory> \[--run-id <id>\] \[--allow-extension <id>\] \[--dry-run\]/,
  );
});

test("declarative pipeline CLI rejects missing, unknown, and duplicate options", async () => {
  const { runHighlightsCli } = await import("./highlights.mjs");
  const options = { repoRoot: "/repo", log: () => {}, pipelineRunner: async () => ({}) };
  await assert.rejects(
    runHighlightsCli(["run", "story.json", "--artifact-root", "/external/story"], options),
    /--source.*required|usage/i,
  );
  await assert.rejects(
    runHighlightsCli(["capture", "story.json", "--artifact-root", "/external/story", "--source", "bad"], options),
    /source.*pr_head.*current_main/i,
  );
  await assert.rejects(
    runHighlightsCli(["render", "story.json", "--artifact-root", "/external/story", "--source", "pr_head"], options),
    /unknown option --source/i,
  );
  await assert.rejects(
    runHighlightsCli(["qa", "story.json", "--artifact-root", "/one", "--artifact-root", "/two"], options),
    /--artifact-root.*only once/i,
  );
  await assert.rejects(
    runHighlightsCli(["run", "story.json", "--artifact-root", "/external/story", "--source", "pr_head", "--dry-run", "--dry-run"], options),
    /--dry-run.*only once/i,
  );
  await assert.rejects(
    runHighlightsCli(["run", "story.json", "extra.json", "--artifact-root", "/external/story", "--source", "pr_head"], options),
    /usage|exactly one scenario/i,
  );
  await assert.rejects(
    runHighlightsCli([
      "run",
      "story.json",
      "--artifact-root",
      "/external/story",
      "--source",
      "pr_head",
      "--runtime",
      "../custom-runtime.mjs",
    ], options),
    /unknown Highlight runtime.*kandev-isolated-e2e/i,
  );
  await assert.rejects(
    runHighlightsCli([
      "render",
      "story.json",
      "--artifact-root",
      "/external/story",
      "--runtime",
      "kandev-isolated-e2e",
    ], options),
    /unknown option --runtime/i,
  );
});

test("exports the Highlights contract module", async () => {
  const modulePath = path.resolve("scripts/highlights.mjs");
  await assert.doesNotReject(fs.access(modulePath));
  const highlights = await import(modulePath);
  for (const name of [
    "parseHighlightDescriptor",
    "validateHighlights",
    "computeSourceDigest",
    "promoteHighlight",
    "buildPrSnippet",
    "evaluatePrGate",
    "activateHighlight",
    "activateHighlightsForRelease",
    "withdrawHighlight",
  ]) {
    assert.equal(typeof highlights[name], "function", `${name} export`);
  }
});

test("probes a checked-in delivery with the real ffprobe executable", async () => {
  const { probeMedia } = await import("./highlights.mjs");
  const evidence = await probeMedia(path.resolve("docs/public/media/feature-guides/task-create.mp4"));
  assert.equal(evidence.codec, "h264");
  assert.equal(evidence.width, 960);
  assert.equal(evidence.height, 600);
  assert.equal(evidence.fps, 25);
  assert.equal(evidence.audio, false);
});

test("parses one descriptor per Highlight and rejects unsafe identifiers", async () => {
  const { root } = await fixtureRoot();
  const { descriptor } = await writeHighlight({ root });
  const { parseHighlightDescriptor } = await import("./highlights.mjs");
  const parsed = await parseHighlightDescriptor(
    path.join(root, "docs/public/media/highlights/task-messaging/highlight.json"),
  );
  assert.equal(parsed.id, descriptor.id);

  descriptor.id = "../escape";
  await fs.writeFile(
    path.join(root, "docs/public/media/highlights/task-messaging/highlight.json"),
    JSON.stringify(descriptor),
  );
  await assert.rejects(
    parseHighlightDescriptor(
      path.join(root, "docs/public/media/highlights/task-messaging/highlight.json"),
    ),
    /id.*lowercase|safe|kebab/i,
  );
});

test("validates all entries without a six-item cap and uses injected ffprobe evidence", async () => {
  const { root } = await fixtureRoot();
  for (let index = 0; index < 7; index += 1) {
    await writeHighlight({ root, id: `highlight-${index}` });
  }
  const { validateHighlights } = await import("./highlights.mjs");
  const result = await validateHighlights({
    repoRoot: root,
    probe: async (filePath) => {
      const isMobile = filePath.includes("mobile.");
      const isPoster = filePath.endsWith(".webp");
      return {
        codec: isPoster ? "webp" : filePath.endsWith(".webm") ? "vp9" : "h264",
        width: isMobile ? 1290 : 1920,
        height: isMobile ? 2796 : 1200,
        fps: isPoster ? null : 25,
        duration: isPoster ? null : 8.2,
        audio: false,
      };
    },
  });
  assert.equal(result.count, 7);
});

test("accepts canonical 960x600 desktop deliveries", async () => {
  const { root } = await fixtureRoot();
  await writeHighlight({ root, id: "canonical-docs-delivery", mobile: false, desktopWidth: 960, desktopHeight: 600 });
  const { validateHighlights } = await import("./highlights.mjs");
  const result = await validateHighlights({
    repoRoot: root,
    probe: async (filePath) => ({
      codec: filePath.endsWith(".webp") ? "webp" : filePath.endsWith(".webm") ? "vp9" : "h264",
      width: 960,
      height: 600,
      fps: filePath.endsWith(".webp") ? null : 25,
      duration: filePath.endsWith(".webp") ? null : 8.2,
      audio: false,
    }),
  });
  assert.equal(result.count, 1);
});

test("treats durable scenario and compact provenance as hashed revision files", async () => {
  const { root } = await fixtureRoot();
  const { descriptor, highlightDir } = await writeHighlight({ root, id: "durable-scenario", mobile: false });
  const revisionDir = path.join(highlightDir, "revisions/r1");
  const scenarioBytes = await fs.readFile(path.resolve("scripts/highlights/examples/quick-start.scenario.json"));
  const { computeScenarioDigest } = await import("./highlights/scenario.mjs");
  const scenarioDigest = computeScenarioDigest(JSON.parse(scenarioBytes));
  const captureDigest = `sha256:${"2".repeat(64)}`;
  const stageDigest = `sha256:${"3".repeat(64)}`;
  const provenanceBytes = Buffer.from(`${JSON.stringify({
    schema_version: 1,
    scenario_digest: scenarioDigest,
    capture_digest: captureDigest,
    stage_digest: stageDigest,
    source_sha: descriptor.provenance.source_sha,
    landing_adapter: {
      source_sha: "89abcdef0123456789abcdef0123456789abcdef",
      contract_version: "1.0.0",
    },
    qa: { status: "accepted", report_digest: `sha256:${"4".repeat(64)}` },
  })}\n`);
  await fs.writeFile(path.join(revisionDir, "scenario.json"), scenarioBytes);
  await fs.writeFile(path.join(revisionDir, "provenance.json"), provenanceBytes);
  const companionRecord = (name, bytes) => ({
    path: `revisions/r1/${name}`,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  descriptor.scenario = {
    ...companionRecord("scenario.json", scenarioBytes),
    digest: scenarioDigest,
  };
  descriptor.provenance_record = companionRecord("provenance.json", provenanceBytes);
  descriptor.provenance.scenario_digest = scenarioDigest;
  descriptor.provenance.capture_digest = captureDigest;
  descriptor.provenance.stage_digest = stageDigest;
  descriptor.provenance.landing_adapter = {
    source_sha: "89abcdef0123456789abcdef0123456789abcdef",
    contract_version: "1.0.0",
  };
  descriptor.revision_history = [{
    revision: "r1",
    files: [
      ...Object.values(descriptor.desktop).map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 })),
      descriptor.scenario,
      descriptor.provenance_record,
    ].map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 })),
  }];
  await fs.writeFile(path.join(highlightDir, "highlight.json"), JSON.stringify(descriptor, null, 2));
  const { computeSourceDigest, validateHighlights } = await import("./highlights.mjs");
  descriptor.source_digest = await computeSourceDigest(highlightDir);
  await fs.writeFile(path.join(highlightDir, "highlight.json"), JSON.stringify(descriptor, null, 2));

  const result = await validateHighlights({
    repoRoot: root,
    probe: async (filePath) => ({
      codec: filePath.endsWith(".webp") ? "webp" : filePath.endsWith(".webm") ? "vp9" : "h264",
      width: 1920,
      height: 1200,
      fps: filePath.endsWith(".webp") ? null : 25,
      duration: filePath.endsWith(".webp") ? null : 8.2,
      audio: false,
    }),
  });
  assert.equal(result.count, 1);

  const provenancePath = path.join(revisionDir, "provenance.json");
  const mismatchedCompact = JSON.parse(await fs.readFile(provenancePath, "utf8"));
  mismatchedCompact.landing_adapter.contract_version = "2.0.0";
  const rewriteCompact = async (compact) => {
    const bytes = Buffer.from(`${JSON.stringify(compact)}\n`);
    await fs.writeFile(provenancePath, bytes);
    const record = companionRecord("provenance.json", bytes);
    descriptor.provenance_record = record;
    const tracked = descriptor.revision_history[0].files.find((file) => file.path.endsWith("/provenance.json"));
    Object.assign(tracked, record);
    await fs.writeFile(path.join(highlightDir, "highlight.json"), JSON.stringify(descriptor, null, 2));
    descriptor.source_digest = await computeSourceDigest(highlightDir);
    await fs.writeFile(path.join(highlightDir, "highlight.json"), JSON.stringify(descriptor, null, 2));
  };
  await rewriteCompact(mismatchedCompact);
  await assert.rejects(validateHighlights({
    repoRoot: root,
    probe: async (filePath) => ({
      codec: filePath.endsWith(".webp") ? "webp" : filePath.endsWith(".webm") ? "vp9" : "h264",
      width: 1920,
      height: 1200,
      fps: filePath.endsWith(".webp") ? null : 25,
      duration: filePath.endsWith(".webp") ? null : 8.2,
      audio: false,
    }),
  }), /landing adapter.*(?:match|version)/i);

  mismatchedCompact.landing_adapter.contract_version = "1.0.0";
  delete descriptor.provenance.landing_adapter;
  await rewriteCompact(mismatchedCompact);
  await assert.rejects(validateHighlights({
    repoRoot: root,
    probe: async (filePath) => ({
      codec: filePath.endsWith(".webp") ? "webp" : filePath.endsWith(".webm") ? "vp9" : "h264",
      width: 1920,
      height: 1200,
      fps: filePath.endsWith(".webp") ? null : 25,
      duration: filePath.endsWith(".webp") ? null : 8.2,
      audio: false,
    }),
  }), /(?:requires.*landing adapter|landing adapter.*require)/i);
});

test("rejects missing mobile declaration, stale provenance, and orphan files", async () => {
  const { root } = await fixtureRoot();
  const validProbe = async (filePath) => ({
    codec: filePath.endsWith(".webp") ? "webp" : filePath.endsWith(".webm") ? "vp9" : "h264",
    width: 1920,
    height: 1200,
    fps: filePath.endsWith(".webp") ? null : 25,
    duration: filePath.endsWith(".webp") ? null : 8.2,
    audio: false,
  });
  const { descriptor, highlightDir } = await writeHighlight({ root, mobile: false });
  delete descriptor.mobile;
  await fs.writeFile(path.join(highlightDir, "highlight.json"), JSON.stringify(descriptor));
  const { validateHighlights } = await import("./highlights.mjs");
  await assert.rejects(
    validateHighlights({ repoRoot: root, probe: validProbe }),
    /mobile declaration/i,
  );

  const valid = await writeHighlight({ root, id: "fresh-highlight", mobile: false });
  valid.descriptor.provenance.captured_at = "2020-01-01T00:00:00.000Z";
  await fs.writeFile(path.join(valid.highlightDir, "highlight.json"), JSON.stringify(valid.descriptor));
  await assert.rejects(
    validateHighlights({ repoRoot: root, probe: validProbe }),
    /fresh|stale|provenance/i,
  );

  valid.descriptor.provenance.captured_at = "2026-07-20T00:00:00.000Z";
  await fs.writeFile(path.join(valid.highlightDir, "highlight.json"), JSON.stringify(valid.descriptor));
  await fs.writeFile(path.join(valid.highlightDir, "orphan.bin"), "orphan");
  await assert.rejects(
    validateHighlights({ repoRoot: root, probe: validProbe }),
    /orphan|untracked/i,
  );
});

test("preserves current_main as a valid backfill capture mode", async () => {
  const { root } = await fixtureRoot();
  const { descriptor, highlightDir } = await writeHighlight({ root, mobile: false });
  descriptor.provenance.capture_mode = "current_main";
  descriptor.provenance.source_ref = "origin/main";
  delete descriptor.provenance.pr_number;
  delete descriptor.provenance.pr_base_sha;
  delete descriptor.provenance.pr_head_sha;
  await fs.writeFile(path.join(highlightDir, "highlight.json"), JSON.stringify(descriptor));
  const { computeSourceDigest, validateHighlights } = await import("./highlights.mjs");
  descriptor.source_digest = await computeSourceDigest(highlightDir);
  await fs.writeFile(path.join(highlightDir, "highlight.json"), JSON.stringify(descriptor));
  const result = await validateHighlights({
    repoRoot: root,
    probe: async (filePath) => ({
      codec: filePath.endsWith(".webp") ? "webp" : filePath.endsWith(".webm") ? "vp9" : "h264",
      width: 1920,
      height: 1200,
      fps: filePath.endsWith(".webp") ? null : 25,
      duration: filePath.endsWith(".webp") ? null : 8.2,
      audio: false,
    }),
  });
  assert.equal(result.count, 1);
});

test("requires accepted QA and validates append-only publication history shape", async () => {
  const { root } = await fixtureRoot();
  const { descriptor, highlightDir } = await writeHighlight({ root, mobile: false });
  const { validateHighlights } = await import("./highlights.mjs");

  descriptor.qa_status = "pending";
  await fs.writeFile(path.join(highlightDir, "highlight.json"), JSON.stringify(descriptor));
  await assert.rejects(validateHighlights({
    repoRoot: root,
    probe: async (filePath) => ({
      codec: filePath.endsWith(".webp") ? "webp" : filePath.endsWith(".webm") ? "vp9" : "h264",
      width: filePath.includes("mobile.") ? 1290 : 1920,
      height: filePath.includes("mobile.") ? 2796 : 1200,
      fps: filePath.endsWith(".webp") ? null : 25,
      duration: filePath.endsWith(".webp") ? null : 8.2,
      audio: false,
    }),
  }), /QA/i);

  descriptor.qa_status = "accepted";
  await fs.writeFile(path.join(highlightDir, "highlight.json"), JSON.stringify(descriptor));
  await fs.writeFile(
    path.join(highlightDir, "published-history.json"),
    JSON.stringify({ schema_version: 1, events: [{ status: "active" }] }),
  );
  await assert.rejects(validateHighlights({
    repoRoot: root,
    probe: async (filePath) => ({
      codec: filePath.endsWith(".webp") ? "webp" : filePath.endsWith(".webm") ? "vp9" : "h264",
      width: 1920,
      height: 1200,
      fps: filePath.endsWith(".webp") ? null : 25,
      duration: filePath.endsWith(".webp") ? null : 8.2,
      audio: false,
    }),
  }), /history/i);
});

test("computes a stable source digest and writes it during promotion", async () => {
  const { root } = await fixtureRoot();
  const { highlightDir } = await writeHighlight({ root });
  const { computeSourceDigest, promoteHighlight } = await import("./highlights.mjs");
  const before = await computeSourceDigest(highlightDir);
  assert.match(before, /^sha256:[a-f0-9]{64}$/);
  const promoted = await promoteHighlight({
    highlightDir,
    sourceDigest: before,
    now: "2026-07-20T01:00:00.000Z",
  });
  assert.equal(promoted.source_digest, before);
  assert.equal(JSON.parse(await fs.readFile(path.join(highlightDir, "highlight.json"))).source_digest, before);
});

test("does not re-promote an active revision after its bytes change", async () => {
  const { root } = await fixtureRoot();
  const { highlightDir } = await writeHighlight({ root });
  const { activateHighlight, promoteHighlight } = await import("./highlights.mjs");
  await activateHighlight({ highlightDir, releaseVersion: "0.81.0", now: "2026-07-20T02:00:00.000Z" });
  await fs.appendFile(path.join(highlightDir, "revisions/r1/desktop.mp4"), "tampered");
  await assert.rejects(
    promoteHighlight({ highlightDir }),
    /active|revision|immutable/i,
  );
});

test("activation refuses a queued descriptor whose source digest no longer matches", async () => {
  const { root } = await fixtureRoot();
  const { highlightDir } = await writeHighlight({ root });
  const { activateHighlight } = await import("./highlights.mjs");
  await fs.appendFile(path.join(highlightDir, "revisions/r1/desktop.mp4"), "tampered");
  await assert.rejects(
    activateHighlight({ highlightDir, releaseVersion: "0.81.0" }),
    /digest|changed/i,
  );
});

test("activates queued entries only for matching releases and keeps append-only history", async () => {
  const { root } = await fixtureRoot();
  const { highlightDir } = await writeHighlight({ root });
  const { activateHighlight, withdrawHighlight } = await import("./highlights.mjs");
  await assert.rejects(
    activateHighlight({ highlightDir, releaseVersion: "0.80.0", now: "2026-07-20T02:00:00.000Z" }),
    /release/i,
  );
  await activateHighlight({ highlightDir, releaseVersion: "0.81.0", now: "2026-07-20T02:00:00.000Z" });
  await withdrawHighlight({ highlightDir, reason: "Feature replaced by a newer workflow.", now: "2026-07-20T03:00:00.000Z" });
  const history = JSON.parse(await fs.readFile(path.join(highlightDir, "published-history.json")));
  assert.equal(history.events.length, 2);
  assert.equal(history.events[0].status, "active");
  assert.equal(history.events[1].status, "withdrawn");
  assert.match(history.events[1].reason, /replaced/);

  const { validateHighlights } = await import("./highlights.mjs");
  const result = await validateHighlights({
    repoRoot: root,
    probe: async (filePath) => ({
      codec: filePath.endsWith(".webp") ? "webp" : filePath.endsWith(".webm") ? "vp9" : "h264",
      width: filePath.includes("mobile.") ? 1290 : 1920,
      height: filePath.includes("mobile.") ? 2796 : 1200,
      fps: filePath.endsWith(".webp") ? null : 25,
      duration: filePath.endsWith(".webp") ? null : 8.2,
      audio: false,
    }),
  });
  assert.equal(result.count, 1);
});

test("rejects duplicate lifecycle events in publication history", async () => {
  const { root } = await fixtureRoot();
  const { descriptor, highlightDir } = await writeHighlight({ root, mobile: false });
  const { validateHighlights } = await import("./highlights.mjs");
  await fs.writeFile(
    path.join(highlightDir, "published-history.json"),
    JSON.stringify({ schema_version: 1, events: [
      { id: descriptor.id, status: "active", release_version: descriptor.release_version, at: "2026-07-20T02:00:00.000Z" },
      { id: descriptor.id, status: "active", release_version: descriptor.release_version, at: "2026-07-20T03:00:00.000Z" },
    ] }),
  );
  await assert.rejects(
    validateHighlights({
      repoRoot: root,
      probe: async (filePath) => ({
        codec: filePath.endsWith(".webp") ? "webp" : filePath.endsWith(".webm") ? "vp9" : "h264",
        width: 1920,
        height: 1200,
        fps: filePath.endsWith(".webp") ? null : 25,
        duration: filePath.endsWith(".webp") ? null : 8.2,
        audio: false,
      }),
    }),
    /transition|append-only|history/i,
  );
});

test("activates every queued Highlight for a release without an item cap", async () => {
  const { root } = await fixtureRoot();
  await writeHighlight({ root, id: "release-one", mobile: false });
  await writeHighlight({ root, id: "release-two", mobile: false });
  const { activateHighlightsForRelease } = await import("./highlights.mjs");
  const result = await activateHighlightsForRelease({
    highlightsDir: path.join(root, "docs/public/media/highlights"),
    releaseVersion: "0.81.0",
    now: "2026-07-20T04:00:00.000Z",
  });
  assert.equal(result.count, 2);
  assert.deepEqual(result.ids, ["release-one", "release-two"]);
});

test("release activation preflights every queued digest before changing any entry", async () => {
  const { root } = await fixtureRoot();
  const first = await writeHighlight({ root, id: "release-first", mobile: false });
  const second = await writeHighlight({ root, id: "release-second", mobile: false });
  const secondPath = path.join(root, "docs/public/media/highlights/release-second/highlight.json");
  const secondDescriptor = JSON.parse(await fs.readFile(secondPath, "utf8"));
  secondDescriptor.source_digest = "sha256:" + "0".repeat(64);
  await fs.writeFile(secondPath, JSON.stringify(secondDescriptor, null, 2));
  const { activateHighlightsForRelease } = await import("./highlights.mjs");
  await assert.rejects(
    activateHighlightsForRelease({
      highlightsDir: path.join(root, "docs/public/media/highlights"),
      releaseVersion: "0.81.0",
    }),
    /source digest changed/,
  );
  const firstAfter = JSON.parse(await fs.readFile(path.join(first.highlightDir, "highlight.json"), "utf8"));
  assert.equal(firstAfter.status, "queued");
  assert.equal(second.descriptor.id, "release-second");
});

test("builds SHA-pinned PR snippets and enforces the two-label gate", async () => {
  const { root } = await fixtureRoot();
  const { descriptor } = await writeHighlight({ root });
  const { buildPrSnippet, evaluatePrGate } = await import("./highlights.mjs");
  const snippet = buildPrSnippet({ descriptor, headSha: "abcdef0123456789abcdef0123456789abcdef01", owner: "kdlbs", repo: "kandev" });
  assert.match(snippet, /raw\.githubusercontent\.com/);
  assert.match(snippet, /abcdef0123456789/);

  assert.equal(evaluatePrGate({ labels: [], changedFiles: [] }).exempt, true);
  assert.equal(evaluatePrGate({ labels: ["highlight:required", "highlight:approved"], changedFiles: ["docs/public/media/highlights/task-messaging/highlight.json"], approvedHeadSha: "abcdef0123456789abcdef0123456789abcdef01", headSha: "abcdef0123456789abcdef0123456789abcdef01" }).ok, true);
  assert.equal(evaluatePrGate({ labels: ["highlight:approved"], changedFiles: [] }).ok, false);
  assert.equal(evaluatePrGate({ labels: ["highlight:approved"], changedFiles: ["docs/public/media/highlights/task-messaging/highlight.json"] }).ok, false);
  assert.equal(evaluatePrGate({ labels: ["highlight:required", "highlight:approved"], changedFiles: [], approvedHeadSha: "old", headSha: "new" }).ok, false);
  assert.equal(evaluatePrGate({
    labels: ["highlight:required", "highlight:approved"],
    changedFiles: [],
    approvedHeadSha: "abcdef0123456789abcdef0123456789abcdef01",
    headSha: "abcdef0123456789abcdef0123456789abcdef01",
    prBody: "<!-- highlight:other-feature head:abcdef0123456789abcdef0123456789abcdef01 -->",
    highlightIds: ["task-messaging"],
  }).ok, false);
  const currentSha = "abcdef0123456789abcdef0123456789abcdef01";
  const oneOfTwo = `<!-- highlight:task-messaging head:${currentSha} -->\nhttps://raw.githubusercontent.com/kdlbs/kandev/${currentSha}/docs/public/media/highlights/task-messaging/revisions/r1/desktop.mp4`;
  assert.equal(evaluatePrGate({
    labels: ["highlight:required", "highlight:approved"],
    changedFiles: [
      "docs/public/media/highlights/task-messaging/highlight.json",
      "docs/public/media/highlights/other-feature/highlight.json",
    ],
    headSha: currentSha,
    approvedHeadSha: currentSha,
    prBody: oneOfTwo,
    highlightIds: ["task-messaging", "other-feature"],
  }).ok, false);
  const swappedSnippets = `<!-- highlight:task-messaging head:${currentSha} -->
https://raw.githubusercontent.com/kdlbs/kandev/${currentSha}/docs/public/media/highlights/other-feature/revisions/r1/desktop.mp4
<!-- highlight:other-feature head:${currentSha} -->
https://raw.githubusercontent.com/kdlbs/kandev/${currentSha}/docs/public/media/highlights/task-messaging/revisions/r1/desktop.mp4`;
  assert.equal(evaluatePrGate({
    labels: ["highlight:required", "highlight:approved"],
    changedFiles: [
      "docs/public/media/highlights/task-messaging/highlight.json",
      "docs/public/media/highlights/other-feature/highlight.json",
    ],
    headSha: currentSha,
    approvedHeadSha: currentSha,
    prBody: swappedSnippets,
    highlightIds: ["task-messaging", "other-feature"],
  }).ok, false);
});
