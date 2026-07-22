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

export interface ReadStageOptions extends ScenarioOptions { repoRoot?: string }
export interface PromoteStageOptions extends ReadStageOptions {
  manifestPath: string;
  highlightsDir?: string;
  probe?: (filePath: string) => Promise<object>;
  now?: Date | string;
}

export const STAGE_MANIFEST_VERSION: 1;
export function computeStageManifestDigest(manifest: Omit<HighlightStageManifestV1, "stageDigest"> | HighlightStageManifestV1): string;
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
