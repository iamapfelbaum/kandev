import fs from "node:fs";
import path from "node:path";
import { expect, test } from "../../fixtures/test-base";
import type { ApiClient } from "../../helpers/api-client";

type CanvasRecord = { id: string; title: string; workspace_id: string };

async function createCanvas(
  apiClient: ApiClient,
  workspaceId: string,
  title: string,
): Promise<CanvasRecord> {
  const response = await apiClient.rawRequest(
    "POST",
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/canvases`,
    { title },
  );
  expect(response.ok).toBe(true);
  return (await response.json()) as CanvasRecord;
}

async function removeCanvas(apiClient: ApiClient, canvasId: string): Promise<void> {
  await apiClient.rawRequest("DELETE", `/api/v1/canvases/${encodeURIComponent(canvasId)}`);
}

test.describe("Portable workspace canvases", () => {
  test("creates from settings, exports a portable file, and appears in the scoped sidebar", async ({
    testPage,
    seedData,
    apiClient,
    backend,
    prCapture,
  }) => {
    const title = `Portable canvas ${Date.now()}`;
    let canvasId: string | undefined;
    let importedCanvasId: string | undefined;

    try {
      await testPage.goto(`/settings/workspaces/${seedData.workspaceId}/canvases`);
      const settings = testPage.getByTestId("canvas-settings-page");
      await expect(settings).toBeVisible({ timeout: 15_000 });

      await testPage.getByRole("button", { name: /new canvas/i }).click();
      await testPage.getByLabel(/canvas title/i).fill(title);
      await testPage.getByRole("button", { name: /create canvas/i }).click();
      await expect(testPage.getByTestId("canvas-page")).toBeVisible({ timeout: 15_000 });
      await expect(testPage.getByRole("heading", { name: title })).toBeVisible();

      canvasId = decodeURIComponent(new URL(testPage.url()).pathname.split("/").pop() ?? "");
      expect(canvasId).not.toBe("");

      await testPage.goto(`/settings/workspaces/${seedData.workspaceId}/canvases`);
      const row = testPage.getByTestId(`canvas-settings-row-${canvasId}`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await prCapture.screenshot("desktop-canvas-settings", {
        caption:
          "Workspace settings keeps canvas management, portability, and task links together.",
        fullPage: true,
      });

      const downloadPromise = testPage.waitForEvent("download");
      await row.getByRole("button", { name: /^export$/i }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe("canvas.kandev-canvas");
      const exportPath = path.join(backend.tmpDir, `canvas-${Date.now()}.kandev-canvas`);
      await download.saveAs(exportPath);
      const portable = JSON.parse(fs.readFileSync(exportPath, "utf8")) as {
        format: string;
        canvas: { title: string; blocks: unknown[] };
      };
      expect(portable).toMatchObject({
        format: "kandev.canvas",
        canvas: { title, blocks: [] },
      });
      expect(JSON.stringify(portable)).not.toContain(canvasId);

      await testPage.getByRole("button", { name: /import canvas/i }).click();
      const importDialog = testPage.getByRole("dialog");
      await importDialog.locator('input[type="file"]').setInputFiles(exportPath);
      await importDialog.getByTestId("canvas-import-submit").click();
      await expect(testPage.getByTestId("canvas-page")).toBeVisible({ timeout: 15_000 });
      importedCanvasId = decodeURIComponent(
        new URL(testPage.url()).pathname.split("/").pop() ?? "",
      );
      expect(importedCanvasId).not.toBe(canvasId);
      await testPage.goto(`/canvases/${encodeURIComponent(canvasId)}`);

      await expect(testPage.getByTestId("canvas-page")).toBeVisible({ timeout: 15_000 });
      await testPage.getByRole("button", { name: /add markdown block/i }).click();
      await expect(testPage.getByTestId(/canvas-block-/)).toHaveCount(1, { timeout: 15_000 });

      const importedResponse = await apiClient.rawRequest(
        "GET",
        `/api/v1/canvases/${encodeURIComponent(importedCanvasId)}`,
      );
      expect(importedResponse.ok).toBe(true);
      await expect(importedResponse.json()).resolves.toMatchObject({ blocks: [] });

      await testPage.goto("/");
      const sidebar = testPage.getByTestId("app-sidebar");
      const canvasesHeader = sidebar.getByRole("button", { name: /^canvases/i });
      await expect(canvasesHeader).toHaveAttribute("aria-expanded", "false");
      await canvasesHeader.click();
      await expect(sidebar.getByTestId(`sidebar-canvas-${canvasId}`)).toBeVisible({
        timeout: 15_000,
      });
      await expect(sidebar.getByTestId("canvases-settings")).toHaveAttribute(
        "href",
        `/settings/workspaces/${seedData.workspaceId}/canvases`,
      );
      await prCapture.screenshot("desktop-canvas-sidebar", {
        caption:
          "The folded desktop sidebar exposes the active workspace canvas and settings shortcut.",
      });
    } finally {
      if (canvasId) await removeCanvas(apiClient, canvasId);
      if (importedCanvasId) await removeCanvas(apiClient, importedCanvasId);
    }
  });

  test("removes a canvas from workspace settings", async ({ testPage, seedData, apiClient }) => {
    const canvas = await createCanvas(
      apiClient,
      seedData.workspaceId,
      `Remove canvas ${Date.now()}`,
    );
    try {
      await testPage.goto(`/settings/workspaces/${seedData.workspaceId}/canvases`);
      const row = testPage.getByTestId(`canvas-settings-row-${canvas.id}`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      testPage.once("dialog", (dialog) => {
        void dialog.accept();
      });
      await row.getByRole("button", { name: /^remove$/i }).click();
      await expect(row).toHaveCount(0, { timeout: 15_000 });
    } finally {
      await removeCanvas(apiClient, canvas.id);
    }
  });
});
