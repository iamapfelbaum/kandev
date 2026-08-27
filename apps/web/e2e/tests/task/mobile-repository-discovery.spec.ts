import { expect, test } from "../../fixtures/test-base";
import fs from "node:fs";

test.describe("Mobile repository discovery consent", () => {
  test("uses the HTTP picker on a mobile browser connected to a desktop backend", async ({
    testPage,
    apiClient,
    backend,
    seedData,
  }) => {
    test.setTimeout(120_000);
    const homePath = fs.realpathSync(backend.tmpDir);
    let rootSaved = false;

    try {
      await backend.restart({ KANDEV_DESKTOP_RUNTIME: "true" });
      await testPage.setViewportSize({ width: 390, height: 844 });
      await testPage.goto(`/settings/workspaces/${seedData.workspaceId}/repositories`);
      await testPage.getByRole("button", { name: "Add Local Repository" }).click();

      const dialog = testPage.getByRole("dialog", { name: "Add Local Repository" });
      const controls = dialog.getByTestId("discovery-root-controls");
      await expect(controls).toBeVisible();

      const listingResponse = testPage.waitForResponse(
        (response) =>
          response.url().includes("/api/v1/fs/list-dir") &&
          response.request().method() === "GET" &&
          response.ok(),
      );
      await controls.getByTestId("folder-picker-trigger").tap();
      await listingResponse;
      const picker = testPage.getByTestId("folder-picker-popover");
      await expect(picker).toBeVisible();
      await expect(picker.getByTestId("folder-picker-choose")).toBeEnabled();

      const addResponse = testPage.waitForResponse(
        (response) =>
          response.url().endsWith("/api/v1/repositories/discovery/roots") &&
          response.request().method() === "POST" &&
          response.ok(),
      );
      await picker.getByTestId("folder-picker-choose").tap();
      expect((await addResponse).status()).toBe(201);
      rootSaved = true;

      await expect(controls.getByRole("button", { name: "Refresh repositories" })).toBeVisible();
      expect(
        await testPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    } finally {
      if (rootSaved) {
        await apiClient
          .rawRequest(
            "DELETE",
            `/api/v1/repositories/discovery/roots?path=${encodeURIComponent(homePath)}`,
          )
          .catch(() => undefined);
      }
      await backend.restart();
    }
  });
});
