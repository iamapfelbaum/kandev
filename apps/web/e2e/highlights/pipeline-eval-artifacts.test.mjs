import assert from "node:assert/strict";
import test from "node:test";

import { summarizeQaArtifacts } from "./pipeline-eval-artifacts.mjs";

function digest(character) {
  return character.repeat(64);
}

function media(kind) {
  const still = kind === "poster";
  return {
    kind,
    path: `/external/run-1/desktop.${still ? "webp" : kind}`,
    bytes: 10_001,
    sha256: digest("1"),
    probe: {
      codec: still ? "webp" : "h264",
      width: 1920,
      height: 1200,
      fps: still ? null : 25,
      durationMs: still ? null : 4_840,
      frameCount: still ? 1 : 121,
      audioStreams: 0,
      pixelFormat: "yuv420p",
      bytes: 10_001,
    },
    proofs: still
      ? { skipped: true, reason: "still-image" }
      : {
          keyframes: [
            {
              frame: 0,
              path: "/external/run-1/mp4-frame.png",
              bytes: 501,
              sha256: digest("3"),
            },
          ],
          contactSheet: {
            path: "/external/run-1/mp4-sheet.png",
            bytes: 701,
            sha256: digest("5"),
          },
        },
  };
}

test("exact QA artifact summary retains delivery and proof hashes and bytes", () => {
  const summary = summarizeQaArtifacts([media("mp4"), media("poster")]);
  assert.equal(summary[0].bytes, 10_001);
  assert.equal(summary[0].sha256, digest("1"));
  assert.equal(summary[0].proofs.keyframes[0].bytes, 501);
  assert.equal(summary[0].proofs.keyframes[0].sha256, digest("3"));
  assert.equal(summary[0].proofs.contactSheet.bytes, 701);
  assert.equal(summary[0].proofs.contactSheet.sha256, digest("5"));
  assert.deepEqual(summary[1].proofs, {
    skipped: true,
    reason: "still-image",
  });
});
