import { expect } from "@playwright/test";

import { ApiClient } from "../helpers/api-client";
import { backendFixture } from "../fixtures/backend";

export type HighlightRuntimeSeedData = {
  workspaceId: string;
  workflowId: string;
  startStepId: string;
};

export const highlightRuntimeTest = backendFixture.extend<
  object,
  { apiClient: ApiClient; seedData: HighlightRuntimeSeedData }
>({
  apiClient: [
    async ({ backend }, use) => {
      const apiClient = new ApiClient(backend.baseUrl);
      const deadline = Date.now() + 10_000;
      let status = 0;
      while (Date.now() < deadline) {
        const response = await apiClient.rawRequest("GET", "/api/v1/_test/health");
        status = response.status;
        if (response.ok) break;
        if (response.status !== 404 && response.status !== 503) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (status !== 200) {
        throw new Error(`Highlight runtime mock health probe failed with status ${status}`);
      }
      await use(apiClient);
    },
    { scope: "worker" },
  ],
  seedData: [
    async ({ apiClient }, use) => {
      const workspace = await apiClient.createWorkspace("Product Workspace");
      const workflow = await apiClient.createWorkflow(workspace.id, "Product Workflow", "simple");
      const { steps } = await apiClient.listWorkflowSteps(workflow.id);
      const ordered = [...steps].sort((left, right) => left.position - right.position);
      const startStep = ordered.find((step) => step.is_start_step) ?? ordered[0];
      if (!startStep) throw new Error("Product Workflow has no start step");
      await use({
        workspaceId: workspace.id,
        workflowId: workflow.id,
        startStepId: startStep.id,
      });
    },
    { scope: "worker" },
  ],
});

export { expect };
