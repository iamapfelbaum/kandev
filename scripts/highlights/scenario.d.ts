export type ScenarioProfile =
  | { kind: "desktop"; viewport: Viewport; deviceScaleFactor: number }
  | { kind: "native-mobile"; viewport: Viewport; deviceScaleFactor: number };

export interface Viewport {
  width: number;
  height: number;
}

export type StableTarget =
  | { testId: string }
  | { role: string; name: string };

interface ActionBase {
  label?: string;
  settleMs?: number;
}

export type ScenarioAction =
  | (ActionBase & { kind: "click"; target: StableTarget; button?: "left" | "middle" | "right"; clickCount?: number; cursorDurationMs?: number })
  | (ActionBase & { kind: "type"; target: StableTarget; text: string; clear?: boolean; keystrokeDelayMs?: number; cursorDurationMs?: number })
  | (ActionBase & { kind: "press"; target: StableTarget; key: string })
  | (ActionBase & { kind: "hover"; target: StableTarget; durationMs?: number })
  | (ActionBase & { kind: "moveCursor"; target: StableTarget; durationMs?: number; easing?: CameraEasing })
  | (ActionBase & { kind: "waitForVisible"; target: StableTarget; timeoutMs?: number })
  | (ActionBase & { kind: "waitForState"; target: StableTarget; state: WaitState; timeoutMs?: number })
  | (ActionBase & { kind: "drag"; from: StableTarget; to: StableTarget; approachDurationMs?: number; durationMs?: number })
  | { kind: "pause"; durationMs: number; label?: string }
  | (ActionBase & { kind: "cameraFocus"; target: StableTarget; durationMs?: number })
  | (ActionBase & { kind: "cameraZoom"; zoom: number; durationMs?: number })
  | { kind: "cameraHold"; durationMs: number; label?: string }
  | (ActionBase & { kind: "cameraReturn"; durationMs?: number })
  | (ActionBase & { kind: "extension"; primitiveId: string; input?: Record<string, JsonValue>; durationMs?: number });

export type WaitState = "attached" | "detached" | "visible" | "hidden" | "enabled" | "disabled" | "checked" | "unchecked";
export type CameraEasing = "linear" | "easeInOutCubic" | "easeOutCubic";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CameraContract {
  minZoom: number;
  maxZoom: number;
  safeMarginPx: number;
  glyphPaddingPx: number;
  maxPanVelocityPxPerSecond: number;
  maxPanAccelerationPxPerSecond2: number;
  maxZoomRatePerSecond: number;
  easing: CameraEasing;
}

export interface HighlightScenarioV1 {
  $schema?: string;
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string;
  profile: ScenarioProfile;
  seed: { recipe: string; parameters?: Record<string, JsonValue> };
  setup: {
    route?: string;
    primitives: Array<{ primitiveId: string; input?: Record<string, JsonValue> }>;
  };
  story: {
    recipe?: string;
    openingSettleMs: number;
    actions: ScenarioAction[];
    endingSettleMs: number;
  };
  camera?: CameraContract;
}

export interface ScenarioValidationIssue { pointer: string; message: string }
export interface ScenarioValidationResult { ok: boolean; errors: ScenarioValidationIssue[] }
export interface ScenarioOptions { allowedExtensionIds?: Iterable<string>; filePath?: string }

export const SCENARIO_SCHEMA_VERSION: 1;
export const SCENARIO_SCHEMA_ID: string;
export const MAX_STORY_DURATION_MS: number;
export function validateScenario(scenario: unknown, options?: ScenarioOptions): ScenarioValidationResult;
export function assertValidScenario(scenario: unknown, options?: ScenarioOptions): HighlightScenarioV1;
export function readScenario(filePath: string, options?: ScenarioOptions): Promise<HighlightScenarioV1>;
export function canonicalScenarioJson(scenario: HighlightScenarioV1, options?: ScenarioOptions): string;
export function computeScenarioDigest(scenario: HighlightScenarioV1, options?: ScenarioOptions): string;
export function compileTimeline(scenario: HighlightScenarioV1, options?: ScenarioOptions): object;
export function renderStoryboard(timeline: object, options?: { format?: "json" | "markdown" }): string;
export function createScenarioScaffold(options: { id: string; title?: string; profileKind?: "desktop" | "native-mobile" }): HighlightScenarioV1;
export function writeScenarioScaffold(options: { destination: string; id: string; title?: string; profileKind?: "desktop" | "native-mobile"; dryRun?: boolean }): Promise<{ destination: string; dryRun: boolean; scenario: HighlightScenarioV1; contents: string }>;
