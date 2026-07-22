import { createHash } from "node:crypto";

import { resolveHighlightRuntime } from "./runtime-catalog.mjs";
import { SENSITIVE_SCAN_CONTRACT, validateSensitiveScanResult } from "./sensitive-scan.mjs";

export const RUNTIME_PROVENANCE_CONTRACT = "kandev-highlight-runtime-provenance-v1";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const BUILD_OUTPUT_KEYS = Object.freeze(["backend", "mockAgent", "webDist"]);
const RUNTIME_KEYS = Object.freeze([
  "contract",
  "runtimeId",
  "receiptDigest",
  "buildManifestDigest",
  "buildContentDigest",
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
  "build_content_digest",
  "capture_evidence_digest",
  "runtime_log_digest",
  "source",
  "scanner",
]);

export function validateRuntimeProvenance(
  provenance,
  { sourceMode, sourceSha, buildManifestDigest, buildContentDigest } = {},
) {
  requireExactKeys(provenance, RUNTIME_KEYS, "runtime provenance");
  if (provenance.contract !== RUNTIME_PROVENANCE_CONTRACT) {
    throw new Error(`runtime provenance contract must be ${RUNTIME_PROVENANCE_CONTRACT}`);
  }
  const runtime = resolveHighlightRuntime(provenance.runtimeId);
  for (const field of [
    "receiptDigest",
    "buildManifestDigest",
    "buildContentDigest",
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
    (buildManifestDigest !== undefined && provenance.buildManifestDigest !== buildManifestDigest) ||
    (buildContentDigest !== undefined && provenance.buildContentDigest !== buildContentDigest)
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
    build_content_digest: provenance.buildContentDigest,
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
  { sourceMode, sourceSha, buildManifestDigest, buildContentDigest } = {},
) {
  requireExactKeys(provenance, COMPACT_RUNTIME_KEYS, "compact runtime provenance");
  requireExactKeys(provenance.source, ["mode", "selected_sha"], "compact runtime source");
  validateRuntimeProvenance(
    {
      contract: provenance.contract,
      runtimeId: provenance.runtime_id,
      receiptDigest: provenance.receipt_digest,
      buildManifestDigest: provenance.build_manifest_digest,
      buildContentDigest: provenance.build_content_digest,
      captureEvidenceDigest: provenance.capture_evidence_digest,
      runtimeLogDigest: provenance.runtime_log_digest,
      source: {
        mode: provenance.source.mode,
        selectedSha: provenance.source.selected_sha,
      },
      scanner: provenance.scanner,
    },
    { sourceMode, sourceSha, buildManifestDigest, buildContentDigest },
  );
  return provenance;
}

export function sameRuntimePolicy(left, right) {
  validateRuntimeProvenance(left);
  validateRuntimeProvenance(right);
  return (
    left.runtimeId === right.runtimeId &&
    left.buildContentDigest === right.buildContentDigest &&
    canonicalJson(left.source) === canonicalJson(right.source) &&
    canonicalJson(left.scanner) === canonicalJson(right.scanner)
  );
}

export function computeBuildContentDigest(value) {
  requireExactKeys(value, ["sourceSha", "outputs"], "build content identity");
  if (!SHA_PATTERN.test(value.sourceSha ?? "")) {
    throw new Error("build content identity sourceSha must be an exact Git SHA");
  }
  requireExactKeys(value.outputs, BUILD_OUTPUT_KEYS, "build content outputs");
  const outputs = {};
  for (const key of BUILD_OUTPUT_KEYS) {
    const output = value.outputs[key];
    const expectedKeys =
      key === "webDist"
        ? ["digest", "bytes", "fileCount"]
        : ["digest", "bytes"];
    requireExactKeys(output, expectedKeys, `build content ${key}`);
    if (
      !DIGEST_PATTERN.test(output.digest ?? "") ||
      !Number.isInteger(output.bytes) ||
      output.bytes <= 0 ||
      (key === "webDist" &&
        (!Number.isInteger(output.fileCount) || output.fileCount <= 0))
    ) {
      throw new Error(`build content ${key} identity is invalid`);
    }
    outputs[key] = {
      digest: output.digest,
      bytes: output.bytes,
      ...(key === "webDist" ? { fileCount: output.fileCount } : {}),
    };
  }
  return `sha256:${createHash("sha256")
    .update(canonicalJson({ sourceSha: value.sourceSha, outputs }))
    .digest("hex")}`;
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
