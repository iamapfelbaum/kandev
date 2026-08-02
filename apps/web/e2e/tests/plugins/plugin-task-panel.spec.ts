/**
 * E2E: the plugin task panel / kanban Edit submenu / card indicator hooks
 * added by this task (docs/plans/plugins/PLUGIN-API.md's registerTaskPanel /
 * registerTaskMenuAction / the "task-card-indicators" slot).
 *
 * Uses the same real `plugin-fixture` gRPC plugin package as
 * `plugins.spec.ts` — see that file's header for how
 * apps/backend/.build/kandev-plugin-e2e-1.0.0.tar.gz is built
 * (`make -C apps/backend e2e-plugin-package`). The fixture's `ui/bundle.js`
 * registers a "Notes" task panel (mobile-enabled), a `task-card-indicators`
 * slot component, and an "edit"-group kanban menu action — see
 * apps/backend/cmd/plugin-fixture/fixture-package/ui/bundle.js.
 */
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../fixtures/test-base";
import { SessionPage } from "../../pages/session-page";
import { KanbanPage } from "../../pages/kanban-page";
import type { ApiClient } from "../../helpers/api-client";

const PLUGIN_ID = "kandev-plugin-e2e";
const PANEL_ID = "notes";
const PACKAGE_PATH = path.resolve(
  __dirname,
  "../../../../../apps/backend/.build/kandev-plugin-e2e-1.0.0.tar.gz",
);

async function installFixturePlugin(page: Page): Promise<void> {
  await page.goto("/settings/plugins");
  await page.getByTestId("install-plugin-trigger").click();
  await expect(page.getByTestId("install-plugin-dialog")).toBeVisible();
  await page.getByTestId("install-plugin-tab-upload").click();
  await page.getByTestId("install-plugin-file-input").setInputFiles(PACKAGE_PATH);
  await page.getByTestId("install-plugin-upload-submit").click();
  await expect(page.getByTestId(`plugin-row-${PLUGIN_ID}`)).toBeVisible({ timeout: 15_000 });
}

async function uninstallViaApi(apiClient: ApiClient): Promise<void> {
  await apiClient.rawRequest("DELETE", `/api/plugins/${PLUGIN_ID}`).catch(() => undefined);
}

