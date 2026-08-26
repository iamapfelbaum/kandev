import { fetchBlob, fetchJson, type ApiRequestOptions } from "../client";
import type {
  ApplyCanvasCommandRequest,
  ApplyCanvasCommandResult,
  Canvas,
  CanvasEvent,
} from "@/lib/types/canvas";

function workspacePath(workspaceId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/canvases`;
}

function canvasPath(canvasId: string): string {
  return `/api/v1/canvases/${encodeURIComponent(canvasId)}`;
}

export async function listCanvases(
  workspaceId: string,
  includeArchived = false,
  options?: ApiRequestOptions,
): Promise<Canvas[]> {
  const query = includeArchived ? "?include_archived=true" : "";
  const response = await fetchJson<{ canvases: Canvas[] }>(
    `${workspacePath(workspaceId)}${query}`,
    options,
  );
  return response.canvases ?? [];
}

export async function listTaskCanvases(
  workspaceId: string,
  taskId: string,
  options?: ApiRequestOptions,
): Promise<Canvas[]> {
  const response = await fetchJson<{ canvases: Canvas[] }>(
    `${workspacePath(workspaceId)}?task_id=${encodeURIComponent(taskId)}`,
    options,
  );
  return response.canvases ?? [];
}

export async function createCanvas(
  workspaceId: string,
  title: string,
  options?: ApiRequestOptions,
): Promise<Canvas> {
  return fetchJson<Canvas>(workspacePath(workspaceId), {
    ...options,
    init: { method: "POST", body: JSON.stringify({ title }), ...(options?.init ?? {}) },
  });
}

export async function importCanvas(
  workspaceId: string,
  file: string,
  taskId?: string,
  options?: ApiRequestOptions,
): Promise<Canvas> {
  const query = taskId ? `?task_id=${encodeURIComponent(taskId)}` : "";
  return fetchJson<Canvas>(`${workspacePath(workspaceId)}/import${query}`, {
    ...options,
    init: {
      method: "POST",
      body: file,
      headers: { "Content-Type": "application/vnd.kandev.canvas+json" },
      ...(options?.init ?? {}),
    },
  });
}

export async function getCanvas(canvasId: string, options?: ApiRequestOptions): Promise<Canvas> {
  return fetchJson<Canvas>(canvasPath(canvasId), options);
}

export async function listCanvasEvents(
  canvasId: string,
  afterRevision: number,
  options?: ApiRequestOptions,
): Promise<CanvasEvent[]> {
  const response = await fetchJson<{ events: CanvasEvent[] }>(
    `${canvasPath(canvasId)}/events?after_revision=${afterRevision}`,
    options,
  );
  return response.events ?? [];
}

export async function renameCanvas(
  canvasId: string,
  title: string,
  options?: ApiRequestOptions,
): Promise<Canvas> {
  return fetchJson<Canvas>(canvasPath(canvasId), {
    ...options,
    init: { method: "PATCH", body: JSON.stringify({ title }), ...(options?.init ?? {}) },
  });
}

export async function archiveCanvas(
  canvasId: string,
  archived: boolean,
  options?: ApiRequestOptions,
): Promise<Canvas> {
  return fetchJson<Canvas>(`${canvasPath(canvasId)}/${archived ? "archive" : "restore"}`, {
    ...options,
    init: { method: "POST", ...(options?.init ?? {}) },
  });
}

export async function removeCanvas(canvasId: string, options?: ApiRequestOptions): Promise<void> {
  return fetchJson<void>(canvasPath(canvasId), {
    ...options,
    init: { method: "DELETE", ...(options?.init ?? {}) },
  });
}

export async function applyCanvasCommand(
  canvasId: string,
  command: ApplyCanvasCommandRequest,
  options?: ApiRequestOptions,
): Promise<ApplyCanvasCommandResult> {
  return fetchJson<ApplyCanvasCommandResult>(`${canvasPath(canvasId)}/commands`, {
    ...options,
    init: { method: "POST", body: JSON.stringify(command), ...(options?.init ?? {}) },
  });
}

export async function addCanvasTaskLink(
  canvasId: string,
  taskId: string,
  options?: ApiRequestOptions,
): Promise<void> {
  return fetchJson<void>(`${canvasPath(canvasId)}/tasks/${encodeURIComponent(taskId)}`, {
    ...options,
    init: { method: "POST", ...(options?.init ?? {}) },
  });
}

export async function removeCanvasTaskLink(
  canvasId: string,
  taskId: string,
  options?: ApiRequestOptions,
): Promise<void> {
  return fetchJson<void>(`${canvasPath(canvasId)}/tasks/${encodeURIComponent(taskId)}`, {
    ...options,
    init: { method: "DELETE", ...(options?.init ?? {}) },
  });
}

export async function exportCanvas(canvasId: string, options?: ApiRequestOptions): Promise<Blob> {
  return fetchBlob(`${canvasPath(canvasId)}/export`, options);
}
