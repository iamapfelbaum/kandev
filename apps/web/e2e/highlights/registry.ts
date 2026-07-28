import { createHash } from "node:crypto";

type SeedData = {
  workspaceId: string;
  workflowId: string;
  startStepId: string;
};

type Backend = {
  frontendUrl: string;
  port: number;
};

type SeededTask = {
  id: string;
  title: string;
  workflow_step_id?: string;
  state?: string;
};

type QuickStartApi = {
  createTask: (
    workspaceId: string,
    title: string,
    options: { workflow_id: string; workflow_step_id: string },
  ) => Promise<SeededTask>;
  getTask: (taskId: string) => Promise<SeededTask>;
  listTasks: (workspaceId: string) => Promise<{ tasks: SeededTask[] }>;
};

type SeededAgentProfile = { id: string; name: string; model: string };
type SeededAgent = {
  id: string;
  name: string;
  profiles: SeededAgentProfile[];
};
type SeededWorkspace = {
  id: string;
  default_agent_profile_id?: string | null;
};
type SeedCounts = {
  workspaces: number;
  workflows: number;
  tasks: number;
  agents: number;
  agentProfiles: number;
};
type QuickChatSnapshot = {
  workspaceListing: { workspaces: SeededWorkspace[]; total: number };
  workflowListing: { workflows: Array<{ id: string }> };
  taskListing: { tasks: SeededTask[] };
  agentListing: { agents: SeededAgent[]; total: number };
  counts: SeedCounts;
};

type QuickChatApi = {
  listWorkspaces: () => Promise<{ workspaces: SeededWorkspace[]; total: number }>;
  listWorkflows: (workspaceId: string) => Promise<{ workflows: Array<{ id: string }> }>;
  listTasks: (workspaceId: string) => Promise<{ tasks: SeededTask[] }>;
  listAgents: () => Promise<{ agents: SeededAgent[]; total: number }>;
  createAgentProfile: (
    agentId: string,
    name: string,
    options: { model: string },
  ) => Promise<{ id: string }>;
  updateWorkspace: (
    workspaceId: string,
    updates: { default_agent_profile_id: string },
  ) => Promise<unknown>;
};

type ApiClientLike = Partial<QuickStartApi & QuickChatApi>;

type PageLike = {
  goto: (url: string, options: { waitUntil: "domcontentloaded" }) => Promise<unknown>;
  getByTestId: (testId: string) => {
    waitFor: (options: { state: "visible"; timeout: number }) => Promise<unknown>;
  };
};

type BrowserContextLike = {
  addInitScript: (
    fn: (argument: { backendPort: string }) => void,
    argument: {
      backendPort: string;
    },
  ) => Promise<unknown>;
};

type ConsoleMessageLike = {
  type: () => string;
  text: () => string;
};

type EvidencePageLike = {
  on: (event: "console", listener: (message: ConsoleMessageLike) => void) => void;
  off: (event: "console", listener: (message: ConsoleMessageLike) => void) => void;
  evaluate: <Result>(fn: () => Result) => Promise<Result>;
};

const CAPTURE_CONTENT_BOUNDS = {
  maxVisibleDomTextRecords: 512,
  maxVisibleDomTextBytes: 65_536,
  maxBrowserConsoleRecords: 128,
  maxBrowserConsoleTextBytes: 2_048,
} as const;

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function truncateUtf8(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  let text = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maximumBytes) return { text, truncated: true };
    text += character;
    bytes += characterBytes;
  }
  return { text, truncated: false };
}

function boundVisibleText(values: string[]) {
  const records: string[] = [];
  let bytes = 0;
  let truncated = values.length > CAPTURE_CONTENT_BOUNDS.maxVisibleDomTextRecords;
  for (const value of values.slice(0, CAPTURE_CONTENT_BOUNDS.maxVisibleDomTextRecords)) {
    const remaining = CAPTURE_CONTENT_BOUNDS.maxVisibleDomTextBytes - bytes;
    const bounded = truncateUtf8(value, Math.max(0, remaining));
    if (bounded.text) records.push(bounded.text);
    bytes += Buffer.byteLength(bounded.text);
    if (bounded.truncated) {
      truncated = true;
      break;
    }
  }
  return { records, truncated };
}

