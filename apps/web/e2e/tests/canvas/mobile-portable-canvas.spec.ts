import { expect, test } from "../../fixtures/test-base";

type CanvasRecord = { id: string };

test("keeps canvas settings and the direct canvas route touch-friendly on mobile", async ({
  testPage,
  seedData,
  apiClient,
  prCapture,
}) => {
  const response = await apiClient.rawRequest(
    "POST",
    `/api/v1/workspaces/${encodeURIComponent(seedData.workspaceId)}/canvases`,
    { title: `Mobile canvas ${Date.now()}` },
  );
  expect(response.ok).toBe(true);
  const canvas = (await response.json()) as CanvasRecord;

  try {
    expect(testPage.viewportSize()).toMatchObject({ width: 393 });
    await testPage.goto(`/settings/workspaces/${seedData.workspaceId}/canvases`);
    const settings = testPage.getByTestId("canvas-settings-page");
    await expect(settings).toBeVisible({ timeout: 15_000 });

    for (const name of [/new canvas/i, /import canvas/i]) {
      const box = await testPage.getByRole("button", { name }).boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    await prCapture.screenshot("mobile-canvas-settings", {
      caption: "Mobile canvas settings keeps New and Import actions visible above vertical cards.",
      fullPage: true,
    });

    await testPage.goto(`/canvases/${encodeURIComponent(canvas.id)}`);
    const canvasPage = testPage.getByTestId("canvas-page");
    await expect(canvasPage).toBeVisible({ timeout: 15_000 });
    await expect(canvasPage).toHaveClass(/h-dvh/);
    await prCapture.screenshot("mobile-canvas-route", {
      caption: "The focused mobile canvas uses a full-height route with contained scrolling.",
    });

    const scrollOwnerCount = await canvasPage.evaluate(
      (root) =>
        [root, ...Array.from(root.querySelectorAll("*"))].filter((element) => {
          const overflow = getComputedStyle(element).overflowY;
          return overflow === "auto" || overflow === "scroll";
        }).length,
    );
    expect(scrollOwnerCount).toBe(1);
  } finally {
    await apiClient.rawRequest("DELETE", `/api/v1/canvases/${encodeURIComponent(canvas.id)}`);
  }
});
