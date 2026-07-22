import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
    contracts: {
      camera: "kandev.highlight-camera",
      encoder: "kandev.highlight-encoder",
    },
    materializeCameraTrack(plan) {
      calls.push(["camera", plan]);
      return {
        contract: "kandev.highlight-camera",
        contractVersion: "1.0.0",
        keyframes: [],
      };
    },
    async encodeHighlight(input) {
      calls.push(["encode", input]);
      const paths = {
        mp4: path.join(input.outputDir, `${input.slug}.mp4`),
        webm: path.join(input.outputDir, `${input.slug}.webm`),
        poster: path.join(input.outputDir, `${input.slug}.webp`),
      };
      await Promise.all(
        Object.values(paths).map((output) => writeFile(output, "media")),
      );
      return Object.fromEntries(
        Object.entries(paths).map(([kind, output]) => [kind, { path: output }]),
      );
    },
  };
  const input = {
    scenario: { id: "tiny-story", profile: { kind: "desktop" } },
    capture: {
      rawPath: "/external/raw.mp4",
      digest: "capture-digest",
      storyStartOffsetMs: 320,
    },
    camera: cameraPlan(),
    artifactRoot,
    runId: "run-001",
    repoRoots: [path.join(temp, "repo")],
    landingAdapter: adapter,
  };

  const result = await renderHighlight(input);
  assert.equal(
    result.stageDir,
    path.join(artifactRoot, "tiny-story", "run-001"),
  );
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["camera", "encode"],
  );
  assert.equal(calls[1][1].slug, "desktop-tiny-story");
  assert.equal(calls[1][1].trimStartMs, 320);
  assert.equal(calls[1][1].sourceWidth, 3840);
  assert.equal(calls[1][1].outputWidth, 1920);
  assert.equal(calls[1][1].track.contract, "kandev.highlight-camera");
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.contract, "kandev-highlight-render-v1");
  assert.equal(manifest.scenarioId, "tiny-story");
  assert.equal(manifest.landingSha, "a".repeat(40));
  assert.deepEqual(
    manifest.artifacts.map(({ kind }) => kind),
    ["mp4", "poster", "webm"],
  );
  await assert.rejects(
    renderHighlight(input),
    /refusing to overwrite.*run-001/i,
  );
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
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "highlight-render-escape-"),
  );
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
        async encodeHighlight() {
          return { mp4: { path: "/tmp/escape.mp4" } };
        },
      },
    }),
    /artifact.*outside.*stage/i,
  );
});

test("failed encoder leaves no published render and same run can retry", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "highlight-render-retry-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const artifactRoot = path.join(temp, "artifacts");
  const stageDir = path.join(artifactRoot, "tiny-story", "run-retry");
  const outputDirs = [];
  let attempts = 0;
  const input = {
    scenario: { id: "tiny-story", profile: { kind: "desktop" } },
    capture: { rawPath: "/external/raw.mp4", digest: "capture-digest" },
    camera: cameraPlan(),
    artifactRoot,
    runId: "run-retry",
    repoRoots: [path.join(temp, "repo")],
    landingAdapter: {
      provenance: { sha: "d".repeat(40), clean: true },
      materializeCameraTrack: () => ({
        contract: "kandev.highlight-camera",
        keyframes: [],
      }),
      async encodeHighlight(encoding) {
        attempts += 1;
        outputDirs.push(encoding.outputDir);
        const outputs = {
          mp4: path.join(encoding.outputDir, `${encoding.slug}.mp4`),
          poster: path.join(encoding.outputDir, `${encoding.slug}.webp`),
          webm: path.join(encoding.outputDir, `${encoding.slug}.webm`),
        };
        await writeFile(outputs.mp4, `attempt-${attempts}`);
        if (attempts === 1) throw new Error("synthetic encoder failure");
        await Promise.all([
          writeFile(outputs.poster, "poster"),
          writeFile(outputs.webm, "webm"),
        ]);
        return Object.fromEntries(
          Object.entries(outputs).map(([kind, output]) => [
            kind,
            { path: output },
          ]),
        );
      },
    },
  };

  await assert.rejects(renderHighlight(input), /synthetic encoder failure/);
  await assert.rejects(access(stageDir), /ENOENT/);
  assert.deepEqual(await readdir(path.dirname(stageDir)), []);

  const result = await renderHighlight(input);
  assert.equal(attempts, 2);
  assert.notEqual(outputDirs[0], stageDir);
  assert.notEqual(outputDirs[1], stageDir);
  assert.notEqual(outputDirs[0], outputDirs[1]);
  assert.deepEqual((await readdir(stageDir)).sort(), [
    "desktop-tiny-story.mp4",
    "desktop-tiny-story.webm",
    "desktop-tiny-story.webp",
    "render-manifest.json",
  ]);
  for (const buildDir of outputDirs) {
    assert.equal(JSON.stringify(result).includes(buildDir), false);
  }
  assert.equal(
    result.encoded.mp4.path,
    path.join(stageDir, "desktop-tiny-story.mp4"),
  );
});