function assertApi(apiClient: ApiClientLike): asserts apiClient is ApiClientLike & QuickStartApi {
  if (
    typeof apiClient.createTask !== "function" ||
    typeof apiClient.getTask !== "function" ||
    typeof apiClient.listTasks !== "function"
  ) {
    throw new Error("quick-start seed needs ApiClient createTask/getTask/listTasks methods");
  }
}

function assertQuickChatApi(
  apiClient: ApiClientLike,
): asserts apiClient is ApiClientLike & QuickChatApi {
  const methods: Array<keyof QuickChatApi> = [
    "listWorkspaces",
    "listWorkflows",
    "listTasks",
    "listAgents",
    "createAgentProfile",
    "updateWorkspace",
  ];
  if (methods.some((method) => typeof apiClient[method] !== "function")) {
    throw new Error(`quick-chat seed needs ApiClient ${methods.join("/")} methods`);
  }
}

export const HIGHLIGHT_RUNTIME_BINDING_METADATA = {
  runtimeId: "kandev-isolated-e2e",
  profiles: ["desktop", "native-mobile"],
  seedRecipes: [
    { id: "kandev.highlight.quick-start", parameterKeys: [] },
    { id: "kandev.highlight.quick-chat", parameterKeys: [] },
  ],
  routes: ["workspace.board"],
  primitiveIds: [],
  scannerCoverage: {
    metadata: true,
    visibleDomText: true,
    browserConsole: true,
    runtimeLogs: false,
    renderedPixelOcr: false,
  },
  scenarioTemplate: "scripts/highlights/examples/quick-start.scenario.json",
} as const;

async function seedQuickStart(apiClient: ApiClientLike, seedData: SeedData) {
  assertApi(apiClient);
  const title = "Review API";
  const created = await apiClient.createTask(seedData.workspaceId, title, {
    workflow_id: seedData.workflowId,
    workflow_step_id: seedData.startStepId,
  });
  const [actual, listing] = await Promise.all([
    apiClient.getTask(created.id),
    apiClient.listTasks(seedData.workspaceId),
  ]);
  if (
    actual.title !== title ||
    actual.workflow_step_id !== seedData.startStepId ||
    listing.tasks.length !== 1 ||
    listing.tasks[0]?.id !== actual.id
  ) {
    throw new Error(
      "quick-start seed invariant failed: expected exactly one seeded task in start workflow step",
    );
  }
  const invariants = {
    workspaceId: seedData.workspaceId,
    workflowId: seedData.workflowId,
    workflowStepId: seedData.startStepId,
    taskId: actual.id,
    title: actual.title,
    state: actual.state ?? "BACKLOG",
    taskCount: listing.tasks.length,
  };
  return {
    seedId: "kandev.highlight.quick-start",
    seedDigest: digest({
      recipe: "kandev.highlight.quick-start",
      parameters: {},
      invariants: {
        workflowStep: "start",
        title: actual.title,
        state: actual.state ?? "BACKLOG",
        taskCount: listing.tasks.length,
      },
    }),
    invariants,
  };
}

function countAgentProfiles(agents: SeededAgent[]) {
  return agents.reduce((count, agent) => count + agent.profiles.length, 0);
}

function matchesCounts(actual: SeedCounts, expected: SeedCounts) {
  return (Object.keys(expected) as Array<keyof SeedCounts>).every(
    (key) => actual[key] === expected[key],
  );
}

async function readQuickChatSnapshot(
  apiClient: QuickChatApi,
  workspaceId: string,
): Promise<QuickChatSnapshot> {
  const [workspaceListing, workflowListing, taskListing, agentListing] = await Promise.all([
    apiClient.listWorkspaces(),
    apiClient.listWorkflows(workspaceId),
    apiClient.listTasks(workspaceId),
    apiClient.listAgents(),
  ]);
  return {
    workspaceListing,
    workflowListing,
    taskListing,
    agentListing,
    counts: {
      workspaces: workspaceListing.workspaces.length,
      workflows: workflowListing.workflows.length,
      tasks: taskListing.tasks.length,
      agents: agentListing.agents.length,
      agentProfiles: countAgentProfiles(agentListing.agents),
    },
  };
}

