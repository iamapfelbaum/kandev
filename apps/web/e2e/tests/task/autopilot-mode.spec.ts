import { expect, test } from "../../fixtures/test-base";
import type { ApiClient } from "../../helpers/api-client";
import { useRegularMode } from "../../helpers/regular-mode";
import { KanbanPage } from "../../pages/kanban-page";
import { SessionPage } from "../../pages/session-page";

useRegularMode();

function parentQuestionScript(): string {
  const args = JSON.stringify({
    questions: [
      {
        id: "risk",
        title: "Risk",
        prompt: "Choose the safe path before I continue.",
        options: [
          {
            option_id: "safe",
            label: "Safe path",
            description: "Use the conservative implementation.",
          },
          {
            option_id: "fast",
            label: "Fast path",
            description: "Use the quicker implementation.",
          },
        ],
      },
    ],
    context: "The implementation has two valid paths.",
  });
  return `e2e:mcp:kandev:ask_parent_question_kandev(${args})`;
}

async function waitForSessionState(
  apiClient: ApiClient,
  taskId: string,
  state: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const { sessions } = await apiClient.listTaskSessions(taskId);
        return sessions[0]?.state ?? "";
      },
      { timeout: 60_000, message: `task ${taskId} should reach ${state}` },
    )
    .toBe(state);
}

test.describe("Task autopilot", () => {
  test("shows the profile, waits for the parent, and resumes once", async ({
    testPage,
    apiClient,
    seedData,
  }) => {
    test.setTimeout(120_000);

    const kanban = new KanbanPage(testPage);
    await kanban.goto();
    await kanban.createTaskButton.first().click();
    const createDialog = testPage.getByTestId("create-task-dialog");
    await expect(createDialog.getByTestId("autopilot-toggle-row")).toBeVisible();
    await expect(createDialog.getByRole("switch", { name: "Autopilot" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await createDialog.getByRole("button", { name: "Cancel", exact: true }).click();

    const parent = await apiClient.createTaskWithAgent(
      seedData.workspaceId,
      "Autopilot Parent",
      seedData.agentProfileId,
      {
        description: "/e2e:simple-message",
        workflow_id: seedData.workflowId,
        workflow_step_id: seedData.startStepId,
        repository_ids: [seedData.repositoryId],
      },
    );
    const child = await apiClient.createTaskWithAgent(
      seedData.workspaceId,
      "Autopilot Child",
      seedData.agentProfileId,
      {
        description: parentQuestionScript(),
        workflow_id: seedData.workflowId,
        workflow_step_id: seedData.startStepId,
        repository_ids: [seedData.repositoryId],
        parent_id: parent.id,
        workspace_mode: "inherit_parent",
        autopilot: true,
      },
    );

    const childTask = await apiClient.getTask(child.id);
    expect(childTask.autopilot).toBe(true);

    await testPage.goto(`/t/${parent.id}`);
    const parentSession = new SessionPage(testPage);
    await parentSession.waitForLoad();
    await waitForSessionState(apiClient, child.id, "WAITING_FOR_INPUT");
    const childRow = parentSession.sidebarTaskItem("Autopilot Child");
    await expect(childRow).toBeVisible({ timeout: 30_000 });
    await expect(childRow.getByTestId("task-autopilot-icon")).toBeVisible();
    await expect(childRow.getByTestId("task-state-waiting-for-input")).toBeVisible({
      timeout: 15_000,
    });

    await expect
      .poll(
        async () => {
          const parentSessions = await apiClient.listTaskSessions(parent.id);
          const parentMessages = await apiClient.listSessionMessages(parentSessions.sessions[0].id);
          return parentMessages.messages.some((message) =>
            message.content.includes("AUTOPILOT CHILD QUESTION"),
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    await expect
      .poll(
        async () => {
          const { sessions } = await apiClient.listTaskSessions(child.id);
          return sessions[0]?.state ?? "";
        },
        { timeout: 30_000, message: "parent answer should resume the child" },
      )
      .not.toBe("WAITING_FOR_INPUT");

    const childSession = new SessionPage(testPage);
    await testPage.goto(`/t/${child.id}`);
    await childSession.waitForLoad();
    await expect(childSession.chatStatusBar().getByTestId("chat-autopilot-chip")).toBeVisible({
      timeout: 15_000,
    });

    const childSessions = await apiClient.listTaskSessions(child.id);
    const childMessages = await apiClient.listSessionMessages(childSessions.sessions[0].id);
    const answeredQuestion = childMessages.messages.find(
      (message) => message.metadata?.status === "answered",
    );
    expect(answeredQuestion).toBeDefined();
  });
});
