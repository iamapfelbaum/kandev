import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const WORKER_PREFIX = "worker-";
const LEASE_NAME = "runtime-temp.lease.json";
const CHROMIUM_TEMP_DIRECTORY = /^org\.chromium\.Chromium\.[A-Za-z0-9]{6}$/;
const MAX_LEASE_BYTES = 16 * 1024;
const CHROMIUM_SINGLETON_SUFFIX = path.join(
  "org.chromium.Chromium.XXXXXX",
  "SingletonSocket",
);
const UNIX_SOCKET_PATH_LIMIT = 108;
const VERIFICATION_PHASES = Object.freeze([
  "verify",
  "process-group",
  "release",
]);
const VERIFICATION_FAILURE_CODES = Object.freeze([
  "cleanup-tamper",
  "lease-tamper",
  "namespace-tamper",
  "owner-mismatch",
  "process-group-live",
  "release-failed",
  "retained-entries",
  "verification-failed",
]);

function digestBytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key))
      throw new Error(`${label} ${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label} ${key} is not allowed`);
  }
  return value;
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function statIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode & 0o7777,
  };
}

function validateIdentity(value, label) {
  exactKeys(value, ["dev", "ino", "uid", "mode"], label);
  for (const key of ["dev", "ino", "uid", "mode"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error(`${label} ${key} is invalid`);
    }
  }
  if (value.ino === 0) throw new Error(`${label} inode is invalid`);
  return value;
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode
  );
}