test("render cleanup preserves a replaced private build directory", async (t) => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "highlight-render-cleanup-"),
  );
  t.after(() => rm(temp, { recursive: true, force: true }));
  let replacementPath;
  const input = {
    scenario: { id: "tiny-story", profile: { kind: "desktop" } },
    capture: { rawPath: "/external/raw.mp4" },
    camera: cameraPlan(),
    artifactRoot: path.join(temp, "artifacts"),
    runId: "run-cleanup-ownership",
    repoRoots: [path.join(temp, "repo")],
    landingAdapter: {
      provenance: { sha: "9".repeat(40), clean: true },
      materializeCameraTrack: () => ({
        contract: "kandev.highlight-camera",
        keyframes: [],
      }),
      async encodeHighlight(encoding) {
        await rename(encoding.outputDir, `${encoding.outputDir}-moved`);
        await mkdir(encoding.outputDir);
        replacementPath = path.join(encoding.outputDir, "do-not-delete.txt");
        await writeFile(replacementPath, "replacement-owned-elsewhere");
        throw new Error("synthetic encoder failure after replacement");
      },
    },
  };

  await assert.rejects(renderHighlight(input), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.match(
      error.message,
      /private build directory could not be cleaned/i,
    );
    assert.match(error.errors[0].message, /encoder failure after replacement/i);
    assert.match(error.errors[1].message, /replaced render build directory/i);
    return true;
  });
  assert.equal(
    await readFile(replacementPath, "utf8"),
    "replacement-owned-elsewhere",
  );
});

test("renderer refuses to publish a replaced private build directory", async (t) => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "highlight-render-publish-owner-"),
  );
  t.after(() => rm(temp, { recursive: true, force: true }));
  const artifactRoot = path.join(temp, "artifacts");
  const stageDir = path.join(
    artifactRoot,
    "tiny-story",
    "run-publish-ownership",
  );
  let replacementRoot;
  const input = {
    scenario: { id: "tiny-story", profile: { kind: "desktop" } },
    capture: { rawPath: "/external/raw.mp4" },
    camera: cameraPlan(),
    artifactRoot,
    runId: "run-publish-ownership",
    repoRoots: [path.join(temp, "repo")],
    landingAdapter: {
      provenance: { sha: "8".repeat(40), clean: true },
      materializeCameraTrack: () => ({
        contract: "kandev.highlight-camera",
        keyframes: [],
      }),
      async encodeHighlight(encoding) {
        await rename(encoding.outputDir, `${encoding.outputDir}-moved`);
        await mkdir(encoding.outputDir);
        replacementRoot = encoding.outputDir;
        const outputs = {
          mp4: path.join(encoding.outputDir, "delivery.mp4"),
          poster: path.join(encoding.outputDir, "delivery.webp"),
          webm: path.join(encoding.outputDir, "delivery.webm"),
        };
        await Promise.all(
          Object.values(outputs).map((output) => writeFile(output, "media")),
        );
        return Object.fromEntries(
          Object.entries(outputs).map(([kind, output]) => [
            kind,
            { path: output },
          ]),
        );
      },
    },
  };

  await assert.rejects(
    renderHighlight(input),
    /private build directory could not be cleaned|replaced render build directory/i,
  );
  await assert.rejects(access(stageDir), /ENOENT/);
  assert.equal((await readdir(replacementRoot)).length, 3);
});

