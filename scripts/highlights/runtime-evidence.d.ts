import type { RuntimeProvenanceV1 } from "./runtime-provenance.mjs";

export interface VerifiedCaptureEvidence {
  visibleDomText: string[];
  browserConsole: Array<{
    type: string;
    text: string;
    digest: string;
  }>;
  truncated: {
    visibleDomText: false;
    browserConsole: false;
  };
}

export interface VerifiedRuntimeEvidence {
  contract: "kandev-highlight-runtime-evidence-v1";
  captureEvidence: VerifiedCaptureEvidence;
  /** Empty while the built-in runtime has no dedicated application-log channel. */
  runtimeEvidence: { logs: [] };
  provenance: RuntimeProvenanceV1;
}

export interface LoadRuntimeEvidenceOptions {
  artifactRoot: string;
  attemptRoot: string;
  scenarioId: string;
  scenarioPath: string;
  scenarioDigest: string;
  runId: string;
  captureReceipt: object;
}

export function loadVerifiedRuntimeEvidence(
  options: LoadRuntimeEvidenceOptions,
): Promise<VerifiedRuntimeEvidence>;
