import { expect, test } from "../../fixtures/test-base";
import { enableCanvasFeature, removeCanvas, seedTaskCanvas } from "./canvas-fixture";

test.describe("Plugin-backed canvases in the desktop task workbench", () => {
  test("discovers, reviews, and operates the first task canvas from the workbench", async ({
    testPage,
    apiClient,
    backend,
    seedData,
  }) => {
    test.setTimeout(150_000);

    const releaseFeature = await enableCanvasFeature(backend, apiClient, seedData.workspaceId);
    let canvasId: string | undefined;
    try {
      const seeded = await seedTaskCanvas(testPage, apiClient, seedData);
      canvasId = seeded.canvas.id;

      await expect(testPage.getByTestId("dockview-task-layout")).toBeVisible();
      await seeded.session.addPanelButton().click();

      const canvasItem = testPage.getByTestId(`add-panel-canvas-item-${seeded.canvas.id}`);
      await expect(canvasItem).toBeVisible();
      await expect(canvasItem).toHaveText(/E2E Plugin Canvas/);
      await canvasItem.click();

      await expect(testPage.getByTestId("canvas-host-route")).toBeVisible({ timeout: 20_000 });
      await expect(testPage.getByTestId("canvas-host-state")).toHaveText(
        "Permission review required",
      );
      await testPage.getByRole("button", { name: "Releases and permissions", exact: true }).click();

      const releasesDialog = testPage.getByTestId("canvas-releases-dialog");
      await expect(releasesDialog).toBeVisible();
      await expect(
        releasesDialog.getByTestId(
          `canvas-release-permissions-${seeded.canvas.pending_release?.id}`,
        ),
      ).toBeVisible();
      await releasesDialog.getByRole("button", { name: "Approve release", exact: true }).click();
      const closeReleasesDialog = releasesDialog
        .locator('[data-slot="dialog-footer"]')
        .getByRole("button", { name: "Close", exact: true });
      await expect(closeReleasesDialog).toBeVisible();
      await closeReleasesDialog.click();

      await expect(testPage.getByTestId("canvas-host-state")).toHaveText("Ready", {
        timeout: 20_000,
      });
      await expect(testPage.getByTestId("web-app-frame")).toHaveAttribute(
        "data-frame-state",
        "ready",
        { timeout: 20_000 },
      );
      const fixture = testPage.frameLocator('iframe[title="E2E Plugin Canvas"]');
      await expect(fixture.getByTestId("canvas-fixture-script")).toHaveText("inline-ready");
      await expect(fixture.getByTestId("canvas-fixture-context")).toHaveText(seeded.taskId);
      await expect(fixture.getByTestId("canvas-fixture-task-count")).toHaveText("1");
      await expect(fixture.getByTestId("canvas-fixture-workflow-count")).toHaveText("1");
      await expect(fixture.getByTestId("canvas-fixture-step-id")).not.toHaveText("loading");
      await expect(fixture.getByTestId("canvas-fixture-sse-status")).toHaveText("connected");

      await fixture.getByTestId("canvas-fixture-continue").dispatchEvent("click");
      await expect(fixture.getByTestId("canvas-fixture-message-status")).toHaveText("accepted");

      await fixture.getByTestId("canvas-fixture-move").dispatchEvent("click");
      await expect(fixture.getByTestId("canvas-fixture-move-status")).toHaveText(/moved:/);
      await expect
        .poll(async () =>
          Number(await fixture.getByTestId("canvas-fixture-sse-events").textContent()),
        )
        .toBeGreaterThan(0);

      await fixture.getByTestId("canvas-fixture-state").dispatchEvent("click");
      await expect(fixture.getByTestId("canvas-fixture-state-status")).toHaveText(
        /conflict-recovered:/,
      );

      await fixture.getByTestId("canvas-fixture-reconnect").dispatchEvent("click");
      await expect(fixture.getByTestId("canvas-fixture-sse-status")).toHaveText("connected");
      await fixture.getByTestId("canvas-fixture-resync").dispatchEvent("click");
      await expect(fixture.getByTestId("canvas-fixture-sse-resync")).toHaveText("received");

      await expect
        .poll(
          () =>
            testPage.evaluate((id) => {
              const dockview = (
                window as unknown as {
                  __dockviewApi__?: {
                    panels?: Array<{
                      id: string;
                      api?: { component?: string };
                      params?: Record<string, unknown>;
                    }>;
                  };
                }
              ).__dockviewApi__;
              const panel = dockview?.panels?.find((candidate) => candidate.id === `canvas:${id}`);
              return panel
                ? {
                    id: panel.id,
                    component: panel.api?.component,
                    canvasId: panel.params?.canvasId,
                  }
                : null;
            }, seeded.canvas.id),
          { timeout: 10_000 },
        )
        .toEqual({
          id: `canvas:${seeded.canvas.id}`,
          component: "canvas",
          canvasId: seeded.canvas.id,
        });
    } finally {
      if (canvasId) await removeCanvas(apiClient, canvasId);
      await releaseFeature();
    }
  });
});
