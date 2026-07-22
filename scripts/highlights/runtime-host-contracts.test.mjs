import assert from "node:assert/strict";
import test from "node:test";

import {
  compactRuntimeBuildProof,
  validateRuntimeHostRequest,
  validateRuntimeSourceProof,
} from "./runtime-host-contracts.mjs";

const SHA = "1".repeat(40);

test("runtime host contract accepts only its exact versioned request", () => {
  const request = {
    contract: "kandev-highlight-runtime-host-request-v1",
    version: 1,
    runtimeId: "kandev-isolated-e2e",
    scenarioPath: "/trusted/repository/scenario.json",
    artifactRoot: "/external/highlights",
    repositoryRoot: "/trusted/repository",
    buildManifestPath: "/external/highlights/build.json",
    source: "current_main",
    runId: "run-contract",
    pullRequest: null,
    runtimeTempNamespaceRoot: "/tmp/kandev-highlight-runtime-1000",
    coordinateLockRoot: "/tmp",
  };

  assert.deepEqual(validateRuntimeHostRequest(request), request);
  assert.throws(
    () => validateRuntimeHostRequest({ ...request, modulePath: "/evil.mjs" }),
    /modulePath is not allowed/,
  );
});

test("runtime preflight contracts bind clean source and build identities", () => {
  const request = { source: "current_main" };
  const source = {
    contract: "kandev-highlight-source-v1",
    source: "current_main",
    selectedSha: SHA,
    clean: true,
    status: "",
  };
  assert.deepEqual(validateRuntimeSourceProof(source, request), source);
  assert.throws(
    () => validateRuntimeSourceProof({ ...source, clean: false }, request),
    /exact clean source proof/,
  );

  const proof = compactRuntimeBuildProof(
    {
      contract: "kandev-highlight-build-provenance-v1",
      manifestDigest: `sha256:${"d".repeat(64)}`,
      source: { selectedSha: SHA },
      outputs: {
        backend: { digest: `sha256:${"a".repeat(64)}`, bytes: 1 },
        mockAgent: { digest: `sha256:${"b".repeat(64)}`, bytes: 2 },
        webDist: {
          digest: `sha256:${"c".repeat(64)}`,
          bytes: 3,
          fileCount: 4,
        },
      },
    },
    source,
  );
  assert.equal(proof.sourceSha, SHA);
  assert.deepEqual(proof.outputs.webDist, {
    digest: `sha256:${"c".repeat(64)}`,
    bytes: 3,
    fileCount: 4,
  });
});
