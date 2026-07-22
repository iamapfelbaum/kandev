import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  createDisabledChromiumSandboxAuthorization,
  validateChromiumSandboxPolicy,
} from "./chromium-sandbox-contract.mjs";
import { requireAbsolute } from "./runtime-host-contracts.mjs";

export const CHROMIUM_SANDBOX_ENV = "KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX";
export const CHROMIUM_TRUSTED_SOURCE_SHA_ENV =
  "KANDEV_HIGHLIGHT_TRUSTED_SOURCE_SHA";
export const CHROMIUM_DOCKER_BOUNDARY_AUTHORIZATION_ENV =
  "KANDEV_HIGHLIGHT_DOCKER_BOUNDARY_AUTHORIZATION";
const POLICY_CONTRACT = "kandev-highlight-chromium-sandbox-policy-v1";
const EXPECTED_PROBE_STATUSES = Object.freeze([
  "available",
  "unavailable",
  "unknown",
]);
const OPTIONAL_FILE_ERRORS = Object.freeze(["ENOENT", "EACCES", "EPERM"]);
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const execFileAsync = promisify(execFile);

function isOptionalFileError(error) {
  return OPTIONAL_FILE_ERRORS.includes(error.code);
}

async function optionalKernelPolicy(filePath, readFile) {
  try {
    return (await readFile(filePath, "utf8")).trim();
  } catch (error) {
    if (isOptionalFileError(error)) return null;
    throw error;
  }
}

function setuidSandboxIsUsable(sandboxStat) {
  return (
    sandboxStat?.isFile() &&
    sandboxStat.uid === 0 &&
    (sandboxStat.mode & 0o4_000) !== 0 &&
    (sandboxStat.mode & 0o111) !== 0 &&
    (sandboxStat.mode & 0o22) === 0
  );
}

function kernelPolicyProof({
  userNamespaces,
  appArmorRestriction,
  maximumUserNamespaces,
}) {
  if (appArmorRestriction === "1") {
    return {
      status: "unavailable",
      reason:
        "AppArmor restricts unprivileged user namespaces and Chromium has no usable setuid sandbox",
    };
  }
  if (userNamespaces === "0") {
    return {
      status: "unavailable",
      reason:
        "the kernel disables unprivileged user namespaces and Chromium has no usable setuid sandbox",
    };
  }
  if (maximumUserNamespaces === "0") {
    return {
      status: "unavailable",
      reason:
        "user.max_user_namespaces is zero and Chromium has no usable setuid sandbox",
    };
  }
  if (!/^[1-9][0-9]*$/.test(maximumUserNamespaces ?? "")) {
    return {
      status: "unknown",
      reason:
        "user.max_user_namespaces could not be proven positive from trusted host state",
    };
  }
  const userNamespacesAllowed =
    userNamespaces === "1" || userNamespaces === null;
  const appArmorAllowed =
    appArmorRestriction === "0" || appArmorRestriction === null;
  if (userNamespacesAllowed && appArmorAllowed) {
    return {
      status: "available",
      reason: "the kernel permits Chromium user-namespace sandboxing",
    };
  }
  return {
    status: "unknown",
    reason: "kernel sandbox policy could not be proven from trusted host state",
  };
}

export async function probeNativeChromiumSandbox({
  chromiumExecutable,
  platform = process.platform,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  stat = fs.stat,
  readFile = fs.readFile,
} = {}) {
  requireAbsolute(chromiumExecutable, "Chromium executable");
  if (platform !== "linux") {
    return {
      status: "available",
      reason: `native Chromium sandbox is platform-managed on ${platform}`,
    };
  }
  if (uid === 0) {
    return {
      status: "unavailable",
      reason: "Chromium cannot use its native sandbox as the root user",
    };
  }
  const sandboxPath = path.join(
    path.dirname(chromiumExecutable),
    "chrome_sandbox",
  );
  const sandboxStat = await stat(sandboxPath).catch((error) => {
    if (isOptionalFileError(error)) return null;
    throw error;
  });
  if (setuidSandboxIsUsable(sandboxStat)) {
    return {
      status: "available",
      reason: "verified Chromium has a root-owned setuid sandbox",
    };
  }
  const [userNamespaces, appArmorRestriction, maximumUserNamespaces] =
    await Promise.all([
      optionalKernelPolicy(
        "/proc/sys/kernel/unprivileged_userns_clone",
        readFile,
      ),
      optionalKernelPolicy(
        "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
        readFile,
      ),
      optionalKernelPolicy("/proc/sys/user/max_user_namespaces", readFile),
    ]);
  return kernelPolicyProof({
    userNamespaces,
    appArmorRestriction,
    maximumUserNamespaces,
  });
}

function validateProbeProof(proof) {
  if (
    !proof ||
    !EXPECTED_PROBE_STATUSES.includes(proof.status) ||
    typeof proof.reason !== "string" ||
    proof.reason === ""
  ) {
    throw new Error("Chromium sandbox probe returned invalid evidence");
  }
  return proof;
}

