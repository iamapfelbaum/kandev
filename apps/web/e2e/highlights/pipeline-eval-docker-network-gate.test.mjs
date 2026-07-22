import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_NETWORK_GATE,
  validateRuntimeNetworkGateEvidence,
} from "./pipeline-eval-docker-network-gate.mjs";

function validEvidence() {
  const root = "/kandev/eval/kandev-highlight-pipeline-eval-test";
  const logs = `${root}/logs/${RUNTIME_NETWORK_GATE.phase}`;
  return {
    contract: RUNTIME_NETWORK_GATE.contract,
    status: "passed",
    phase: RUNTIME_NETWORK_GATE.phase,
    argv: [...RUNTIME_NETWORK_GATE.argv],
    cwd: `${root}/snapshot`,
    exitCode: 0,
    timedOut: false,
    durationMs: 42,
    stdout: {
      bytes: 128,
      sha256: `sha256:${"1".repeat(64)}`,
      path: `${logs}.stdout.log`,
    },
    stderr: {
      bytes: 0,
      sha256: `sha256:${"2".repeat(64)}`,
      path: `${logs}.stderr.log`,
    },
    recordPath: `${logs}.json`,
  };
}

test("runtime network gate binds the exact passing test command and logs", () => {
  assert.deepEqual(validateRuntimeNetworkGateEvidence(validEvidence()), validEvidence());
});

test("runtime network gate rejects missing, failed, or tampered evidence", () => {
  assert.throws(() => validateRuntimeNetworkGateEvidence(), /exact passing command/i);
  for (const mutate of [
    (value) => (value.status = "failed"),
    (value) => value.argv.push("--test-name-pattern=skip"),
    (value) => (value.exitCode = 1),
    (value) => (value.timedOut = true),
    (value) => (value.stdout.sha256 = "untrusted"),
    (value) => (value.stdout.path = "/tmp/forged.log"),
  ]) {
    const evidence = validEvidence();
    mutate(evidence);
    assert.throws(() => validateRuntimeNetworkGateEvidence(evidence), /network gate/i);
  }
});
