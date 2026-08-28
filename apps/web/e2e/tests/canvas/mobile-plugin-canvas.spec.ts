import { expect, test } from "../../fixtures/test-base";
import {
  approvePendingCanvas,
  canvasHref,
  enableCanvasFeature,
  getCanvas,
  removeCanvas,
  seedTaskCanvas,
} from "./canvas-fixture";

test.describe("Plugin-backed canvases on mobile", () => {
  test("uses a focused route, workspace navigation, and an inset action drawer", async ({
    testPage,
    apiClient,
    backend,
    seedData,
  }) => {
    test.setTimeout(180_000);

    const releaseFeature = await enableCanvasFeature(backend, apiClient, seedData.workspaceId);
    let canvasId: string | undefined;
    try {
      const seeded = await seedTaskCanvas(testPage, apiClient, seedData, true);
      canvasId = seeded.canvas.id;
      const activeCanvas = seeded.canvas.pending_release
        ? await approvePendingCanvas(apiClient, seeded.canvas)
        : seeded.canvas;
      const activeReleaseId = activeCanvas.active_release_id;

      await expect(testPage.getByTestId("dockview-task-layout")).toHaveCount(0);

      await testPage.goto(canvasHref(activeCanvas.id));
      await expect(testPage.getByTestId("canvas-host-route")).toBeVisible({ timeout: 20_000 });
      await expect(testPage.getByTestId("dockview-task-layout")).toHaveCount(0);
      await expect(testPage.getByTestId("web-app-frame")).toHaveAttribute(
        "data-frame-state",
        "ready",
        { timeout: 20_000 },
      );

      const actionsButton = testPage.getByTestId("canvas-mobile-actions");
      await expect(actionsButton).toBeVisible();
      expect((await actionsButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await actionsButton.tap();

      const actionsSheet = testPage.getByTestId("canvas-mobile-actions-sheet");
      await expect(actionsSheet).toBeVisible();
      const promoteButton = actionsSheet.getByRole("button", {
        name: "Promote canvas",
        exact: true,
      });
      await expect(promoteButton).toBeVisible();
      expect((await promoteButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await promoteButton.tap();

      const promotionDialog = testPage.getByTestId("canvas-promotion-dialog");
      await expect(promotionDialog).toBeVisible();
      await expect(promotionDialog.getByTestId("canvas-promotion-target-scope")).toHaveText(
        "workspace",
      );
      await promotionDialog.getByRole("button", { name: "Confirm promotion", exact: true }).tap();

      await expect
        .poll(async () => (await getCanvas(apiClient, activeCanvas.id))?.scope_kind ?? null)
        .toBe("workspace");
      await expect
        .poll(async () => (await getCanvas(apiClient, activeCanvas.id))?.active_release_id ?? null)
        .toBe(activeReleaseId ?? null);

      await testPage.goto("/");
      await expect(testPage.getByTestId("kanban-board")).toBeVisible({ timeout: 20_000 });
      const menuButton = testPage.getByRole("button", { name: "Open menu" });
      await expect(menuButton).toBeVisible();
      await menuButton.tap();

      const workspaceCanvas = testPage.getByTestId(`mobile-workspace-canvas-${activeCanvas.id}`);
      await expect(workspaceCanvas).toBeVisible({ timeout: 15_000 });
      expect((await workspaceCanvas.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await workspaceCanvas.tap();

      await expect(testPage).toHaveURL(new RegExp(`${canvasHref(activeCanvas.id)}$`));
      await expect(testPage.getByTestId("canvas-host-route")).toBeVisible({ timeout: 20_000 });
      await expect(testPage.getByTestId("dockview-task-layout")).toHaveCount(0);
      await expect(testPage.getByTestId("canvas-mobile-actions")).toBeVisible();
      await expect
        .poll(() =>
          testPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        )
        .toBe(true);
    } finally {
      if (canvasId) await removeCanvas(apiClient, canvasId);
      await releaseFeature();
    }
  });
});
