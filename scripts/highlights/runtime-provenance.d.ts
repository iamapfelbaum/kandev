export interface SensitiveScanCoverage {
  metadata: boolean;
  visibleDomText: boolean;
  browserConsole: boolean;
  runtimeLogs: boolean;
  renderedPixelOcr: boolean;
}

export interface RuntimeProvenanceV1 {
  contract: "kandev-highlight-runtime-provenance-v1";
  runtimeId: string;
  receiptDigest: string;
  buildManifestDigest: string;
  captureEvidenceDigest: string;
  runtimeLogDigest: string;
  source: {
    mode: "pr_head" | "current_main";
    selectedSha: string;
  };
  scanner: {
    contract: "kandev-highlight-sensitive-scan-v1";
    coverage: SensitiveScanCoverage;
  };
}

export interface CompactRuntimeProvenanceV1 {
  contract: "kandev-highlight-runtime-provenance-v1";
  runtime_id: string;
  receipt_digest: string;
  build_manifest_digest: string;
  capture_evidence_digest: string;
  runtime_log_digest: string;
  source: {
    mode: "pr_head" | "current_main";
    selected_sha: string;
  };
  scanner: RuntimeProvenanceV1["scanner"];
}

export interface RuntimeIdentityExpectation {
  sourceMode?: "pr_head" | "current_main";
  sourceSha?: string;
  buildManifestDigest?: string;
}

export const RUNTIME_PROVENANCE_CONTRACT: "kandev-highlight-runtime-provenance-v1";
export function validateRuntimeProvenance(
  provenance: unknown,
  expected?: RuntimeIdentityExpectation,
): RuntimeProvenanceV1;
export function compactRuntimeProvenance(
  provenance: RuntimeProvenanceV1,
): CompactRuntimeProvenanceV1;
export function validateCompactRuntimeProvenance(
  provenance: unknown,
  expected?: RuntimeIdentityExpectation,
): CompactRuntimeProvenanceV1;
export function sameRuntimePolicy(left: RuntimeProvenanceV1, right: RuntimeProvenanceV1): boolean;
