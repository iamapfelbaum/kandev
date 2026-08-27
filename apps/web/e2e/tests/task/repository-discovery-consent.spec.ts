import { expect, test } from "../../fixtures/test-base";
import fs from "node:fs";
import path from "node:path";

test.describe("Desktop repository discovery consent", () => {
  test("uses the native picker and keeps the discovery root recoverable", async ({
    testPage,
    apiClient,
    backend,
    seedData,
  }) => {
    test.setTimeout(120_000);
    const selectedRoot = fs.mkdtempSync(path.join(backend.tmpDir, "desktop-discovery-root-"));
    let rootSaved = false;
    let directoryListingRequests = 0;
    const onRequest = (request: { url(): string; method(): string }) => {
      if (request.url().includes("/api/v1/fs/list-dir") && request.method() === "GET") {
        directoryListingRequests += 1;
      }
    };

    try {
      await backend.restart({ KANDEV_DESKTOP_RUNTIME: "true" });
      await testPage.addInitScript(
        ({ selectedPath }: { selectedPath: string }) => {
          const win = window as typeof window & {
            __TAURI_INTERNALS__?: {
              invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
              transformCallback: () => number;
            };
            __kandevFolderPickerCommands?: string[];
          };
          const commands: string[] = [];
          win.__kandevFolderPickerCommands = commands;
          Object.defineProperty(win, "__TAURI_INTERNALS__", {
            configurable: true,
            value: {
              transformCallback: () => 1,
              invoke: async (command: string) => {
                commands.push(command);
                if (command === "pick_directory") {
                  return { status: "selected", path: selectedPath };
                }
                if (command === "plugin:event|listen") return 1;
                if (command === "get_native_notification_permission") return "granted";
                if (command === "request_native_notification_permission") return "granted";
                if (command === "get_update_state") {
                  return {
                    phase: "idle",
                    currentVersion: "",
                    latestVersion: null,
                    releaseNotes: null,
                    releaseUrl: null,
                    checkedAtEpochMs: null,
                    downloadedBytes: null,
                    totalBytes: null,
                    installSupported: false,
                    installUnsupportedReason: null,
                    error: null,
                  };
                }
                return null;
              },
            },
          });
        },
        { selectedPath: selectedRoot },
      );
      testPage.on("request", onRequest);

      await testPage.goto(`/settings/workspaces/${seedData.workspaceId}/repositories`);
      await testPage.getByRole("button", { name: "Add Local Repository" }).click();
      const dialog = testPage.getByRole("dialog", { name: "Add Local Repository" });
      const controls = dialog.getByTestId("discovery-root-controls");
      await expect(controls).toBeVisible();

      const addResponse = testPage.waitForResponse(
        (response) =>
          response.url().endsWith("/api/v1/repositories/discovery/roots") &&
          response.request().method() === "POST" &&
          response.ok(),
      );
      await controls
        .getByRole("button", { name: "Choose folders to discover repositories" })
        .click();
      expect((await addResponse).status()).toBe(201);
      rootSaved = true;

      await expect(controls.getByTitle(selectedRoot)).toBeVisible();
      expect(
        await testPage.evaluate(
          () =>
            (window as typeof window & { __kandevFolderPickerCommands?: string[] })
              .__kandevFolderPickerCommands ?? [],
        ),
      ).toContain("pick_directory");
      expect(directoryListingRequests).toBe(0);

      const refreshResponse = testPage.waitForResponse(
        (response) =>
          response.url().includes("/api/v1/workspaces/") &&
          response.url().endsWith("/repositories/discovery/refresh") &&
          response.request().method() === "POST" &&
          response.ok(),
      );
      await controls.getByRole("button", { name: "Refresh repositories" }).click();
      await refreshResponse;

      const removeResponse = testPage.waitForResponse(
        (response) =>
          response.url().includes("/api/v1/repositories/discovery/roots?") &&
          response.request().method() === "DELETE" &&
          response.ok(),
      );
      await controls.getByRole("button", { name: "Remove" }).click();
      await removeResponse;
      rootSaved = false;
      await expect(controls.getByTitle(selectedRoot)).toHaveCount(0);
    } finally {
      testPage.off("request", onRequest);
      if (rootSaved) {
        await apiClient
          .rawRequest(
            "DELETE",
            `/api/v1/repositories/discovery/roots?path=${encodeURIComponent(selectedRoot)}`,
          )
          .catch(() => undefined);
      }
      fs.rmSync(selectedRoot, { recursive: true, force: true });
      await backend.restart();
    }
  });
});
