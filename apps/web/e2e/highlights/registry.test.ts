import assert from "node:assert/strict";
import test from "node:test";

import { createHighlightRegistries } from "./registry";

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
        title: "Declarative Highlight fixture",
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
            title: "Declarative Highlight fixture",
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
    "Declarative Highlight fixture",
    { workflow_id: "workflow-1", workflow_step_id: "step-start" },
  ]);
  assert.equal(proof.seedId, "kandev.highlight.quick-start");
  assert.match(proof.seedDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(proof.invariants, {
    workspaceId: "workspace-1",
    workflowId: "workflow-1",
    workflowStepId: "step-start",
    taskId: "task-seed-1",
    title: "Declarative Highlight fixture",
    state: "BACKLOG",
    taskCount: 1,
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
