import type { CanvasBlock, CanvasBlockType } from "@/lib/types/canvas";

export function asStateRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function blockLabelKey(type: CanvasBlockType): string {
  return `canvases:${type}`;
}

export function blockText(block: CanvasBlock): string | null {
  const state = asStateRecord(block.state);
  const value = state.markdown ?? state.content ?? state.text;
  return typeof value === "string" && value.trim() ? value : null;
}

export function blockItems(
  block: CanvasBlock,
): Array<{ id: string; label: string; detail?: string; completed?: boolean }> {
  const state = asStateRecord(block.state);
  const result: Array<{ id: string; label: string; detail?: string; completed?: boolean }> = [];
  const collectionKeys = new Set(["items", "cards", "columns", "events", "metrics"]);

  const visit = (value: unknown, path: string[]) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const itemPath = [...path, String(index)];
        if (typeof item === "string" && item.trim()) {
          const id =
            path.length === 1 && path[0] === "items"
              ? `${block.id}-${index}`
              : `${block.id}-${itemPath.join("-")}`;
          result.push({ id, label: item });
          return;
        }
        if (typeof item !== "object" || item === null) return;
        const record = item as Record<string, unknown>;
        const label = [record.label, record.title, record.name, record.text].find(
          (candidate): candidate is string => typeof candidate === "string" && !!candidate.trim(),
        );
        const detail = [record.value, record.time, record.date, record.status].find(
          (candidate): candidate is string | number =>
            (typeof candidate === "string" && !!candidate.trim()) || typeof candidate === "number",
        );
        if (label) {
          const fallbackId =
            path.length === 1 && path[0] === "items"
              ? `${block.id}-${index}`
              : `${block.id}-${itemPath.join("-")}`;
          const displayItem: { id: string; label: string; detail?: string; completed?: boolean } = {
            id: typeof record.id === "string" ? record.id : fallbackId,
            label,
            completed: typeof record.completed === "boolean" ? record.completed : undefined,
          };
          if (detail !== undefined) displayItem.detail = String(detail);
          result.push({
            ...displayItem,
          });
        }
        Object.entries(record).forEach(([key, child]) => {
          if (Array.isArray(child) && collectionKeys.has(key)) visit(child, [...itemPath, key]);
        });
      });
      return;
    }
    if (typeof value !== "object" || value === null) return;
    Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
      if (Array.isArray(child) && collectionKeys.has(key)) visit(child, [...path, key]);
    });
  };

  Object.entries(state).forEach(([key, value]) => {
    if (Array.isArray(value) && collectionKeys.has(key)) visit(value, [key]);
  });
  return result;
}