test("renderer requires exactly one mp4, poster, and webm with no extra files", async (t) => {
  const cases = [
    {
      name: "missing webm",
      async encode(encoding) {
        const mp4 = path.join(encoding.outputDir, "delivery.mp4");
        const poster = path.join(encoding.outputDir, "delivery.webp");
        await Promise.all([writeFile(mp4, "mp4"), writeFile(poster, "poster")]);
        return { mp4: { path: mp4 }, poster: { path: poster } };
      },
      message: /exactly.*mp4.*poster.*webm|required.*webm/i,
    },
    {
      name: "duplicate mp4",
      async encode(encoding) {
        const paths = {
          mp4: path.join(encoding.outputDir, "delivery.mp4"),
          poster: path.join(encoding.outputDir, "delivery.webp"),
          webm: path.join(encoding.outputDir, "delivery.webm"),
        };
        await Promise.all(
          Object.values(paths).map((output) => writeFile(output, output)),
        );
        return {
          artifacts: [
            { kind: "mp4", path: paths.mp4 },
            { kind: "mp4", path: paths.mp4 },
            { kind: "poster", path: paths.poster },
            { kind: "webm", path: paths.webm },
          ],
        };
      },
      message: /exactly.*mp4.*poster.*webm|duplicate.*mp4/i,
    },
    {
      name: "unreported extra file",
      async encode(encoding) {
        const paths = {
          mp4: path.join(encoding.outputDir, "delivery.mp4"),
          poster: path.join(encoding.outputDir, "delivery.webp"),
          webm: path.join(encoding.outputDir, "delivery.webm"),
        };
        await Promise.all([
          ...Object.values(paths).map((output) => writeFile(output, output)),
          writeFile(path.join(encoding.outputDir, "debug.log"), "debug"),
        ]);
        return Object.fromEntries(
          Object.entries(paths).map(([kind, output]) => [
            kind,
            { path: output },
          ]),
        );
      },
      message: /unexpected.*debug\.log|extra file/i,
    },
  ];

  for (const [index, item] of cases.entries()) {
    await t.test(item.name, async (subtest) => {
      const temp = await mkdtemp(
        path.join(os.tmpdir(), "highlight-render-exact-"),
      );
      subtest.after(() => rm(temp, { recursive: true, force: true }));
      const artifactRoot = path.join(temp, "artifacts");
      const stageDir = path.join(
        artifactRoot,
        "tiny-story",
        `run-exact-${index}`,
      );
      await assert.rejects(
        renderHighlight({
          scenario: { id: "tiny-story", profile: { kind: "desktop" } },
          capture: { rawPath: "/external/raw.mp4" },
          camera: cameraPlan(),
          artifactRoot,
          runId: `run-exact-${index}`,
          repoRoots: [path.join(temp, "repo")],
          landingAdapter: {
            provenance: { sha: "e".repeat(40), clean: true },
            materializeCameraTrack: () => ({
              contract: "kandev.highlight-camera",
            }),
            encodeHighlight: item.encode,
          },
        }),
        item.message,
      );
      await assert.rejects(access(stageDir), /ENOENT/);
      assert.deepEqual(await readdir(path.dirname(stageDir)), []);
    });
  }
});

