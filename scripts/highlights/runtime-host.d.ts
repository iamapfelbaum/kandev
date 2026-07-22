export type HighlightSha256 = `sha256:${string}`;
export type HighlightSourceMode = "pr_head" | "current_main";
export type HighlightRuntimeId = "kandev-isolated-e2e";

export interface HighlightRuntimePullRequest {
  number: number;
  baseSha: string;
}

export interface HighlightRuntimeHostRequest {
  contract: "kandev-highlight-runtime-host-request-v1";
  version: 1;
  runtimeId: HighlightRuntimeId;
  scenarioPath: string;
  artifactRoot: string;
  repositoryRoot: string;
  buildManifestPath: string;
  source: HighlightSourceMode;
  runId: string;
  pullRequest: HighlightRuntimePullRequest | null;
}

export interface HighlightRuntimeSourceProof {
  contract: "kandev-highlight-source-v1";
  source: HighlightSourceMode;
  repoRoot: string;
  selectedSha: string;
  headSha: string;
  currentMainSha: string;
  clean: true;
  status: "";
}

export interface HighlightBuildOutputIdentity {
  digest: HighlightSha256;
  bytes: number;
  fileCount?: number;
}

export interface HighlightRuntimeBuildIdentity {
  contract: "kandev-highlight-build-provenance-v1";
  manifestDigest: HighlightSha256;
  sourceSha: string;
  outputs: {
    backend: HighlightBuildOutputIdentity;
    mockAgent: HighlightBuildOutputIdentity;
    webDist: HighlightBuildOutputIdentity & { fileCount: number };
  };
}

export interface HighlightRuntimeToolPaths {
  ffmpeg: string;
  xvfb: string;
  chromium: string;
  backend: string;
  mockAgent: string;
  webBuild: string;
}

export interface HighlightRuntimeWorkerRequest {
  contract: "kandev-highlight-runtime-worker-request-v1";
  version: 1;
  runtimeId: HighlightRuntimeId;
  scenarioPath: string;
  artifactRoot: string;
  repositoryRoot: string;
  buildManifestPath: string;
  source: HighlightSourceMode;
  runId: string;
  pullRequest: HighlightRuntimePullRequest | null;
  bundleRoot: string;
  workerTempRoot: string;
  sourceProof: HighlightRuntimeSourceProof;
  build: HighlightRuntimeBuildIdentity;
  tools: HighlightRuntimeToolPaths;
  chromiumSandbox: HighlightChromiumSandboxPolicy;
  ports: { offset: number; backend: number };
}

export interface HighlightChromiumSandboxPolicy {
  contract: "kandev-highlight-chromium-sandbox-policy-v1";
  version: 1;
  mode: "native" | "disabled";
  proof: {
    status: "available" | "unavailable" | "unknown";
    reason: string;
  };
  authorization: HighlightDisabledSandboxAuthorization | null;
}

export interface HighlightDisabledSandboxAuthorization {
  contract: "kandev-highlight-disabled-sandbox-authorization-v1";
  sourceMode: "current_main";
  sourceSha: string;
  allowedOrigin: string;
  guardContract: "kandev-highlight-origin-isolation-v1";
}

export interface HighlightApplicationRuntimeProof {
  contract: "kandev-highlight-application-runtime-pre-teardown-v1";
  version: 1;
  runtimeId: HighlightRuntimeId;
  origin: string;
  ports: { backend: number; frontend: number };
  isolation: {
    fixtureTempRoot: string;
    homeRoot: string;
    databasePath: string;
    worktreeRoot: string;
    repositoryCloneRoot: string;
  };
  providerRouting: {
    profile: "e2e";
    mockAgent: true;
    mockProviders: true;
    liveCredentialsPresent: false;
    environmentSanitized: true;
  };
  source: {
    contract: "kandev-highlight-source-v1";
    mode: HighlightSourceMode;
    selectedSha: string;
  };
  build: {
    contract: "kandev-highlight-build-provenance-v1";
    manifestDigest: HighlightSha256;
    sourceSha: string;
    outputs: {
      backend: HighlightSha256;
      mockAgent: HighlightSha256;
      webDist: HighlightSha256;
    };
  };
}

export interface HighlightCaptureEvidenceSummary {
  records: number;
  bytes: number;
  digest: HighlightSha256;
  truncated: boolean;
}

export interface HighlightCaptureEvidenceIdentity {
  contract: "kandev-highlight-capture-evidence-v1";
  version: 1;
  path: string;
  bytes: number;
  digest: HighlightSha256;
  visibleDomText: HighlightCaptureEvidenceSummary;
  browserConsole: HighlightCaptureEvidenceSummary;
}

export interface HighlightRuntimeWorkerResult {
  contract: "kandev-highlight-runtime-worker-result-v1";
  version: 1;
  runtimeId: HighlightRuntimeId;
  runId: string;
  applicationRuntime: HighlightApplicationRuntimeProof;
  capture: {
    phaseManifestPath: string;
    captureManifestPath: string;
    rawMasterPath: string;
    scenarioDigest: HighlightSha256;
    sourceDigest: HighlightSha256;
    rawMasterDigest: HighlightSha256;
    captureEvidence: HighlightCaptureEvidenceIdentity;
  };
}

export interface HighlightFileIdentity {
  path: string;
  bytes: number;
  digest: HighlightSha256;
}

export interface HighlightScenarioIdentity {
  id: string;
  path: string;
  bytes: number;
  digest: HighlightSha256;
}

