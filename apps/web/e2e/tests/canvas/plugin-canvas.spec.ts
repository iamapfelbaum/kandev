import { expect, test } from "../../fixtures/test-base";
import {
  approvePendingCanvas,
  enableCanvasFeature,
  removeCanvas,
  seedTaskCanvas,
} from "./canvas-fixture";

test.describe("Plugin-backed canvases in the desktop task workbench", () => {
  test("opens an active task canvas from the Dockview + menu", async ({
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
      const activeCanvas = seeded.canvas.pending_release
        ? await approvePendingCanvas(apiClient, seeded.canvas)
        : seeded.canvas;

      await expect(testPage.getByTestId("dockview-task-layout")).toBeVisible();
      await seeded.session.addPanelButton().click();

      const canvasItem = testPage.getByTestId(`add-panel-canvas-item-${activeCanvas.id}`);
      await expect(canvasItem).toBeVisible();
      await expect(canvasItem).toHaveText(/E2E Plugin Canvas/);
      await canvasItem.click();

      await expect(testPage.getByTestId("canvas-host-route")).toBeVisible({ timeout: 20_000 });
      await expect(testPage.getByTestId("canvas-host-state")).toHaveText("Ready");
      await expect(testPage.getByTestId("web-app-frame")).toHaveAttribute(
        "data-frame-state",
        "ready",
        { timeout: 20_000 },
      );
      await expect(testPage.locator('iframe[title="E2E Plugin Canvas"]')).toBeVisible();

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
            }, activeCanvas.id),
          { timeout: 10_000 },
        )
        .toEqual({
          id: `canvas:${activeCanvas.id}`,
          component: "canvas",
          canvasId: activeCanvas.id,
        });
    } finally {
      if (canvasId) await removeCanvas(apiClient, canvasId);
      await releaseFeature();
    }
  });
});