function assertFreshQuickChatBaseline(
  snapshot: QuickChatSnapshot,
  seedData: SeedData,
  expectedCounts: SeedCounts,
) {
  const controlledAgent = snapshot.agentListing.agents.find(
    (agent) => agent.id === "mock-agent" && agent.name === "mock-agent",
  );
  if (!controlledAgent) {
    throw new Error(
      "quick-chat seed invariant failed: expected one fresh workspace, workflow, controlled agent, profile, and zero tasks",
    );
  }
  const checks = [
    snapshot.workspaceListing.total === 1,
    snapshot.workspaceListing.workspaces[0]?.id === seedData.workspaceId,
    !snapshot.workspaceListing.workspaces[0]?.default_agent_profile_id,
    snapshot.workflowListing.workflows[0]?.id === seedData.workflowId,
    snapshot.agentListing.total === 1,
    matchesCounts(snapshot.counts, expectedCounts),
  ];
  if (!checks.every(Boolean)) {
    throw new Error(
      "quick-chat seed invariant failed: expected one fresh workspace, workflow, controlled agent, profile, and zero tasks",
    );
  }
  return controlledAgent;
}

function assertConfiguredQuickChat(
  snapshot: QuickChatSnapshot,
  seedData: SeedData,
  profile: { id: string; name: string; model: string },
  expectedCounts: SeedCounts,
) {
  const configuredProfile = snapshot.agentListing.agents
    .flatMap((agent) => agent.profiles)
    .find((candidate) => candidate.id === profile.id);
  const checks = [
    snapshot.workspaceListing.workspaces[0]?.default_agent_profile_id === profile.id,
    snapshot.workflowListing.workflows[0]?.id === seedData.workflowId,
    configuredProfile?.name === profile.name,
    configuredProfile?.model === profile.model,
    matchesCounts(snapshot.counts, expectedCounts),
  ];
  if (!checks.every(Boolean)) {
    throw new Error(
      "quick-chat seed invariant failed: expected Product Guide as workspace default with no task mutation",
    );
  }
}

async function seedQuickChat(apiClient: ApiClientLike, seedData: SeedData) {
  assertQuickChatApi(apiClient);
  const baseline = await readQuickChatSnapshot(apiClient, seedData.workspaceId);
  const expectedBaselineCounts = {
    workspaces: 1,
    workflows: 1,
    tasks: 0,
    agents: 1,
    agentProfiles: 1,
  };
  const controlledAgent = assertFreshQuickChatBaseline(baseline, seedData, expectedBaselineCounts);

  const profileName = "Product Guide";
  const profileModel = "mock-fast";
  const profile = await apiClient.createAgentProfile(controlledAgent.id, profileName, {
    model: profileModel,
  });
  await apiClient.updateWorkspace(seedData.workspaceId, {
    default_agent_profile_id: profile.id,
  });

  const result = await readQuickChatSnapshot(apiClient, seedData.workspaceId);
  const expectedResultCounts = { ...expectedBaselineCounts, agentProfiles: 2 };
  assertConfiguredQuickChat(
    result,
    seedData,
    { id: profile.id, name: profileName, model: profileModel },
    expectedResultCounts,
  );

  const invariants = {
    workspaceId: seedData.workspaceId,
    workflowId: seedData.workflowId,
    workflowStepId: seedData.startStepId,
    agentProfileId: profile.id,
    profileName,
    baselineCounts: baseline.counts,
    resultCounts: result.counts,
    workspaceDefaultAgentProfileId: profile.id,
  };
  return {
    seedId: "kandev.highlight.quick-chat",
    seedDigest: digest({
      recipe: "kandev.highlight.quick-chat",
      parameters: {},
      invariants: {
        agentId: controlledAgent.id,
        profileName,
        profileModel,
        baselineCounts: baseline.counts,
        resultCounts: result.counts,
        workspaceDefaultConfigured: true,
      },
    }),
    invariants,
  };
}

