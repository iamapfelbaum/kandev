import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PLAYWRIGHT_IMAGE_REFERENCE,
  buildDockerCreatePlan,
} from "./pipeline-eval-docker-boundary.mjs";
import {
  executeDockerBoundaryPlan,
  runInsideDockerBoundary,
} from "./pipeline-eval-docker-launcher.mjs";

const IMAGE_DIGEST = PLAYWRIGHT_IMAGE_REFERENCE.split("@").at(-1);
const IMAGE_ID = `sha256:${"8".repeat(64)}`;
const SOURCE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const CONTAINER_ID = "6".repeat(64);
const CONTAINER_SOURCE_ROOT = "/kandev/source";
const WORK_ROOT = "/kandev/eval/kandev-highlight-pipeline-eval-failed";
const FAILURE_MESSAGE = "capture exploded";
const NETWORK_GATE_PHASE = "docker-boundary-network-gate";
const NETWORK_GATE_ARGV = [
  "/usr/bin/node",
  "--test",
  "scripts/highlights/capture-runtime-network.test.mjs",
];
const NETWORK_GATE_STDOUT = "TAP version 13\n1..1\n";

function fixtureInput() {
  return {
    sourceRoot: "/trusted/source",
    landingRoot: "/trusted/landing",
    evalRoot: "/external/eval",
    proofRoot: "/external/proof",
    sourceProof: {
      headSha: SOURCE_SHA,
      tree: "c".repeat(40),
      originMainSha: BASE_SHA,
      status: "",
      identity: { device: "2049", inode: "101", mode: 0o755 },
    },
    landingProof: {
      headSha: "d".repeat(40),
      tree: "e".repeat(40),
      status: "",
      identity: { device: "2049", inode: "102", mode: 0o755 },
    },
    writableProofs: {
      eval: { device: "2049", inode: "103", mode: 0o700 },
      proof: { device: "2049", inode: "104", mode: 0o700 },
    },
    image: { id: IMAGE_ID, digest: IMAGE_DIGEST },
    uid: 1000,
    gid: 1000,
    captureDeadlineMs: 120_000,
    daemonSecurity: { appArmor: "default", seccomp: "default" },
    toolchainMounts: [
      {
        source: "/trusted/pnpm-store",
        target: "/kandev/toolchain/pnpm-store",
        identity: { device: "2049", inode: "105", mode: 0o755 },
      },
    ],
  };
}

function authorization(plan) {
  return {
    contract: "kandev-highlight-docker-boundary-authorization-v1",
    requestDigest: plan.request.requestDigest,
    containerId: CONTAINER_ID,
    imageId: IMAGE_ID,
    sourceSha: SOURCE_SHA,
    sourceOriginMainSha: BASE_SHA,
    inspection: {
      containerId: CONTAINER_ID,
      imageId: IMAGE_ID,
      appArmorProfile: "docker-default",
      networkMode: "none",
      requestDigest: plan.request.requestDigest,
    },
  };
}

function networkGateEvidence(evalRoot = WORK_ROOT) {
  const logRoot = `${evalRoot}/logs`;
  return {
    contract: "kandev-highlight-runtime-network-gate-v1",
    status: "passed",
    phase: NETWORK_GATE_PHASE,
    argv: NETWORK_GATE_ARGV,
    cwd: `${evalRoot}/snapshot`,
    exitCode: 0,
    timedOut: false,
    durationMs: 17,
    stdout: {
      bytes: Buffer.byteLength(NETWORK_GATE_STDOUT),
      sha256: `sha256:${"1".repeat(64)}`,
      path: `${logRoot}/${NETWORK_GATE_PHASE}.stdout.log`,
    },
    stderr: {
      bytes: 0,
      sha256: `sha256:${"2".repeat(64)}`,
      path: `${logRoot}/${NETWORK_GATE_PHASE}.stderr.log`,
    },
    recordPath: `${logRoot}/${NETWORK_GATE_PHASE}.json`,
  };
}

