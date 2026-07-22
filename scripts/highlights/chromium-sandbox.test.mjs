import assert from "node:assert/strict";
import test from "node:test";

import { validateChromiumSandboxPolicy } from "./chromium-sandbox-contract.mjs";
import {
  probeNativeChromiumSandbox,
  resolveChromiumSandboxPolicy,
} from "./chromium-sandbox.mjs";

const CHROMIUM_EXECUTABLE =
  "/verified/ms-playwright/chromium-1228/chrome-linux64/chrome";
const SOURCE_SHA = "a".repeat(40);
const ALLOWED_ORIGIN = "http://localhost:18087";
const AVAILABLE = Object.freeze({
  status: "available",
  reason: "user namespaces enabled",
});
const UNAVAILABLE = Object.freeze({
  status: "unavailable",
  reason: "AppArmor restriction",
});
const UNKNOWN = Object.freeze({
  status: "unknown",
  reason: "kernel policy unreadable",
});

function sourceProof(source = "current_main") {
  return {
    source,
    selectedSha: SOURCE_SHA,
  };
}

function resolvePolicy({ requested = "native", probe = AVAILABLE, ...options } = {}) {
  return resolveChromiumSandboxPolicy({
    inheritedEnv: { KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX: requested },
    chromiumExecutable: CHROMIUM_EXECUTABLE,
    sourceProof: sourceProof(),
    trustedSourceSha: SOURCE_SHA,
    allowedOrigin: ALLOWED_ORIGIN,
    probeNativeSandbox: async () => probe,
    ...options,
  });
}

test("native Chromium policy is versioned and carries no disabled authorization", async () => {
  assert.deepEqual(await resolvePolicy(), {
    contract: "kandev-highlight-chromium-sandbox-policy-v1",
    version: 1,
    mode: "native",
    proof: AVAILABLE,
    authorization: null,
  });
});

test("disabled Chromium requires unavailable native sandbox and exact trusted current_main", async () => {
  assert.deepEqual(
    await resolvePolicy({ requested: "disabled", probe: UNAVAILABLE }),
    {
      contract: "kandev-highlight-chromium-sandbox-policy-v1",
      version: 1,
      mode: "disabled",
      proof: UNAVAILABLE,
      authorization: {
        contract: "kandev-highlight-disabled-sandbox-authorization-v1",
        sourceMode: "current_main",
        sourceSha: SOURCE_SHA,
        allowedOrigin: ALLOWED_ORIGIN,
        guardContract: "kandev-highlight-origin-isolation-v1",
      },
    },
  );

  await assert.rejects(
    () =>
      resolvePolicy({
        requested: "disabled",
        probe: UNAVAILABLE,
        trustedSourceSha: undefined,
      }),
    /trusted current_main source SHA/i,
  );
  await assert.rejects(
    () =>
      resolvePolicy({
        requested: "disabled",
        probe: UNAVAILABLE,
        trustedSourceSha: "b".repeat(40),
      }),
    /trusted current_main source SHA/i,
  );
  await assert.rejects(
    () =>
      resolvePolicy({
        requested: "disabled",
        probe: UNAVAILABLE,
        sourceProof: sourceProof("pr_head"),
      }),
    /pr_head.*whole-worker OS isolation|disabled.*current_main/i,
  );
});

test("automatic selection uses disabled mode only with the same exact authorization", async () => {
  assert.equal(
    (await resolvePolicy({ requested: "auto", probe: AVAILABLE })).mode,
    "native",
  );
  assert.equal(
    (await resolvePolicy({ requested: "auto", probe: UNAVAILABLE })).mode,
    "disabled",
  );
  await assert.rejects(
    () => resolvePolicy({ requested: "auto", probe: UNKNOWN }),
    /automatic Chromium sandbox selection.*unknown/i,
  );
  await assert.rejects(
    () =>
      resolvePolicy({
        requested: "auto",
        probe: UNAVAILABLE,
        trustedSourceSha: undefined,
      }),
    /trusted current_main source SHA/i,
  );
});

