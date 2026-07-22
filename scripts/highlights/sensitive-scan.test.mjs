import assert from "node:assert/strict";
import test from "node:test";

import * as sensitiveScan from "./sensitive-scan.mjs";

const { validateSensitiveScanResult } = sensitiveScan;

const metadataOnlyCoverage = {
  metadata: true,
  visibleDomText: false,
  browserConsole: false,
  runtimeLogs: false,
  renderedPixelOcr: false,
};

function validResult(overrides = {}) {
  return {
    contract: "kandev-highlight-sensitive-scan-v1",
    passed: true,
    coverage: { ...metadataOnlyCoverage },
    findings: [],
    ...overrides,
  };
}

test("sensitive-scan results require the exact versioned contract", () => {
  assert.throws(
    () =>
      validateSensitiveScanResult({
        contract: "unversioned",
        passed: true,
        coverage: metadataOnlyCoverage,
        findings: [],
      }),
    /contract.*kandev-highlight-sensitive-scan-v1/i,
  );
});

test("sensitive-scan results require an exact boolean coverage declaration", () => {
  const missing = { ...metadataOnlyCoverage };
  delete missing.runtimeLogs;
  assert.throws(
    () => validateSensitiveScanResult(validResult({ coverage: missing })),
    /coverage.*runtimeLogs/i,
  );
  assert.throws(
    () =>
      validateSensitiveScanResult(
        validResult({
          coverage: { ...metadataOnlyCoverage, screenshots: true },
        }),
      ),
    /coverage.*screenshots.*not allowed/i,
  );
  assert.throws(
    () =>
      validateSensitiveScanResult(
        validResult({
          coverage: { ...metadataOnlyCoverage, browserConsole: "yes" },
        }),
      ),
    /coverage.*browserConsole.*boolean/i,
  );
  assert.throws(
    () =>
      validateSensitiveScanResult(validResult(), {
        expectedCoverage: { ...metadataOnlyCoverage, visibleDomText: true },
      }),
    /coverage.*visibleDomText.*declared true.*reported false/i,
  );
});

test("sensitive-scan findings are strict redacted records", () => {
  const finding = {
    ruleId: "access-token",
    source: "metadata",
    occurrences: 1,
    redacted: true,
  };
  assert.doesNotThrow(() =>
    validateSensitiveScanResult(
      validResult({ passed: false, findings: [finding] }),
    ),
  );
  assert.throws(
    () =>
      validateSensitiveScanResult(
        validResult({
          passed: false,
          findings: [{ ...finding, value: "sk-do-not-leak-this-value" }],
        }),
      ),
    /finding 0.*value.*not allowed/i,
  );
  assert.throws(
    () =>
      validateSensitiveScanResult(
        validResult({
          passed: false,
          findings: [{ ...finding, redacted: false }],
        }),
      ),
    /finding 0.*redacted.*true/i,
  );
  assert.throws(
    () =>
      validateSensitiveScanResult(
        validResult({
          passed: false,
          findings: [{ ...finding, source: "runtimeLogs" }],
        }),
      ),
    /finding 0.*source.*not covered/i,
  );
});

test("sensitive-scan passed state exactly matches whether findings are empty", () => {
  assert.throws(
    () => validateSensitiveScanResult(validResult({ passed: false })),
    /passed.*findings/i,
  );
  assert.throws(
    () =>
      validateSensitiveScanResult(
        validResult({
          findings: [
            {
              ruleId: "private-key",
              source: "metadata",
              occurrences: 1,
              redacted: true,
            },
          ],
        }),
      ),
    /passed.*findings/i,
  );
});

test("sensitive-scan results reject unknown top-level fields", () => {
  assert.throws(
    () => validateSensitiveScanResult(validResult({ rawMatches: ["secret"] })),
    /rawMatches.*not allowed/i,
  );
});