async function canonicalDirectory(directory, label, expectedUid) {
  const resolved = absolutePath(directory, label);
  const stat = await fs.lstat(resolved).catch((error) => {
    if (error.code === "ENOENT")
      throw new Error(`${label} does not exist: ${resolved}`);
    throw error;
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory: ${resolved}`);
  }
  if ((await fs.realpath(resolved)) !== resolved) {
    throw new Error(`${label} cannot resolve through symlinks: ${resolved}`);
  }
  if (stat.uid !== expectedUid) {
    throw new Error(`${label} must be owned by uid ${expectedUid}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} must not grant group or world permissions`);
  }
  return { path: resolved, stat, identity: statIdentity(stat) };
}

async function canonicalCoordinateDirectory(directory, expectedUid) {
  if (directory !== "/tmp") {
    return canonicalDirectory(
      directory,
      "runtime coordinate lock root",
      expectedUid,
    );
  }
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await fs.realpath(directory)) !== directory ||
    stat.uid !== 0 ||
    (stat.mode & 0o1777) !== 0o1777
  ) {
    throw new Error(
      "host-global /tmp coordinate lock root must be root-owned, sticky, world-writable, and canonical",
    );
  }
  return { path: directory, stat, identity: statIdentity(stat) };
}

async function ensurePrivateDirectory(directory, expectedUid, label) {
  const parent = path.dirname(directory);
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(
      `${label} parent must be a non-symlink directory: ${parent}`,
    );
  }
  if ((await fs.realpath(parent)) !== parent) {
    throw new Error(
      `${label} parent cannot resolve through symlinks: ${parent}`,
    );
  }
  await fs.mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  return canonicalDirectory(directory, label, expectedUid);
}

function validateNamespaceShape(value) {
  exactKeys(
    value,
    [
      "contract",
      "version",
      "namespaceRoot",
      "coordinateLockRoot",
      "namespaceIdentity",
      "coordinateLockIdentity",
    ],
    "runtime temp namespace",
  );
  if (
    value.contract !== "kandev-highlight-runtime-temp-namespace-v1" ||
    value.version !== 1
  ) {
    throw new Error("runtime temp namespace contract must be version 1");
  }
  const namespaceRoot = absolutePath(
    value.namespaceRoot,
    "runtime temp namespaceRoot",
  );
  const coordinateLockRoot = absolutePath(
    value.coordinateLockRoot,
    "runtime temp coordinateLockRoot",
  );
  validateIdentity(value.namespaceIdentity, "runtime temp namespace identity");
  validateIdentity(
    value.coordinateLockIdentity,
    "runtime temp coordinate lock identity",
  );
  return { ...value, namespaceRoot, coordinateLockRoot };
}

export async function verifyRuntimeTempNamespace(input) {
  const namespace = validateNamespaceShape(input);
  const expectedUid = namespace.namespaceIdentity.uid;
  const [root, coordinate] = await Promise.all([
    canonicalDirectory(
      namespace.namespaceRoot,
      "runtime temp namespace",
      expectedUid,
    ),
    canonicalCoordinateDirectory(namespace.coordinateLockRoot, expectedUid),
  ]);
  if (
    !sameIdentity(root.identity, namespace.namespaceIdentity) ||
    !sameIdentity(coordinate.identity, namespace.coordinateLockIdentity)
  ) {
    throw new Error(
      "runtime temp namespace inode identity changed (possible tamper)",
    );
  }
  return namespace;
}

export async function prepareRuntimeTempNamespace({
  namespaceRoot,
  coordinateLockRoot = "/tmp",
  uid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new Error("runtime temp namespace requires a numeric process uid");
  }
  const resolved = absolutePath(namespaceRoot, "runtime temp namespaceRoot");
  const resolvedCoordinateLockRoot = absolutePath(
    coordinateLockRoot,
    "runtime temp coordinateLockRoot",
  );
  const projectedWorkerRoot = path.join(resolved, `${WORKER_PREFIX}XXXXXX`);
  const projectedSocket = path.join(
    projectedWorkerRoot,
    CHROMIUM_SINGLETON_SUFFIX,
  );
  if (Buffer.byteLength(projectedSocket) >= UNIX_SOCKET_PATH_LIMIT) {
    throw new Error(
      `runtime temp namespace is too long for Chromium Unix sockets (${Buffer.byteLength(projectedSocket)} >= ${UNIX_SOCKET_PATH_LIMIT} bytes): ${resolved}`,
    );
  }
  const root = await ensurePrivateDirectory(
    resolved,
    uid,
    "runtime temp namespace",
  );
  const coordinate =
    resolvedCoordinateLockRoot === "/tmp"
      ? await canonicalCoordinateDirectory(resolvedCoordinateLockRoot, uid)
      : await ensurePrivateDirectory(
          resolvedCoordinateLockRoot,
          uid,
          "runtime coordinate lock root",
        );
  return {
    contract: "kandev-highlight-runtime-temp-namespace-v1",
    version: 1,
    namespaceRoot: root.path,
    coordinateLockRoot: coordinate.path,
    namespaceIdentity: root.identity,
    coordinateLockIdentity: coordinate.identity,
  };
}

export async function runtimeProcessStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const token = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/)[19];
    return /^\d+$/.test(token ?? "") ? token : null;
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    throw error;
  }
}

function validateOwner(owner) {
  exactKeys(owner, ["pid", "startToken"], "runtime temp owner");
  if (
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.startToken !== "string" ||
    !/^\d+$/.test(owner.startToken)
  ) {
    throw new Error(
      "runtime temp owner must bind a PID and numeric start token",
    );
  }
  return { pid: owner.pid, startToken: owner.startToken };
}

function leaseBody(lease) {
  const { leaseIdentity: _leaseIdentity, ...body } = lease;
  return body;
}

function validateLeaseShape(value) {
  exactKeys(
    value,
    [
      "contract",
      "version",
      "namespaceRoot",
      "coordinateLockRoot",
      "workerTempRoot",
      "leasePath",
      "runId",
      "artifactRoot",
      "owner",
      "namespaceIdentity",
      "coordinateLockIdentity",
      "rootIdentity",
      "leaseIdentity",
    ],
    "runtime temp lease",
  );
  if (
    value.contract !== "kandev-highlight-runtime-temp-lease-v1" ||
    value.version !== 1 ||
    !SAFE_RUN_ID.test(value.runId ?? "")
  ) {
    throw new Error(
      "runtime temp lease contract, version, or runId is invalid",
    );
  }
  const namespaceRoot = absolutePath(
    value.namespaceRoot,
    "runtime temp namespaceRoot",
  );
  const coordinateLockRoot = absolutePath(
    value.coordinateLockRoot,
    "runtime temp coordinateLockRoot",
  );
  const workerTempRoot = absolutePath(
    value.workerTempRoot,
    "runtime worker temp root",
  );
  const leasePath = absolutePath(value.leasePath, "runtime temp lease path");
  const artifactRoot = absolutePath(
    value.artifactRoot,
    "runtime temp artifactRoot",
  );
  if (
    path.dirname(workerTempRoot) !== namespaceRoot ||
    !path.basename(workerTempRoot).startsWith(WORKER_PREFIX) ||
    leasePath !== path.join(workerTempRoot, LEASE_NAME)
  ) {
    throw new Error(
      "runtime temp lease paths are not fixed to their namespace",
    );
  }
  for (const [identity, label] of [
    [value.namespaceIdentity, "runtime temp namespace identity"],
    [value.coordinateLockIdentity, "runtime temp coordinate lock identity"],
    [value.rootIdentity, "runtime worker temp root identity"],
  ]) {
    validateIdentity(identity, label);
  }
  exactKeys(
    value.leaseIdentity,
    ["path", "dev", "ino", "bytes", "digest"],
    "runtime temp lease identity",
  );
  if (
    value.leaseIdentity.path !== leasePath ||
    !Number.isSafeInteger(value.leaseIdentity.dev) ||
    !Number.isSafeInteger(value.leaseIdentity.ino) ||
    value.leaseIdentity.ino <= 0 ||
    !Number.isSafeInteger(value.leaseIdentity.bytes) ||
    value.leaseIdentity.bytes <= 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(value.leaseIdentity.digest ?? "")
  ) {
    throw new Error("runtime temp lease file identity is invalid");
  }
  return {
    ...value,
    namespaceRoot,
    coordinateLockRoot,
    workerTempRoot,
    leasePath,
    artifactRoot,
    owner: validateOwner(value.owner),
  };
}

export function validateRuntimeTempLease(value) {
  return validateLeaseShape(value);
}

function validateRecoveryPaths(value, namespaceRoot) {
  exactKeys(
    value,
    ["removed", "live", "preserved"],
    "runtime temp recovery evidence",
  );
  const seen = new Set();
  for (const state of ["removed", "live", "preserved"]) {
    const entries = value[state];
    if (!Array.isArray(entries)) {
      throw new Error(`runtime temp recovery ${state} must be an array`);
    }
    if (canonicalJson(entries) !== canonicalJson([...entries].sort())) {
      throw new Error(`runtime temp recovery ${state} must be sorted`);
    }
    for (const entry of entries) {
      if (
        typeof entry !== "string" ||
        !path.isAbsolute(entry) ||
        path.dirname(path.resolve(entry)) !== namespaceRoot ||
        !path.basename(entry).startsWith(WORKER_PREFIX) ||
        seen.has(entry)
      ) {
        throw new Error(
          "runtime temp recovery paths must be unique worker roots inside the exact namespace",
        );
      }
      seen.add(entry);
    }
  }
  if (value.removed.length !== 0) {
    throw new Error(
      "runtime temp recovery is inspect-only and cannot claim automatic removal",
    );
  }
  return structuredClone(value);
}

function validateRuntimeTempRelease(value, lease) {
  exactKeys(
    value,
    [
      "contract",
      "version",
      "runId",
      "workerTempRoot",
      "leasePath",
      "leaseDigest",
      "rootIdentity",
      "verified",
      "leaseRemoved",
      "removed",
    ],
    "runtime temp release evidence",
  );
  validateIdentity(value.rootIdentity, "runtime temp release root identity");
  if (
    value.contract !== "kandev-highlight-runtime-temp-release-v1" ||
    value.version !== 1 ||
    value.runId !== lease.runId ||
    value.workerTempRoot !== lease.workerTempRoot ||
    value.leasePath !== lease.leasePath ||
    value.leaseDigest !== lease.leaseIdentity.digest ||
    !sameIdentity(value.rootIdentity, lease.rootIdentity) ||
    value.verified !== true ||
    value.leaseRemoved !== true ||
    value.removed !== true
  ) {
    throw new Error("runtime temp release is not bound to the exact lease");
  }
  return structuredClone(value);
}

function runtimeTempFailureCode(error, phase) {
  const message = String(error?.message ?? error ?? "runtime temp failure");
  if (phase === "process-group") return "process-group-live";
  if (/retained entries|refusing cleanup/i.test(message)) {
    return "retained-entries";
  }
  if (/owner|start token|current live owner/i.test(message)) {
    return "owner-mismatch";
  }
  if (/namespace|coordinate lock identity/i.test(message)) {
    return "namespace-tamper";
  }
  if (
    /lease.*(?:changed|disappeared|invalid|symlink|inode|digest|payload|tamper)/i.test(
      message,
    )
  ) {
    return "lease-tamper";
  }
  if (
    /worker temp root.*(?:changed|renamed|inode)|possible tamper/i.test(message)
  ) {
    return "cleanup-tamper";
  }
  return phase === "verify" ? "verification-failed" : "release-failed";
}

export function runtimeTempVerificationEvidence({
  lease: leaseInput,
  release: releaseInput = null,
  phase = "release",
  error = null,
} = {}) {
  const lease = validateLeaseShape(leaseInput);
  if (releaseInput !== null) {
    validateRuntimeTempRelease(releaseInput, lease);
    if (phase !== "release" || error !== null) {
      throw new Error(
        "successful runtime temp verification must be a release without an error",
      );
    }
    return {
      contract: "kandev-highlight-runtime-temp-verification-v1",
      version: 1,
      status: "verified",
      phase: "release",
      code: "released",
      reasonDigest: null,
      preservedRoot: null,
    };
  }
  if (!VERIFICATION_PHASES.includes(phase) || error === null) {
    throw new Error(
      "failed runtime temp verification requires a known phase and error",
    );
  }
  const reason = String(error?.message ?? error);
  return {
    contract: "kandev-highlight-runtime-temp-verification-v1",
    version: 1,
    status: "failed",
    phase,
    code: runtimeTempFailureCode(error, phase),
    reasonDigest: digestBytes(Buffer.from(reason)),
    preservedRoot: lease.workerTempRoot,
  };
}

function validateRuntimeTempVerification(value, lease, release) {
  exactKeys(
    value,
    [
      "contract",
      "version",
      "status",
      "phase",
      "code",
      "reasonDigest",
      "preservedRoot",
    ],
    "runtime temp verification evidence",
  );
  if (
    value.contract !== "kandev-highlight-runtime-temp-verification-v1" ||
    value.version !== 1 ||
    !VERIFICATION_PHASES.includes(value.phase)
  ) {
    throw new Error("runtime temp verification contract or phase is invalid");
  }
  if (
    value.status === "verified" &&
    value.phase === "release" &&
    value.code === "released" &&
    value.reasonDigest === null &&
    value.preservedRoot === null &&
    release !== null
  ) {
    return structuredClone(value);
  }
  if (
    value.status === "failed" &&
    VERIFICATION_FAILURE_CODES.includes(value.code) &&
    /^sha256:[a-f0-9]{64}$/.test(value.reasonDigest ?? "") &&
    value.preservedRoot === lease.workerTempRoot &&
    release === null
  ) {
    return structuredClone(value);
  }
  throw new Error(
    "runtime temp verification is not bound to its release or preserved root",
  );
}

export function validateRuntimeTempEvidence(
  value,
  {
    namespaceRoot,
    coordinateLockRoot,
    runId,
    artifactRoot,
    requireReleased = true,
  } = {},
) {
  exactKeys(
    value,
    ["namespace", "recovery", "lease", "release", "verification"],
    "runtime temp evidence",
  );
  const namespace = validateNamespaceShape(value.namespace);
  const lease = validateLeaseShape(value.lease);
  const recovery = validateRecoveryPaths(
    value.recovery,
    namespace.namespaceRoot,
  );
  if (
    !sameIdentity(namespace.namespaceIdentity, lease.namespaceIdentity) ||
    !sameIdentity(
      namespace.coordinateLockIdentity,
      lease.coordinateLockIdentity,
    ) ||
    lease.namespaceRoot !== namespace.namespaceRoot ||
    lease.coordinateLockRoot !== namespace.coordinateLockRoot ||
    lease.rootIdentity.uid !== namespace.namespaceIdentity.uid ||
    (namespace.namespaceIdentity.mode & 0o077) !== 0 ||
    (lease.rootIdentity.mode & 0o077) !== 0 ||
    (namespace.coordinateLockRoot === "/tmp" &&
      (namespace.coordinateLockIdentity.uid !== 0 ||
        (namespace.coordinateLockIdentity.mode & 0o1777) !== 0o1777)) ||
    (namespaceRoot !== undefined &&
      namespace.namespaceRoot !== namespaceRoot) ||
    (coordinateLockRoot !== undefined &&
      namespace.coordinateLockRoot !== coordinateLockRoot) ||
    (runId !== undefined && lease.runId !== runId) ||
    (artifactRoot !== undefined && lease.artifactRoot !== artifactRoot)
  ) {
    throw new Error(
      "runtime temp namespace and lease identities are not exactly bound",
    );
  }
  const release =
    value.release === null
      ? null
      : validateRuntimeTempRelease(value.release, lease);
  const verification = validateRuntimeTempVerification(
    value.verification,
    lease,
    release,
  );
  if (
    requireReleased &&
    (release === null || verification.status !== "verified")
  ) {
    throw new Error("runtime temp evidence requires a bound release receipt");
  }
  return { namespace, recovery, lease, release, verification };
}

async function openLeaseSnapshot(leasePath) {
  const pathStat = await fs.lstat(leasePath).catch((error) => {
    if (error.code === "ENOENT")
      throw new Error(`runtime temp lease disappeared: ${leasePath}`);
    throw error;
  });
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(
      `runtime temp lease must be a non-symlink file: ${leasePath}`,
    );
  }
  const handle = await fs.open(
    leasePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (before.dev !== pathStat.dev || before.ino !== pathStat.ino) {
      throw new Error(`runtime temp lease changed while opening: ${leasePath}`);
    }
    if (before.size <= 0 || before.size > MAX_LEASE_BYTES) {
      throw new Error(
        `runtime temp lease exceeds its byte bound: ${before.size}`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      bytes.length !== before.size
    ) {
      throw new Error(`runtime temp lease changed while reading: ${leasePath}`);
    }
    return { bytes, stat: before };
  } finally {
    await handle.close();
  }
}

async function verifiedLease(leaseInput, processStartToken) {
  const lease = validateLeaseShape(leaseInput);
  await verifyRuntimeTempNamespace({
    contract: "kandev-highlight-runtime-temp-namespace-v1",
    version: 1,
    namespaceRoot: lease.namespaceRoot,
    coordinateLockRoot: lease.coordinateLockRoot,
    namespaceIdentity: lease.namespaceIdentity,
    coordinateLockIdentity: lease.coordinateLockIdentity,
  });
  const root = await canonicalDirectory(
    lease.workerTempRoot,
    "runtime worker temp root",
    lease.rootIdentity.uid,
  );
  if (!sameIdentity(root.identity, lease.rootIdentity)) {
    throw new Error(
      "runtime worker temp root inode identity changed (possible tamper)",
    );
  }
  const snapshot = await openLeaseSnapshot(lease.leasePath);
  if (
    snapshot.stat.dev !== lease.leaseIdentity.dev ||
    snapshot.stat.ino !== lease.leaseIdentity.ino ||
    snapshot.bytes.length !== lease.leaseIdentity.bytes ||
    digestBytes(snapshot.bytes) !== lease.leaseIdentity.digest
  ) {
    throw new Error(
      "runtime temp lease inode, bytes, or digest changed (possible tamper)",
    );
  }
  let persisted;
  try {
    persisted = JSON.parse(snapshot.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`runtime temp lease is invalid JSON: ${error.message}`);
  }
  if (canonicalJson(persisted) !== canonicalJson(leaseBody(lease))) {
    throw new Error("runtime temp lease payload changed (possible tamper)");
  }
  const currentToken = await processStartToken(lease.owner.pid);
  if (currentToken !== lease.owner.startToken) {
    throw new Error("runtime temp lease live owner start token changed");
  }
  return { lease, snapshot };
}

export async function verifyRuntimeWorkerTemp(
  lease,
  { processStartToken = runtimeProcessStartToken } = {},
) {
  await verifiedLease(lease, processStartToken);
  return { verified: true };
}

export async function reserveRuntimeWorkerTemp({
  namespace: namespaceInput,
  runId,
  artifactRoot,
  owner,
  processStartToken = runtimeProcessStartToken,
} = {}) {
  const namespace = await verifyRuntimeTempNamespace(namespaceInput);
  if (!SAFE_RUN_ID.test(runId ?? ""))
    throw new Error("runtime temp runId is unsafe");
  const resolvedArtifactRoot = absolutePath(
    artifactRoot,
    "runtime temp artifactRoot",
  );
  const resolvedOwner = owner
    ? validateOwner(owner)
    : {
        pid: process.pid,
        startToken: await processStartToken(process.pid),
      };
  validateOwner(resolvedOwner);
  const workerTempRoot = await fs.mkdtemp(
    path.join(namespace.namespaceRoot, WORKER_PREFIX),
  );
  await fs.chmod(workerTempRoot, 0o700);
  const root = await canonicalDirectory(
    workerTempRoot,
    "runtime worker temp root",
    namespace.namespaceIdentity.uid,
  );
  const leasePath = path.join(workerTempRoot, LEASE_NAME);
  const body = {
    contract: "kandev-highlight-runtime-temp-lease-v1",
    version: 1,
    namespaceRoot: namespace.namespaceRoot,
    coordinateLockRoot: namespace.coordinateLockRoot,
    workerTempRoot,
    leasePath,
    runId,
    artifactRoot: resolvedArtifactRoot,
    owner: resolvedOwner,
    namespaceIdentity: namespace.namespaceIdentity,
    coordinateLockIdentity: namespace.coordinateLockIdentity,
    rootIdentity: root.identity,
  };
  const bytes = Buffer.from(`${JSON.stringify(body, null, 2)}\n`);
  let handle;
  try {
    handle = await fs.open(
      leasePath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    const stat = await handle.stat();
    await handle.close();
    handle = null;
    const lease = {
      ...body,
      leaseIdentity: {
        path: leasePath,
        dev: stat.dev,
        ino: stat.ino,
        bytes: bytes.length,
        digest: digestBytes(bytes),
      },
    };
    await verifyRuntimeWorkerTemp(lease, { processStartToken });
    return lease;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs
      .rm(workerTempRoot, { recursive: true, force: true })
      .catch(() => {});
    throw error;
  }
}

function anchoredDirectoryPath(handle) {
  return path.join("/proc/self/fd", String(handle.fd));
}

async function openAnchoredDirectory(directoryPath, expectedIdentity, label) {
  const pathStat = await fs.lstat(directoryPath);
  if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
    throw new Error(`${label} must remain a non-symlink directory`);
  }
  const handle = await fs.open(
    directoryPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (
      stat.dev !== pathStat.dev ||
      stat.ino !== pathStat.ino ||
      stat.dev !== expectedIdentity.dev ||
      stat.ino !== expectedIdentity.ino
    ) {
      throw new Error(`${label} inode changed before cleanup`);
    }
    return { handle, stat };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function retainedEntriesError(entries) {
  return new Error(
    `refusing cleanup: runtime worker temp root has retained entries (${entries.filter((entry) => entry !== LEASE_NAME).join(", ") || "lease mismatch"})`,
  );
}

async function removeEmptyChromiumTempDirectories(root, entries) {
  if (!entries.includes(LEASE_NAME)) throw retainedEntriesError(entries);
  const anchoredRoot = anchoredDirectoryPath(root.handle);
  const candidates = [];
  for (const entry of entries) {
    if (entry === LEASE_NAME) continue;
    if (!CHROMIUM_TEMP_DIRECTORY.test(entry)) {
      throw retainedEntriesError(entries);
    }
    const entryPath = path.join(anchoredRoot, entry);
    const entryStat = await fs.lstat(entryPath);
    if (
      !entryStat.isDirectory() ||
      entryStat.isSymbolicLink() ||
      entryStat.uid !== root.stat.uid ||
      (entryStat.mode & 0o077) !== 0
    ) {
      throw retainedEntriesError(entries);
    }
    const candidate = await openAnchoredDirectory(
      entryPath,
      statIdentity(entryStat),
      "Chromium runtime temp directory",
    );
    try {
      if ((await fs.readdir(anchoredDirectoryPath(candidate.handle))).length) {
        throw retainedEntriesError(entries);
      }
      candidates.push({ entryPath, identity: statIdentity(candidate.stat) });
    } finally {
      await candidate.handle.close().catch(() => {});
    }
  }

  for (const candidate of candidates) {
    const directory = await openAnchoredDirectory(
      candidate.entryPath,
      candidate.identity,
      "Chromium runtime temp directory",
    );
    try {
      if ((await fs.readdir(anchoredDirectoryPath(directory.handle))).length) {
        throw retainedEntriesError(entries);
      }
      const current = await fs.lstat(candidate.entryPath);
      if (!sameIdentity(statIdentity(current), candidate.identity)) {
        throw new Error(
          "Chromium runtime temp directory changed before cleanup (possible tamper)",
        );
      }
      await fs.rmdir(candidate.entryPath);
    } finally {
      await directory.handle.close().catch(() => {});
    }
  }
}

async function removeVerifiedLeaseTree(lease, options = {}) {
  const root = await openAnchoredDirectory(
    lease.workerTempRoot,
    lease.rootIdentity,
    "runtime worker temp root",
  );
  try {
    await options.afterRootOpen?.();
    const currentRoot = await fs.lstat(lease.workerTempRoot).catch((error) => {
      if (error.code === "ENOENT") {
        throw new Error(
          "runtime worker temp root was renamed before cleanup (possible tamper)",
        );
      }
      throw error;
    });
    if (
      currentRoot.dev !== root.stat.dev ||
      currentRoot.ino !== root.stat.ino
    ) {
      throw new Error(
        "runtime worker temp root changed before cleanup (possible tamper)",
      );
    }
    const entries = (
      await fs.readdir(anchoredDirectoryPath(root.handle))
    ).sort();
    await removeEmptyChromiumTempDirectories(root, entries);
    const retained = (
      await fs.readdir(anchoredDirectoryPath(root.handle))
    ).sort();
    if (retained.length !== 1 || retained[0] !== LEASE_NAME) {
      throw retainedEntriesError(retained);
    }
    const anchoredLeasePath = path.join(
      anchoredDirectoryPath(root.handle),
      LEASE_NAME,
    );
    const snapshot = await openLeaseSnapshot(anchoredLeasePath);
    if (
      snapshot.stat.dev !== lease.leaseIdentity.dev ||
      snapshot.stat.ino !== lease.leaseIdentity.ino ||
      snapshot.bytes.length !== lease.leaseIdentity.bytes ||
      digestBytes(snapshot.bytes) !== lease.leaseIdentity.digest
    ) {
      throw new Error(
        "runtime temp lease changed before cleanup (possible tamper)",
      );
    }
    const beforeUnlink = await fs.lstat(lease.workerTempRoot);
    if (
      beforeUnlink.dev !== root.stat.dev ||
      beforeUnlink.ino !== root.stat.ino
    ) {
      throw new Error(
        "runtime worker temp root changed before lease removal (possible tamper)",
      );
    }
    await fs.unlink(anchoredLeasePath);
    const beforeRemove = await fs.lstat(lease.workerTempRoot);
    if (
      beforeRemove.dev !== root.stat.dev ||
      beforeRemove.ino !== root.stat.ino
    ) {
      throw new Error(
        "runtime worker temp root changed before cleanup (possible tamper)",
      );
    }
    await fs.rmdir(lease.workerTempRoot);
  } finally {
    await root.handle.close().catch(() => {});
  }
}

export async function releaseRuntimeWorkerTemp(
  leaseInput,
  { processStartToken = runtimeProcessStartToken, afterRootOpen } = {},
) {
  const lease = validateLeaseShape(leaseInput);
  if (lease.owner.pid !== process.pid) {
    throw new Error("runtime temp release requires the current live owner");
  }
  await verifiedLease(lease, processStartToken);
  await removeVerifiedLeaseTree(lease, { afterRootOpen });
  return {
    contract: "kandev-highlight-runtime-temp-release-v1",
    version: 1,
    runId: lease.runId,
    workerTempRoot: lease.workerTempRoot,
    leasePath: lease.leasePath,
    leaseDigest: lease.leaseIdentity.digest,
    rootIdentity: lease.rootIdentity,
    verified: true,
    leaseRemoved: true,
    removed: true,
  };
}

async function recoverableLease(namespace, workerTempRoot) {
  const leasePath = path.join(workerTempRoot, LEASE_NAME);
  const root = await canonicalDirectory(
    workerTempRoot,
    "stale runtime worker temp root",
    namespace.namespaceIdentity.uid,
  );
  const snapshot = await openLeaseSnapshot(leasePath);
  let body;
  try {
    body = JSON.parse(snapshot.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `stale runtime temp lease is invalid JSON: ${error.message}`,
    );
  }
  const lease = validateLeaseShape({
    ...body,
    leaseIdentity: {
      path: leasePath,
      dev: snapshot.stat.dev,
      ino: snapshot.stat.ino,
      bytes: snapshot.bytes.length,
      digest: digestBytes(snapshot.bytes),
    },
  });
  if (
    lease.workerTempRoot !== workerTempRoot ||
    lease.namespaceRoot !== namespace.namespaceRoot ||
    lease.coordinateLockRoot !== namespace.coordinateLockRoot ||
    !sameIdentity(lease.rootIdentity, root.identity) ||
    !sameIdentity(lease.namespaceIdentity, namespace.namespaceIdentity) ||
    !sameIdentity(
      lease.coordinateLockIdentity,
      namespace.coordinateLockIdentity,
    )
  ) {
    throw new Error("stale runtime temp lease identity is not recoverable");
  }
  return lease;
}

export async function recoverRuntimeWorkerTemps({
  namespace: namespaceInput,
  processStartToken = runtimeProcessStartToken,
} = {}) {
  const namespace = await verifyRuntimeTempNamespace(namespaceInput);
  const removed = [];
  const live = [];
  const preserved = [];
  const entries = (await fs.readdir(namespace.namespaceRoot)).sort();
  for (const entry of entries) {
    if (!entry.startsWith(WORKER_PREFIX)) continue;
    const workerTempRoot = path.join(namespace.namespaceRoot, entry);
    try {
      const lease = await recoverableLease(namespace, workerTempRoot);
      const token = await processStartToken(lease.owner.pid);
      if (token === lease.owner.startToken) {
        live.push(workerTempRoot);
        continue;
      }
      preserved.push(workerTempRoot);
    } catch {
      preserved.push(workerTempRoot);
    }
  }
  return { removed, live, preserved };
}
