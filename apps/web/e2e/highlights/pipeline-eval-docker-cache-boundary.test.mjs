import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAYWRIGHT_IMAGE_REFERENCE,
  buildDockerCreatePlan,
} from "./pipeline-eval-docker-boundary.mjs";
import { validateMountedGoToolchain } from "./pipeline-eval-docker-inner.mjs";
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
const CACHE_PROVISION = {
  contract: "kandev-highlight-go-module-provision-v1",
  source: {
    repository: {
      headSha: "a".repeat(40),
      tree: "b".repeat(40),
      originMainSha: "c".repeat(40),
      status: "",
      identity: { device: "1", inode: "1", mode: 0o755 },
    },
    goMod: {
      path: "apps/backend/go.mod",
      bytes: 100,
      digest: `sha256:${"1".repeat(64)}`,
    },
    goSum: {
      path: "apps/backend/go.sum",
      bytes: 200,
      digest: `sha256:${"2".repeat(64)}`,
    },
  },
  command: {
    executable: "/kandev/toolchain/go/bin/go",
    args: ["mod", "download", "all"],
    cwd: "apps/backend",
  },
  offlineProof: {
    executable: "/kandev/toolchain/go/bin/go",
    args: ["mod", "download", "all"],
    proxy: "off",
    status: "passed",
    cacheUnchanged: true,
  },
  telemetry: {
    executable: "/kandev/toolchain/go/bin/go",
    args: ["telemetry", "off"],
    status: "passed",
    runtimeSeparated: true,
  },
  toolchain: {
    version: "go version go1.24.6 linux/amd64",
    root: "/kandev/toolchain/go",
    acquired: {
      contract: "kandev-highlight-private-go-toolchain-v1",
      required: { go: "1.24.6", toolchain: null },
      version: "go version go1.24.6 linux/amd64",
      os: "linux",
      architecture: "amd64",
      binary: {
        bytes: 12_345,
        digest: `sha256:${"3".repeat(64)}`,
      },
      tree: {
        ...CACHE_INPUT,
        digest: `sha256:${"4".repeat(64)}`,
      },
      acquisition: {
        command: {
          executable: "bootstrap-go",
          args: ["env", "GOROOT"],
        },
        selected: "go1.24.6",
        proxyPolicy: {
          GOPROXY: "https://proxy.golang.org",
          GOSUMDB: "sum.golang.org",
          GOPRIVATE: "",
          GONOPROXY: "",
          GONOSUMDB: "",
          GOENV: "off",
          GOWORK: "off",
        },
        offlineProof: {
          proxy: "off",
          status: "passed",
          treeUnchanged: true,
        },
        cache: {
          ...CACHE_INPUT,
          digest: `sha256:${"5".repeat(64)}`,
        },
      },
    },
  },
  proxyPolicy: {
    GOPROXY: "https://proxy.golang.org",
    GOSUMDB: "sum.golang.org",
    GOPRIVATE: "",
    GONOPROXY: "",
    GONOSUMDB: "",
    GOWORK: "off",
    GOENV: "off",
    GOFLAGS: "-mod=readonly",
    GOTOOLCHAIN: "local",
  },
  cache: CACHE_INPUT,
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
      provision: CACHE_PROVISION,
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
  assert.deepEqual(plan.request.goModuleCache.provision, CACHE_PROVISION);
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
      captureTreeProof: async () => ({
        root: "/kandev/toolchain/go",
        ...CACHE_PROVISION.toolchain.acquired.tree,
      }),
      captureFileProof: async () => structuredClone(CACHE_PROVISION.toolchain.acquired.binary),
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
  assert.deepEqual(checkpoint.goModuleCache.provision, CACHE_PROVISION);
});

test("request rejects tampered Go provisioning and acquisition evidence", () => {
  assert.throws(
    () =>
      buildDockerCreatePlan({
        ...input(),
        goModuleCache: {
          ...input().goModuleCache,
          provision: {
            ...CACHE_PROVISION,
            proxyPolicy: {
              ...CACHE_PROVISION.proxyPolicy,
              GOPROXY: "https://credential.example",
            },
          },
        },
      }),
    /provision|proxy policy/i,
  );
  assert.throws(
    () =>
      buildDockerCreatePlan({
        ...input(),
        goModuleCache: {
          ...input().goModuleCache,
          provision: {
            ...CACHE_PROVISION,
            toolchain: {
              ...CACHE_PROVISION.toolchain,
              acquired: {
                ...CACHE_PROVISION.toolchain.acquired,
                version: "go version go1.24.7 linux/amd64",
              },
            },
          },
        },
      }),
    /toolchain|binary|evidence/i,
  );
});

test("inner boundary rejects a separately forged acquired Go binary digest", async () => {
  const acquired = CACHE_PROVISION.toolchain.acquired;
  await assert.rejects(
    validateMountedGoToolchain(
      {
        goModuleCache: {
          provision: {
            toolchain: {
              acquired: {
                ...acquired,
                binary: {
                  ...acquired.binary,
                  digest: `sha256:${"f".repeat(64)}`,
                },
              },
            },
          },
        },
      },
      {
        captureTreeProof: async () => ({
          root: "/kandev/toolchain/go",
          ...acquired.tree,
        }),
        captureFileProof: async () => structuredClone(acquired.binary),
      },
    ),
    /binary.*changed/i,
  );
});