test("closed sandbox selector rejects policy and argv injection", async () => {
  await assert.rejects(
    () => resolvePolicy({ requested: "disabled", probe: AVAILABLE }),
    /refusing.*disabled.*native sandbox is available/i,
  );
  await assert.rejects(
    () => resolvePolicy({ requested: "disabled", probe: UNKNOWN }),
    /refusing.*disabled.*could not prove native sandbox unavailable/i,
  );
  await assert.rejects(
    () =>
      resolvePolicy({
        requested: "no-sandbox --remote-debugging-port=0",
        probe: UNAVAILABLE,
      }),
    /must be native, disabled, or auto/i,
  );
});

test("native probe requires an executable setuid helper", async () => {
  const readPaths = [];
  const readFile = async (filePath) => {
    readPaths.push(filePath);
    if (filePath.endsWith("unprivileged_userns_clone")) return "1\n";
    if (filePath.endsWith("apparmor_restrict_unprivileged_userns")) {
      return "0\n";
    }
    if (filePath.endsWith("max_user_namespaces")) return "0\n";
    throw new Error(`unexpected kernel policy path ${filePath}`);
  };
  const executable = await probeNativeChromiumSandbox({
    chromiumExecutable: CHROMIUM_EXECUTABLE,
    platform: "linux",
    uid: 1_000,
    stat: async () => ({ isFile: () => true, uid: 0, mode: 0o4_511 }),
    readFile,
  });
  assert.equal(executable.status, "available");
  assert.deepEqual(readPaths, []);

  const writable = await probeNativeChromiumSandbox({
    chromiumExecutable: CHROMIUM_EXECUTABLE,
    platform: "linux",
    uid: 1_000,
    stat: async () => ({ isFile: () => true, uid: 0, mode: 0o4_777 }),
    readFile,
  });
  assert.equal(writable.status, "unavailable");
  assert.match(writable.reason, /max_user_namespaces.*zero/i);

  const nonExecutable = await probeNativeChromiumSandbox({
    chromiumExecutable: CHROMIUM_EXECUTABLE,
    platform: "linux",
    uid: 1_000,
    stat: async () => ({ isFile: () => true, uid: 0, mode: 0o4_600 }),
    readFile,
  });
  assert.equal(nonExecutable.status, "unavailable");
  assert.match(nonExecutable.reason, /max_user_namespaces.*zero/i);
  assert.equal(readPaths.some((value) => value.endsWith("max_user_namespaces")), true);
});

test("native probe fails closed when the namespace quota is zero or unknown", async () => {
  const missingStat = async () => {
    const error = new Error("missing setuid helper");
    error.code = "ENOENT";
    throw error;
  };
  const probeWithQuota = (quota) =>
    probeNativeChromiumSandbox({
      chromiumExecutable: CHROMIUM_EXECUTABLE,
      platform: "linux",
      uid: 1_000,
      stat: missingStat,
      readFile: async (filePath) => {
        if (filePath.endsWith("unprivileged_userns_clone")) return "1\n";
        if (filePath.endsWith("apparmor_restrict_unprivileged_userns")) {
          return "0\n";
        }
        if (quota === null) {
          const error = new Error("quota unreadable");
          error.code = "EACCES";
          throw error;
        }
        return `${quota}\n`;
      },
    });

  assert.equal((await probeWithQuota("15000")).status, "available");
  assert.equal((await probeWithQuota("0")).status, "unavailable");
  assert.equal((await probeWithQuota(null)).status, "unknown");
});

test("sandbox contracts accept Git SHA-1 or SHA-256 and reject control characters", async () => {
  const sha256 = "c".repeat(64);
  const policy = await resolvePolicy({
    requested: "disabled",
    probe: UNAVAILABLE,
    sourceProof: {
      source: "current_main",
      selectedSha: sha256,
    },
    trustedSourceSha: sha256,
  });
  assert.equal(policy.authorization.sourceSha, sha256);

  assert.throws(
    () =>
      validateChromiumSandboxPolicy({
        contract: "kandev-highlight-chromium-sandbox-policy-v1",
        version: 1,
        mode: "native",
        proof: { status: "available", reason: "bad\tcontrol" },
        authorization: null,
      }),
    /printable characters/i,
  );
});