export interface HighlightRuntimeCompactSourceProof {
  contract: "kandev-highlight-source-v1";
  mode: HighlightSourceMode;
  selectedSha: string;
  headSha: string;
  currentMainSha: string;
}

export interface HighlightRuntimeSourceEvidence {
  pre: HighlightRuntimeCompactSourceProof;
  post: HighlightRuntimeCompactSourceProof | null;
  unchanged: boolean;
}

export interface HighlightRuntimeProcessGroupEvidence {
  pid: number | null;
  termSent: boolean;
  killSent: boolean;
  exited: boolean;
  gone: boolean;
}

export interface HighlightRuntimeLogEvidence {
  limitBytes: number;
  capturedBytes: number | null;
  discardedBytes: number;
  truncated: boolean;
}

export interface HighlightRuntimeExecution {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  deadlineMs: number;
  processGroup: HighlightRuntimeProcessGroupEvidence;
  log: HighlightRuntimeLogEvidence;
}

export interface HighlightCaptureTeardownEvidence {
  declared: true;
  cdpPortReleased: boolean;
  displayReleased: boolean;
  processesGone: boolean;
  recorderGone: boolean;
  profileRemoved: boolean;
  locksRemoved: boolean;
}

export interface HighlightRuntimeTeardownEvidence {
  playwrightExited: boolean;
  playwrightProcessGroupGone: boolean;
  backendPortReleased: boolean;
  frontendPortReleased: boolean;
  fixtureTempRootOwned: boolean;
  fixtureTempRootRemoved: boolean;
  capture: HighlightCaptureTeardownEvidence | null;
}

export interface HighlightRuntimeFailure {
  code: string;
  phase: string;
  retry: {
    nextRunIdRequired: true;
    reason: "immutable-run-id-reserved";
  };
}

export interface HighlightRuntimeCaptureIdentity {
  attemptRoot: string;
  scenarioDigest: HighlightSha256;
  sourceDigest: HighlightSha256;
  phaseManifestPath: string;
  phaseManifestDigest: HighlightSha256;
  captureManifestPath: string;
  captureManifestDigest: HighlightSha256;
  rawMasterPath: string;
  rawMasterDigest: HighlightSha256;
  rawMaster: HighlightFileIdentity;
  captureEvidence: HighlightCaptureEvidenceIdentity;
}

export interface HighlightRuntimeHostResult {
  contract: "kandev-highlight-runtime-host-result-v1";
  version: 1;
  status: "succeeded" | "failed";
  runtimeId: HighlightRuntimeId;
  runId: string;
  scenario: HighlightScenarioIdentity;
  source: HighlightRuntimeSourceEvidence;
  bundle: {
    path: string;
    requestPath: string;
    workerResultPath: string;
    logPath: string;
    failurePath: string;
    resultPath: string;
  };
  request: HighlightFileIdentity | null;
  workerResult: HighlightFileIdentity | null;
  log: HighlightFileIdentity | null;
  applicationRuntime: {
    receiptPath: string;
    digest: HighlightSha256;
  } | null;
  capture: HighlightRuntimeCaptureIdentity | null;
  execution: HighlightRuntimeExecution | null;
  teardown: HighlightRuntimeTeardownEvidence | null;
  failure: HighlightRuntimeFailure | null;
  completedAt: string;
  resultDigest: HighlightSha256;
}

export interface HighlightRuntimeFailureEvidence {
  contract: "kandev-highlight-runtime-host-failure-v1";
  version: 1;
  runtimeId: HighlightRuntimeId;
  runId: string;
  phase: string;
  failure: HighlightRuntimeFailure;
  completedAt: string;
  failureDigest: HighlightSha256;
}

export interface HighlightRuntimeSignalSource {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface HighlightRuntimeOwnedCommand {
  command: string;
  args: string[];
  cwd: string;
}

export function validateRuntimeHostRequest(
  value: unknown,
): HighlightRuntimeHostRequest;
export function validateRuntimeWorkerRequest(
  value: unknown,
): HighlightRuntimeWorkerRequest;
export function validateRuntimeWorkerResult(
  value: unknown,
  workerRequest: HighlightRuntimeWorkerRequest,
): HighlightRuntimeWorkerResult;
export function writeRuntimeWorkerResult(
  destination: string,
  value: HighlightRuntimeWorkerResult,
  workerRequest: HighlightRuntimeWorkerRequest,
): Promise<HighlightRuntimeWorkerResult>;
export function sanitizeRuntimeHostEnvironment(
  inheritedEnv: Record<string, string | undefined>,
  options: {
    homeRoot: string;
    fixtureRoot: string;
    tempRoot: string;
    requestPath: string;
    workerResultPath: string;
    portOffset: number;
    playwrightBrowsersPath: string;
  },
): Record<string, string>;
export function buildRuntimeHostCommand(options?: {
  webRoot?: string;
  nodeExecutable?: string;
}): { command: string; args: string[]; cwd: string };
export function runOwnedRuntimeProcess(options: {
  command: HighlightRuntimeOwnedCommand;
  env: Record<string, string>;
  logPath: string;
  deadlineMs?: number;
  termGraceMs?: number;
  killGraceMs?: number;
  logLimitBytes?: number;
  signalSource?: HighlightRuntimeSignalSource;
}): Promise<HighlightRuntimeExecution>;
export function runHighlightRuntimeHost(options: {
  request: HighlightRuntimeHostRequest;
  inheritedEnv?: Record<string, string | undefined>;
  dependencies?: Record<string, unknown>;
}): Promise<HighlightRuntimeHostResult>;
