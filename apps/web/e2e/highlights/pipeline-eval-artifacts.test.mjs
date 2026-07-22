import assert from "node:assert/strict";
import test from "node:test";

import * as artifacts from "./pipeline-eval-artifacts.mjs";
import { digestValue } from "./pipeline-eval-shared.mjs";

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
  const summary = artifacts.summarizeQaArtifacts([media("mp4"), media("poster")]);
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

function selfDigested(body, key) {
  return { ...body, [key]: digestValue(body) };
}

function digestFixture() {
  const host = selfDigested({ contract: "runtime-result-v1", semantic: "host" }, "resultDigest");
  const receipt = selfDigested(
    { contract: "runtime-receipt-v1", semantic: "receipt" },
    "receiptDigest",
  );
  const build = selfDigested(
    { contract: "build-manifest-v1", semantic: "build" },
    "manifestDigest",
  );
  const camera = selfDigested(
    { contract: "camera-evidence-v1", semantic: "camera" },
    "recordDigest",
  );
  const qaDigest = `sha256:${digest("e")}`;
  return {
    files: {
      runId: "fresh-agent-1",
      host: { digest: `sha256:${digest("a")}`, value: host },
      receipt: { digest: `sha256:${digest("b")}`, value: receipt },
      build: { value: build },
      camera: { value: camera },
      review: { value: { qa: { reportDigest: qaDigest } } },
      qa: { digest: qaDigest },
    },
    commandResult: {
      host: {
        resultDigest: host.resultDigest,
        receiptDigest: receipt.receiptDigest,
      },
    },
  };
}

test("runtime host and receipt validate semantic self-digests, not whole-file bytes", () => {
  assert.equal(
    typeof artifacts.validateExactDigests,
    "function",
    "validateExactDigests must be exported for contract tests",
  );
  const fixture = digestFixture();
  assert.notEqual(fixture.files.host.digest, fixture.commandResult.host.resultDigest);
  assert.notEqual(fixture.files.receipt.digest, fixture.commandResult.host.receiptDigest);
  assert.doesNotThrow(() => artifacts.validateExactDigests(fixture.files));
});

test("runtime host and receipt reject tampered semantic self-digests", async (t) => {
  for (const item of [
    { name: "host", field: "host", message: /runtime result self digest is invalid/i },
    {
      name: "receipt",
      field: "receipt",
      message: /runtime receipt self digest is invalid/i,
    },
  ]) {
    await t.test(item.name, () => {
      const fixture = digestFixture();
      fixture.files[item.field].value.semantic = "tampered";
      assert.throws(() => artifacts.validateExactDigests(fixture.files), item.message);
    });
  }
});
