import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

const requestPath = process.env.KANDEV_HIGHLIGHT_RUNTIME_REQUEST;
if (!requestPath || !path.isAbsolute(requestPath)) {
  throw new Error("KANDEV_HIGHLIGHT_RUNTIME_REQUEST must be an absolute trusted request path");
}

export default defineConfig({
  testDir: ".",
  testMatch: "pipeline-capture.spec.ts",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 180_000,
  reporter: "list",
  outputDir: path.join(path.dirname(requestPath), "playwright"),
  projects: [
    {
      name: "highlight-runtime-capture",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