async function probeSandbox(probeNativeSandbox, chromiumExecutable) {
  try {
    return validateProbeProof(await probeNativeSandbox({ chromiumExecutable }));
  } catch (error) {
    if (error.message === "Chromium sandbox probe returned invalid evidence") {
      throw error;
    }
    throw new Error(`Chromium sandbox probe failed closed: ${error.message}`, {
      cause: error,
    });
  }
}

function nativePolicy(proof) {
  return validateChromiumSandboxPolicy({
    contract: POLICY_CONTRACT,
    version: 1,
    mode: "native",
    proof,
    authorization: null,
  });
}

function disabledPolicy(proof, authorizationInput) {
  return validateChromiumSandboxPolicy({
    contract: POLICY_CONTRACT,
    version: 1,
    mode: "disabled",
    proof,
    authorization:
      createDisabledChromiumSandboxAuthorization(authorizationInput),
  });
}

async function defaultRunGit(args, { repoRoot }) {
  const result = await execFileAsync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return result.stdout;
}

function exactScenarioRelativePath(repoRoot, scenarioPath) {
  const repository = requireAbsolute(repoRoot, "Docker source repository");
  const scenario = requireAbsolute(
    scenarioPath,
    "Docker derived scenario path",
  );
  const relative = path
    .relative(repository, scenario)
    .split(path.sep)
    .join("/");
  if (
    relative === "" ||
    relative.startsWith("../") ||
    path.posix.isAbsolute(relative) ||
    !relative.endsWith(".scenario.json")
  ) {
    throw new Error(
      "Docker derived source must change one scenario file inside its repository",
    );
  }
  return relative;
}

function dockerSourceBindingBase(sourceProof, outerBoundary) {
  const invalid = [
    !SHA_PATTERN.test(sourceProof?.selectedSha ?? ""),
    !SHA_PATTERN.test(sourceProof?.currentMainSha ?? ""),
    sourceProof.currentMainSha !== outerBoundary.originMainSha,
  ];
  if (invalid.some(Boolean)) {
    throw new Error(
      "Docker boundary origin/main does not match the exact capture source proof",
    );
  }
  return {
    contract: "kandev-highlight-docker-source-binding-v1",
    version: 1,
    selectedSha: sourceProof.selectedSha,
    boundarySourceSha: outerBoundary.boundarySourceSha,
    originMainSha: outerBoundary.originMainSha,
  };
}

function derivedSourceBinding({
  base,
  sourceProof,
  outerBoundary,
  relativeScenario,
  parentLine,
  changed,
  objectType,
}) {
  const parents = String(parentLine).trim().split(/\s+/);
  const changes = String(changed).trim().split("\n").filter(Boolean);
  const invalid = [
    parents.length !== 2,
    parents[0] !== sourceProof.selectedSha,
    parents[1] !== outerBoundary.boundarySourceSha,
    changes.length !== 1,
    changes[0] !== `A\t${relativeScenario}`,
    String(objectType).trim() !== "blob",
  ];
  if (invalid.some(Boolean)) {
    throw new Error(
      "Docker derived source must be one exact child adding only the declared scenario",
    );
  }
  return {
    ...base,
    mode: "scenario-child",
    parentSha: outerBoundary.boundarySourceSha,
    scenarioPath: relativeScenario,
  };
}

async function resolveDockerSourceBinding({
  sourceProof,
  outerBoundary,
  scenarioPath,
  runGit,
}) {
  const base = dockerSourceBindingBase(sourceProof, outerBoundary);
  if (sourceProof.selectedSha === outerBoundary.boundarySourceSha) {
    return {
      ...base,
      mode: "exact-boundary",
      parentSha: null,
      scenarioPath: null,
    };
  }
  const relativeScenario = exactScenarioRelativePath(
    sourceProof.repoRoot,
    scenarioPath,
  );
  let parentLine;
  let changed;
  let objectType;
  try {
    [parentLine, changed, objectType] = await Promise.all([
      runGit(["rev-list", "--parents", "-n", "1", sourceProof.selectedSha], {
        repoRoot: sourceProof.repoRoot,
      }),
      runGit(
        [
          "diff-tree",
          "--no-commit-id",
          "--name-status",
          "-r",
          "--no-renames",
          sourceProof.selectedSha,
        ],
        { repoRoot: sourceProof.repoRoot },
      ),
      runGit(
        ["cat-file", "-t", `${sourceProof.selectedSha}:${relativeScenario}`],
        { repoRoot: sourceProof.repoRoot },
      ),
    ]);
  } catch (error) {
    throw new Error(
      `cannot attest Docker scenario-only source child: ${error.message}`,
      { cause: error },
    );
  }
  return derivedSourceBinding({
    base,
    sourceProof,
    outerBoundary,
    relativeScenario,
    parentLine,
    changed,
    objectType,
  });
}

