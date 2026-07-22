import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { renderHighlight } from "./render.mjs";

function cameraPlan() {
  return {
    contract: "kandev-highlight-camera-plan-v1",
    profile: "desktop",
    captureProfile: {
      sourceWidth: 3840,
      sourceHeight: 2400,
      deliveryWidth: 1920,
      deliveryHeight: 1200,
    },
    durationMs: 4_000,
    openingSettleMs: 400,
    endingSettleMs: 400,
    cameraDirectives: [],
    pointerTrack: [],
    pointerSafeMargin: { top: 0.02, right: 0.02, bottom: 0.02, left: 0.02 },
  };
}

test("render materializes landing camera, encodes into unique external stage, and writes manifest", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "highlight-render-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const artifactRoot = path.join(temp, "artifacts");
  const calls = [];
  const adapter = {
    provenance: { sha: "a".repeat(40), clean: true },
    contracts: { camera: "kandev.highlight-camera", encoder: "kandev.highlight-encoder" },
    materializeCameraTrack(plan) {
      calls.push(["camera", plan]);
      return { contract: "kandev.highlight-camera", contractVersion: "1.0.0", keyframes: [] };
    },
    async encodeHighlight(input) {
      calls.push(["encode", input]);
      const paths = {
        mp4: path.join(input.outputDir, `${input.slug}.mp4`),
        webm: path.join(input.outputDir, `${input.slug}.webm`),
        poster: path.join(input.outputDir, `${input.slug}.webp`),
      };
      await Promise.all(Object.values(paths).map((output) => writeFile(output, "media")));
      return Object.fromEntries(Object.entries(paths).map(([kind, output]) => [kind, { path: output }]));
    },
  };
  const input = {
    scenario: { id: "tiny-story", profile: { kind: "desktop" } },
    capture: { rawPath: "/external/raw.mp4", digest: "capture-digest", storyStartOffsetMs: 320 },
    camera: cameraPlan(),
    artifactRoot,
    runId: "run-001",
    repoRoots: [path.join(temp, "repo")],
    landingAdapter: adapter,
  };

  const result = await renderHighlight(input);
  assert.equal(result.stageDir, path.join(artifactRoot, "tiny-story", "run-001"));
  assert.deepEqual(calls.map(([kind]) => kind), ["camera", "encode"]);
  assert.equal(calls[1][1].slug, "desktop-tiny-story");
  assert.equal(calls[1][1].trimStartMs, 320);
  assert.equal(calls[1][1].sourceWidth, 3840);
  assert.equal(calls[1][1].outputWidth, 1920);
  assert.equal(calls[1][1].track.contract, "kandev.highlight-camera");
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.contract, "kandev-highlight-render-v1");
  assert.equal(manifest.scenarioId, "tiny-story");
  assert.equal(manifest.landingSha, "a".repeat(40));
  assert.deepEqual(manifest.artifacts.map(({ kind }) => kind), ["mp4", "poster", "webm"]);
  await assert.rejects(renderHighlight(input), /refusing to overwrite.*run-001/i);
});

test("dry-run plans exact landing encoding without creating stage", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "highlight-render-dry-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const artifactRoot = path.join(temp, "artifacts");
  const planned = await renderHighlight({
    scenario: { id: "tiny-story", profile: { kind: "desktop" } },
    capture: { rawPath: "/external/raw.mp4" },
    camera: cameraPlan(),
    artifactRoot,
    runId: "run-002",
    repoRoots: [path.join(temp, "repo")],
    landingAdapter: {
      provenance: { sha: "b".repeat(40), clean: true },
      materializeCameraTrack: () => ({ contract: "kandev.highlight-camera" }),
      buildHighlightEncodingPlan: (input) => ({ contract: "dry-plan", input }),
    },
    dryRun: true,
  });
  assert.equal(planned.dryRun, true);
  assert.equal(planned.encodingPlan.contract, "dry-plan");
  await assert.rejects(access(planned.stageDir), /ENOENT/);
});

test("renderer rejects encoder artifacts escaping reserved stage", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "highlight-render-escape-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await assert.rejects(
    renderHighlight({
      scenario: { id: "tiny-story", profile: { kind: "desktop" } },
      capture: { rawPath: "/external/raw.mp4" },
      camera: cameraPlan(),
      artifactRoot: path.join(temp, "artifacts"),
      runId: "run-003",
      repoRoots: [path.join(temp, "repo")],
      landingAdapter: {
        provenance: { sha: "c".repeat(40), clean: true },
        materializeCameraTrack: () => ({ contract: "kandev.highlight-camera" }),
        async encodeHighlight() { return { mp4: { path: "/tmp/escape.mp4" } }; },
      },
    }),
    /artifact.*outside.*stage/i,
  );
});
