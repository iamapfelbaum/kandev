// Routing: /t/{taskId}. File starts with "mobile-" so it runs on the
// mobile-chrome Playwright project (Pixel 5 emulation) — see
// mobile-file-viewer.spec.ts's header for the convention.
//
// E2E: a mobileEnabled task panel (registerTaskPanel) gets a phone
// bottom-nav entry, and selecting it renders the plugin's Component
// full-width in the mobile panel area (AC7). Uses the same real
// `plugin-fixture` package as plugin-task-panel.spec.ts.
import path from "node:path";
import { expect, test } from "../../fixtures/test-base";
import { SessionPage } from "../../pages/session-page";

const PLUGIN_ID = "kandev-plugin-e2e";
const PACKAGE_PATH = path.resolve(
  __dirname,
  "../../../../../apps/backend/.build/kandev-plugin-e2e-1.0.0.tar.gz",
);

test.describe("Mobile plugin task panel", () => {
  test.afterEach(async ({ apiClient }) => {
    await apiClient.rawRequest("DELETE", `/api/plugins/${PLUGIN_ID}`).catch(() => undefined);
  });

  test("bottom-nav entry opens the plugin's Component full-width (AC7)", async ({
    testPage,
    apiClient,
    seedData,
  }) => {
    test.setTimeout(90_000);

    // Install through the real Settings > Plugins upload flow (reachable on
    // a phone via the settings menu sheet, same as mobile-plugin-nav.spec.ts).
    await testPage.goto("/settings/plugins");
    await testPage.getByTestId("install-plugin-trigger").click();
    await testPage.getByTestId("install-plugin-tab-upload").click();
    await testPage.getByTestId("install-plugin-file-input").setInputFiles(PACKAGE_PATH);
    await testPage.getByTestId("install-plugin-upload-submit").click();
    await expect(testPage.getByTestId(`plugin-row-${PLUGIN_ID}`)).toBeVisible({ timeout: 30_000 });

    // A repo-backed task with an agent (not a bare createTask) so the task
    // has a real session — the mobile bottom-nav panel switch this test
    // exercises is a no-op without one (handlePanelChange in
    // use-session-layout-state.ts guards on effectiveSessionId), same as
    // every other mobile-nav e2e spec (see mobile-terminal-keybar.spec.ts).
    const seedTask = await apiClient.createTaskWithAgent(
      seedData.workspaceId,
      "Mobile plugin panel task",
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

    // The mobileEnabled Notes panel appends a bottom-nav button after
    // Terminal, labelled with the registration's title.
    const notesNavButton = testPage.getByRole("button", { name: "Notes" });
    await expect(notesNavButton).toBeVisible({ timeout: 15_000 });
    expect((await notesNavButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);

    const notesEditor = testPage.getByTestId("e2e-notes-panel");
    // On mobile the bottom-nav button can be tapped before hydration wires
    // its handler; a lost tap leaves the panel unmounted (see
    // mobile-terminal-helpers.ts's tapTerminalTab/switchToTerminalPanel for
    // the same pattern). Re-tap once if the first tap didn't take.
    await notesNavButton.tap();
    if (!(await notesEditor.isVisible())) {
      await notesNavButton.tap();
    }
    await expect(notesEditor).toBeVisible({ timeout: 10_000 });
    await expect(notesEditor).toHaveAttribute("data-presentation", "mobile");

    // host.storage round-trips the same way it does on desktop.
    await notesEditor.fill("hello from mobile e2e");
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
      .toBe("hello from mobile e2e");
  });
});
