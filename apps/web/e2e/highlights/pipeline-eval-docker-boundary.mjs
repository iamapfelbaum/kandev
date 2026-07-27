import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { captureRepositoryState } from "./pipeline-eval-repository.mjs";
import { validateGoModuleProvision } from "./pipeline-eval-go-provision-contract.mjs";
import { git, isInside } from "./pipeline-eval-shared.mjs";

const IMAGE_DIGEST = "sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48";
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const CONTAINER_SOURCE_ROOT = "/kandev/source";
const CONTAINER_LANDING_ROOT = "/kandev/landing";
const CONTAINER_EVAL_ROOT = "/kandev/eval";
const OVERRIDABLE_ENVIRONMENT = new Set(["GOROOT", "npm_config_store_dir"]);
const EXPECTED_TMPFS = Object.freeze({
  "/run": "rw,nosuid,nodev,size=67108864",
  "/tmp": "rw,nosuid,nodev,size=2147483648",
});
export const INNER_REQUEST_PATH = "/kandev-boundary/request.json";
const INNER_ENTRYPOINT = "/kandev/source/apps/web/e2e/highlights/run-pipeline-integration.mjs";
const BOOTSTRAP_SCRIPT =
  "mkdir -p /kandev/eval/bin /kandev/eval/home /kandev/eval/cache /kandev/eval/go-cache /kandev/eval/go; printf '#!/bin/sh\\nexec /usr/bin/node /kandev/toolchain/pnpm/bin/pnpm.cjs \"$@\"\\n' > /kandev/eval/bin/pnpm; chmod 700 /kandev/eval/bin/pnpm; while [ ! -s /kandev-boundary/authorization.json ]; do sleep 0.05; done; exec /usr/bin/node /kandev/source/apps/web/e2e/highlights/run-pipeline-integration.mjs --inside-docker-boundary /kandev-boundary/request.json";

