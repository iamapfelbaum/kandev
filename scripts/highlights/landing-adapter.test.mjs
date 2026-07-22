import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadLandingAdapter } from "./landing-adapter.mjs";

async function fixture({ named = true, missingEncoder = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "highlight-landing-"));
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts/product-loop-camera.mjs"), "export const cameraMarker = true;\n");
  if (!missingEncoder) {
    await writeFile(path.join(root, "scripts/product-loop-encoder.mjs"), "export const encoderMarker = true;\n");
  }
  if (named) {
    await writeFile(
      path.join(root, "scripts/product-loop-highlight.mjs"),
      "export const HIGHLIGHT_CAMERA_CONTRACT = 'kandev.highlight-camera';\n",
    );
  }
  return root;
}

const sha = "a".repeat(40);

function highlightExports(callLog = []) {
  return {
    HIGHLIGHT_CAMERA_DIRECTIVE_CONTRACT: { id: "kandev.highlight-camera-directives", version: "1.0.0", types: {} },
    HIGHLIGHT_CAMERA_CONTRACT: { id: "kandev.highlight-camera", version: "1.0.0", profiles: {} },
    HIGHLIGHT_ENCODER_CONTRACT: { id: "kandev.highlight-encoder", version: "1.0.0", capabilities: [] },
    createHighlightCameraTrack(input) {
      callLog.push(["camera", input]);
      return { contract: "kandev.highlight-camera", contractVersion: "1.0.0", keyframes: [] };
    },
    auditHighlightCameraMotion(track) { return { ok: track.contract === "kandev.highlight-camera" }; },
    assertHighlightCameraMotion(track) { return { ok: track.contract === "kandev.highlight-camera" }; },
    buildHighlightEncodingPlan(input) { callLog.push(["plan", input]); return { mp4: {}, webm: {}, poster: {} }; },
    async encodeHighlight(input) { callLog.push(["encode", input]); return { mp4: {}, webm: {}, poster: {} }; },
  };
}

test("adapter verifies legacy markers, records clean SHA, and binds exact named Highlight exports", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const imports = [];
  const adapter = await loadLandingAdapter({
    landingRoot: root,
    runner: async (_command, args) => ({ stdout: args.includes("status") ? "" : `${sha}\n` }),
    importer: async (url) => { imports.push(url.href); return highlightExports(); },
  });

  assert.equal(adapter.root, root);
  assert.equal(adapter.provenance.sha, sha);
  assert.equal(adapter.provenance.clean, true);
  assert.equal(imports.length, 1);
  assert.match(imports[0], /product-loop-highlight\.mjs$/);
  assert.deepEqual(adapter.contracts, {
    cameraDirectives: { id: "kandev.highlight-camera-directives", version: "1.0.0", types: {} },
    camera: { id: "kandev.highlight-camera", version: "1.0.0", profiles: {} },
    encoder: { id: "kandev.highlight-encoder", version: "1.0.0", capabilities: [] },
  });
  assert.equal(typeof adapter.createHighlightCameraTrack, "function");
  assert.equal(typeof adapter.buildHighlightEncodingPlan, "function");
  assert.equal(typeof adapter.encodeHighlight, "function");
});

test("materializer passes canonical directive plan and omits workingZoom", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const adapter = await loadLandingAdapter({
    landingRoot: root,
    runner: async (_command, args) => ({ stdout: args.includes("status") ? "" : `${sha}\n` }),
    importer: async () => highlightExports(calls),
  });
  const plan = {
    contract: "kandev-highlight-camera-plan-v1",
    profile: "desktop",
    durationMs: 4_000,
    openingSettleMs: 400,
    endingSettleMs: 400,
    cameraDirectives: [{ type: "zoom", atMs: 400, zoom: 1.4, transitionMs: 1_200 }],
    pointerTrack: [],
    pointerSafeMargin: { top: 0.02, right: 0.02, bottom: 0.02, left: 0.02 },
  };
  const track = adapter.materializeCameraTrack(plan);

  assert.equal(track.contract, "kandev.highlight-camera");
  assert.equal(calls[0][0], "camera");
  assert.deepEqual(calls[0][1].cameraDirectives, plan.cameraDirectives);
  assert.equal(Object.hasOwn(calls[0][1], "workingZoom"), false);
  assert.equal(calls[0][1].profile, "desktop");
});

test("explicit landing root fails closed when marker or named export is absent", async (t) => {
  const root = await fixture({ missingEncoder: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    loadLandingAdapter({ landingRoot: root, runner: async () => ({ stdout: "" }) }),
    /product-loop-encoder\.mjs.*missing/i,
  );

  const malformed = await fixture();
  t.after(() => rm(malformed, { recursive: true, force: true }));
  await assert.rejects(
    loadLandingAdapter({
      landingRoot: malformed,
      runner: async (_command, args) => ({ stdout: args.includes("status") ? "" : `${sha}\n` }),
      importer: async () => ({ HIGHLIGHT_CAMERA_CONTRACT: "wrong" }),
    }),
    /createHighlightCameraTrack|Highlight export/i,
  );
});

test("missing named adapter is an actionable compatibility failure", async (t) => {
  const root = await fixture({ named: false });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    loadLandingAdapter({
      landingRoot: root,
      runner: async (_command, args) => ({ stdout: args.includes("status") ? "" : `${sha}\n` }),
    }),
    /product-loop-highlight\.mjs.*required|upgrade.*landing/i,
  );
});
