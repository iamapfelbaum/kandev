import { defineConfig, devices } from "@playwright/test";
import os from "node:os";
import path from "node:path";

const artifactRoot =
  process.env.KANDEV_HIGHLIGHT_ARTIFACT_ROOT ??
  path.join(os.tmpdir(), `kandev-highlight-playwright-${process.pid}`);

export default defineConfig({
  testDir: ".",
  testMatch: "capture.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 180_000,
  reporter: "list",
  outputDir: path.join(artifactRoot, "playwright"),
  projects: [
    {
      name: "highlight-capture",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
