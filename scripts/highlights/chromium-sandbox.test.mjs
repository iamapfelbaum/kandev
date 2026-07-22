import assert from "node:assert/strict";
import test from "node:test";

import { resolveChromiumSandboxPolicy } from "./chromium-sandbox.mjs";

test("host authorizes disabled Chromium sandboxing only from proven native unavailability", async () => {
  const chromiumExecutable =
    "/verified/ms-playwright/chromium-1228/chrome-linux64/chrome";
  const available = async () => ({
    status: "available",
    reason: "user namespaces enabled",
  });
  const unavailable = async () => ({
    status: "unavailable",
    reason: "AppArmor restriction",
  });
  const unknown = async () => ({
    status: "unknown",
    reason: "kernel policy unreadable",
  });

  assert.deepEqual(
    await resolveChromiumSandboxPolicy({
      inheritedEnv: {},
      chromiumExecutable,
      probeNativeSandbox: available,
    }),
    {
      mode: "native",
      proof: { status: "available", reason: "user namespaces enabled" },
    },
  );
  assert.deepEqual(
    await resolveChromiumSandboxPolicy({
      inheritedEnv: { KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX: "disabled" },
      chromiumExecutable,
      probeNativeSandbox: unavailable,
    }),
    {
      mode: "disabled",
      proof: { status: "unavailable", reason: "AppArmor restriction" },
    },
  );
  assert.deepEqual(
    await resolveChromiumSandboxPolicy({
      inheritedEnv: { KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX: "auto" },
      chromiumExecutable,
      probeNativeSandbox: available,
    }),
    {
      mode: "native",
      proof: { status: "available", reason: "user namespaces enabled" },
    },
  );
  assert.deepEqual(
    await resolveChromiumSandboxPolicy({
      inheritedEnv: { KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX: "auto" },
      chromiumExecutable,
      probeNativeSandbox: unavailable,
    }),
    {
      mode: "disabled",
      proof: { status: "unavailable", reason: "AppArmor restriction" },
    },
  );
  await assert.rejects(
    () =>
      resolveChromiumSandboxPolicy({
        inheritedEnv: { KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX: "auto" },
        chromiumExecutable,
        probeNativeSandbox: unknown,
      }),
    /automatic Chromium sandbox selection.*unknown/i,
  );
  await assert.rejects(
    () =>
      resolveChromiumSandboxPolicy({
        inheritedEnv: { KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX: "disabled" },
        chromiumExecutable,
        probeNativeSandbox: available,
      }),
    /refusing.*disabled.*native sandbox is available/i,
  );
  await assert.rejects(
    () =>
      resolveChromiumSandboxPolicy({
        inheritedEnv: { KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX: "disabled" },
        chromiumExecutable,
        probeNativeSandbox: unknown,
      }),
    /refusing.*disabled.*could not prove native sandbox unavailable/i,
  );
  await assert.rejects(
    () =>
      resolveChromiumSandboxPolicy({
        inheritedEnv: {},
        chromiumExecutable,
        probeNativeSandbox: unavailable,
      }),
    /native Chromium sandbox is unavailable.*KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX=disabled/i,
  );
  await assert.rejects(
    () =>
      resolveChromiumSandboxPolicy({
        inheritedEnv: {
          KANDEV_HIGHLIGHT_CHROMIUM_SANDBOX:
            "no-sandbox --remote-debugging-port=0",
        },
        chromiumExecutable,
        probeNativeSandbox: unavailable,
      }),
    /must be native, disabled, or auto/i,
  );
});
