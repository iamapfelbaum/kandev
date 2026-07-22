import fs from "node:fs/promises";
import path from "node:path";

import { validateChromiumSandboxPolicy } from "./chromium-sandbox-contract.mjs";
import { requireAbsolute } from "./runtime-host-contracts.mjs";

export const CHROMIUM_SANDBOX_ENV = "KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX";

async function optionalKernelPolicy(filePath, readFile) {
  try {
    return (await readFile(filePath, "utf8")).trim();
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return null;
    throw error;
  }
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
    if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return null;
    throw error;
  });
  if (
    sandboxStat?.isFile() &&
    sandboxStat.uid === 0 &&
    (sandboxStat.mode & 0o4_000) !== 0
  ) {
    return {
      status: "available",
      reason: "verified Chromium has a root-owned setuid sandbox",
    };
  }
  const [userNamespaces, appArmorRestriction] = await Promise.all([
    optionalKernelPolicy(
      "/proc/sys/kernel/unprivileged_userns_clone",
      readFile,
    ),
    optionalKernelPolicy(
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
      readFile,
    ),
  ]);
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
  if (
    (userNamespaces === "1" || userNamespaces === null) &&
    (appArmorRestriction === "0" || appArmorRestriction === null) &&
    (userNamespaces === "1" || appArmorRestriction === "0")
  ) {
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

export async function resolveChromiumSandboxPolicy({
  inheritedEnv = {},
  chromiumExecutable,
  probeNativeSandbox = probeNativeChromiumSandbox,
} = {}) {
  const requested = inheritedEnv[CHROMIUM_SANDBOX_ENV] ?? "native";
  if (!["native", "disabled", "auto"].includes(requested)) {
    throw new Error(
      `${CHROMIUM_SANDBOX_ENV} must be native, disabled, or auto`,
    );
  }
  let proof;
  try {
    proof = await probeNativeSandbox({ chromiumExecutable });
  } catch (error) {
    throw new Error(`Chromium sandbox probe failed closed: ${error.message}`, {
      cause: error,
    });
  }
  if (
    !proof ||
    !["available", "unavailable", "unknown"].includes(proof.status) ||
    typeof proof.reason !== "string" ||
    proof.reason === ""
  ) {
    throw new Error("Chromium sandbox probe returned invalid evidence");
  }
  if (requested === "auto") {
    if (proof.status === "unknown") {
      throw new Error(
        `automatic Chromium sandbox selection failed closed because availability is unknown (${proof.reason})`,
      );
    }
    return validateChromiumSandboxPolicy({
      mode: proof.status === "available" ? "native" : "disabled",
      proof,
    });
  }
  if (requested === "disabled") {
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
    return validateChromiumSandboxPolicy({ mode: "disabled", proof });
  }
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
  return validateChromiumSandboxPolicy({ mode: "native", proof });
}
