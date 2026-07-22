import path from "node:path";

import { canonicalJson } from "./pipeline-eval-shared.mjs";

const CONTAINER_EVAL_ROOT = "/kandev/eval";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const RUNTIME_NETWORK_GATE = Object.freeze({
  contract: "kandev-highlight-runtime-network-gate-v1",
  phase: "docker-boundary-network-gate",
  argv: Object.freeze([
    "/usr/bin/node",
    "--test",
    "scripts/highlights/capture-runtime-network.test.mjs",
  ]),
});

function validateStream(value, label, expectedPath, minimumBytes) {
  const invalid = [
    !Number.isInteger(value?.bytes),
    value?.bytes < minimumBytes,
    !DIGEST_PATTERN.test(value?.sha256 ?? ""),
    value?.path !== expectedPath,
  ];
  if (invalid.some(Boolean)) {
    throw new Error(`Docker runtime network gate ${label} evidence is invalid`);
  }
  return { bytes: value.bytes, sha256: value.sha256, path: value.path };
}

function validateExecution(value) {
  const invalid = [
    value?.contract !== RUNTIME_NETWORK_GATE.contract,
    value?.status !== "passed",
    value?.phase !== RUNTIME_NETWORK_GATE.phase,
    canonicalJson(value?.argv) !== canonicalJson(RUNTIME_NETWORK_GATE.argv),
    value?.exitCode !== 0,
    value?.timedOut !== false,
    !Number.isInteger(value?.durationMs),
    value?.durationMs < 0,
  ];
  if (invalid.some(Boolean)) {
    throw new Error("Docker runtime network gate did not prove the exact passing command");
  }
}

function validateWorkingDirectory(value) {
  const invalid = [
    typeof value !== "string",
    !path.isAbsolute(value ?? ""),
    path.normalize(value ?? "") !== value,
    !value?.startsWith(`${CONTAINER_EVAL_ROOT}/`),
    path.basename(value ?? "") !== "snapshot",
  ];
  if (invalid.some(Boolean)) {
    throw new Error("Docker runtime network gate working directory is invalid");
  }
  return value;
}

export function validateRuntimeNetworkGateEvidence(value) {
  validateExecution(value);
  const cwd = validateWorkingDirectory(value.cwd);
  const logRoot = path.join(path.dirname(cwd), "logs");
  const stdout = validateStream(
    value.stdout,
    "stdout",
    path.join(logRoot, `${RUNTIME_NETWORK_GATE.phase}.stdout.log`),
    1,
  );
  const stderr = validateStream(
    value.stderr,
    "stderr",
    path.join(logRoot, `${RUNTIME_NETWORK_GATE.phase}.stderr.log`),
    0,
  );
  const recordPath = path.join(logRoot, `${RUNTIME_NETWORK_GATE.phase}.json`);
  if (value.recordPath !== recordPath) {
    throw new Error("Docker runtime network gate command record path is invalid");
  }
  return {
    contract: RUNTIME_NETWORK_GATE.contract,
    status: "passed",
    phase: RUNTIME_NETWORK_GATE.phase,
    argv: [...RUNTIME_NETWORK_GATE.argv],
    cwd,
    exitCode: 0,
    timedOut: false,
    durationMs: value.durationMs,
    stdout,
    stderr,
    recordPath,
  };
}
