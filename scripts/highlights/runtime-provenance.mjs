import { resolveHighlightRuntime } from "./runtime-catalog.mjs";
import { SENSITIVE_SCAN_CONTRACT, validateSensitiveScanResult } from "./sensitive-scan.mjs";

export const RUNTIME_PROVENANCE_CONTRACT = "kandev-highlight-runtime-provenance-v1";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const RUNTIME_KEYS = Object.freeze([
  "contract",
  "runtimeId",
  "receiptDigest",
  "buildManifestDigest",
  "captureEvidenceDigest",
  "runtimeLogDigest",
  "source",
  "scanner",
]);
const COMPACT_RUNTIME_KEYS = Object.freeze([
  "contract",
  "runtime_id",
  "receipt_digest",
  "build_manifest_digest",
  "capture_evidence_digest",
  "runtime_log_digest",
  "source",
  "scanner",
]);

export function validateRuntimeProvenance(
  provenance,
  { sourceMode, sourceSha, buildManifestDigest } = {},
) {
  requireExactKeys(provenance, RUNTIME_KEYS, "runtime provenance");
  if (provenance.contract !== RUNTIME_PROVENANCE_CONTRACT) {
    throw new Error(`runtime provenance contract must be ${RUNTIME_PROVENANCE_CONTRACT}`);
  }
  const runtime = resolveHighlightRuntime(provenance.runtimeId);
  for (const field of [
    "receiptDigest",
    "buildManifestDigest",
    "captureEvidenceDigest",
    "runtimeLogDigest",
  ]) {
    if (!DIGEST_PATTERN.test(provenance[field] ?? "")) {
      throw new Error(`runtime provenance ${field} must be SHA-256`);
    }
  }
  requireExactKeys(provenance.source, ["mode", "selectedSha"], "runtime source");
  if (
    !["pr_head", "current_main"].includes(provenance.source.mode) ||
    !SHA_PATTERN.test(provenance.source.selectedSha ?? "")
  ) {
    throw new Error("runtime provenance source identity is invalid");
  }
  if (
    (sourceMode !== undefined && provenance.source.mode !== sourceMode) ||
    (sourceSha !== undefined && provenance.source.selectedSha !== sourceSha) ||
    (buildManifestDigest !== undefined && provenance.buildManifestDigest !== buildManifestDigest)
  ) {
    throw new Error("runtime provenance does not match source or build identity");
  }
  requireExactKeys(provenance.scanner, ["contract", "coverage"], "runtime scanner");
  if (provenance.scanner.contract !== SENSITIVE_SCAN_CONTRACT) {
    throw new Error(`runtime scanner contract must be ${SENSITIVE_SCAN_CONTRACT}`);
  }
  validateSensitiveScanResult(
    {
      contract: provenance.scanner.contract,
      passed: true,
      coverage: provenance.scanner.coverage,
      findings: [],
    },
    { expectedCoverage: runtime.scannerCoverage },
  );
  return provenance;
}

export function compactRuntimeProvenance(provenance) {
  validateRuntimeProvenance(provenance);
  return {
    contract: provenance.contract,
    runtime_id: provenance.runtimeId,
    receipt_digest: provenance.receiptDigest,
    build_manifest_digest: provenance.buildManifestDigest,
    capture_evidence_digest: provenance.captureEvidenceDigest,
    runtime_log_digest: provenance.runtimeLogDigest,
    source: {
      mode: provenance.source.mode,
      selected_sha: provenance.source.selectedSha,
    },
    scanner: structuredClone(provenance.scanner),
  };
}

export function validateCompactRuntimeProvenance(
  provenance,
  { sourceMode, sourceSha, buildManifestDigest } = {},
) {
  requireExactKeys(provenance, COMPACT_RUNTIME_KEYS, "compact runtime provenance");
  requireExactKeys(provenance.source, ["mode", "selected_sha"], "compact runtime source");
  validateRuntimeProvenance(
    {
      contract: provenance.contract,
      runtimeId: provenance.runtime_id,
      receiptDigest: provenance.receipt_digest,
      buildManifestDigest: provenance.build_manifest_digest,
      captureEvidenceDigest: provenance.capture_evidence_digest,
      runtimeLogDigest: provenance.runtime_log_digest,
      source: {
        mode: provenance.source.mode,
        selectedSha: provenance.source.selected_sha,
      },
      scanner: provenance.scanner,
    },
    { sourceMode, sourceSha, buildManifestDigest },
  );
  return provenance;
}

export function sameRuntimePolicy(left, right) {
  validateRuntimeProvenance(left);
  validateRuntimeProvenance(right);
  return (
    left.runtimeId === right.runtimeId &&
    left.buildManifestDigest === right.buildManifestDigest &&
    canonicalJson(left.source) === canonicalJson(right.source) &&
    canonicalJson(left.scanner) === canonicalJson(right.scanner)
  );
}

function requireExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} requires ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) {
      throw new Error(`${label} contains unknown property ${key}`);
    }
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