test("default scanner covers metadata only and emits no matched secret values", async () => {
  assert.equal(typeof sensitiveScan.defaultSensitiveScanner, "function");
  const secret = "sk-sensitive-value-1234567890";
  const result = await sensitiveScan.defaultSensitiveScanner({
    scenario: { id: "safe-contract", title: secret },
    camera: { keyframes: [] },
    artifacts: [],
    generatedProofEvidence: [],
  });

  assert.deepEqual(result.coverage, metadataOnlyCoverage);
  assert.equal(result.passed, false);
  assert.deepEqual(result.findings, [
    {
      ruleId: "access-token",
      source: "metadata",
      occurrences: 1,
      redacted: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  assert.doesNotThrow(() =>
    validateSensitiveScanResult(result, {
      expectedCoverage: metadataOnlyCoverage,
    }),
  );
});

test("default metadata scan does not confuse external QA storage paths with captured content", async () => {
  const result = await sensitiveScan.defaultSensitiveScanner({
    scenario: { id: "safe-storage-path" },
    camera: { keyframes: [] },
    artifacts: [{ path: "/home/capture-agent/highlights/demo.mp4" }],
    generatedProofEvidence: [
      {
        artifactPath: "/home/capture-agent/highlights/demo.mp4",
        keyframes: [{ path: "/home/capture-agent/highlights/qa/frame.png" }],
        contactSheet: { path: "/home/capture-agent/highlights/qa/contact.png" },
      },
    ],
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
});

test("trusted scanner builder requires and reports exact text evidence coverage", async () => {
  assert.equal(typeof sensitiveScan.createTrustedSensitiveScanner, "function");
  const scanner = sensitiveScan.createTrustedSensitiveScanner({
    requiredCoverage: [
      "metadata",
      "visibleDomText",
      "browserConsole",
      "runtimeLogs",
    ],
  });
  await assert.rejects(
    scanner({
      scenario: { id: "missing-evidence" },
      camera: {},
      artifacts: [],
      generatedProofEvidence: [],
    }),
    /visibleDomText evidence is required/i,
  );

  const result = await scanner({
    scenario: { id: "complete-evidence" },
    camera: {},
    artifacts: [],
    generatedProofEvidence: [],
    captureEvidence: {
      visibleDomText: [],
      browserConsole: [],
      truncated: { visibleDomText: false, browserConsole: false },
    },
    runtimeEvidence: { logs: [] },
  });
  assert.deepEqual(result.coverage, {
    metadata: true,
    visibleDomText: true,
    browserConsole: true,
    runtimeLogs: true,
    renderedPixelOcr: false,
  });
  assert.deepEqual(
    sensitiveScan.getTrustedSensitiveScannerCoverage(scanner),
    result.coverage,
  );
});

test("trusted scanner refuses coverage for truncated capture evidence", async () => {
  const scanner = sensitiveScan.createTrustedSensitiveScanner({
    requiredCoverage: ["metadata", "visibleDomText", "browserConsole"],
  });
  for (const source of ["visibleDomText", "browserConsole"]) {
    await assert.rejects(
      scanner({
        scenario: { id: `truncated-${source}` },
        camera: {},
        artifacts: [],
        generatedProofEvidence: [],
        captureEvidence: {
          visibleDomText: ["Safe bounded prefix"],
          browserConsole: [],
          truncated: {
            visibleDomText: source === "visibleDomText",
            browserConsole: source === "browserConsole",
          },
        },
      }),
      new RegExp(`${source}.*(?:truncated|incomplete)|(?:truncated|incomplete).*${source}`, "i"),
    );
  }
});

test("trusted custom scanner may explicitly require generated proof OCR coverage", async () => {
  assert.equal(typeof sensitiveScan.createTrustedSensitiveScanner, "function");
  let hookInput;
  const scanner = sensitiveScan.createTrustedSensitiveScanner({
    requiredCoverage: ["metadata", "renderedPixelOcr"],
    scan: async (input) => {
      hookInput = input;
      return [];
    },
  });
  const generatedProofEvidence = [
    {
      artifactPath: "/stage/demo.mp4",
      keyframes: [
        {
          frame: 0,
          path: "/stage/qa/keyframe.png",
          bytes: 100,
          sha256: "a".repeat(64),
        },
      ],
      contactSheet: {
        path: "/stage/qa/contact.png",
        bytes: 100,
        sha256: "b".repeat(64),
      },
    },
  ];
  const result = await scanner({
    scenario: { id: "ocr-ready" },
    camera: {},
    artifacts: [],
    generatedProofEvidence,
  });

  assert.equal(result.coverage.renderedPixelOcr, true);
  assert.equal(hookInput.generatedProofEvidence, generatedProofEvidence);
  assert.doesNotThrow(() =>
    validateSensitiveScanResult(result, {
      expectedCoverage:
        sensitiveScan.getTrustedSensitiveScannerCoverage(scanner),
    }),
  );
});

test("trusted custom hooks add findings without replacing mandatory built-in rules", async () => {
  const secret = "sk-custom-hook-cannot-hide-1234567890";
  const scanner = sensitiveScan.createTrustedSensitiveScanner({
    requiredCoverage: ["metadata"],
    scan: async () => [],
  });

  const result = await scanner({
    scenario: { id: "custom-hook-union", title: secret },
    camera: {},
    artifacts: [],
    generatedProofEvidence: [],
  });

  assert.equal(result.passed, false);
  assert.deepEqual(result.findings, [
    {
      ruleId: "access-token",
      source: "metadata",
      occurrences: 1,
      redacted: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});
