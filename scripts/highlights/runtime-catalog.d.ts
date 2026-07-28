import type { HighlightScenarioV1, JsonValue } from "./scenario.mjs";

export type HighlightRuntimeId = "kandev-isolated-e2e";
export type HighlightRuntimeProfile = "desktop" | "native-mobile";

export interface HighlightRuntimeScannerCoverage {
  readonly metadata: true;
  readonly visibleDomText: true;
  readonly browserConsole: true;
  readonly runtimeLogs: false;
  readonly renderedPixelOcr: false;
}

export interface HighlightRuntimeDescriptor {
  readonly contract: "kandev-highlight-runtime-v1";
  readonly version: 1;
  readonly id: HighlightRuntimeId;
  readonly host: "playwright-isolated-e2e";
  readonly profiles: readonly HighlightRuntimeProfile[];
  readonly seedRecipes: readonly {
    readonly id: "kandev.highlight.quick-start" | "kandev.highlight.quick-chat";
    readonly parameterKeys: readonly [];
  }[];
  readonly routes: readonly ["workspace.board"];
  readonly primitiveIds: readonly [];
  readonly scannerCoverage: HighlightRuntimeScannerCoverage;
  readonly scenarioTemplate: "scripts/highlights/examples/quick-start.scenario.json";
}

export interface HighlightRuntimePreflight {
  contract: "kandev-highlight-runtime-preflight-v1";
  runtimeId: HighlightRuntimeId;
  profile: HighlightRuntimeProfile;
  seedRecipe: "kandev.highlight.quick-start" | "kandev.highlight.quick-chat";
  route: "workspace.board";
  primitiveIds: string[];
  scannerCoverage: HighlightRuntimeScannerCoverage;
}

export const BUILTIN_HIGHLIGHT_RUNTIME_ID: HighlightRuntimeId;
export function listHighlightRuntimeIds(): HighlightRuntimeId[];
export function resolveHighlightRuntime(runtimeId: string): HighlightRuntimeDescriptor;
export function preflightHighlightRuntime(options: {
  runtimeId: string;
  scenario: HighlightScenarioV1 | Record<string, JsonValue>;
}): HighlightRuntimePreflight;
