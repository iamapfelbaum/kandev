import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PLAYWRIGHT_IMAGE_REFERENCE,
  buildDockerCreatePlan,
  validateDockerBoundaryAuthorization,
  validateDockerContainerInspection,
  validateDockerDaemonSecurity,
  validateDockerImageInspection,
  writeJsonExclusive,
} from "./pipeline-eval-docker-boundary.mjs";
import {
  executeDockerBoundaryPlan,
  prepareDockerInputRepositories,
  runInsideDockerBoundary,
} from "./pipeline-eval-docker-launcher.mjs";
const DIGEST = "sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48";
const IMAGE_ID = `sha256:${"8".repeat(64)}`;
const SOURCE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const APPARMOR_PROFILE = "docker-default";
const INSPECT_CONTAINER_ID = "7".repeat(64);
const CONTAINER_SOURCE_ROOT = "/kandev/source";
const NETWORK_GATE_PHASE = "docker-boundary-network-gate";
const NETWORK_GATE_SCRIPT = "scripts/highlights/capture-runtime-network.test.mjs";
const NETWORK_GATE_ARGV = ["/usr/bin/node", "--test", NETWORK_GATE_SCRIPT];
const NETWORK_GATE_STDOUT = "TAP version 13\n1..1\n";
async function execGit(root, args) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return promisify(execFile)("git", args, { cwd: root, encoding: "utf8" });
}

async function createLinkedWorktreeFixture(parent, name) {
  const repository = path.join(parent, `${name}-repository`);
  const worktree = path.join(parent, `${name}-worktree`);
  await fs.mkdir(repository);
  await execGit(repository, ["init", "--initial-branch=main"]);
  await execGit(repository, ["config", "user.name", "Docker Boundary Test"]);
  await execGit(repository, ["config", "user.email", "docker-boundary@example.invalid"]);
  await fs.writeFile(path.join(repository, "main.txt"), "main\n");
  await execGit(repository, ["add", "main.txt"]);
  await execGit(repository, ["commit", "-m", "main"]);
  await execGit(repository, ["checkout", "-b", "feature/eval"]);
  await fs.writeFile(path.join(repository, "feature.txt"), "feature\n");
  await execGit(repository, ["add", "feature.txt"]);
  await execGit(repository, ["commit", "-m", "feature"]);
  await execGit(repository, ["update-ref", "refs/remotes/origin/main", "main"]);
  await execGit(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);
  return worktree;
}

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
    image: { id: IMAGE_ID, digest: DIGEST },
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
function boundaryAuthorization(plan, containerId = "6".repeat(64)) {
  return {
    contract: "kandev-highlight-docker-boundary-authorization-v1",
    requestDigest: plan.request.requestDigest,
    containerId,
    imageId: IMAGE_ID,
    sourceSha: SOURCE_SHA,
    sourceOriginMainSha: BASE_SHA,
    inspection: {
      containerId,
      imageId: IMAGE_ID,
      appArmorProfile: APPARMOR_PROFILE,
      networkMode: "none",
      requestDigest: plan.request.requestDigest,
    },
  };
}
function networkGateEvidence(evalName = "work") {
  const evalRoot = `/kandev/eval/${evalName}`;
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
function containerInspection(plan, { id = INSPECT_CONTAINER_ID, pid = 1234 } = {}) {
  return {
    Id: id,
    Image: IMAGE_ID,
    AppArmorProfile: APPARMOR_PROFILE,
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
    State: { Running: true, Pid: pid },
  };
}

test("official Playwright image is pinned by immutable digest", () => {
  assert.equal(PLAYWRIGHT_IMAGE_REFERENCE, `mcr.microsoft.com/playwright:v1.61.1-noble@${DIGEST}`);
  assert.deepEqual(
    validateDockerImageInspection(
      [
        {
          Id: IMAGE_ID,
          RepoDigests: [`mcr.microsoft.com/playwright@${DIGEST}`],
          Os: "linux",
          Architecture: "amd64",
        },
      ],
      { architecture: "amd64" },
    ),
    { id: IMAGE_ID, digest: DIGEST, os: "linux", architecture: "amd64" },
  );
  assert.throws(
    () =>
      validateDockerImageInspection([
        {
          Id: IMAGE_ID,
          RepoDigests: [`mcr.microsoft.com/playwright@sha256:${"f".repeat(64)}`],
          Os: "linux",
          Architecture: "amd64",
        },
      ]),
    /immutable Playwright image digest/i,
  );
});

test("host boundary proof publication is exclusive and leaves one complete JSON record", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-boundary-json-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "authorization.json");
  await writeJsonExclusive(target, { contract: "proof", sequence: [1, 2, 3] });
  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), {
    contract: "proof",
    sequence: [1, 2, 3],
  });
  await assert.rejects(() => writeJsonExclusive(target, { contract: "replacement" }), /EEXIST/);
  assert.deepEqual(await fs.readdir(root), ["authorization.json"]);
});