test.describe("Plugins — task panel / kanban Edit submenu / card indicator", () => {
  test.afterEach(async ({ apiClient }) => {
    await uninstallViaApi(apiClient);
  });

  test("registerTaskPanel: opens from the + menu, round-trips through host.storage, and survives a reload (AC1, AC3, AC19)", async ({
    testPage,
    apiClient,
    seedData,
  }) => {
    test.setTimeout(90_000);

    await installFixturePlugin(testPage);

    // A repo-backed task with an agent (not a bare createTask) so the task
    // gets a real environment id — the dockview per-env layout persistence
    // this test exercises (AC3) is keyed by envId and is a no-op without one,
    // same as every other layout-persistence-across-reload spec.
    const seedTask = await apiClient.createTaskWithAgent(
      seedData.workspaceId,
      "Plugin panel seed task",
      seedData.agentProfileId,
      {
        workflow_id: seedData.workflowId,
        workflow_step_id: seedData.startStepId,
        repository_ids: [seedData.repositoryId],
      },
    );
    await testPage.goto(`/t/${seedTask.id}`);
    const session = new SessionPage(testPage);
    await session.waitForLoad();

    // --- AC1: the "+" menu shows a "Notes" row; opening it renders the
    // plugin's Component as a real dockview panel. ---
    await session.addPanelButton().click();
    const addPanelRow = session.addPanelPluginItem(PLUGIN_ID, PANEL_ID);
    await expect(addPanelRow).toBeVisible();
    await expect(addPanelRow).toHaveText(/Notes/);
    await addPanelRow.click();

    const notesEditor = testPage.getByTestId("e2e-notes-panel");
    await expect(notesEditor).toBeVisible({ timeout: 10_000 });
    await expect(notesEditor).toHaveValue("");

    // --- AC19: host.storage.set/get round-trip through the real backend
    // (the fixture debounces ~150ms before writing). ---
    await notesEditor.fill("hello from e2e");
    await expect
      .poll(
        async () => {
          const res = await apiClient.rawRequest(
            "GET",
            `/api/plugins/${PLUGIN_ID}/user-state/task/${seedTask.id}/note`,
          );
          if (res.status !== 200) return null;
          const body = (await res.json()) as { value: string };
          return body.value;
        },
        { timeout: 10_000, intervals: [250, 500, 1000] },
      )
      .toBe("hello from e2e");

    // --- AC3: reloading restores the panel at the same id/title/position —
    // the layout was saved with the open plugin panel. Wait on the restored
    // panel directly rather than session.waitForLoad() (which gates on the
    // chat panel specifically) — the agent-backed environment can take a
    // moment to reconnect post-reload, and that reconnection isn't what
    // this assertion is about. ---
    await testPage.reload();
    await expect(testPage.getByTestId("e2e-notes-panel")).toBeVisible({ timeout: 20_000 });
    await expect(testPage.getByTestId("e2e-notes-panel")).toHaveValue("hello from e2e", {
      timeout: 10_000,
    });
  });

  test("disabling the plugin closes its open panel and removes the + menu row (AC4)", async ({
    testPage,
    apiClient,
    seedData,
  }) => {
    test.setTimeout(90_000);

    await installFixturePlugin(testPage);
    const pluginRow = testPage.getByTestId(`plugin-row-${PLUGIN_ID}`);

    const seedTask = await apiClient.createTask(seedData.workspaceId, "Plugin panel disable task", {
      workflow_id: seedData.workflowId,
      workflow_step_id: seedData.startStepId,
    });
    await testPage.goto(`/t/${seedTask.id}`);
    const session = new SessionPage(testPage);
    await session.waitForLoad();

    await session.addPanelButton().click();
    await session.addPanelPluginItem(PLUGIN_ID, PANEL_ID).click();
    await expect(testPage.getByTestId("e2e-notes-panel")).toBeVisible({ timeout: 10_000 });

    const consoleErrors: string[] = [];
    testPage.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await testPage.goto("/settings/plugins");
    await pluginRow.getByRole("button", { name: "Disable" }).click();
    await expect(pluginRow.getByText("Disabled", { exact: true })).toBeVisible({ timeout: 10_000 });

    await testPage.goto(`/t/${seedTask.id}`);
    await session.waitForLoad();
    await expect(testPage.getByTestId("e2e-notes-panel")).toHaveCount(0);
    await session.addPanelButton().click();
    await expect(session.addPanelPluginItem(PLUGIN_ID, PANEL_ID)).toHaveCount(0);
    expect(consoleErrors).toEqual([]);
  });

  test("registerTaskMenuAction: the kanban card Edit item becomes a submenu, and the plugin action runs (AC9)", async ({
    testPage,
    apiClient,
    seedData,
  }) => {
    test.setTimeout(90_000);

    await installFixturePlugin(testPage);

    const seedTask = await apiClient.createTask(seedData.workspaceId, "Plugin edit menu task", {
      workflow_id: seedData.workflowId,
      workflow_step_id: seedData.startStepId,
    });
    await testPage.goto("/");
    const kanban = new KanbanPage(testPage);
    await expect(kanban.board).toBeVisible({ timeout: 15_000 });

    await kanban.taskCard(seedTask.id).click({ button: "right" });
    const editSubmenu = testPage.getByTestId("kanban-edit-submenu");
    await expect(editSubmenu).toBeVisible();
    await editSubmenu.click();

    await expect(testPage.getByRole("menuitem", { name: "Edit task" })).toBeVisible();
    const pluginAction = testPage.getByRole("menuitem", { name: "Enhance notes" });
    await expect(pluginAction).toBeVisible();
    await pluginAction.click();

    await expect
      .poll(
        async () => {
          const res = await apiClient.rawRequest(
            "GET",
            `/api/plugins/${PLUGIN_ID}/user-state/task/${seedTask.id}/note`,
          );
          if (res.status !== 200) return null;
          const body = (await res.json()) as { value: string };
          return body.value;
        },
        { timeout: 10_000, intervals: [250, 500, 1000] },
      )
      .toBe("Enhanced via plugin action");
  });

  test("task-card-indicators slot renders the plugin's indicator on the kanban card (AC13)", async ({
    testPage,
    apiClient,
    seedData,
  }) => {
    test.setTimeout(60_000);

    await installFixturePlugin(testPage);

    const seedTask = await apiClient.createTask(
      seedData.workspaceId,
      "Plugin card indicator task",
      {
        workflow_id: seedData.workflowId,
        workflow_step_id: seedData.startStepId,
      },
    );
    await testPage.goto("/");
    const kanban = new KanbanPage(testPage);
    await expect(kanban.board).toBeVisible({ timeout: 15_000 });

    const indicator = kanban.taskCard(seedTask.id).getByTestId("e2e-card-indicator");
    await expect(indicator).toBeVisible({ timeout: 15_000 });
    await expect(indicator).toHaveAttribute("data-task-id", seedTask.id);
  });
});
