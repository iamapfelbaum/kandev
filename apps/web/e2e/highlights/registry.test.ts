import assert from "node:assert/strict";
import test from "node:test";

import { HIGHLIGHT_RUNTIME_BINDING_METADATA, createHighlightRegistries } from "./registry";

function quickChatSeedFixture(suffix: string) {
  const workspaceId = `workspace-${suffix}`;
  const workflowId = `workflow-${suffix}`;
  const startStepId = `step-${suffix}`;
  const createdProfileId = `profile-product-guide-${suffix}`;
  const calls: unknown[][] = [];
  let defaultAgentProfileId: string | null = null;
  const profiles = [{ id: `profile-default-${suffix}`, name: "Default", model: "mock-default" }];
  const apiClient = {
    async listWorkspaces() {
      calls.push(["listWorkspaces"]);
      return {
        workspaces: [{ id: workspaceId, default_agent_profile_id: defaultAgentProfileId }],
        total: 1,
      };
    },
    async listWorkflows(requestedWorkspaceId: string) {
      calls.push(["listWorkflows", requestedWorkspaceId]);
      return { workflows: [{ id: workflowId }] };
    },
    async listTasks(requestedWorkspaceId: string) {
      calls.push(["listTasks", requestedWorkspaceId]);
      return { tasks: [] };
    },
    async listAgents() {
      calls.push(["listAgents"]);
      return {
        agents: [{ id: "mock-agent", name: "mock-agent", profiles: structuredClone(profiles) }],
        total: 1,
      };
    },
    async createAgentProfile(agentId: string, name: string, options: { model: string }) {
      calls.push(["createAgentProfile", agentId, name, options]);
      profiles.push({ id: createdProfileId, name, model: options.model });
      return { id: createdProfileId, cli_flags: [] };
    },
    async updateWorkspace(
      requestedWorkspaceId: string,
      updates: { default_agent_profile_id?: string },
    ) {
      calls.push(["updateWorkspace", requestedWorkspaceId, updates]);
      defaultAgentProfileId = updates.default_agent_profile_id ?? null;
    },
  };
  return {
    apiClient,
    calls,
    seedData: { workspaceId, workflowId, startStepId },
  };
}

