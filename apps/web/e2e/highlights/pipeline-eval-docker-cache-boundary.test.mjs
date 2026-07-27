import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAYWRIGHT_IMAGE_REFERENCE,
  buildDockerCreatePlan,
} from "./pipeline-eval-docker-boundary.mjs";
import { runInsideDockerBoundary } from "./pipeline-eval-docker-launcher.mjs";

const IMAGE_DIGEST = PLAYWRIGHT_IMAGE_REFERENCE.split("@").at(-1);
const IMAGE_ID = `sha256:${"8".repeat(64)}`;
const TREE_DIGEST = `sha256:${"9".repeat(64)}`;
const CONTAINER_CACHE_SOURCE = "/kandev/toolchain/go-mod";
const CONTAINER_CACHE_TARGET = "/kandev/eval/go-mod-cache";
const CACHE_INPUT = {
  contract: "kandev-highlight-readonly-tree-v1",
  digest: TREE_DIGEST,
  fileCount: 2,
  directoryCount: 3,
  bytes: 41,
  symlinkCount: 0,
};

function input() {
  return {
    sourceRoot: "/trusted/source",
    landingRoot: "/trusted/landing",
    evalRoot: "/external/eval",
    proofRoot: "/external/proof",
    sourceProof: {
      headSha: "a".repeat(40),
      tree: "b".repeat(40),
      originMainSha: "c".repeat(40),
      status: "",
      identity: { device: "1", inode: "1", mode: 0o755 },
    },
    landingProof: {
      headSha: "d".repeat(40),
      tree: "e".repeat(40),
      status: "",
      identity: { device: "1", inode: "2", mode: 0o755 },
    },
    writableProofs: {
      eval: { device: "1", inode: "3", mode: 0o700 },
      proof: { device: "1", inode: "4", mode: 0o700 },
    },
    image: { id: IMAGE_ID, digest: IMAGE_DIGEST },
    uid: 1000,
    gid: 1000,
    captureDeadlineMs: 120_000,
    daemonSecurity: { appArmor: "default", seccomp: "default" },
    toolchainMounts: [
      {
        source: "/trusted/go-mod",
        target: CONTAINER_CACHE_SOURCE,
        identity: { device: "1", inode: "5", mode: 0o755 },
      },
    ],
    goModuleCache: {
      sourceRoot: CONTAINER_CACHE_SOURCE,
      targetRoot: CONTAINER_CACHE_TARGET,
      input: CACHE_INPUT,
    },
  };
}

function authorization(plan) {
  return {
    contract: "kandev-highlight-docker-boundary-authorization-v1",
    requestDigest: plan.request.requestDigest,
    containerId: "6".repeat(64),
    imageId: IMAGE_ID,
    sourceSha: plan.request.source.headSha,
    sourceOriginMainSha: plan.request.source.originMainSha,
    inspection: {
      containerId: "6".repeat(64),
      imageId: IMAGE_ID,
      appArmorProfile: "docker-default",
      networkMode: "none",
      requestDigest: plan.request.requestDigest,
    },
  };
}

test("inner worker uses only a request-bound private writable Go module cache", async () => {
  const plan = buildDockerCreatePlan(input());
  const auth = authorization(plan);
  const records = [];
  let preparedCalls = 0;
  const prepared = {
    contract: "kandev-highlight-private-go-module-cache-v1",
    sourceBefore: { root: CONTAINER_CACHE_SOURCE, ...CACHE_INPUT },
    copy: { root: CONTAINER_CACHE_TARGET, ...CACHE_INPUT },
    targetRoot: CONTAINER_CACHE_TARGET,
  };
  await runInsideDockerBoundary({
    requestPath: "/kandev-boundary/request.json",
    dependencies: {
      readJson: async (filePath) => (filePath.endsWith("request.json") ? plan.request : auth),
      readFile: async () =>
        plan.request.mounts
          .map(
            (mount, index) =>
              `${index + 1} 0 0:${index + 1} / ${mount.target} ${
                mount.readOnly ? "ro" : "rw"
              } - ext4 /dev/sda ${mount.readOnly ? "ro" : "rw"}`,
          )
          .join("\n"),
      captureRepositoryProof: async (root) =>
        root === "/kandev/source" ? plan.request.source : plan.request.landing,
      capturePathIdentity: async (target) =>
        plan.request.mounts.find((mount) => mount.target === target).identity,
      prepareGoModuleCache: async (options) => {
        preparedCalls += 1;
        assert.deepEqual(options, {
          sourceRoot: CONTAINER_CACHE_SOURCE,
          targetRoot: CONTAINER_CACHE_TARGET,
          evalRoot: "/kandev/eval",
          expected: CACHE_INPUT,
        });
        return prepared;
      },
      finalizeGoModuleCache: async (value) => ({
        ...value,
        sourceAfter: value.sourceBefore,
        sourceUnchanged: true,
        post: value.copy,
        isolation: {
          writableCopy: true,
          insideEvalRoot: true,
          noSymlinks: true,
        },
      }),
      runEvaluation: async (options) => {
        assert.equal(options.inheritedEnv.GOMODCACHE, CONTAINER_CACHE_TARGET);
        await options.beforeCapture({
          cloneRoot: "/kandev/eval/work/snapshot",
          logRoot: "/kandev/eval/work/logs",
          environment: options.inheritedEnv,
        });
        return { status: "passed" };
      },
      runCommand: async (specification) => ({
        phase: specification.phase,
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        stdout: "ok\n",
        stderr: "",
        stdoutBytes: Buffer.from("ok\n"),
        stderrBytes: Buffer.alloc(0),
        logPaths: {
          stdout: "/kandev/eval/work/logs/docker-boundary-network-gate.stdout.log",
          stderr: "/kandev/eval/work/logs/docker-boundary-network-gate.stderr.log",
          record: "/kandev/eval/work/logs/docker-boundary-network-gate.json",
        },
      }),
      writeJson: async (filePath, value) => records.push({ filePath, value }),
    },
  });

  assert.equal(preparedCalls, 1);
  const checkpoint = records.find(({ filePath }) =>
    filePath.endsWith("/boundary-result.json"),
  ).value;
  assert.equal(checkpoint.goModuleCache.sourceUnchanged, true);
  assert.equal(checkpoint.goModuleCache.copy.digest, TREE_DIGEST);
});
