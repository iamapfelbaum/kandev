import assert from "node:assert/strict";
import test from "node:test";

import { runBrowserPlaybackQa } from "./browser-qa.mjs";

function fakeChromium(results, calls = []) {
  const page = {
    async goto(url) { calls.push(["goto", url]); },
    async setContent(markup) { calls.push(["setContent", markup]); },
    async evaluate(_inspect, input) {
      calls.push(["evaluate", input]);
      return results[input.kind];
    },
  };
  return {
    async launch(options) {
      calls.push(["launch", options]);
      return {
        async newPage() { calls.push(["newPage"]); return page; },
        async close() { calls.push(["close"]); },
      };
    },
  };
}

test("browser QA plays MP4 and WebM to completion at 1x and decodes poster", async () => {
  const calls = [];
  const report = await runBrowserPlaybackQa({
    artifacts: [
      { kind: "mp4", path: "/stage/demo.mp4", probe: { width: 1920, height: 1200, durationMs: 4000 } },
      { kind: "webm", path: "/stage/demo.webm", probe: { width: 1920, height: 1200, durationMs: 4000 } },
      { kind: "poster", path: "/stage/demo.webp", probe: { width: 1920, height: 1200, durationMs: null } },
    ],
    chromium: fakeChromium({
      mp4: { ended: true, mediaError: null, width: 1920, height: 1200, durationMs: 4000, playbackRate: 1, posterDecoded: true },
      webm: { ended: true, mediaError: null, width: 1920, height: 1200, durationMs: 4000, playbackRate: 1, posterDecoded: true },
      poster: { decoded: true, mediaError: null, width: 1920, height: 1200 },
    }, calls),
  });

  assert.equal(report.passed, true);
  assert.equal(report.normalSpeed, true);
  assert.equal(report.reducedMotionTested, false);
  assert.deepEqual(report.artifacts.map(({ kind, passed }) => [kind, passed]), [
    ["mp4", true], ["webm", true], ["poster", true],
  ]);
  assert.deepEqual(calls.filter(([name]) => name === "evaluate").map(([, input]) => input.kind), ["mp4", "webm", "poster"]);
  const mediaUrls = calls.filter(([name]) => name === "evaluate").map(([, input]) => new URL(input.url));
  assert.ok(mediaUrls.every((url) => url.protocol === "http:" && url.hostname === "127.0.0.1"));
  assert.equal(new Set(mediaUrls.map((url) => url.origin)).size, 1);
  assert.equal(calls.at(-1)[0], "close");
});

test("browser QA requires exactly one MP4, WebM, and WebP poster", async () => {
  const artifact = (kind) => ({ kind, path: `/stage/demo.${kind === "poster" ? "webp" : kind}`, probe: { width: 1920, height: 1200, durationMs: kind === "poster" ? null : 4000 } });
  await assert.rejects(
    runBrowserPlaybackQa({ artifacts: [artifact("mp4"), artifact("webm")], chromium: fakeChromium({}) }),
    /exactly one.*MP4.*WebM.*poster|missing.*poster/i,
  );
  await assert.rejects(
    runBrowserPlaybackQa({ artifacts: [artifact("mp4"), artifact("webm"), artifact("poster"), artifact("mp4")], chromium: fakeChromium({}) }),
    /exactly one.*MP4.*WebM.*poster|duplicate.*mp4/i,
  );
});

test("browser QA rejects media errors, incomplete playback, and probe mismatches", async () => {
  const artifacts = [
    { kind: "mp4", path: "/stage/demo.mp4", probe: { width: 1920, height: 1200, durationMs: 4000 } },
    { kind: "webm", path: "/stage/demo.webm", probe: { width: 1920, height: 1200, durationMs: 4000 } },
    { kind: "poster", path: "/stage/demo.webp", probe: { width: 1920, height: 1200, durationMs: null } },
  ];
  const passing = {
    webm: { ended: true, mediaError: null, width: 1920, height: 1200, durationMs: 4000, playbackRate: 1 },
    poster: { decoded: true, mediaError: null, width: 1920, height: 1200 },
  };
  const base = {
    artifacts,
  };
  await assert.rejects(runBrowserPlaybackQa({
    ...base,
    chromium: fakeChromium({ ...passing, mp4: { ended: false, mediaError: "MEDIA_ERR_DECODE", width: 1920, height: 1200, durationMs: 4000, playbackRate: 1 } }),
  }), /demo\.mp4.*MEDIA_ERR_DECODE|media.*error/i);
  await assert.rejects(runBrowserPlaybackQa({
    ...base,
    chromium: fakeChromium({ ...passing, mp4: { ended: true, mediaError: null, width: 1919, height: 1200, durationMs: 4000, playbackRate: 1 } }),
  }), /width.*1920.*1919|dimensions/i);
  await assert.rejects(runBrowserPlaybackQa({
    ...base,
    chromium: fakeChromium({ ...passing, mp4: { ended: false, mediaError: null, width: 1920, height: 1200, durationMs: 4000, playbackRate: 1 } }),
  }), /did not play to completion/i);
});

test("browser QA always closes browser after playback failure", async () => {
  const calls = [];
  await assert.rejects(runBrowserPlaybackQa({
    artifacts: [
      { kind: "mp4", path: "/stage/good.mp4", probe: { width: 1920, height: 1200, durationMs: 1000 } },
      { kind: "webm", path: "/stage/bad.webm", probe: { width: 1920, height: 1200, durationMs: 1000 } },
      { kind: "poster", path: "/stage/good.webp", probe: { width: 1920, height: 1200, durationMs: null } },
    ],
    chromium: fakeChromium({
      mp4: { ended: true, mediaError: null, width: 1920, height: 1200, durationMs: 1000, playbackRate: 1 },
      webm: { ended: false, mediaError: "decode failed" },
      poster: { decoded: true, mediaError: null, width: 1920, height: 1200 },
    }, calls),
  }));
  assert.equal(calls.at(-1)[0], "close");
});

test("browser QA reports actionable missing Playwright Chromium", async () => {
  await assert.rejects(
    runBrowserPlaybackQa({
      artifacts: [
        { kind: "mp4", path: "/stage/demo.mp4", probe: { width: 1, height: 1, durationMs: 1000 } },
        { kind: "webm", path: "/stage/demo.webm", probe: { width: 1, height: 1, durationMs: 1000 } },
        { kind: "poster", path: "/stage/demo.webp", probe: { width: 1, height: 1, durationMs: null } },
      ],
      loadChromium: async () => { throw Object.assign(new Error("Cannot find package"), { code: "MODULE_NOT_FOUND" }); },
    }),
    /Playwright Chromium.*apps.*pnpm install|browser playback/i,
  );
});
