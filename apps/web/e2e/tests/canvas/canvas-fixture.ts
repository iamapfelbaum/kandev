import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { BackendContext } from "../../fixtures/backend";
import type { SeedData } from "../../fixtures/test-base";
import type { ApiClient } from "../../helpers/api-client";
import { SessionPage } from "../../pages/session-page";

export class CanvasFixtureUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasFixtureUnavailable";
  }
}

export type CanvasRecord = {
  id: string;
  title: string;
  workspace_id: string;
  task_id?: string;
  scope_kind?: string;
  status?: string;
  active_release_id?: string;
  active_release_status?: string;
  pending_release?: {
    id: string;
    validation_status?: string;
  };
};

export type SeededCanvas = {
  taskId: string;
  taskSessionId: string;
  canvas: CanvasRecord;
  session: SessionPage;
};

export async function readCanvasFeature(apiClient: ApiClient): Promise<boolean | null> {
  const response = await apiClient.rawRequest("GET", "/api/v1/features");
  if (!response.ok) return null;
  const body = (await response.json()) as { canvases?: unknown };
  return typeof body.canvases === "boolean" ? body.canvases : null;
}

export async function enableCanvasFeature(
  backend: BackendContext,
  apiClient: ApiClient,
  workspaceId: string,
): Promise<() => Promise<void>> {
  const release = await backend.useEnv({ KANDEV_FEATURES_CANVASES: "true" });
  const enabled = await readCanvasFeature(apiClient);
  if (enabled !== true) {
    await release();
    throw new CanvasFixtureUnavailable(
      "Canvas fixture skipped: KANDEV_FEATURES_CANVASES could not be enabled.",
    );
  }

  const probe = await apiClient.rawRequest(
    "GET",
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/canvases`,
  );
  if (!probe.ok) {
    await release();
    throw new CanvasFixtureUnavailable(
      `Canvas fixture skipped: canvas API is unavailable (${probe.status}).`,
    );
  }
  return release;
}

async function listTaskCanvases(apiClient: ApiClient, taskId: string): Promise<CanvasRecord[]> {
  const response = await apiClient.rawRequest(
    "GET",
    `/api/v1/tasks/${encodeURIComponent(taskId)}/canvases`,
  );
  if (!response.ok) {
    throw new Error(`Canvas task discovery failed (${response.status}).`);
  }
  const body = (await response.json()) as { canvases?: CanvasRecord[] };
  return body.canvases ?? [];
}

export async function getCanvas(
  apiClient: ApiClient,
  canvasId: string,
): Promise<CanvasRecord | null> {
  const response = await apiClient.rawRequest(
    "GET",
    `/api/v1/canvases/${encodeURIComponent(canvasId)}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Canvas lookup failed (${response.status}).`);
  }
  return (await response.json()) as CanvasRecord;
}

async function waitForSessionWorkspace(
  apiClient: ApiClient,
  taskId: string,
  sessionId: string,
): Promise<string> {
  let workspacePath = "";
  await expect
    .poll(
      async () => {
        const { sessions } = await apiClient.listTaskSessions(taskId);
        const session = sessions.find((candidate) => candidate.id === sessionId);
        workspacePath =
          session?.workspace_path ??
          session?.worktree_path ??
          session?.worktrees?.find((worktree) => worktree.worktree_path)?.worktree_path ??
          "";
        return workspacePath;
      },
      { timeout: 30_000, message: "The canvas task session did not expose a local workspace." },
    )
    .toMatch(/\S/);
  return path.resolve(workspacePath);
}

function canvasManifest(canvas: CanvasRecord): string {
  const compactId = canvas.id.replaceAll("-", "").slice(0, 12);
  return [
    `id: "canvas-${compactId}"`,
    "api_version: 2",
    'version: "1.0.0"',
    'display_name: "E2E Plugin Canvas"',
    'description: "Canvas fixture for Playwright acceptance coverage."',
    'author: "Kandev E2E"',
    "ui:",
    "  web_apps:",
    "    - key: main",
    '      title: "E2E Plugin Canvas"',
    "      entry: index.html",
    "      placements:",
    "        - task-canvas",
    "        - workspace-canvas",
    "capabilities:",
    "  api_read:",
    "    - tasks",
    "    - workflows",
    "  api_write:",
    "    - messages",
    "",
  ].join("\n");
}

function writeCanvasSource(workspacePath: string, canvas: CanvasRecord): void {
  const sourceDirectory = path.join(workspacePath, ".kandev", "canvases", canvas.id);
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.writeFileSync(path.join(sourceDirectory, "manifest.yaml"), canvasManifest(canvas));
  fs.writeFileSync(
    path.join(sourceDirectory, "index.html"),
    [
      "<!doctype html>",
      '<html lang="en">',
      '  <head><meta charset="utf-8"><title>E2E Plugin Canvas</title></head>',
      '  <body><main data-testid="canvas-fixture-content"><h1>E2E Plugin Canvas</h1></main></body>',
      "</html>",
      "",
    ].join("\n"),
  );
}

export async function seedTaskCanvas(
  page: Page,
  apiClient: ApiClient,
  seedData: SeedData,
  useMobileSubmit = false,
): Promise<SeededCanvas> {
  const title = "E2E Plugin Canvas";
  const script = [
    `e2e:mcp:kandev:create_canvas_kandev(${JSON.stringify({
      title,
      summary: "Canvas fixture for Playwright acceptance coverage.",
    })})`,
    'e2e:message("Canvas created.")',
  ].join("\n");
  const task = await apiClient.createTaskWithAgent(
    seedData.workspaceId,
    "E2E Plugin Canvas Task",
    seedData.agentProfileId,
    {
      description: script,
      workflow_id: seedData.workflowId,
      workflow_step_id: seedData.startStepId,
      repository_ids: [seedData.repositoryId],
    },
  );
  if (!task.session_id) {
    throw new CanvasFixtureUnavailable("Canvas fixture skipped: task session was not created.");
  }

  await page.goto(`/t/${encodeURIComponent(task.id)}`);
  const session = new SessionPage(page);
  await session.waitForLoad();
  await session.waitForChatIdle({ timeout: 45_000 });

  let canvas: CanvasRecord | null = null;
  await expect
    .poll(
      async () => {
        const canvases = await listTaskCanvases(apiClient, task.id);
        canvas = canvases.find((candidate) => candidate.title === title) ?? null;
        return canvas?.id ?? null;
      },
      { timeout: 30_000, message: "The mock agent did not create a task canvas." },
    )
    .not.toBeNull();
  if (!canvas) throw new Error("The canvas fixture returned no canvas record.");

  const workspacePath = await waitForSessionWorkspace(apiClient, task.id, task.session_id);
  writeCanvasSource(workspacePath, canvas);
  const sourcePath = `.kandev/canvases/${canvas.id}`;
  const publishScript = `e2e:mcp:kandev:publish_canvas_kandev(${JSON.stringify({
    canvas_id: canvas.id,
    source_path: sourcePath,
  })})`;
  if (useMobileSubmit) {
    await session.sendMessageViaButton(publishScript);
  } else {
    await session.sendMessage(publishScript);
  }
  await session.waitForChatIdle({ timeout: 45_000 });

  let publishedCanvas: CanvasRecord | null = null;
  await expect
    .poll(
      async () => {
        publishedCanvas = await getCanvas(apiClient, canvas!.id);
        return Boolean(
          publishedCanvas?.pending_release ||
          publishedCanvas?.active_release_id ||
          publishedCanvas?.active_release_status,
        );
      },
      { timeout: 30_000, message: "The mock agent did not publish the canvas package." },
    )
    .toBe(true);
  if (!publishedCanvas) throw new Error("The canvas publish response was empty.");

  return {
    taskId: task.id,
    taskSessionId: task.session_id,
    canvas: publishedCanvas,
    session,
  };
}

export async function approvePendingCanvas(
  apiClient: ApiClient,
  canvas: CanvasRecord,
): Promise<CanvasRecord> {
  const pendingRelease = canvas.pending_release;
  if (!pendingRelease) throw new Error("The canvas has no pending release to approve.");
  const response = await apiClient.rawRequest(
    "POST",
    `/api/v1/canvases/${encodeURIComponent(canvas.id)}/releases/${encodeURIComponent(pendingRelease.id)}/approve`,
  );
  if (!response.ok) {
    throw new Error(`Canvas release approval failed (${response.status}).`);
  }

  let approvedCanvas: CanvasRecord | null = null;
  await expect
    .poll(
      async () => {
        approvedCanvas = await getCanvas(apiClient, canvas.id);
        return approvedCanvas?.active_release_status === "valid";
      },
      { timeout: 30_000, message: "The canvas release did not become active." },
    )
    .toBe(true);
  if (!approvedCanvas) throw new Error("The approved canvas record was empty.");
  return approvedCanvas;
}

export async function removeCanvas(apiClient: ApiClient, canvasId: string): Promise<void> {
  await apiClient.rawRequest("DELETE", `/api/v1/canvases/${encodeURIComponent(canvasId)}`);
}

export function canvasHref(canvasId: string): string {
  return `/canvases/${encodeURIComponent(canvasId)}`;
}