function successfulNetworkGateCommand(specification) {
  const evidence = networkGateEvidence();
  return {
    phase: specification.phase,
    exitCode: 0,
    timedOut: false,
    durationMs: evidence.durationMs,
    stdout: NETWORK_GATE_STDOUT,
    stderr: "",
    stdoutBytes: Buffer.from(NETWORK_GATE_STDOUT),
    stderrBytes: Buffer.alloc(0),
    logPaths: {
      stdout: evidence.stdout.path,
      stderr: evidence.stderr.path,
      record: evidence.recordPath,
    },
  };
}

function mountInfo() {
  return [
    `1 0 0:1 / ${CONTAINER_SOURCE_ROOT} ro - ext4 /dev/sda ro`,
    "2 0 0:2 / /kandev/landing ro - ext4 /dev/sda ro",
    "3 0 0:3 / /kandev/eval rw - ext4 /dev/sda rw",
    "4 0 0:4 / /kandev-boundary ro - ext4 /dev/sda ro",
    "5 0 0:5 / /kandev/toolchain/pnpm-store ro - ext4 /dev/sda ro",
  ].join("\n");
}

function containerInspection(plan, { running = true, exitCode = 0 } = {}) {
  return {
    Id: CONTAINER_ID,
    Image: IMAGE_ID,
    AppArmorProfile: "docker-default",
    Config: {
      User: "1000:1000",
      Cmd: plan.request.bootstrap.argv,
      Entrypoint: null,
      WorkingDir: CONTAINER_SOURCE_ROOT,
      Env: Object.entries(plan.request.environment).map(([key, value]) => `${key}=${value}`),
    },
    HostConfig: {
      NetworkMode: "none",
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      PidsLimit: 512,
      Memory: 8 * 1024 ** 3,
      NanoCpus: 4 * 10 ** 9,
      ReadonlyRootfs: true,
      Privileged: false,
      Devices: [],
      DeviceRequests: null,
      Tmpfs: {
        "/run": "rw,nosuid,nodev,size=67108864",
        "/tmp": "rw,nosuid,nodev,size=2147483648",
      },
      ShmSize: 1024 ** 3,
      Init: true,
      IpcMode: "private",
      AutoRemove: false,
    },
    Mounts: plan.mounts.map(({ source, target, readOnly }) => ({
      Type: "bind",
      Source: source,
      Destination: target,
      RW: !readOnly,
      Propagation: "rprivate",
    })),
    State: { Running: running, Pid: running ? 111 : 0, ExitCode: exitCode, OOMKilled: false },
  };
}

test("inner boundary checkpoints a passed network gate when later evaluation fails", async () => {
  const plan = buildDockerCreatePlan(fixtureInput());
  const boundaryAuthorization = authorization(plan);
  const writtenRecords = [];
  await assert.rejects(
    () =>
      runInsideDockerBoundary({
        requestPath: "/kandev-boundary/request.json",
        dependencies: {
          readJson: async (filePath) =>
            filePath.endsWith("request.json") ? plan.request : boundaryAuthorization,
          readFile: async () => mountInfo(),
          captureRepositoryProof: async (root) =>
            root === CONTAINER_SOURCE_ROOT ? plan.request.source : plan.request.landing,
          capturePathIdentity: async (target) =>
            plan.request.mounts.find((mountRecord) => mountRecord.target === target).identity,
          runEvaluation: async (options) => {
            await options.beforeCapture({
              cloneRoot: `${WORK_ROOT}/snapshot`,
              logRoot: `${WORK_ROOT}/logs`,
              environment: options.inheritedEnv,
            });
            const error = new Error(FAILURE_MESSAGE);
            error.phase = "run-1";
            error.evalRoot = WORK_ROOT;
            error.failurePath = `${WORK_ROOT}/failure.json`;
            throw error;
          },
          runCommand: async (specification) => successfulNetworkGateCommand(specification),
          writeJson: async (filePath, value) => writtenRecords.push({ filePath, value }),
        },
      }),
    new RegExp(FAILURE_MESSAGE),
  );

  const checkpoint = writtenRecords.find(
    ({ filePath }) => filePath === "/kandev/eval/boundary-result.json",
  )?.value;
  assert.equal(checkpoint.status, "failed");
  assert.equal(checkpoint.requestDigest, plan.request.requestDigest);
  assert.equal(checkpoint.containerId, boundaryAuthorization.containerId);
  assert.equal(checkpoint.networkGate.status, "passed");
  assert.deepEqual(checkpoint.networkGate.argv, NETWORK_GATE_ARGV);
  assert.deepEqual(checkpoint.failure, {
    message: FAILURE_MESSAGE,
    phase: "run-1",
    evalRoot: WORK_ROOT,
    failurePath: `${WORK_ROOT}/failure.json`,
  });
});

