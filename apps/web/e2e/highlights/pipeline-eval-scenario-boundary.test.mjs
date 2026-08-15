import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDockerCreatePlan,
  validateDockerBoundaryAuthorization,
} from "./pipeline-eval-docker-boundary.mjs";
import { runInsideDockerBoundary } from "./pipeline-eval-docker-launcher.mjs";

const SOURCE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const IMAGE_ID = `sha256:${"8".repeat(64)}`;
const IMAGE_DIGEST = "sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48";
const QUICK_CHAT_SCENARIO = "apps/web/e2e/highlights/quick-chat.scenario.json";

function committedScenarioEvaluation() {
  return {
    contract: "kandev-highlight-pipeline-evaluation-v1",
    mode: "committed-scenario",
    scenario: {
      path: QUICK_CHAT_SCENARIO,
      sourceHead: SOURCE_SHA,
      gitBlobSha: "c".repeat(40),
      bytes: 1234,
      sha256: `sha256:${"d".repeat(64)}`,
    },
  };
}

function fixtureInput() {
  const identity = (inode, mode = 0o755) => ({ device: "2049", inode, mode });
  return {
    sourceRoot: "/trusted/source",
    landingRoot: "/trusted/landing",
    evalRoot: "/external/eval",
    proofRoot: "/external/proof",
    sourceProof: {
      headSha: SOURCE_SHA,
      tree: "c".repeat(40),
      originMainSha: BASE_SHA,
      status: "",
      identity: identity("101"),
    },
    landingProof: {
      headSha: "d".repeat(40),
      tree: "e".repeat(40),
      status: "",
      identity: identity("102"),
    },
    writableProofs: {
      eval: identity("103", 0o700),
      proof: identity("104", 0o700),
    },
    image: { id: IMAGE_ID, digest: IMAGE_DIGEST },
    uid: 1000,
    gid: 1000,
    captureDeadlineMs: 120_000,
    daemonSecurity: { appArmor: "default", seccomp: "default" },
  };
}

function boundaryAuthorization(plan) {
  const containerId = "6".repeat(64);
  return {
    contract: "kandev-highlight-docker-boundary-authorization-v1",
    requestDigest: plan.request.requestDigest,
    containerId,
    imageId: IMAGE_ID,
    sourceSha: SOURCE_SHA,
    sourceOriginMainSha: BASE_SHA,
    inspection: {
      containerId,
      imageId: IMAGE_ID,
      appArmorProfile: "docker-default",
      networkMode: "none",
      requestDigest: plan.request.requestDigest,
    },
  };
}

test("Docker request digest and authorization bind committed scenario mode and proof", () => {
  const quickStart = buildDockerCreatePlan(fixtureInput());
  const evaluation = committedScenarioEvaluation();
  const supplied = buildDockerCreatePlan({ ...fixtureInput(), evaluation });

  assert.deepEqual(supplied.request.evaluation, evaluation);
  assert.equal(quickStart.request.evaluation.mode, "quick-start");
  assert.notEqual(supplied.request.requestDigest, quickStart.request.requestDigest);
  const authorization = boundaryAuthorization(supplied);
  assert.equal(
    validateDockerBoundaryAuthorization(authorization, supplied.request).requestDigest,
    supplied.request.requestDigest,
  );

  const tampered = structuredClone(supplied.request);
  tampered.evaluation.scenario.path = "apps/web/e2e/highlights/other.scenario.json";
  assert.throws(
    () => validateDockerBoundaryAuthorization(authorization, tampered),
    /request digest|evaluation.*binding/i,
  );
});

test("inner worker re-proves a committed scenario before passing its evaluation to orchestration", async () => {
  const evaluation = committedScenarioEvaluation();
  const plan = buildDockerCreatePlan({ ...fixtureInput(), evaluation });
  const authorization = boundaryAuthorization(plan);
  let scenarioProofCalls = 0;
  let evaluationCalls = 0;

  await assert.rejects(
    () =>
      runInsideDockerBoundary({
        requestPath: "/kandev-boundary/request.json",
        dependencies: {
          readJson: async (filePath) =>
            filePath.endsWith("request.json") ? plan.request : authorization,
          readFile: async () =>
            plan.mounts
              .map(
                ({ target, readOnly }, index) =>
                  `${index + 1} 0 0:${index + 1} / ${target} ${
                    readOnly ? "ro" : "rw"
                  } - ext4 /dev/sda ${readOnly ? "ro" : "rw"}`,
              )
              .join("\n"),
          captureRepositoryProof: async (root) =>
            root === "/kandev/source" ? plan.request.source : plan.request.landing,
          captureScenarioEvaluation: async (input) => {
            scenarioProofCalls += 1;
            assert.deepEqual(input, {
              sourceRoot: "/kandev/source",
              scenarioPath: QUICK_CHAT_SCENARIO,
            });
            return evaluation;
          },
          capturePathIdentity: async (target) =>
            plan.mounts.find((mountRecord) => mountRecord.target === target).identity,
          runEvaluation: async (options) => {
            evaluationCalls += 1;
            assert.deepEqual(options.evaluation, evaluation);
            throw new Error("stop after committed scenario handoff");
          },
          writeJson: async () => {},
        },
      }),
    /stop after committed scenario handoff/,
  );
  assert.equal(scenarioProofCalls, 1);
  assert.equal(evaluationCalls, 1);
});