test("Docker inputs replace linked-worktree git pointers with sanitized self-contained snapshots", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-docker-input-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = await createLinkedWorktreeFixture(root, "source");
  const landingRoot = await createLinkedWorktreeFixture(root, "landing");
  assert.equal((await fs.lstat(path.join(sourceRoot, ".git"))).isFile(), true);

  const prepared = await prepareDockerInputRepositories({
    sourceRoot,
    landingRoot,
    inputRoot: path.join(root, "docker-input"),
  });

  assert.equal((await fs.lstat(path.join(prepared.sourceRoot, ".git"))).isDirectory(), true);
  assert.equal((await fs.lstat(path.join(prepared.landingRoot, ".git"))).isDirectory(), true);
  assert.equal(prepared.sourceProof.headSha, prepared.upstreamSourceProof.headSha);
  assert.equal(prepared.sourceProof.tree, prepared.upstreamSourceProof.tree);
  assert.equal(prepared.sourceProof.originMainSha, prepared.upstreamSourceProof.originMainSha);
  assert.equal(prepared.landingProof.headSha, prepared.upstreamLandingProof.headSha);
  assert.equal(prepared.landingProof.tree, prepared.upstreamLandingProof.tree);
  assert.equal(prepared.sourceRoot.startsWith(prepared.inputRoot), true);
  assert.equal(prepared.landingRoot.startsWith(prepared.inputRoot), true);
});
test("inner boundary validates host proof and mounted source before any eval command", async () => {
  const plan = buildDockerCreatePlan(fixtureInput());
  const authorization = boundaryAuthorization(plan);
  let calls = 0;
  let evaluationEnvironment;
  const networkGateCalls = [];
  const writtenRecords = [];
  const result = await runInsideDockerBoundary({
    requestPath: "/kandev-boundary/request.json",
    dependencies: {
      readJson: async (filePath) =>
        filePath.endsWith("request.json") ? plan.request : authorization,
      readFile: async () =>
        [
          `1 0 0:1 / ${CONTAINER_SOURCE_ROOT} ro - ext4 /dev/sda ro`,
          "2 0 0:2 / /kandev/landing ro - ext4 /dev/sda ro",
          "3 0 0:3 / /kandev/eval rw - ext4 /dev/sda rw",
          "4 0 0:4 / /kandev-boundary ro - ext4 /dev/sda ro",
          "5 0 0:5 / /kandev/toolchain/pnpm-store ro - ext4 /dev/sda ro",
        ].join("\n"),
      captureRepositoryProof: async (root) =>
        root === CONTAINER_SOURCE_ROOT ? plan.request.source : plan.request.landing,
      capturePathIdentity: async (target) =>
        plan.request.mounts.find((mountRecord) => mountRecord.target === target).identity,
      runEvaluation: async (options) => {
        calls += 1;
        assert.deepEqual(options.evaluation, plan.request.evaluation);
        assert.equal(options.sourceRoot, CONTAINER_SOURCE_ROOT);
        assert.equal(options.landingRoot, "/kandev/landing");
        assert.equal(options.evalParent, "/kandev/eval");
        assert.equal(options.inheritedEnv.KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX, "disabled");
        assert.equal(
          options.inheritedEnv.KANDEV_HIGHLIGHT_DOCKER_BOUNDARY_AUTHORIZATION,
          "/kandev-boundary/authorization.json",
        );
        evaluationEnvironment = options.inheritedEnv;
        assert.equal(typeof options.beforeCapture, "function");
        const networkGate = await options.beforeCapture({
          cloneRoot: "/kandev/eval/work/snapshot",
          logRoot: "/kandev/eval/work/logs",
          environment: options.inheritedEnv,
        });
        assert.equal(networkGate.status, "passed");
        return {
          status: "passed",
          resultPath: "/kandev/eval/work/result.json",
          networkGate,
        };
      },
      runCommand: async (specification) => {
        networkGateCalls.push(specification);
        return successfulNetworkGateCommand(specification);
      },
      writeJson: async (filePath, value) => writtenRecords.push({ filePath, value }),
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "passed");
  assert.equal(networkGateCalls.length, 1);
  assert.deepEqual(networkGateCalls[0], {
    command: "/usr/bin/node",
    args: NETWORK_GATE_ARGV.slice(1),
    cwd: "/kandev/eval/work/snapshot",
    env: evaluationEnvironment,
    phase: NETWORK_GATE_PHASE,
    logRoot: "/kandev/eval/work/logs",
    deadlineMs: 120_000,
  });
  const innerRecord = writtenRecords.find(
    ({ filePath }) => filePath === "/kandev/eval/boundary-result.json",
  )?.value;
  assert.equal(innerRecord.networkGate.contract, "kandev-highlight-runtime-network-gate-v1");
  assert.deepEqual(innerRecord.networkGate.argv, NETWORK_GATE_ARGV);
  assert.equal(innerRecord.networkGate.stdout.bytes, 20);
  assert.match(innerRecord.networkGate.stdout.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(innerRecord.networkGate.stderr.bytes, 0);

  await assert.rejects(
    () =>
      runInsideDockerBoundary({
        requestPath: "/kandev-boundary/request.json",
        dependencies: {
          readJson: async (filePath) => (filePath.endsWith("request.json") ? plan.request : null),
          runEvaluation: async () => {
            calls += 1;
          },
        },
      }),
    /authorization.*before.*evaluation/i,
  );
  assert.equal(calls, 1, "missing proof must fail before eval starts");
});
test("host lifecycle records create, inspect, exit, removal, and unchanged source", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "highlight-docker-boundary-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const proofRoot = path.join(root, "proof");
  const evalRoot = path.join(root, "eval");
  const evidenceRoot = path.join(root, "host-evidence");
  await fs.mkdir(proofRoot);
  await fs.mkdir(evalRoot);
  await fs.mkdir(evidenceRoot);
  await fs.writeFile(path.join(evalRoot, "outer-boundary.receipt.json"), "worker poison\n");
  const plan = buildDockerCreatePlan({
    ...fixtureInput(),
    evalRoot,
    proofRoot,
    writableProofs: fixtureInput().writableProofs,
  });
  const runningInspect = containerInspection(plan, { id: "6".repeat(64), pid: 111 });
  const phases = [];
  let dockerCreateDeadline;
  const responses = {
    "docker-create": { stdout: `${"6".repeat(64)}\n`, stderr: "", exitCode: 0 },
    "docker-start": { stdout: `${"6".repeat(64)}\n`, stderr: "", exitCode: 0 },
    "docker-inspect-running": { stdout: JSON.stringify([runningInspect]), stderr: "", exitCode: 0 },
    "docker-wait": { stdout: "0\n", stderr: "", exitCode: 0 },
    "docker-logs": { stdout: "inside passed\n", stderr: "", exitCode: 0 },
    "docker-inspect-exit": {
      stdout: JSON.stringify([
        { ...runningInspect, State: { Running: false, ExitCode: 0, OOMKilled: false } },
      ]),
      stderr: "",
      exitCode: 0,
    },
    "docker-remove": { stdout: `${"6".repeat(64)}\n`, stderr: "", exitCode: 0 },
    "docker-removal-check": { stdout: "", stderr: "", exitCode: 0 },
  };
  const receipt = await executeDockerBoundaryPlan({
    plan,
    proofRoot,
    evalRoot,
    evidenceRoot,
    sourceBefore: plan.request.source,
    landingBefore: plan.request.landing,
    dependencies: {
      runCommand: async ({ phase, deadlineMs }) => {
        phases.push(phase);
        if (phase === "docker-create") dockerCreateDeadline = deadlineMs;
        return responses[phase];
      },
      captureRepositoryProof: async (rootPath) =>
        rootPath === plan.mounts[0].source ? plan.request.source : plan.request.landing,
      capturePathIdentity: async (rootPath) =>
        plan.mounts.find((record) => record.source === rootPath).identity,
      readJson: async () => ({
        contract: "kandev-highlight-docker-boundary-inner-result-v1",
        status: "passed",
        requestDigest: plan.request.requestDigest,
        containerId: "6".repeat(64),
        networkGate: networkGateEvidence("kandev-highlight-pipeline-eval-abc123"),
        result: { status: "passed" },
      }),
    },
  });
  assert.deepEqual(phases, [
    "docker-create",
    "docker-start",
    "docker-inspect-running",
    "docker-wait",
    "docker-logs",
    "docker-inspect-exit",
    "docker-remove",
    "docker-removal-check",
  ]);
  assert.equal(dockerCreateDeadline, 120_000);
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.container.removed, true);
  assert.equal(receipt.source.unchanged, true);
  assert.equal(receipt.landing.unchanged, true);
  assert.equal(receipt.network.mode, "none");
  assert.equal(receipt.networkGate.status, "passed");
  assert.deepEqual(receipt.networkGate.argv, NETWORK_GATE_ARGV);
  assert.equal(receipt.exit.code, 0);
  assert.equal(
    await fs.readFile(path.join(evidenceRoot, "outer-container.stdout.log"), "utf8"),
    "inside passed\n",
  );
  assert.equal(
    await fs.readFile(path.join(evidenceRoot, "outer-container.stderr.log"), "utf8"),
    "",
  );
  assert.equal(receipt.logs.stdout.bytes, 14);
  assert.match(receipt.logs.stdout.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(receipt.logs.stderr.bytes, 0);
  assert.equal(receipt.receiptPath, path.join(evidenceRoot, "outer-boundary.receipt.json"));
  assert.equal(
    await fs.readFile(path.join(evalRoot, "outer-boundary.receipt.json"), "utf8"),
    "worker poison\n",
  );
});
test("Docker create plan isolates one nonroot worker and exposes only declared mounts", () => {
  const plan = buildDockerCreatePlan(fixtureInput());
  assert.equal(plan.command, "docker");
  assert.equal(plan.args[0], "create");
  assert.ok(plan.args.includes(PLAYWRIGHT_IMAGE_REFERENCE));
  for (const pair of [
    ["--network", "none"],
    ["--user", "1000:1000"],
    ["--cap-drop", "ALL"],
    ["--security-opt", "no-new-privileges"],
    ["--pids-limit", "512"],
    ["--memory", "8g"],
    ["--cpus", "4"],
  ]) {
    assert.ok(
      plan.args.some((value, index) => value === pair[0] && plan.args[index + 1] === pair[1]),
      `${pair.join(" ")} missing`,
    );
  }
  assert.ok(plan.args.includes("--read-only"));
  assert.ok(plan.args.includes("--init"));
  assert.ok(!plan.args.includes("--privileged"));
  assert.ok(!plan.args.includes("--device"));
  assert.ok(!plan.args.some((value) => /docker\.sock|\.ssh|credential|\.npmrc/i.test(value)));
  assert.deepEqual(
    plan.mounts.map(({ target, readOnly }) => [target, readOnly]),
    [
      ["/kandev/source", true],
      ["/kandev/landing", true],
      ["/kandev/eval", false],
      ["/kandev-boundary", true],
      ["/kandev/toolchain/pnpm-store", true],
    ],
  );
  assert.equal(plan.request.source.headSha, SOURCE_SHA);
  assert.equal(plan.request.source.originMainSha, BASE_SHA);
  assert.equal(plan.request.network.mode, "none");
  assert.equal(plan.request.inner.argv[0], "/usr/bin/node");
  assert.equal(plan.request.inner.argv.at(-2), "--inside-docker-boundary");
  assert.match(
    plan.request.bootstrap.argv.at(-1),
    /\/usr\/bin\/node \/kandev\/toolchain\/pnpm\/bin\/pnpm\.cjs/,
  );
  assert.doesNotMatch(plan.request.bootstrap.argv.at(-1), /corepack pnpm/);
  assert.throws(
    () =>
      buildDockerCreatePlan({
        ...fixtureInput(),
        environment: { KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX: "native" },
      }),
    /environment.*cannot be overridden/i,
  );
  assert.throws(
    () =>
      buildDockerCreatePlan({
        ...fixtureInput(),
        toolchainMounts: [
          {
            source: "/trusted/store,readonly",
            target: "/kandev/toolchain/store",
            identity: { device: "2049", inode: "105", mode: 0o755 },
          },
        ],
      }),
    /mount path.*unsupported/i,
  );
});
test("daemon and running-container proof require default seccomp and AppArmor", () => {
  assert.deepEqual(
    validateDockerDaemonSecurity(["name=apparmor", "name=seccomp,profile=builtin"]),
    { appArmor: "default", seccomp: "default" },
  );
  assert.throws(
    () => validateDockerDaemonSecurity(["name=seccomp,profile=unconfined"]),
    /AppArmor.*default seccomp/i,
  );

  const plan = buildDockerCreatePlan(fixtureInput());
  const inspect = containerInspection(plan);
  const proof = validateDockerContainerInspection(inspect, plan.request);
  assert.equal(proof.containerId, INSPECT_CONTAINER_ID);
  assert.equal(proof.appArmorProfile, APPARMOR_PROFILE);
  assert.throws(
    () =>
      validateDockerContainerInspection(
        { ...inspect, HostConfig: { ...inspect.HostConfig, NetworkMode: "bridge" } },
        plan.request,
      ),
    /network.*none/i,
  );
  assert.throws(
    () => validateDockerContainerInspection({ ...inspect, Id: "not-a-container" }, plan.request),
    /container identity/i,
  );
  assert.throws(
    () =>
      validateDockerContainerInspection(
        { ...inspect, Config: { ...inspect.Config, WorkingDir: "/tmp" } },
        plan.request,
      ),
    /working directory/i,
  );
  assert.throws(
    () =>
      validateDockerContainerInspection(
        { ...inspect, HostConfig: { ...inspect.HostConfig, Tmpfs: {} } },
        plan.request,
      ),
    /temporary filesystem/i,
  );
});

test("inner eval fails closed before execution without exact read-only host authorization", () => {
  const plan = buildDockerCreatePlan(fixtureInput());
  const inspection = {
    containerId: INSPECT_CONTAINER_ID,
    imageId: IMAGE_ID,
    appArmorProfile: APPARMOR_PROFILE,
    networkMode: "none",
    requestDigest: plan.request.requestDigest,
  };
  const authorization = {
    contract: "kandev-highlight-docker-boundary-authorization-v1",
    requestDigest: plan.request.requestDigest,
    containerId: INSPECT_CONTAINER_ID,
    imageId: IMAGE_ID,
    sourceSha: SOURCE_SHA,
    sourceOriginMainSha: BASE_SHA,
    inspection,
  };
  assert.equal(
    validateDockerBoundaryAuthorization(authorization, plan.request).containerId,
    INSPECT_CONTAINER_ID,
  );
  assert.throws(
    () =>
      validateDockerBoundaryAuthorization(
        { ...authorization, sourceSha: "f".repeat(40) },
        plan.request,
      ),
    /authorization.*source SHA/i,
  );
  assert.throws(
    () => validateDockerBoundaryAuthorization(null, plan.request),
    /authorization.*before.*evaluation/i,
  );
});