export const PLAYWRIGHT_IMAGE_REFERENCE = `mcr.microsoft.com/playwright:v1.61.1-noble@${IMAGE_DIGEST}`;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digestValue(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function digestBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function publishExclusive(filePath, bytes) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.link(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function writeTextExclusive(filePath, value) {
  await publishExclusive(filePath, value);
}

export async function writeJsonExclusive(filePath, value) {
  await publishExclusive(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function capturePathIdentity(filePath) {
  const resolved = path.resolve(filePath);
  const [canonical, value] = await Promise.all([fs.realpath(resolved), fs.lstat(resolved)]);
  if (
    canonical !== resolved ||
    (!value.isDirectory() && !value.isFile()) ||
    value.isSymbolicLink()
  ) {
    throw new Error(`Docker boundary mount must be a canonical file or directory: ${resolved}`);
  }
  return {
    device: String(value.dev),
    inode: String(value.ino),
    mode: value.mode & 0o7777,
    kind: value.isDirectory() ? "directory" : "file",
  };
}

export async function captureDockerRepositoryProof(repoRoot, { includeOrigin = false } = {}) {
  const state = await captureRepositoryState(repoRoot);
  if (state.status !== "")
    throw new Error(`Docker boundary repository is not clean: ${state.status}`);
  const proof = {
    headSha: state.head,
    tree: state.tree,
    status: state.status,
    identity: await capturePathIdentity(state.root),
  };
  if (includeOrigin) {
    const origin = await git(state.root, ["rev-parse", "origin/main"], {
      phase: "docker-boundary-origin-main",
    });
    proof.originMainSha = exactSha(origin.stdout.trim(), "Docker boundary origin/main");
  }
  return proof;
}

function exactSha(value, label) {
  if (!SHA_PATTERN.test(value ?? "")) throw new Error(`${label} must be an exact Git SHA`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function identity(value, label) {
  if (
    !value ||
    !/^\d+$/.test(value.device ?? "") ||
    !/^\d+$/.test(value.inode ?? "") ||
    !Number.isInteger(value.mode)
  ) {
    throw new Error(`${label} identity must bind device, inode, and mode`);
  }
  if (value.kind !== undefined && !["file", "directory"].includes(value.kind)) {
    throw new Error(`${label} identity kind must be file or directory`);
  }
  return {
    device: value.device,
    inode: value.inode,
    mode: value.mode,
    ...(value.kind ? { kind: value.kind } : {}),
  };
}

function repositoryProof(value, label, { needsOrigin = false } = {}) {
  if (value?.status !== "") throw new Error(`${label} repository must be clean`);
  const proof = {
    headSha: exactSha(value?.headSha, `${label} HEAD`),
    tree: exactSha(value?.tree, `${label} tree`),
    status: "",
    identity: identity(value?.identity, `${label} mount`),
  };
  if (needsOrigin) {
    proof.originMainSha = exactSha(value?.originMainSha, `${label} origin/main`);
  }
  return proof;
}

function requireAbsolute(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || /[\0\r\n,]/.test(value)) {
    throw new Error(`${label} mount path contains unsupported syntax`);
  }
  if (path.normalize(value) !== value) {
    throw new Error(`${label} must be an absolute path`);
  }
  return value;
}

function mount(source, target, readOnly, mountIdentity) {
  return {
    source: requireAbsolute(source, `${target} mount source`),
    target: requireAbsolute(target, `${target} mount target`),
    readOnly,
    identity: identity(mountIdentity, `${target} mount`),
  };
}

function treeProof(value, label) {
  if (
    value?.contract !== "kandev-highlight-readonly-tree-v1" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.digest ?? "") ||
    !Number.isInteger(value.fileCount) ||
    value.fileCount < 1 ||
    !Number.isInteger(value.directoryCount) ||
    value.directoryCount < 0 ||
    !Number.isInteger(value.bytes) ||
    value.bytes < 1 ||
    value.symlinkCount !== 0
  ) {
    throw new Error(`${label} must bind a symlink-free content tree digest`);
  }
  return {
    contract: value.contract,
    digest: value.digest,
    fileCount: value.fileCount,
    directoryCount: value.directoryCount,
    bytes: value.bytes,
    symlinkCount: 0,
  };
}

function goModuleCache(value, mounts, source) {
  if (value === undefined) return null;
  const sourceRoot = requireAbsolute(value?.sourceRoot, "Go module cache source");
  const targetRoot = requireAbsolute(value?.targetRoot, "Go module cache target");
  const sourceMount = mounts.find(({ target }) => target === sourceRoot);
  if (!sourceMount?.readOnly) {
    throw new Error("Go module cache source must be an exact read-only toolchain mount");
  }
  if (
    targetRoot !== `${CONTAINER_EVAL_ROOT}/go-mod-cache` ||
    !isInside(CONTAINER_EVAL_ROOT, targetRoot)
  ) {
    throw new Error("private Go module cache target must stay at the fixed writable eval path");
  }
  const input = treeProof(value.input, "Go module cache input");
  return {
    sourceRoot,
    targetRoot,
    input,
    provision: validateGoModuleProvision({
      value: value.provision,
      input,
      source,
    }),
  };
}

function imageDigestFromRepoDigests(repoDigests) {
  const match = (repoDigests ?? []).find((value) => value.endsWith(`@${IMAGE_DIGEST}`));
  return match ? IMAGE_DIGEST : null;
}

function dockerEnvironment(overrides = {}) {
  const defaults = {
    PATH: "/kandev/eval/bin:/kandev/toolchain/bin:/kandev/toolchain/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/kandev/eval/home",
    TMPDIR: "/tmp",
    XDG_CACHE_HOME: "/kandev/eval/cache",
    COREPACK_HOME: "/kandev/toolchain/corepack-disabled",
    COREPACK_ENABLE_NETWORK: "0",
    npm_config_store_dir: "/kandev/toolchain/pnpm-store/v3",
    GOROOT: "/kandev/toolchain/go",
    GOPATH: "/kandev/eval/go",
    GOMODCACHE: "/kandev/toolchain/go-mod",
    GOCACHE: "/kandev/eval/go-cache",
    GOTOOLCHAIN: "local",
    CC: "/usr/bin/x86_64-linux-gnu-gcc-13",
    PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX: "disabled",
    KANDEV_HIGHLIGHT_DOCKER_BOUNDARY_AUTHORIZATION: "/kandev-boundary/authorization.json",
  };
  for (const key of Object.keys(overrides)) {
    if (!OVERRIDABLE_ENVIRONMENT.has(key)) {
      throw new Error(`Docker boundary environment ${key} cannot be overridden`);
    }
  }
  const environment = { ...defaults, ...overrides };
  const allowed = new Set(Object.keys(defaults));
  for (const [key, value] of Object.entries(environment)) {
    if (!allowed.has(key) || typeof value !== "string" || value === "" || /[\0\r\n]/.test(value)) {
      throw new Error(`Docker boundary environment ${key} is not allowlisted`);
    }
  }
  return environment;
}

export function validateDockerImageInspection(value, { architecture = process.arch } = {}) {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("Docker image inspection must return exactly one image");
  }
  const image = value[0];
  if (imageDigestFromRepoDigests(image.RepoDigests) !== IMAGE_DIGEST) {
    throw new Error("Docker inspection did not prove immutable Playwright image digest");
  }
  if (!IMAGE_ID_PATTERN.test(image.Id ?? "") || image.Os !== "linux") {
    throw new Error("Docker Playwright image must have exact Linux image identity");
  }
  const expectedArchitecture = architecture === "x64" ? "amd64" : architecture;
  if (image.Architecture !== expectedArchitecture) {
    throw new Error(
      `Docker Playwright image architecture mismatch: ${image.Architecture ?? "missing"}`,
    );
  }
  return {
    id: image.Id,
    digest: IMAGE_DIGEST,
    os: image.Os,
    architecture: image.Architecture,
  };
}

export function validateDockerDaemonSecurity(value) {
  if (!Array.isArray(value)) throw new Error("Docker daemon security options are required");
  const appArmor = value.some((option) => option === "name=apparmor");
  const seccomp = value.some(
    (option) =>
      option === "name=seccomp" || /^name=seccomp,profile=(?:builtin|default)$/.test(option),
  );
  if (!appArmor || !seccomp) {
    throw new Error("Docker daemon must enforce AppArmor and default seccomp profiles");
  }
  if (value.some((option) => /unconfined/i.test(option))) {
    throw new Error("Docker daemon cannot use unconfined AppArmor or seccomp");
  }
  return { appArmor: "default", seccomp: "default" };
}

function validatePlanInput(input) {
  if (!IMAGE_ID_PATTERN.test(input.image?.id ?? "") || input.image?.digest !== IMAGE_DIGEST) {
    throw new Error("Docker create plan needs inspected immutable Playwright image identity");
  }
  if (input.daemonSecurity?.appArmor !== "default" || input.daemonSecurity?.seccomp !== "default") {
    throw new Error("Docker create plan requires inspected default AppArmor and seccomp");
  }
  return {
    source: repositoryProof(input.sourceProof, "source", { needsOrigin: true }),
    landing: repositoryProof(input.landingProof, "landing"),
    uid: positiveInteger(input.uid, "Docker worker uid"),
    gid: positiveInteger(input.gid, "Docker worker gid"),
    environment: dockerEnvironment(input.environment),
  };
}

function validateMountList(mounts) {
  const destinations = new Set();
  for (const value of mounts) {
    if (destinations.has(value.target)) {
      throw new Error(`duplicate Docker mount ${value.target}`);
    }
    destinations.add(value.target);
    if (/docker\.sock|\.ssh|credential|\.npmrc/i.test(value.source)) {
      throw new Error(`credential or Docker control mount is forbidden: ${value.source}`);
    }
  }
  return mounts;
}

function createPlanMounts(input, source, landing) {
  return validateMountList([
    mount(input.sourceRoot, CONTAINER_SOURCE_ROOT, true, source.identity),
    mount(input.landingRoot, CONTAINER_LANDING_ROOT, true, landing.identity),
    mount(input.evalRoot, CONTAINER_EVAL_ROOT, false, input.writableProofs?.eval),
    mount(input.proofRoot, "/kandev-boundary", true, input.writableProofs?.proof),
    ...(input.toolchainMounts ?? []).map((value) =>
      mount(value.source, value.target, true, value.identity),
    ),
  ]);
}

function createBoundaryRequest(input, trusted, mounts) {
  const innerArgv = [
    "/usr/bin/node",
    INNER_ENTRYPOINT,
    "--inside-docker-boundary",
    INNER_REQUEST_PATH,
  ];
  const bootstrapArgv = ["/bin/sh", "-ceu", BOOTSTRAP_SCRIPT];
  const requestBody = {
    contract: "kandev-highlight-docker-boundary-request-v1",
    image: {
      reference: PLAYWRIGHT_IMAGE_REFERENCE,
      digest: IMAGE_DIGEST,
      id: input.image.id,
    },
    source: trusted.source,
    landing: trusted.landing,
    mounts,
    goModuleCache: goModuleCache(input.goModuleCache, mounts, trusted.source),
    environment: trusted.environment,
    network: { mode: "none", application: "loopback-only" },
    security: {
      uid: trusted.uid,
      gid: trusted.gid,
      capDrop: ["ALL"],
      noNewPrivileges: true,
      appArmor: "docker-default",
      seccomp: "default",
      privileged: false,
      devices: false,
      dockerSocket: false,
      readonlyRootfs: true,
      pidsLimit: 512,
      memoryBytes: 8 * 1024 ** 3,
      nanoCpus: 4 * 10 ** 9,
      daemon: structuredClone(input.daemonSecurity),
    },
    inner: {
      argv: innerArgv,
      sourceRoot: CONTAINER_SOURCE_ROOT,
      landingRoot: CONTAINER_LANDING_ROOT,
      evalParent: CONTAINER_EVAL_ROOT,
      captureDeadlineMs: positiveInteger(input.captureDeadlineMs, "capture deadline"),
      prNumber: 2_147_483_647,
    },
    bootstrap: { argv: bootstrapArgv },
  };
  return { ...requestBody, requestDigest: digestValue(requestBody) };
}

function dockerCreateArgs(request) {
  const args = [
    "create",
    "--network",
    "none",
    "--user",
    `${request.security.uid}:${request.security.gid}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "512",
    "--memory",
    "8g",
    "--cpus",
    "4",
    "--read-only",
    "--init",
    "--shm-size",
    "1g",
    "--workdir",
    CONTAINER_SOURCE_ROOT,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=2147483648",
    "--tmpfs",
    "/run:rw,nosuid,nodev,size=67108864",
  ];
  for (const [key, value] of Object.entries(request.environment).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    args.push("--env", `${key}=${value}`);
  }
  for (const value of request.mounts) {
    args.push(
      "--mount",
      `type=bind,src=${value.source},dst=${value.target}${value.readOnly ? ",readonly" : ""}`,
    );
  }
  args.push(PLAYWRIGHT_IMAGE_REFERENCE, ...request.bootstrap.argv);
  return args;
}

export function buildDockerCreatePlan(input = {}) {
  const trusted = validatePlanInput(input);
  const mounts = createPlanMounts(input, trusted.source, trusted.landing);
  const request = createBoundaryRequest(input, trusted, mounts);
  return { command: "docker", args: dockerCreateArgs(request), mounts, request };
}
function canonicalMounts(value) {
  return (value ?? [])
    .map((item) => ({
      type: item.Type,
      source: item.Source,
      target: item.Destination,
      readOnly: item.RW === false,
      propagation: item.Propagation,
    }))
    .sort((left, right) => left.target.localeCompare(right.target));
}

function expectedMounts(request) {
  return request.mounts
    .map((item) => ({
      type: "bind",
      source: item.source,
      target: item.target,
      readOnly: item.readOnly,
      propagation: "rprivate",
    }))
    .sort((left, right) => left.target.localeCompare(right.target));
}

function inspectedEnvironment(value) {
  return Object.fromEntries(
    (value.Config?.Env ?? []).map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}

function assertContainerRuntime(value, request) {
  if (!CONTAINER_ID_PATTERN.test(value?.Id ?? "")) {
    throw new Error("Docker boundary container identity is invalid");
  }
  const state = value.State ?? {};
  const invalid = [state.Running !== true, !Number.isInteger(state.Pid), state.Pid < 1];
  if (invalid.some(Boolean)) {
    throw new Error("Docker boundary container must be running before authorization");
  }
  if (value.Image !== request.image.id) {
    throw new Error("Docker boundary container image changed before authorization");
  }
}

function assertContainerConfiguration(value, request) {
  const configuration = value.Config ?? {};
  if (configuration.User !== `${request.security.uid}:${request.security.gid}`) {
    throw new Error("Docker boundary worker must run as exact nonroot uid/gid");
  }
  if (configuration.Entrypoint !== null) {
    throw new Error("Docker boundary image entrypoint changed");
  }
  if (configuration.WorkingDir !== CONTAINER_SOURCE_ROOT) {
    throw new Error("Docker boundary working directory changed");
  }
  if (canonicalJson(configuration.Cmd) !== canonicalJson(request.bootstrap.argv)) {
    throw new Error("Docker boundary bootstrap argv changed");
  }
  if (canonicalJson(inspectedEnvironment(value)) !== canonicalJson(request.environment)) {
    throw new Error("Docker boundary environment changed or contains unapproved credentials");
  }
}

function assertContainerHeader(value, request) {
  if (!value) throw new Error("Docker boundary container inspection is required");
  assertContainerRuntime(value, request);
  assertContainerConfiguration(value, request);
}

function assertContainerIsolation(value, request) {
  const host = value.HostConfig ?? {};
  if (host.NetworkMode !== "none") throw new Error("Docker boundary network must be none");
  const securityOptions = host.SecurityOpt ?? [];
  const invalidPrivilege = [
    canonicalJson(host.CapDrop) !== canonicalJson(["ALL"]),
    !securityOptions.includes("no-new-privileges"),
    securityOptions.some((option) => /unconfined/i.test(option)),
    host.ReadonlyRootfs !== true,
    host.Privileged !== false,
    (host.Devices?.length ?? 0) !== 0,
    (host.DeviceRequests?.length ?? 0) !== 0,
  ];
  if (invalidPrivilege.some(Boolean)) {
    throw new Error("Docker boundary privilege isolation inspection failed");
  }
  const invalidLimits = [
    host.PidsLimit !== request.security.pidsLimit,
    host.Memory !== request.security.memoryBytes,
    host.NanoCpus !== request.security.nanoCpus,
  ];
  if (invalidLimits.some(Boolean)) {
    throw new Error("Docker boundary resource limits changed");
  }
  const invalidFilesystems = [
    canonicalJson(host.Tmpfs) !== canonicalJson(EXPECTED_TMPFS),
    host.ShmSize !== 1024 ** 3,
    host.Init !== true,
    host.IpcMode !== "private",
    host.AutoRemove !== false,
  ];
  if (invalidFilesystems.some(Boolean)) {
    throw new Error("Docker boundary temporary filesystem isolation changed");
  }
  if (value.AppArmorProfile !== "docker-default") {
    throw new Error("Docker boundary must run under default AppArmor profile");
  }
  return host;
}

function assertContainerMounts(value, request) {
  if (canonicalJson(canonicalMounts(value.Mounts)) !== canonicalJson(expectedMounts(request))) {
    throw new Error("Docker boundary mount identities or permissions changed");
  }
}

export function validateDockerContainerInspection(value, request) {
  assertContainerHeader(value, request);
  const host = assertContainerIsolation(value, request);
  assertContainerMounts(value, request);
  return {
    containerId: value.Id,
    imageId: value.Image,
    appArmorProfile: value.AppArmorProfile,
    networkMode: host.NetworkMode,
    requestDigest: request.requestDigest,
  };
}

function assertAuthorizationHeader(value, request) {
  if (!value || value.contract !== "kandev-highlight-docker-boundary-authorization-v1") {
    throw new Error(
      "Docker boundary authorization is required before evaluation or browser launch",
    );
  }
  if (value.requestDigest !== request.requestDigest) {
    throw new Error("Docker boundary authorization does not bind request digest");
  }
  if (!CONTAINER_ID_PATTERN.test(value.containerId ?? "")) {
    throw new Error("Docker boundary authorization container identity is invalid");
  }
  if (
    value.imageId !== request.image.id ||
    value.sourceSha !== request.source.headSha ||
    value.sourceOriginMainSha !== request.source.originMainSha
  ) {
    throw new Error("Docker boundary authorization source SHA, origin, or image changed");
  }
}

function assertAuthorizationInspection(value, request) {
  const invalid = [
    value.containerId !== value.inspection?.containerId,
    value.inspection?.requestDigest !== request.requestDigest,
    value.inspection?.imageId !== request.image.id,
    value.inspection?.appArmorProfile !== "docker-default",
    value.inspection?.networkMode !== "none",
  ];
  if (invalid.some(Boolean)) {
    throw new Error("Docker boundary authorization inspection binding is invalid");
  }
}

export function validateDockerBoundaryAuthorization(value, request) {
  assertAuthorizationHeader(value, request);
  assertAuthorizationInspection(value, request);
  return structuredClone(value);
}