test("renderer rejects symlinked artifacts and canonical escapes before publication", async (t) => {
  const cases = [
    {
      name: "artifact symlink",
      async mp4Path({ encoding, outsideDir }) {
        const outside = path.join(outsideDir, "outside.mp4");
        await writeFile(outside, "outside");
        const linked = path.join(encoding.outputDir, "delivery.mp4");
        await symlink(outside, linked);
        return linked;
      },
      message: /mp4.*regular|mp4.*symlink/i,
    },
    {
      name: "symlinked parent escape",
      async mp4Path({ encoding, outsideDir }) {
        const outside = path.join(outsideDir, "outside.mp4");
        await writeFile(outside, "outside");
        const linkedDir = path.join(encoding.outputDir, "escaped");
        await symlink(outsideDir, linkedDir, "dir");
        return path.join(linkedDir, "outside.mp4");
      },
      message: /mp4.*outside|mp4.*symlink/i,
    },
  ];

  for (const [index, item] of cases.entries()) {
    await t.test(item.name, async (subtest) => {
      const temp = await mkdtemp(
        path.join(os.tmpdir(), "highlight-render-link-"),
      );
      subtest.after(() => rm(temp, { recursive: true, force: true }));
      const artifactRoot = path.join(temp, "artifacts");
      const outsideDir = path.join(temp, `outside-${index}`);
      await mkdir(outsideDir);
      const stageDir = path.join(
        artifactRoot,
        "tiny-story",
        `run-link-${index}`,
      );
      await assert.rejects(
        renderHighlight({
          scenario: { id: "tiny-story", profile: { kind: "desktop" } },
          capture: { rawPath: "/external/raw.mp4" },
          camera: cameraPlan(),
          artifactRoot,
          runId: `run-link-${index}`,
          repoRoots: [path.join(temp, "repo")],
          landingAdapter: {
            provenance: { sha: "f".repeat(40), clean: true },
            materializeCameraTrack: () => ({
              contract: "kandev.highlight-camera",
            }),
            async encodeHighlight(encoding) {
              const paths = {
                mp4: await item.mp4Path({ encoding, outsideDir }),
                poster: path.join(encoding.outputDir, "delivery.webp"),
                webm: path.join(encoding.outputDir, "delivery.webm"),
              };
              await Promise.all([
                writeFile(paths.poster, "poster"),
                writeFile(paths.webm, "webm"),
              ]);
              return Object.fromEntries(
                Object.entries(paths).map(([kind, output]) => [
                  kind,
                  { path: output },
                ]),
              );
            },
          },
        }),
        item.message,
      );
      await assert.rejects(access(stageDir), /ENOENT/);
      assert.deepEqual(await readdir(path.dirname(stageDir)), []);
    });
  }
});

test("explicit recovery verifies and reuses a complete published render without encoding", async (t) => {
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "highlight-render-recover-"),
  );
  t.after(() => rm(temp, { recursive: true, force: true }));
  const artifactRoot = path.join(temp, "artifacts");
  let encodeCalls = 0;
  const adapter = {
    provenance: { sha: "1".repeat(40), clean: true },
    materializeCameraTrack: () => ({
      contract: "kandev.highlight-camera",
      keyframes: [],
    }),
    async encodeHighlight(encoding) {
      encodeCalls += 1;
      const paths = {
        mp4: path.join(encoding.outputDir, "delivery.mp4"),
        poster: path.join(encoding.outputDir, "delivery.webp"),
        webm: path.join(encoding.outputDir, "delivery.webm"),
      };
      await Promise.all(
        Object.values(paths).map((output) => writeFile(output, output)),
      );
      return Object.fromEntries(
        Object.entries(paths).map(([kind, output]) => [kind, { path: output }]),
      );
    },
  };
  const input = {
    scenario: { id: "tiny-story", profile: { kind: "desktop" } },
    capture: {
      rawPath: "/external/raw.mp4",
      digest: "capture-digest",
      storyStartOffsetMs: 123,
    },
    camera: cameraPlan(),
    artifactRoot,
    runId: "run-recover",
    repoRoots: [path.join(temp, "repo")],
    landingAdapter: adapter,
  };

  const published = await renderHighlight(input);
  const recovered = await renderHighlight({ ...input, recoverPublished: true });
  assert.equal(encodeCalls, 1);
  assert.deepEqual(recovered.manifest, published.manifest);
  assert.equal(recovered.stageDir, published.stageDir);
  assert.equal(JSON.stringify(recovered).includes(".building-"), false);

  await writeFile(path.join(published.stageDir, "delivery.mp4"), "tampered");
  await assert.rejects(
    renderHighlight({ ...input, recoverPublished: true }),
    /mp4.*digest|mp4.*bytes/i,
  );
  assert.equal(encodeCalls, 1);
});
