export type TrustedHighlightRuntimeCommand = "capture" | "run";

export interface TrustedHighlightCommandOptions {
  command: TrustedHighlightRuntimeCommand;
  scenarioPath: string;
  artifactRoot: string;
  source: "pr_head" | "current_main";
  repoRoot?: string;
  landingRoot?: string;
  runId?: string;
  runtimeId?: string;
  prNumber?: number;
  prBaseSha?: string;
  allowedExtensionIds?: string[];
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  dependencies?: Record<string, unknown>;
}

export interface TrustedHighlightCommandResult {
  contract: "kandev-highlight-runtime-command-v1";
  command: TrustedHighlightRuntimeCommand;
  runtimeId: string;
  runId: string;
  order: string[];
  host: {
    contract: string;
    resultPath: string;
    resultDigest: string;
    receiptPath: string;
    receiptDigest: string;
  };
  phases: Record<string, object>;
}

export interface TrustedHighlightDryRun {
  contract: "kandev-highlight-runtime-dry-run-v1";
  command: TrustedHighlightRuntimeCommand;
  dryRun: true;
  zeroWrites: true;
  runId: string;
  order: string[];
  paths: Record<string, string>;
  [key: string]: unknown;
}

export function runTrustedHighlightCommand(
  options: TrustedHighlightCommandOptions,
): Promise<TrustedHighlightCommandResult | TrustedHighlightDryRun>;
