import fs from "node:fs/promises";
import path from "node:path";

import { runDeclarativeHighlightCommand } from "../../../../scripts/highlights/pipeline.mjs";
import { createTrustedCaptureBuildVerifier } from "../../../../scripts/highlights/capture-source.mjs";
import {
  validateRuntimeWorkerRequest,
  writeRuntimeWorkerResult,
} from "../../../../scripts/highlights/runtime-host.mjs";
import { verifySourceGate } from "../../../../scripts/highlights/source-gate.mjs";
import { createHighlightRegistries } from "./registry";
import {
  preflightCaptureIntegration,
  verifyCaptureBuildProvenance,
} from "./run-capture-integration.mjs";
import { expect, highlightRuntimeTest as test } from "./runtime-fixture";

const CREDENTIAL_KEY =
  /(?:^|_)(?:TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIALS?|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)(?:_|$)/i;

function requiredAbsoluteEnvironmentPath(name: string): string {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute trusted runtime-host path`);
  }
  return path.resolve(value);
}

function liveCredentialKeys(): string[] {
  return Object.keys(process.env)
    .filter((key) => CREDENTIAL_KEY.test(key))
    .sort();
}

test("captures one closed declarative Highlight runtime request", async ({
  apiClient,
  seedData,
  backend,
}) => {
  test.setTimeout(180_000);
  const requestPath = requiredAbsoluteEnvironmentPath("KANDEV_HIGHLIGHT_RUNTIME_REQUEST");
  const workerResultPath = requiredAbsoluteEnvironmentPath(
    "KANDEV_HIGHLIGHT_RUNTIME_WORKER_RESULT",
  );
  const request = validateRuntimeWorkerRequest(JSON.parse(await fs.readFile(requestPath, "utf8")));
  expect(workerResultPath).toBe(path.join(request.bundleRoot, "worker-result.json"));
  expect(liveCredentialKeys()).toEqual([]);

  const source = await verifySourceGate({
    repoRoot: request.repositoryRoot,
    source: request.source,
  });
  expect(source).toEqual(request.sourceProof);
  const buildProof = await verifyCaptureBuildProvenance(request.buildManifestPath, {
    expectedSourceSha: source.selectedSha,
    expectedRepositoryRoot: request.repositoryRoot,
  });
  expect(buildProof.manifestDigest).toBe(request.build.manifestDigest);
  const tools = await preflightCaptureIntegration({
    webRoot: path.join(request.repositoryRoot, "apps", "web"),
  });
  expect({
    ffmpeg: tools.ffmpeg,
    xvfb: tools.xvfb,
    chromium: tools.chromium,
    backend: tools.backend,
    mockAgent: tools.mockAgent,
    webBuild: tools.webBuild,
  }).toEqual(request.tools);

  const registries = createHighlightRegistries({ apiClient, seedData, backend });
  const applicationRuntime = {
    contract: "kandev-highlight-application-runtime-pre-teardown-v1" as const,
    version: 1 as const,
    runtimeId: request.runtimeId,
    origin: new URL(backend.frontendUrl).origin,
    ports: { backend: backend.port, frontend: backend.frontendPort },
    isolation: {
      fixtureTempRoot: backend.tmpDir,
      homeRoot: path.join(backend.tmpDir, ".kandev"),
      databasePath: path.join(backend.tmpDir, "kandev.db"),
      worktreeRoot: path.join(backend.tmpDir, "worktrees"),
      repositoryCloneRoot: path.join(backend.tmpDir, "repos"),
    },
    providerRouting: {
      profile: "e2e" as const,
      mockAgent: true as const,
      mockProviders: true as const,
      liveCredentialsPresent: false as const,
      environmentSanitized: true as const,
    },
    source: {
      contract: source.contract,
      mode: source.source,
      selectedSha: source.selectedSha,
    },
    build: {
      contract: request.build.contract,
      manifestDigest: request.build.manifestDigest,
      sourceSha: source.selectedSha,
      outputs: {
        backend: request.build.outputs.backend.digest,
        mockAgent: request.build.outputs.mockAgent.digest,
        webDist: request.build.outputs.webDist.digest,
      },
    },
  };
  const captureBindings = {
    ...registries,
    buildProvenance: buildProof,
    buildVerifier: createTrustedCaptureBuildVerifier({
      manifestPath: request.buildManifestPath,
      repositoryRoot: request.repositoryRoot,
      verify: verifyCaptureBuildProvenance,
    }),
    applicationRuntime,
    browserExecutable: request.tools.chromium,
    chromiumSandbox: request.chromiumSandbox,
    coordinateLockRoot: request.workerTempRoot,
    ffmpegExecutable: request.tools.ffmpeg,
    xvfbExecutable: request.tools.xvfb,
  };
  const result = await runDeclarativeHighlightCommand({
    command: "capture",
    scenarioPath: request.scenarioPath,
    artifactRoot: request.artifactRoot,
    source: request.source,
    repoRoot: request.repositoryRoot,
    runId: request.runId,
    prNumber: request.pullRequest?.number,
    prBaseSha: request.pullRequest?.baseSha,
    dependencies: {
      captureBindings,
      frontendUrl: backend.frontendUrl,
    },
  });
  const capture = result.phases.capture;
  expect(capture.receipt.applicationRuntime).toEqual(applicationRuntime);
  expect(capture.receipt.captureEvidence.contract).toBe("kandev-highlight-capture-evidence-v1");
  await writeRuntimeWorkerResult(
    workerResultPath,
    {
      contract: "kandev-highlight-runtime-worker-result-v1",
      version: 1,
      runtimeId: request.runtimeId,
      runId: request.runId,
      applicationRuntime,
      capture: {
        phaseManifestPath: capture.phaseManifestPath,
        captureManifestPath: capture.captureManifestPath,
        rawMasterPath: capture.rawMasterPath,
        scenarioDigest: capture.receipt.scenarioDigest,
        sourceDigest: capture.receipt.sourceDigest,
        rawMasterDigest: capture.receipt.rawMaster.digest,
        captureEvidence: capture.receipt.captureEvidence,
      },
    },
    request,
  );
});
