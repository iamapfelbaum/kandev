import { describe, expect, it } from "vitest";
import {
  blockItems,
  blockLabelKey,
  blockText,
  blockCollection,
  kanbanColumns,
  itemLabel,
} from "./canvas-utils";
import type { CanvasBlock } from "@/lib/types/canvas";

function block(state: unknown): CanvasBlock {
  return {
    id: "block-1",
    canvas_id: "canvas-1",
    type: "checklist",
    position: 0,
    state,
    block_revision: 1,
    created_at: "2026-08-26T00:00:00Z",
    updated_at: "2026-08-26T00:00:00Z",
  };
}

describe("canvas block display helpers", () => {
  it("maps block types to translated labels", () => {
    expect(blockLabelKey("markdown")).toBe("canvases:markdown");
    expect(blockLabelKey("timeline")).toBe("canvases:timeline");
  });

  it("reads common text fields and ignores blank values", () => {
    expect(blockText(block({ content: "A note" }))).toBe("A note");
    expect(blockText(block({ markdown: "   " }))).toBeNull();
    expect(blockText(block(["not a record"]))).toBeNull();
  });

  it("normalizes string and object item forms while dropping invalid items", () => {
    expect(
      blockItems(
        block({
          items: [
            "First",
            { id: "item-2", title: "Second", completed: true },
            { label: "Third" },
            { label: "   " },
            42,
          ],
        }),
      ),
    ).toEqual([
      { id: "block-1-0", label: "First" },
      { id: "item-2", label: "Second", completed: true },
      { id: "block-1-2", label: "Third", completed: undefined },
    ]);
  });

  it("keeps typed collections separate for native block renderers", () => {
    const checklist = block({
      items: [{ id: "item-1", label: "Write", revision: 2, completed: true }],
    });
    expect(blockCollection(checklist, "items")).toEqual([
      { id: "item-1", label: "Write", revision: 2, completed: true },
    ]);
    expect(itemLabel({ id: "item-1", title: "Fallback title" })).toBe("Fallback title");
  });

  it("preserves kanban columns and their card ownership", () => {
    const columns = kanbanColumns(
      block({
        columns: [
          { id: "todo", cards: [{ id: "card-1", title: "Task", revision: 1 }] },
          { id: "done", cards: [] },
        ],
      }),
    );
    expect(columns.map((column) => [column.id, column.cards.map((card) => card.id)])).toEqual([
      ["todo", ["card-1"]],
      ["done", []],
    ]);
  });
});
