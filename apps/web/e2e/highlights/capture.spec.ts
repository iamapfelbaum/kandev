import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { expect, test } from "../fixtures/test-base";
import { createHighlightRegistries } from "./registry";

import { captureScenario } from "../../../../scripts/highlights/capture-source.mjs";
import { compileTimeline, readScenario } from "../../../../scripts/highlights/scenario.mjs";
import { verifySourceGate } from "../../../../scripts/highlights/source-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(HERE, "../../../..");
const SCENARIO_PATH = path.join(HERE, "quick-start.scenario.json");
const execFileAsync = promisify(execFile);

function sourceDigest(source: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(source)).digest("hex")}`;
}

async function sourceMasterProof(rawMasterPath: string, evidenceDir: string, frameCount: number) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", rawMasterPath],
    { encoding: "utf8" },
  );
  const probe = JSON.parse(stdout);
  const frameIndexes = [0, Math.floor((frameCount - 1) / 2), frameCount - 1];
  const framesDir = path.join(evidenceDir, "source-frames");
  await fs.mkdir(framesDir, { recursive: false });
  await execFileAsync("ffmpeg", [
    "-v",
    "error",
    "-i",
    rawMasterPath,
    "-vf",
    `select=${frameIndexes.map((frame) => `eq(n\\,${frame})`).join("+")}`,
    "-fps_mode",
    "vfr",
    "-frames:v",
    String(frameIndexes.length),
    "-n",
    path.join(framesDir, "source-%02d.png"),
  ]);
  const frameFiles = (await fs.readdir(framesDir)).filter((name) => name.endsWith(".png")).sort();
  const frames = await Promise.all(
    frameFiles.map(async (name, index) => {
      const absolutePath = path.join(framesDir, name);
      const bytes = await fs.readFile(absolutePath);
      return {
        frame: frameIndexes[index],
        path: absolutePath,
        bytes: bytes.byteLength,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      };
    }),
  );
  const proof = { contract: "kandev-highlight-source-proof-v1", probe, frames };
  const proofPath = path.join(evidenceDir, "source-proof.json");
  await fs.writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return { proofPath, probe, frames };
}

test("captures deterministic declarative quick-start source master", async ({
  apiClient,
  seedData,
  backend,
}, testInfo) => {
  test.setTimeout(180_000);
  const artifactParent = process.env.KANDEV_HIGHLIGHT_ARTIFACT_ROOT;
  if (!artifactParent || !path.isAbsolute(artifactParent)) {
    throw new Error(
      "KANDEV_HIGHLIGHT_ARTIFACT_ROOT must be an absolute external directory; " +
        "run `pnpm e2e:highlight-capture` instead of invoking this spec directly.",
    );
  }
  const scenario = await readScenario(SCENARIO_PATH);
  const timeline = compileTimeline(scenario);
  const source = await verifySourceGate({ repoRoot: REPOSITORY_ROOT, source: "pr_head" });
  const runId = `e2e-${process.pid}-${testInfo.workerIndex}`;
  const artifactRoot = path.join(artifactParent, runId);
  const registries = createHighlightRegistries({ apiClient, seedData, backend });

  const result = await captureScenario({
    scenario,
    timeline,
    sourceDigest: sourceDigest(source),
    frontendUrl: backend.frontendUrl,
    artifactRoot,
    repositoryRoots: [REPOSITORY_ROOT],
    runId,
    seedRegistry: registries.seedRegistry,
    primitiveRegistry: registries.primitiveRegistry,
    navigateRoute: registries.navigateRoute,
    preparePage: registries.preparePage,
  });

  const manifest = JSON.parse(await fs.readFile(result.captureManifestPath, "utf8"));
  const raw = await fs.readFile(result.rawMasterPath);
  const rawDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const proof = await sourceMasterProof(
    result.rawMasterPath,
    path.dirname(result.captureManifestPath),
    manifest.capture.frameCount,
  );
  const videoStreams = proof.probe.streams.filter(
    (stream: { codec_type: string }) => stream.codec_type === "video",
  );
  const audioStreams = proof.probe.streams.filter(
    (stream: { codec_type: string }) => stream.codec_type === "audio",
  );
  expect(result.contract).toBe("kandev-highlight-capture-result-v1");
  expect(manifest.rawMaster.digest).toBe(rawDigest);
  expect(manifest.rawMaster.bytes).toBe(raw.byteLength);
  expect(manifest.capture).toMatchObject({
    width: 3840,
    height: 2400,
    fps: 25,
    audio: false,
    duplicateFrames: 0,
    droppedFrames: 0,
    lossless: true,
  });
  expect(manifest.capture.frameCount).toBeGreaterThanOrEqual(50);
  expect(videoStreams).toHaveLength(1);
  expect(videoStreams[0]).toMatchObject({
    codec_name: "h264",
    profile: "High 4:4:4 Predictive",
    pix_fmt: "yuv444p",
    width: 3840,
    height: 2400,
    r_frame_rate: "25/1",
  });
  expect(audioStreams).toHaveLength(0);
  expect(proof.frames).toHaveLength(3);
  expect(proof.frames.every((frame) => frame.bytes > 0 && frame.digest.startsWith("sha256:"))).toBe(
    true,
  );
  await expect(fs.access(proof.proofPath)).resolves.toBeUndefined();
  expect(manifest.seed.seedId).toBe("kandev.highlight.quick-start");
  expect(manifest.seed.invariants.taskId).toMatch(/\S+/);
  expect(manifest.seed.invariants.taskCount).toBe(1);
  expect(manifest.execution.steps).toHaveLength(scenario.story.actions.length);
  expect(manifest.execution.cursorEvidence.length).toBeGreaterThanOrEqual(1);
  expect(manifest.runtime.teardown).toMatchObject({
    processesGone: true,
    coordinatesReleased: true,
    profileRemoved: true,
    lockRemoved: true,
  });
  await expect(fs.access(manifest.runtime.allocation.profileDir)).rejects.toThrow();
  await expect(fs.access(manifest.runtime.allocation.lockPath)).rejects.toThrow();
});
