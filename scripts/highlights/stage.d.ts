import type { HighlightScenarioV1, ScenarioOptions } from "./scenario.mjs";

export interface StageFileRecord {
  path: string;
  bytes: number;
  sha256: string;
}

export interface StageMediaRecord extends StageFileRecord {
  codec: "vp9" | "h264" | "webp";
  width: number;
  height: number;
  fps: 25 | null;
  duration: number | null;
  audio: false;
}

export interface HighlightRuntimeProvenanceV1 {
  contract: "kandev-highlight-runtime-provenance-v1";
  runtimeId: string;
  receiptDigest: string;
  buildManifestDigest: string;
  buildContentDigest: string;
  captureEvidenceDigest: string;
  runtimeLogDigest: string;
  source: { mode: "pr_head" | "current_main"; selectedSha: string };
  scanner: {
    contract: "kandev-highlight-sensitive-scan-v1";
    coverage: {
      metadata: boolean;
      visibleDomText: boolean;
      browserConsole: boolean;
      runtimeLogs: boolean;
      renderedPixelOcr: boolean;
    };
  };
}

export interface HighlightStageManifestV1 {
  schemaVersion: 1;
  stageDigest: string;
  revision: string;
  highlight: {
    id: string;
    title: string;
    summary: string;
    caption: string;
    releaseVersion: string;
    featureFlags: string[];
    docs: { page: string; section: string };
    mobileDeclaration: string;
  };
  scenario: { path: string; digest: string };
  capture: { path: string; digest: string };
  qa: {
    status: "accepted" | "pending" | "rejected";
    reportPath: string;
    reportDigest: string;
    acceptedAt: string;
  };
  provenance: {
    captureMode: "pr_head" | "current_main";
    sourceSha: string;
    capturedAt: string;
    seedId: string;
    seedDigest: string;
    toolVersion: string;
    landingAdapter: { sourceSha: string; contractVersion: string };
    prNumber?: number;
    prBaseSha?: string;
    prHeadSha?: string;
    sourceRef?: "origin/main";
  };
  assets: {
    desktop: { webm: StageMediaRecord; mp4: StageMediaRecord; poster: StageMediaRecord };
    mobile?: { webm: StageMediaRecord; mp4: StageMediaRecord; poster: StageMediaRecord };
  };
}

export interface HighlightReviewManifestV2 {
  contract: "kandev-highlight-review-stage-v2";
  schemaVersion: 2;
  stageDigest: string;
  revision: string;
  highlight: HighlightStageManifestV1["highlight"] & { mobileRequired?: boolean };
  scenario: { path: string; digest: string };
  capture: { path: string; digest: string };
  qa: {
    status: "technical_pass";
    passed: true;
    reportPath: string;
    reportDigest: string;
    completedAt: string;
  };
  provenance: HighlightStageManifestV1["provenance"] & {
    runtime: HighlightRuntimeProvenanceV1;
  };
  profile: "desktop" | "native-mobile";
  promotable: false;
  readyForReview: true;
  reason: "explicit-acceptance-required" | "desktop-stage-required";
  assets: {
    desktop?: { webm: StageMediaRecord; mp4: StageMediaRecord; poster: StageMediaRecord };
    mobile?: { webm: StageMediaRecord; mp4: StageMediaRecord; poster: StageMediaRecord };
  };
}

export interface ReadStageOptions extends ScenarioOptions { repoRoot?: string }
export interface PromoteStageOptions extends ReadStageOptions {
  manifestPath: string;
  highlightsDir?: string;
  probe?: (filePath: string) => Promise<object>;
  now?: Date | string;
}
export interface PromoteReviewedOptions extends ReadStageOptions {
  desktopManifestPath: string;
  mobileManifestPath?: string;
  acceptedBy: string;
  highlightsDir?: string;
  probe?: (filePath: string) => Promise<object>;
  dryRun?: boolean;
  now?: Date | string;
}

export const STAGE_MANIFEST_VERSION: 1;
export const REVIEW_STAGE_VERSION: 2;
export const REVIEW_STAGE_CONTRACT: "kandev-highlight-review-stage-v2";
export function computeStageManifestDigest(manifest: Omit<HighlightStageManifestV1, "stageDigest"> | HighlightStageManifestV1 | Omit<HighlightReviewManifestV2, "stageDigest"> | HighlightReviewManifestV2): string;
export function readStageManifest(manifestPath: string, options?: ReadStageOptions): Promise<{
  manifest: HighlightStageManifestV1;
  stageDir: string;
  scenario: HighlightScenarioV1;
  scenarioPath: string;
  capturePath: string;
  reportPath: string;
  assets: object;
}>;
export function promoteStagedHighlight(options: PromoteStageOptions): Promise<{
  descriptor: object;
  destination: string;
  stageDigest: string;
  validation: object;
}>;
export function readReviewManifest(manifestPath: string, options?: ReadStageOptions): Promise<{
  manifest: HighlightReviewManifestV2;
  stageDir: string;
  scenario: HighlightScenarioV1;
  scenarioPath: string;
  capturePath: string;
  reportPath: string;
  assets: object;
  form: "desktop" | "mobile";
  mobileRequired: boolean;
}>;
export function promoteReviewedHighlight(options: PromoteReviewedOptions): Promise<{
  dryRun?: boolean;
  descriptor?: object;
  destination: string;
  stageDigest?: string;
  validation?: object;
  highlightId?: string;
  revision?: string;
  reviewDigests?: string[];
  acceptance?: { status: "accepted"; acceptedBy: string; acceptedAt: string };
}>;
