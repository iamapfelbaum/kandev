export const SENSITIVE_SCAN_CONTRACT = "kandev-highlight-sensitive-scan-v1";

export const SENSITIVE_SCAN_COVERAGE_KEYS = Object.freeze([
  "metadata",
  "visibleDomText",
  "browserConsole",
  "runtimeLogs",
  "renderedPixelOcr",
]);

const RESULT_KEYS = Object.freeze([
  "contract",
  "passed",
  "coverage",
  "findings",
]);
const FINDING_KEYS = Object.freeze([
  "ruleId",
  "source",
  "occurrences",
  "redacted",
]);
const trustedScannerCoverage = new WeakMap();
const TEXT_EVIDENCE_PATHS = Object.freeze({
  visibleDomText: ["captureEvidence", "visibleDomText"],
  browserConsole: ["captureEvidence", "browserConsole"],
  runtimeLogs: ["runtimeEvidence", "logs"],
});
const BUILT_IN_RULES = Object.freeze([
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi],
  [
    "access-token",
    /\b(?:ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,})\b/g,
  ],
  ["host-home", /\/(?:home|Users)\/[A-Za-z0-9._-]+\//g],
  ["localhost", /\b(?:localhost|127\.0\.0\.1)(?::\d+)?\b/gi],
]);

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, label) {
  requireRecord(value, label);
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key))
      throw new Error(`${label} ${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!expectedKeys.includes(key))
      throw new Error(`${label} ${key} is not allowed`);
  }
}

function validateCoverage(coverage, label = "sensitive-scan coverage") {
  requireExactKeys(coverage, SENSITIVE_SCAN_COVERAGE_KEYS, label);
  for (const key of SENSITIVE_SCAN_COVERAGE_KEYS) {
    if (typeof coverage[key] !== "boolean")
      throw new Error(`${label} ${key} must be boolean`);
  }
  if (!coverage.metadata) throw new Error(`${label} metadata must be true`);
  return coverage;
}

function validateFinding(finding, index, coverage) {
  const label = `sensitive-scan finding ${index}`;
  requireExactKeys(finding, FINDING_KEYS, label);
  if (
    typeof finding.ruleId !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(finding.ruleId)
  ) {
    throw new Error(`${label} ruleId must be a redacted rule slug`);
  }
  if (
    !SENSITIVE_SCAN_COVERAGE_KEYS.includes(finding.source) ||
    !coverage[finding.source]
  ) {
    throw new Error(`${label} source is not covered`);
  }
  if (!Number.isInteger(finding.occurrences) || finding.occurrences <= 0) {
    throw new Error(`${label} occurrences must be a positive integer`);
  }
  if (finding.redacted !== true)
    throw new Error(`${label} redacted must be true`);
}

export function validateSensitiveScanResult(result, { expectedCoverage } = {}) {
  requireExactKeys(result, RESULT_KEYS, "sensitive-scan result");
  if (result?.contract !== SENSITIVE_SCAN_CONTRACT) {
    throw new Error(
      `sensitive-scan contract must be ${SENSITIVE_SCAN_CONTRACT}`,
    );
  }
  if (typeof result.passed !== "boolean")
    throw new Error("sensitive-scan passed must be boolean");
  const coverage = validateCoverage(result.coverage);
  if (expectedCoverage !== undefined) {
    validateCoverage(expectedCoverage, "declared sensitive-scan coverage");
    for (const key of SENSITIVE_SCAN_COVERAGE_KEYS) {
      if (coverage[key] !== expectedCoverage[key]) {
        throw new Error(
          `sensitive-scan coverage ${key} declared ${expectedCoverage[key]} but reported ${coverage[key]}`,
        );
      }
    }
  }
  if (!Array.isArray(result.findings))
    throw new Error("sensitive-scan findings must be an array");
  result.findings.forEach((finding, index) =>
    validateFinding(finding, index, coverage),
  );
  if (result.passed !== (result.findings.length === 0)) {
    throw new Error(
      "sensitive-scan passed must exactly match whether findings are empty",
    );
  }
  return result;
}

function buildCoverage(requiredCoverage) {
  if (!Array.isArray(requiredCoverage)) {
    throw new Error(
      "trusted sensitive-scanner requiredCoverage must be an array",
    );
  }
  const requested = new Set(["metadata"]);
  for (const [index, key] of requiredCoverage.entries()) {
    if (!SENSITIVE_SCAN_COVERAGE_KEYS.includes(key)) {
      throw new Error(
        `trusted sensitive-scanner requiredCoverage ${index} is unsupported`,
      );
    }
    if (requested.has(key) && key !== "metadata") {
      throw new Error(
        `trusted sensitive-scanner requiredCoverage duplicates ${key}`,
      );
    }
    requested.add(key);
  }
  return Object.freeze(
    Object.fromEntries(
      SENSITIVE_SCAN_COVERAGE_KEYS.map((key) => [key, requested.has(key)]),
    ),
  );
}

function valueAt(input, pathParts) {
  return pathParts.reduce((value, key) => value?.[key], input);
}

function requireEvidence(input, coverage, hasCustomScanner) {
  for (const [key, pathParts] of Object.entries(TEXT_EVIDENCE_PATHS)) {
    if (!coverage[key]) continue;
    const evidence = valueAt(input, pathParts);
    if (!Array.isArray(evidence))
      throw new Error(`${key} evidence is required as an array`);
  }
  if (coverage.renderedPixelOcr) {
    if (!hasCustomScanner) {
      throw new Error(
        "renderedPixelOcr coverage requires a trusted custom scanner",
      );
    }
    const proofs = input?.generatedProofEvidence;
    if (
      !Array.isArray(proofs) ||
      !proofs.some(
        (proof) =>
          Array.isArray(proof?.keyframes) &&
          proof.keyframes.length > 0 &&
          proof.contactSheet,
      )
    ) {
      throw new Error(
        "renderedPixelOcr evidence requires generated keyframes and a contact sheet",
      );
    }
  }
}

function jsonText(value, label) {
  try {
    const text = JSON.stringify(value ?? null);
    if (typeof text !== "string") throw new Error("not JSON data");
    return text;
  } catch {
    throw new Error(
      `${label} must be JSON-serializable for sensitive scanning`,
    );
  }
}

function builtInSources(input, coverage) {
  const sources = [
    [
      "metadata",
      jsonText(
        {
          scenario: input?.scenario,
          camera: input?.camera,
        },
        "metadata evidence",
      ),
    ],
  ];
  for (const [source, pathParts] of Object.entries(TEXT_EVIDENCE_PATHS)) {
    if (coverage[source])
      sources.push([
        source,
        jsonText(valueAt(input, pathParts), `${source} evidence`),
      ]);
  }
  return sources;
}

function scanBuiltIn(input, coverage) {
  const findings = [];
  for (const [source, text] of builtInSources(input, coverage)) {
    for (const [ruleId, expression] of BUILT_IN_RULES) {
      const occurrences = [...text.matchAll(expression)].length;
      if (occurrences > 0)
        findings.push({ ruleId, source, occurrences, redacted: true });
    }
  }
  return findings;
}

export function createTrustedSensitiveScanner({
  requiredCoverage = ["metadata"],
  scan,
} = {}) {
  if (scan !== undefined && typeof scan !== "function") {
    throw new Error("trusted sensitive-scanner scan hook must be a function");
  }
  const coverage = buildCoverage(requiredCoverage);
  if (coverage.renderedPixelOcr && typeof scan !== "function") {
    throw new Error(
      "renderedPixelOcr coverage requires a trusted custom scanner",
    );
  }
  const scanner = async (input) => {
    requireEvidence(input, coverage, typeof scan === "function");
    const findings =
      typeof scan === "function"
        ? await scan(input)
        : scanBuiltIn(input, coverage);
    if (!Array.isArray(findings))
      throw new Error(
        "trusted sensitive-scanner hook must return a findings array",
      );
    return validateSensitiveScanResult(
      {
        contract: SENSITIVE_SCAN_CONTRACT,
        passed: findings.length === 0,
        coverage: { ...coverage },
        findings,
      },
      { expectedCoverage: coverage },
    );
  };
  trustedScannerCoverage.set(scanner, coverage);
  return scanner;
}

export function getTrustedSensitiveScannerCoverage(scanner) {
  const coverage = trustedScannerCoverage.get(scanner);
  return coverage ? { ...coverage } : null;
}

export const defaultSensitiveScanner = createTrustedSensitiveScanner();
