import fs from "node:fs/promises";
import path from "node:path";

import {
  createDisabledChromiumSandboxAuthorization,
  validateChromiumSandboxPolicy,
} from "./chromium-sandbox-contract.mjs";
import { requireAbsolute } from "./runtime-host-contracts.mjs";

export const CHROMIUM_SANDBOX_ENV = "KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX";
export const CHROMIUM_TRUSTED_SOURCE_SHA_ENV =
  "KANDEV_HIGHLIGHT_TRUSTED_SOURCE_SHA";
const POLICY_CONTRACT = "kandev-highlight-chromium-sandbox-policy-v1";
const EXPECTED_PROBE_STATUSES = Object.freeze([
  "available",
  "unavailable",
  "unknown",
]);
const OPTIONAL_FILE_ERRORS = Object.freeze(["ENOENT", "EACCES", "EPERM"]);

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
    return validateProbeProof(
      await probeNativeSandbox({ chromiumExecutable }),
    );
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
  probeNativeSandbox = probeNativeChromiumSandbox,
} = {}) {
  const requested = inheritedEnv[CHROMIUM_SANDBOX_ENV] ?? "native";
  if (!["native", "disabled", "auto"].includes(requested)) {
    throw new Error(
      `${CHROMIUM_SANDBOX_ENV} must be native, disabled, or auto`,
    );
  }
  const proof = await probeSandbox(probeNativeSandbox, chromiumExecutable);
  const authorizationInput = { sourceProof, trustedSourceSha, allowedOrigin };
  if (requested === "auto") {
    return resolveAutomaticPolicy(proof, authorizationInput);
  }
  if (requested === "disabled") {
    return resolveDisabledPolicy(proof, authorizationInput);
  }
  return resolveNativePolicy(proof);
}