function compactOuterBoundary(value, authorizationPath) {
  if (
    value?.contract !== "kandev-highlight-docker-boundary-authorization-v1" ||
    value.containerId !== value.inspection?.containerId ||
    value.imageId !== value.inspection?.imageId ||
    value.requestDigest !== value.inspection?.requestDigest
  ) {
    throw new Error(
      "Docker boundary authorization inspection binding is invalid",
    );
  }
  return {
    contract: value.contract,
    requestDigest: value.requestDigest,
    containerId: value.containerId,
    imageId: value.imageId,
    boundarySourceSha: value.sourceSha,
    originMainSha: value.sourceOriginMainSha,
    appArmorProfile: value.inspection.appArmorProfile,
    networkMode: value.inspection.networkMode,
    authorizationPath,
    readOnlyMount: true,
  };
}

async function loadOuterBoundaryAuthorization(inheritedEnv, readFile) {
  const authorizationPath =
    inheritedEnv[CHROMIUM_DOCKER_BOUNDARY_AUTHORIZATION_ENV];
  if (authorizationPath !== "/kandev-boundary/authorization.json") {
    throw new Error(
      "disabled Chromium pr_head requires whole-worker OS isolation from Docker boundary authorization at the fixed read-only path",
    );
  }
  let authorization;
  let mountInfo;
  try {
    [authorization, mountInfo] = await Promise.all([
      readFile(authorizationPath, "utf8").then((bytes) => JSON.parse(bytes)),
      readFile("/proc/self/mountinfo", "utf8"),
    ]);
  } catch (error) {
    throw new Error(
      `cannot verify Docker boundary authorization: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  if (!/(?:^|\n)[^\n]*\s\/kandev-boundary\s+ro(?:,|\s)/.test(mountInfo)) {
    throw new Error(
      "Docker boundary authorization must come from read-only /kandev-boundary mount",
    );
  }
  return compactOuterBoundary(authorization, authorizationPath);
}

function resolveAutomaticPolicy(proof, authorizationInput) {
  if (proof.status === "unknown") {
    throw new Error(
      `automatic Chromium sandbox selection failed closed because availability is unknown (${proof.reason})`,
    );
  }
  return proof.status === "available"
    ? nativePolicy(proof)
    : disabledPolicy(proof, authorizationInput);
}

function resolveDisabledPolicy(proof, authorizationInput) {
  if (proof.status === "available") {
    throw new Error(
      `refusing disabled Chromium sandbox: native sandbox is available (${proof.reason})`,
    );
  }
  if (proof.status !== "unavailable") {
    throw new Error(
      `refusing disabled Chromium sandbox: could not prove native sandbox unavailable (${proof.reason})`,
    );
  }
  return disabledPolicy(proof, authorizationInput);
}

function resolveNativePolicy(proof) {
  if (proof.status === "unavailable") {
    throw new Error(
      `native Chromium sandbox is unavailable: ${proof.reason}. For this isolated localhost capture host only, set ${CHROMIUM_SANDBOX_ENV}=disabled`,
    );
  }
  if (proof.status !== "available") {
    throw new Error(
      `native Chromium sandbox availability is unknown; refusing capture (${proof.reason})`,
    );
  }
  return nativePolicy(proof);
}

export async function resolveChromiumSandboxPolicy({
  inheritedEnv = {},
  chromiumExecutable,
  sourceProof,
  trustedSourceSha,
  allowedOrigin,
  scenarioPath,
  probeNativeSandbox = probeNativeChromiumSandbox,
  readFile = fs.readFile,
  runGit = defaultRunGit,
} = {}) {
  const requested = inheritedEnv[CHROMIUM_SANDBOX_ENV] ?? "native";
  if (!["native", "disabled", "auto"].includes(requested)) {
    throw new Error(
      `${CHROMIUM_SANDBOX_ENV} must be native, disabled, or auto`,
    );
  }
  const proof = await probeSandbox(probeNativeSandbox, chromiumExecutable);
  const outerBoundary =
    sourceProof?.source === "pr_head" && proof.status === "unavailable"
      ? await loadOuterBoundaryAuthorization(inheritedEnv, readFile)
      : null;
  const sourceBinding = outerBoundary
    ? await resolveDockerSourceBinding({
        sourceProof,
        outerBoundary,
        scenarioPath,
        runGit,
      })
    : null;
  const authorizationInput = {
    sourceProof,
    trustedSourceSha,
    allowedOrigin,
    outerBoundary,
    sourceBinding,
  };
  if (requested === "auto") {
    return resolveAutomaticPolicy(proof, authorizationInput);
  }
  if (requested === "disabled") {
    return resolveDisabledPolicy(proof, authorizationInput);
  }
  return resolveNativePolicy(proof);
}
