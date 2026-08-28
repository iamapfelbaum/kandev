import { expect, test } from "../../fixtures/test-base";
import {
  approvePendingCanvas,
  canvasHref,
  enableCanvasFeature,
  getCanvas,
  removeCanvas,
  promoteCanvas,
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
    const canvasIds: string[] = [];
    try {
      const seeded = await seedTaskCanvas(testPage, apiClient, seedData, true);
      canvasIds.push(seeded.canvas.id);
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
      const fixture = testPage.frameLocator('iframe[title="E2E Plugin Canvas"]');
      await expect(fixture.getByTestId("canvas-fixture-script")).toHaveText("inline-ready");
      await expect(fixture.getByTestId("canvas-fixture-context")).toHaveText(seeded.taskId);
      await expect(fixture.getByTestId("canvas-fixture-sse-status")).toHaveText("connected");

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

      const secondSeeded = await seedTaskCanvas(testPage, apiClient, seedData, true);
      canvasIds.push(secondSeeded.canvas.id);
      const secondApproved = secondSeeded.canvas.pending_release
        ? await approvePendingCanvas(apiClient, secondSeeded.canvas)
        : secondSeeded.canvas;
      await promoteCanvas(apiClient, secondApproved);

      await testPage.goto(canvasHref(activeCanvas.id));
      await expect(testPage.getByTestId("canvas-host-route")).toBeVisible({ timeout: 20_000 });
      await expect(testPage.getByTestId("web-app-frame")).toHaveAttribute(
        "data-frame-state",
        "ready",
        { timeout: 20_000 },
      );
      await testPage.getByTestId("canvas-mobile-actions").tap();
      const picker = testPage.getByTestId("canvas-mobile-picker");
      await expect(picker).toBeVisible();
      const secondCanvasItem = picker.getByTestId(`canvas-mobile-picker-item-${secondApproved.id}`);
      await expect(secondCanvasItem).toBeVisible();
      expect((await secondCanvasItem.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await secondCanvasItem.tap();

      await expect(testPage).toHaveURL(new RegExp(`${canvasHref(secondApproved.id)}$`));
      await expect(testPage.getByTestId("canvas-host-route")).toBeVisible({ timeout: 20_000 });
      await expect(testPage.getByTestId("web-app-frame")).toHaveAttribute(
        "data-frame-state",
        "ready",
        { timeout: 20_000 },
      );
      await testPage.getByTestId("canvas-mobile-actions").tap();
      await expect(testPage.getByTestId(`canvas-mobile-picker-item-${canvasIds[0]}`)).toBeVisible();
      await expect(
        testPage.getByRole("button", { name: "Releases and permissions", exact: true }),
      ).toBeVisible();
    } finally {
      await Promise.all(canvasIds.map((canvasId) => removeCanvas(apiClient, canvasId)));
      await releaseFeature();
    }
  });
});
