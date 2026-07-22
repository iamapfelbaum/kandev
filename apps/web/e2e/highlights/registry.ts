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

type ApiClientLike = {
  createTask?: (
    workspaceId: string,
    title: string,
    options: { workflow_id: string; workflow_step_id: string },
  ) => Promise<SeededTask>;
  getTask?: (taskId: string) => Promise<SeededTask>;
  listTasks?: (workspaceId: string) => Promise<{ tasks: SeededTask[] }>;
};

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

function assertApi(apiClient: ApiClientLike): asserts apiClient is Required<ApiClientLike> {
  if (
    typeof apiClient.createTask !== "function" ||
    typeof apiClient.getTask !== "function" ||
    typeof apiClient.listTasks !== "function"
  ) {
    throw new Error("quick-start seed needs ApiClient createTask/getTask/listTasks methods");
  }
}

export const HIGHLIGHT_RUNTIME_BINDING_METADATA = {
  runtimeId: "kandev-isolated-e2e",
  profiles: ["desktop", "native-mobile"],
  seedRecipes: [{ id: "kandev.highlight.quick-start", parameterKeys: [] }],
  routes: ["workspace.board"],
  primitiveIds: [],
  scannerCoverage: {
    metadata: true,
    visibleDomText: true,
    browserConsole: true,
    runtimeLogs: true,
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
