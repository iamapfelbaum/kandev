import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchBlob: vi.fn(),
  fetchJson: vi.fn(),
}));

vi.mock("../client", () => mocks);

const WORKSPACE_CANVAS_PATH = "/api/v1/workspaces/workspace%2Fone/canvases";
const CANVAS_PATH = "/api/v1/canvases/canvas%2Fone";
const TASK_PATH = "/api/v1/canvases/canvas%2Fone/tasks/task%2Fone";
const WORKSPACE_ID = "workspace/one";
const CANVAS_ID = "canvas/one";
const TASK_ID = "task/one";

import {
  addCanvasTaskLink,
  applyCanvasCommand,
  archiveCanvas,
  createCanvas,
  exportCanvas,
  importCanvas,
  listCanvases,
  listCanvasEvents,
  listTaskCanvases,
  removeCanvas,
  removeCanvasTaskLink,
  renameCanvas,
} from "./canvas-api";

beforeEach(() => {
  mocks.fetchBlob.mockReset();
  mocks.fetchJson.mockReset();
  mocks.fetchJson.mockResolvedValue({ canvases: [] });
  mocks.fetchBlob.mockResolvedValue(new Blob());
});

describe("canvas API routes", () => {
  it("encodes workspace and task filters without widening the workspace scope", async () => {
    await listCanvases(WORKSPACE_ID, true);
    await listTaskCanvases(WORKSPACE_ID, TASK_ID);

    expect(mocks.fetchJson.mock.calls[0]?.[0]).toBe(
      `${WORKSPACE_CANVAS_PATH}?include_archived=true`,
    );
    expect(mocks.fetchJson.mock.calls[1]?.[0]).toBe(`${WORKSPACE_CANVAS_PATH}?task_id=task%2Fone`);
  });

  it("uses workspace routes for creation and import", async () => {
    await createCanvas(WORKSPACE_ID, "Project canvas");
    await createCanvas(WORKSPACE_ID, "Task canvas", TASK_ID);
    await importCanvas(WORKSPACE_ID, '{"title":"Imported"}', TASK_ID);

    expect(mocks.fetchJson.mock.calls[0]?.[1]).toMatchObject({
      init: { method: "POST", body: JSON.stringify({ title: "Project canvas" }) },
    });
    expect(mocks.fetchJson.mock.calls[1]?.[0]).toBe(`${WORKSPACE_CANVAS_PATH}?task_id=task%2Fone`);
    expect(mocks.fetchJson.mock.calls[1]?.[1]).toMatchObject({
      init: { method: "POST", body: JSON.stringify({ title: "Task canvas" }) },
    });
    expect(mocks.fetchJson.mock.calls[2]).toMatchObject({
      0: `${WORKSPACE_CANVAS_PATH}/import?task_id=task%2Fone`,
      1: {
        init: {
          method: "POST",
          body: '{"title":"Imported"}',
          headers: { "Content-Type": "application/vnd.kandev.canvas+json" },
        },
      },
    });
  });

  it("keeps canvas mutations and task links on canvas-owned paths", async () => {
    const command = {
      command_id: "command-1",
      base_revision: 2,
      action: "canvas.rename",
      input: { title: "Renamed" },
    };
    await renameCanvas(CANVAS_ID, "Renamed");
    await archiveCanvas(CANVAS_ID, true);
    await removeCanvas(CANVAS_ID);
    await applyCanvasCommand(CANVAS_ID, command);
    await addCanvasTaskLink(CANVAS_ID, TASK_ID);
    await removeCanvasTaskLink(CANVAS_ID, TASK_ID);
    await listCanvasEvents(CANVAS_ID, 4);

    expect(
      mocks.fetchJson.mock.calls.map(([path, options]) => [path, options?.init?.method]),
    ).toEqual([
      [CANVAS_PATH, "PATCH"],
      [`${CANVAS_PATH}/archive`, "POST"],
      [CANVAS_PATH, "DELETE"],
      [`${CANVAS_PATH}/commands`, "POST"],
      [TASK_PATH, "POST"],
      [TASK_PATH, "DELETE"],
      [`${CANVAS_PATH}/events?after_revision=4`, undefined],
    ]);
    expect(mocks.fetchJson.mock.calls[3]?.[1]?.init?.body).toBe(JSON.stringify(command));
  });

  it("uses the portable export endpoint", async () => {
    const blob = new Blob(["canvas"]);
    mocks.fetchBlob.mockResolvedValueOnce(blob);

    await expect(exportCanvas("canvas/one")).resolves.toBe(blob);
    expect(mocks.fetchBlob).toHaveBeenCalledWith(`${CANVAS_PATH}/export`, undefined);
  });
});