test("host failure receipt recovers the passed network gate checkpoint", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-docker-failure-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const proofRoot = path.join(root, "proof");
  const evalRoot = path.join(root, "eval");
  const evidenceRoot = path.join(root, "host-evidence");
  await Promise.all([fs.mkdir(proofRoot), fs.mkdir(evalRoot), fs.mkdir(evidenceRoot)]);
  const plan = buildDockerCreatePlan({
    ...fixtureInput(),
    evalRoot,
    proofRoot,
    writableProofs: fixtureInput().writableProofs,
  });
  const checkpoint = {
    contract: "kandev-highlight-docker-boundary-inner-result-v1",
    status: "failed",
    requestDigest: plan.request.requestDigest,
    containerId: CONTAINER_ID,
    networkGate: networkGateEvidence(),
    result: null,
    failure: {
      message: FAILURE_MESSAGE,
      phase: "run-1",
      evalRoot: WORK_ROOT,
      failurePath: `${WORK_ROOT}/failure.json`,
    },
  };
  const runningInspection = containerInspection(plan);
  const responses = {
    "docker-create": { stdout: `${CONTAINER_ID}\n`, stderr: "", exitCode: 0 },
    "docker-start": { stdout: `${CONTAINER_ID}\n`, stderr: "", exitCode: 0 },
    "docker-inspect-running": {
      stdout: JSON.stringify([runningInspection]),
      stderr: "",
      exitCode: 0,
    },
    "docker-wait": { stdout: "1\n", stderr: "", exitCode: 0 },
    "docker-logs": { stdout: "", stderr: `${FAILURE_MESSAGE}\n`, exitCode: 0 },
    "docker-inspect-exit": {
      stdout: JSON.stringify([containerInspection(plan, { running: false, exitCode: 1 })]),
      stderr: "",
      exitCode: 0,
    },
    "docker-remove": { stdout: `${CONTAINER_ID}\n`, stderr: "", exitCode: 0 },
    "docker-removal-check": { stdout: "", stderr: "", exitCode: 0 },
  };

  await assert.rejects(
    () =>
      executeDockerBoundaryPlan({
        plan,
        proofRoot,
        evalRoot,
        evidenceRoot,
        sourceBefore: plan.request.source,
        landingBefore: plan.request.landing,
        dependencies: {
          runCommand: async ({ phase }) => responses[phase],
          captureRepositoryProof: async (rootPath) =>
            rootPath === plan.mounts[0].source ? plan.request.source : plan.request.landing,
          capturePathIdentity: async (rootPath) =>
            plan.mounts.find((record) => record.source === rootPath).identity,
          readJson: async () => checkpoint,
        },
      }),
    /Docker eval worker exited 1/,
  );

  const receipt = JSON.parse(
    await fs.readFile(path.join(evidenceRoot, "outer-boundary.receipt.json"), "utf8"),
  );
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.container.removed, true);
  assert.equal(receipt.networkGate.status, "passed");
  assert.deepEqual(receipt.networkGate.argv, NETWORK_GATE_ARGV);
  assert.match(receipt.innerResultDigest, /^sha256:[a-f0-9]{64}$/);
});
