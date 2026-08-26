import { expect, test } from "../../fixtures/test-base";
import type { ApiClient } from "../../helpers/api-client";

type CanvasRecord = { id: string; revision: number; blocks: Array<{ id: string }> };

async function createCanvas(apiClient: ApiClient, workspaceId: string): Promise<CanvasRecord> {
  const response = await apiClient.rawRequest(
    "POST",
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/canvases`,
    { title: `Typed canvas ${Date.now()}` },
  );
  expect(response.ok).toBe(true);
  return (await response.json()) as CanvasRecord;
}

async function addBlock(
  apiClient: ApiClient,
  canvas: CanvasRecord,
  type: string,
  state: unknown,
): Promise<CanvasRecord> {
  const response = await apiClient.rawRequest(
    "POST",
    `/api/v1/canvases/${encodeURIComponent(canvas.id)}/commands`,
    {
      command_id: `block-${type}-${Date.now()}-${Math.random()}`,
      base_revision: canvas.revision,
      action: "block.create",
      input: { type, state },
    },
  );
  const body = await response.text();
  expect(response.ok, body).toBe(true);
  return (JSON.parse(body) as { canvas: CanvasRecord }).canvas;
}

test("renders typed canvas blocks and exposes native editing controls", async ({
  testPage,
  seedData,
  apiClient,
}) => {
  let canvas = await createCanvas(apiClient, seedData.workspaceId);
  try {
    canvas = await addBlock(apiClient, canvas, "markdown", { markdown: "Notes" });
    canvas = await addBlock(apiClient, canvas, "checklist", {
      items: [{ id: "item-1", label: "Review", revision: 1, completed: false }],
    });
    canvas = await addBlock(apiClient, canvas, "kanban", {
      columns: [{ id: "todo", cards: [{ id: "card-1", title: "Ship", revision: 1 }] }],
    });
    canvas = await addBlock(apiClient, canvas, "metrics", {
      metrics: [{ id: "metric-1", name: "Coverage", value: 90, revision: 1 }],
    });
    canvas = await addBlock(apiClient, canvas, "timeline", {
      events: [{ id: "event-1", label: "Started", timestamp: "2026-08-26", revision: 1 }],
    });

    await testPage.goto(`/canvases/${encodeURIComponent(canvas.id)}`);
    const page = testPage.getByTestId("canvas-page");
    await expect(page).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(/canvas-block-/)).toHaveCount(5, { timeout: 15_000 });
    await expect(page.getByTestId(/canvas-checklist-items/)).toBeVisible();
    await expect(page.getByTestId("canvas-kanban-items")).toBeVisible();
    await expect(page.getByTestId(/canvas-metrics-items/)).toBeVisible();
    await expect(page.getByTestId(/canvas-timeline-items/)).toBeVisible();

    await expect(page.getByTestId("canvas-item-item-1")).toBeVisible();
    await page
      .getByTestId("canvas-item-item-1")
      .getByRole("button", { name: /toggle item/i })
      .click();
    await expect(page.getByTestId("canvas-item-item-1")).toContainText("Review");

    const markdownBlock = page
      .getByTestId(/canvas-block-/)
      .filter({ hasText: "Notes" })
      .first();
    await markdownBlock.getByRole("button", { name: /^edit$/i }).click();
    await expect(markdownBlock.getByTestId(/canvas-markdown-editor-/)).toBeVisible();
    await markdownBlock.getByRole("textbox", { name: /markdown editor/i }).fill("Updated notes");
    await markdownBlock.getByRole("button", { name: /^save$/i }).click();
    await expect(markdownBlock).toContainText("Updated notes");

    await expect(page.getByRole("button", { name: /move block down/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /delete block/i }).first()).toBeVisible();
  } finally {
    await apiClient.rawRequest("DELETE", `/api/v1/canvases/${encodeURIComponent(canvas.id)}`);
  }
});
