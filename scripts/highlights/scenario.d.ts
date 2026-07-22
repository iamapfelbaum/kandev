export type ScenarioProfile =
  | { kind: "desktop"; viewport: { width: 1920; height: 1200 }; deviceScaleFactor: 2 }
  | { kind: "native-mobile"; viewport: { width: 430; height: 932 }; deviceScaleFactor: 3 };

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

export type ClickAction = ActionBase & { kind: "click"; target: StableTarget; button?: "left" | "middle" | "right"; clickCount?: number; cursorDurationMs?: number };
export type NativeMobileClickAction = ActionBase & { kind: "click"; target: StableTarget; button?: "left"; clickCount?: 1; cursorDurationMs?: number };
export type TypeAction = ActionBase & { kind: "type"; target: StableTarget; text: string; clear?: boolean; keystrokeDelayMs?: number; cursorDurationMs?: number };
export type PressAction = ActionBase & { kind: "press"; target: StableTarget; key: string };
export type HoverAction = ActionBase & { kind: "hover"; target: StableTarget; durationMs?: number };
export type MoveCursorAction = ActionBase & { kind: "moveCursor"; target: StableTarget; durationMs?: number; easing?: CameraEasing };
export type WaitForVisibleAction = ActionBase & { kind: "waitForVisible"; target: StableTarget; timeoutMs?: number };
export type WaitForStateAction = ActionBase & { kind: "waitForState"; target: StableTarget; state: WaitState; timeoutMs?: number };
export type DragAction = ActionBase & { kind: "drag"; from: StableTarget; to: StableTarget; approachDurationMs?: number; durationMs?: number };
export type PauseAction = { kind: "pause"; durationMs: number; label?: string };
export type CameraFocusAction = ActionBase & { kind: "cameraFocus"; target: StableTarget; durationMs?: number };
export type CameraZoomAction = ActionBase & { kind: "cameraZoom"; zoom: number; durationMs?: number };
export type CameraHoldAction = { kind: "cameraHold"; durationMs: number; label?: string };
export type CameraReturnAction = ActionBase & { kind: "cameraReturn"; durationMs?: number };
export type ExtensionAction = ActionBase & { kind: "extension"; primitiveId: string; input?: Record<string, JsonValue>; durationMs?: number };

export type ScenarioAction =
  | ClickAction
  | TypeAction
  | PressAction
  | HoverAction
  | MoveCursorAction
  | WaitForVisibleAction
  | WaitForStateAction
  | DragAction
  | PauseAction
  | CameraFocusAction
  | CameraZoomAction
  | CameraHoldAction
  | CameraReturnAction
  | ExtensionAction;

export type NativeMobileScenarioAction =
  | NativeMobileClickAction
  | TypeAction
  | PressAction
  | MoveCursorAction
  | WaitForVisibleAction
  | WaitForStateAction
  | DragAction
  | PauseAction
  | CameraFocusAction
  | CameraZoomAction
  | CameraHoldAction
  | CameraReturnAction
  | ExtensionAction;

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

export interface DeliveryMetadata {
  revision: string;
  releaseVersion: string;
  summary: string;
  caption: string;
  featureFlags: string[];
  docs: { page: string; section: string };
  mobileDeclaration: string;
  mobileRequired?: boolean;
}

export interface RequiredDeliveryMetadata {
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
    mobileRequired: boolean;
  };
}

interface HighlightScenarioBase<TProfile extends ScenarioProfile, TAction extends ScenarioAction> {
  $schema?: string;
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string;
  profile: TProfile;
  seed: { recipe: string; parameters?: Record<string, JsonValue> };
  setup: {
    route?: string;
    primitives: Array<{ primitiveId: string; input?: Record<string, JsonValue> }>;
  };
  story: {
    recipe?: string;
    openingSettleMs: number;
    actions: TAction[];
    endingSettleMs: number;
  };
  camera?: CameraContract;
  delivery?: DeliveryMetadata;
}

export type HighlightScenarioV1 =
  | HighlightScenarioBase<Extract<ScenarioProfile, { kind: "desktop" }>, ScenarioAction>
  | HighlightScenarioBase<Extract<ScenarioProfile, { kind: "native-mobile" }>, NativeMobileScenarioAction>;

export interface ScenarioValidationIssue { pointer: string; message: string }
export interface ScenarioValidationResult { ok: boolean; errors: ScenarioValidationIssue[] }
export interface ScenarioOptions { allowedExtensionIds?: Iterable<string>; filePath?: string }

export const SCENARIO_SCHEMA_VERSION: 1;
export const SCENARIO_SCHEMA_ID: string;
export const MAX_STORY_DURATION_MS: number;
export type ScenarioTemplateId = "quick-start";
export const SCENARIO_TEMPLATE_IDS: readonly ScenarioTemplateId[];
export type ScenarioScaffoldOptions =
  | { destination: string; templateId: ScenarioTemplateId; id?: never; title?: never; profileKind?: never; dryRun?: boolean }
  | { destination: string; templateId?: never; id: string; title?: string; profileKind?: "desktop" | "native-mobile"; dryRun?: boolean };
export function validateScenario(scenario: unknown, options?: ScenarioOptions): ScenarioValidationResult;
export function assertValidScenario(scenario: unknown, options?: ScenarioOptions): HighlightScenarioV1;
export function readScenario(filePath: string, options?: ScenarioOptions): Promise<HighlightScenarioV1>;
export function readScenarioTemplate(templateId: ScenarioTemplateId): Promise<HighlightScenarioV1>;
export function canonicalScenarioJson(scenario: HighlightScenarioV1, options?: ScenarioOptions): string;
export function computeScenarioDigest(scenario: HighlightScenarioV1, options?: ScenarioOptions): string;
export function requireDeliveryMetadata(scenario: HighlightScenarioV1, options?: ScenarioOptions): RequiredDeliveryMetadata;
export function compileTimeline(scenario: HighlightScenarioV1, options?: ScenarioOptions): object;
export function renderStoryboard(timeline: object, options?: { format?: "json" | "markdown" }): string;
export function createScenarioScaffold(options: { id: string; title?: string; profileKind?: "desktop" | "native-mobile" }): HighlightScenarioV1;
export function writeScenarioScaffold(options: ScenarioScaffoldOptions): Promise<{ destination: string; dryRun: boolean; scenario: HighlightScenarioV1; contents: string }>;