function captureBootScript({ backendPort }: { backendPort: string }) {
  localStorage.setItem("kandev.onboarding.completed", "true");
  window.__KANDEV_API_PORT = backendPort;
  window.__KANDEV_E2E_EXPOSE_STORE__ = true;
  const captured: Array<{ title: string; body?: string }> = [];
  (window as unknown as { __kandevTestNotifications: typeof captured }).__kandevTestNotifications =
    captured;
  class NotificationStub {
    static permission: NotificationPermission = "granted";
    static async requestPermission(): Promise<NotificationPermission> {
      return "granted";
    }
    title: string;
    body?: string;
    constructor(title: string, options?: NotificationOptions) {
      this.title = title;
      this.body = options?.body;
      captured.push({ title, body: options?.body });
    }
    close(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    dispatchEvent(): boolean {
      return false;
    }
  }
  Object.defineProperty(window, "Notification", {
    configurable: true,
    writable: true,
    value: NotificationStub,
  });
}

export function createHighlightRegistries({
  apiClient,
  seedData,
  backend,
}: {
  apiClient: ApiClientLike;
  seedData: SeedData;
  backend: Backend;
}) {
  const browserConsole: Array<{ type: string; text: string; digest: string }> = [];
  let browserConsoleTruncated = false;
  let attachedPage: EvidencePageLike | null = null;
  const consoleListener = (message: ConsoleMessageLike) => {
    if (browserConsole.length >= CAPTURE_CONTENT_BOUNDS.maxBrowserConsoleRecords) {
      browserConsoleTruncated = true;
      return;
    }
    const type = message.type();
    const bounded = truncateUtf8(message.text(), CAPTURE_CONTENT_BOUNDS.maxBrowserConsoleTextBytes);
    browserConsoleTruncated ||= bounded.truncated;
    const record = { type, text: bounded.text };
    browserConsole.push({
      ...record,
      digest: `sha256:${createHash("sha256").update(canonicalJson(record)).digest("hex")}`,
    });
  };
  return {
    seedRegistry: {
      "kandev.highlight.quick-start": async (_input: { parameters?: unknown }) =>
        seedQuickStart(apiClient, seedData),
      "kandev.highlight.quick-chat": async (_input: { parameters?: unknown }) =>
        seedQuickChat(apiClient, seedData),
    },
    primitiveRegistry: {},
    async navigateRoute(route: string, { page }: { page: PageLike }) {
      if (route !== "workspace.board") throw new Error(`route '${route}' is not allowlisted`);
      await page.goto(`${backend.frontendUrl}/`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("kanban-board").waitFor({ state: "visible", timeout: 15_000 });
    },
    async preparePage({ context, page }: { context: BrowserContextLike; page?: EvidencePageLike }) {
      await context.addInitScript(captureBootScript, { backendPort: String(backend.port) });
      if (page) {
        if (attachedPage) attachedPage.off("console", consoleListener);
        attachedPage = page;
        attachedPage.on("console", consoleListener);
      }
    },
    async collectCaptureEvidence({ page }: { page: EvidencePageLike }) {
      const visible = await page.evaluate(() =>
        (document.body?.innerText ?? "")
          .split(/\n+/)
          .map((line) => line.trim())
          .filter(Boolean),
      );
      if (!Array.isArray(visible) || visible.some((value) => typeof value !== "string")) {
        throw new Error("visible DOM text collector returned invalid records");
      }
      const boundedVisible = boundVisibleText(visible);
      if (attachedPage) {
        attachedPage.off("console", consoleListener);
        attachedPage = null;
      }
      return {
        contract: "kandev-highlight-capture-content-v1" as const,
        version: 1 as const,
        bounds: { ...CAPTURE_CONTENT_BOUNDS },
        visibleDomText: boundedVisible.records,
        browserConsole: structuredClone(browserConsole),
        truncated: {
          visibleDomText: boundedVisible.truncated,
          browserConsole: browserConsoleTruncated,
        },
      };
    },
  };
}