test("quick-start seed recipe creates and proves one isolated task", async () => {
  const calls: unknown[][] = [];
  const apiClient = {
    async createTask(workspaceId: string, title: string, options: unknown) {
      calls.push(["createTask", workspaceId, title, options]);
      return { id: "task-seed-1", title, workflow_step_id: "step-start" };
    },
    async getTask(taskId: string) {
      calls.push(["getTask", taskId]);
      return {
        id: taskId,
        title: "Review API",
        workflow_step_id: "step-start",
        state: "BACKLOG",
      };
    },
    async listTasks(workspaceId: string) {
      calls.push(["listTasks", workspaceId]);
      return {
        tasks: [
          {
            id: "task-seed-1",
            title: "Review API",
            workflow_step_id: "step-start",
          },
        ],
      };
    },
  };
  const registries = createHighlightRegistries({
    apiClient,
    seedData: { workspaceId: "workspace-1", workflowId: "workflow-1", startStepId: "step-start" },
    backend: { frontendUrl: "http://127.0.0.1:18080", port: 18080 },
  });

  const proof = await registries.seedRegistry["kandev.highlight.quick-start"]({ parameters: {} });

  assert.deepEqual(calls[0], [
    "createTask",
    "workspace-1",
    "Review API",
    { workflow_id: "workflow-1", workflow_step_id: "step-start" },
  ]);
  assert.equal(proof.seedId, "kandev.highlight.quick-start");
  assert.match(proof.seedDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(proof.invariants, {
    workspaceId: "workspace-1",
    workflowId: "workflow-1",
    workflowStepId: "step-start",
    taskId: "task-seed-1",
    title: "Review API",
    state: "BACKLOG",
    taskCount: 1,
  });
});

test("quick-start seed digest is stable across isolated generated IDs", async () => {
  const seed = async (suffix: string) => {
    const title = "Review API";
    const registries = createHighlightRegistries({
      apiClient: {
        async createTask() {
          return {
            id: `task-${suffix}`,
            title,
            workflow_step_id: `step-${suffix}`,
          };
        },
        async getTask(taskId: string) {
          return {
            id: taskId,
            title,
            workflow_step_id: `step-${suffix}`,
            state: "BACKLOG",
          };
        },
        async listTasks() {
          return {
            tasks: [
              {
                id: `task-${suffix}`,
                title,
                workflow_step_id: `step-${suffix}`,
              },
            ],
          };
        },
      },
      seedData: {
        workspaceId: `workspace-${suffix}`,
        workflowId: `workflow-${suffix}`,
        startStepId: `step-${suffix}`,
      },
      backend: { frontendUrl: "http://127.0.0.1:18080", port: 18080 },
    });
    return registries.seedRegistry["kandev.highlight.quick-start"]({ parameters: {} });
  };

  const first = await seed("one");
  const second = await seed("two");
  assert.equal(first.seedDigest, second.seedDigest);
  assert.notEqual(first.invariants.workspaceId, second.invariants.workspaceId);
  assert.notEqual(first.invariants.taskId, second.invariants.taskId);
  assert.doesNotMatch(JSON.stringify(first), /fixture|\bE2E\b|mock/i);
});

test("quick-chat seed creates one safe default profile and proves fresh baseline counts", async () => {
  const fixture = quickChatSeedFixture("one");
  const registries = createHighlightRegistries({
    apiClient: fixture.apiClient,
    seedData: fixture.seedData,
    backend: { frontendUrl: "http://127.0.0.1:18080", port: 18080 },
  });
  const recipe = (
    registries.seedRegistry as unknown as Record<
      string,
      ((input: { parameters?: unknown }) => Promise<unknown>) | undefined
    >
  )["kandev.highlight.quick-chat"];

  assert.equal(typeof recipe, "function", "Quick Chat seed recipe must be registered");
  if (!recipe) return;
  const proof = (await recipe({ parameters: {} })) as {
    seedId: string;
    seedDigest: string;
    invariants: unknown;
  };

  assert.deepEqual(
    fixture.calls.filter(([operation]) =>
      ["createAgentProfile", "updateWorkspace"].includes(String(operation)),
    ),
    [
      ["createAgentProfile", "mock-agent", "Product Guide", { model: "mock-fast" }],
      [
        "updateWorkspace",
        "workspace-one",
        { default_agent_profile_id: "profile-product-guide-one" },
      ],
    ],
  );
  assert.equal(proof.seedId, "kandev.highlight.quick-chat");
  assert.match(proof.seedDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(proof.invariants, {
    workspaceId: "workspace-one",
    workflowId: "workflow-one",
    workflowStepId: "step-one",
    agentProfileId: "profile-product-guide-one",
    profileName: "Product Guide",
    baselineCounts: {
      workspaces: 1,
      workflows: 1,
      tasks: 0,
      agents: 1,
      agentProfiles: 1,
    },
    resultCounts: {
      workspaces: 1,
      workflows: 1,
      tasks: 0,
      agents: 1,
      agentProfiles: 2,
    },
    workspaceDefaultAgentProfileId: "profile-product-guide-one",
  });
  assert.doesNotMatch(JSON.stringify(proof), /fixture|\bE2E\b|\bmock\b/i);
});

test("quick-chat seed digest is stable across isolated generated IDs", async () => {
  const seed = async (suffix: string) => {
    const fixture = quickChatSeedFixture(suffix);
    const registries = createHighlightRegistries({
      apiClient: fixture.apiClient,
      seedData: fixture.seedData,
      backend: { frontendUrl: "http://127.0.0.1:18080", port: 18080 },
    });
    const recipe = (
      registries.seedRegistry as unknown as Record<
        string,
        ((input: { parameters?: unknown }) => Promise<{ seedDigest: string }>) | undefined
      >
    )["kandev.highlight.quick-chat"];
    assert.equal(typeof recipe, "function", "Quick Chat seed recipe must be registered");
    if (!recipe) throw new Error("Quick Chat seed recipe missing");
    return recipe({ parameters: {} });
  };

  const first = await seed("one");
  const second = await seed("two");
  assert.equal(first.seedDigest, second.seedDigest);
});

test("registry metadata exactly matches the closed Node runtime catalog", async () => {
  const { resolveHighlightRuntime } =
    await import("../../../../scripts/highlights/runtime-catalog.mjs");
  const catalog = resolveHighlightRuntime("kandev-isolated-e2e");

  assert.deepEqual(HIGHLIGHT_RUNTIME_BINDING_METADATA, {
    runtimeId: catalog.id,
    profiles: catalog.profiles,
    seedRecipes: catalog.seedRecipes,
    routes: catalog.routes,
    primitiveIds: catalog.primitiveIds,
    scannerCoverage: catalog.scannerCoverage,
    scenarioTemplate: catalog.scenarioTemplate,
  });
});

test("route registry allows board only and waits for stable semantic surface", async () => {
  const events: unknown[] = [];
  const page = {
    async goto(url: string, options: unknown) {
      events.push(["goto", url, options]);
    },
    getByTestId(testId: string) {
      return {
        async waitFor(options: unknown) {
          events.push(["waitFor", testId, options]);
        },
      };
    },
  };
  const registries = createHighlightRegistries({
    apiClient: {},
    seedData: { workspaceId: "workspace-1", workflowId: "workflow-1", startStepId: "step-start" },
    backend: { frontendUrl: "http://127.0.0.1:18080", port: 18080 },
  });

  await registries.navigateRoute("workspace.board", { page });

  assert.deepEqual(events, [
    ["goto", "http://127.0.0.1:18080/", { waitUntil: "domcontentloaded" }],
    ["waitFor", "kanban-board", { state: "visible", timeout: 15_000 }],
  ]);
  await assert.rejects(
    () => registries.navigateRoute("raw.javascript", { page }),
    /route 'raw\.javascript' is not allowlisted/,
  );
});

test("page preparation installs deterministic Kandev boot state before navigation", async () => {
  const scripts: Array<{ fn: unknown; argument: unknown }> = [];
  const context = {
    async addInitScript(fn: unknown, argument: unknown) {
      scripts.push({ fn, argument });
    },
  };
  const registries = createHighlightRegistries({
    apiClient: {},
    seedData: { workspaceId: "workspace-1", workflowId: "workflow-1", startStepId: "step-start" },
    backend: { frontendUrl: "http://127.0.0.1:18080", port: 18080 },
  });

  await registries.preparePage({ context });

  assert.equal(scripts.length, 1);
  assert.deepEqual(scripts[0].argument, { backendPort: "18080" });
  assert.match(String(scripts[0].fn), /kandev\.onboarding\.completed/);
  assert.match(String(scripts[0].fn), /__KANDEV_API_PORT/);
  assert.match(String(scripts[0].fn), /NotificationStub/);
});

test("trusted adapter captures bounded visible text and console records at the final frame", async () => {
  let consoleListener: ((message: { type(): string; text(): string }) => void) | undefined;
  const page = {
    on(event: string, listener: typeof consoleListener) {
      if (event === "console") consoleListener = listener;
    },
    off(event: string, listener: typeof consoleListener) {
      if (event === "console" && listener === consoleListener) consoleListener = undefined;
    },
    async evaluate() {
      return ["Quick start", ...Array.from({ length: 700 }, (_, index) => `Task ${index}`)];
    },
  };
  const context = {
    async addInitScript() {},
  };
  const registries = createHighlightRegistries({
    apiClient: {},
    seedData: { workspaceId: "workspace-1", workflowId: "workflow-1", startStepId: "step-start" },
    backend: { frontendUrl: "http://127.0.0.1:18080", port: 18080 },
  });

  await registries.preparePage({ context, page });
  for (let index = 0; index < 140; index += 1) {
    consoleListener?.({
      type: () => "info",
      text: () => `${index}:${"x".repeat(3_000)}`,
    });
  }
  const evidence = await registries.collectCaptureEvidence({ page });

  assert.equal(evidence.contract, "kandev-highlight-capture-content-v1");
  assert.deepEqual(evidence.bounds, {
    maxVisibleDomTextRecords: 512,
    maxVisibleDomTextBytes: 65_536,
    maxBrowserConsoleRecords: 128,
    maxBrowserConsoleTextBytes: 2_048,
  });
  assert.equal(evidence.visibleDomText.length, 512);
  assert.ok(
    evidence.visibleDomText.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0) <=
      evidence.bounds.maxVisibleDomTextBytes,
  );
  assert.equal(evidence.browserConsole.length, 128);
  assert.ok(
    evidence.browserConsole.every(
      (record) =>
        Buffer.byteLength(record.text) <= evidence.bounds.maxBrowserConsoleTextBytes &&
        /^sha256:[a-f0-9]{64}$/.test(record.digest),
    ),
  );
  assert.deepEqual(evidence.truncated, {
    visibleDomText: true,
    browserConsole: true,
  });
  assert.equal(
    consoleListener,
    undefined,
    "collector detaches console listener at record boundary",
  );
});
