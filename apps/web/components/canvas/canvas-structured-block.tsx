"use client";

/* eslint-disable max-lines */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconCheck,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { Button } from "@kandev/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@kandev/ui/card";
import { Input } from "@kandev/ui/input";
import type {
  ApplyCanvasCommandRequest,
  ApplyCanvasCommandResult,
  Canvas,
  CanvasBlock,
} from "@/lib/types/canvas";
import { generateUUID } from "@/lib/utils";
import {
  blockCollection,
  itemDetail,
  itemLabel,
  kanbanColumns,
  type CanvasItemRecord,
} from "./canvas-utils";

type ApplyCanvasCommand = (
  command: ApplyCanvasCommandRequest,
) => Promise<ApplyCanvasCommandResult | null>;

type StructuredBlockProps = {
  canvas: Canvas;
  block: CanvasBlock;
  readOnly: boolean;
  apply: ApplyCanvasCommand;
  onError: (error: unknown) => void;
};

type StructuredItemListProps = StructuredBlockProps & {
  collection: "items" | "cards" | "metrics" | "events";
  actions: StructuredItemActions;
  items: CanvasItemRecord[];
  field: "label" | "title" | "name";
  columnID?: string;
  columns?: Array<{ id: string; cardCount: number }>;
};

type StructuredItemActions = {
  add: string;
  edit: string;
  move: string;
  remove: string;
  toggle?: string;
};

function moveToAdjacentColumn(
  columns: Array<{ id: string; cardCount: number }> | undefined,
  columnID: string | undefined,
  item: CanvasItemRecord,
  direction: -1 | 1,
  moveItem: (item: CanvasItemRecord, position: number, destinationColumnID?: string) => void,
) {
  if (!columns || !columnID) return;
  const destination = columns[columns.findIndex((column) => column.id === columnID) + direction];
  if (destination) moveItem(item, destination.cardCount, destination.id);
}

type ExecuteStructuredCommand = (
  action: string,
  input: Record<string, unknown>,
) => Promise<boolean>;

// i18n-exempt: backend command names, not user-facing copy.
const CHECKLIST_ACTIONS: StructuredItemActions = {
  add: "checklist.add",
  edit: "checklist.edit",
  move: "checklist.move",
  remove: "checklist.remove",
  toggle: "checklist.toggle",
};
// i18n-exempt: backend command names, not user-facing copy.
const KANBAN_ACTIONS: StructuredItemActions = {
  add: "kanban.card.add",
  edit: "kanban.card.edit",
  move: "kanban.card.move",
  remove: "kanban.card.remove",
};
// i18n-exempt: backend command names, not user-facing copy.
const METRICS_ACTIONS: StructuredItemActions = {
  add: "metrics.set",
  edit: "metrics.set",
  move: "metrics.reorder",
  remove: "metrics.remove",
};
// i18n-exempt: backend command names, not user-facing copy.
const TIMELINE_ACTIONS: StructuredItemActions = {
  add: "timeline.add",
  edit: "timeline.edit",
  move: "timeline.move",
  remove: "timeline.remove",
};

function toggleStructuredItem(
  actions: StructuredItemActions,
  collection: StructuredItemListProps["collection"],
  item: CanvasItemRecord,
  execute: ExecuteStructuredCommand,
) {
  if (!actions.toggle) return;
  void execute(actions.toggle, {
    collection,
    item_id: item.id,
    completed: item.completed !== true,
    expected_item_revision: item.revision,
  });
}

async function runCommand({
  apply,
  canvas,
  action,
  targetID,
  input,
  onError,
}: {
  apply: ApplyCanvasCommand;
  canvas: Canvas;
  action: string;
  targetID: string;
  input: Record<string, unknown>;
  onError: (error: unknown) => void;
}): Promise<boolean> {
  try {
    await apply({
      command_id: generateUUID(),
      base_revision: canvas.revision,
      action,
      target_id: targetID,
      input,
    });
    return true;
  } catch (error: unknown) {
    onError(error);
    return false;
  }
}

function ItemActions({
  item,
  index,
  count,
  onEdit,
  onDelete,
  onMove,
  onMoveColumn,
  checklist,
  pending,
}: {
  item: CanvasItemRecord;
  index: number;
  count: number;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (position: number) => void;
  onMoveColumn?: (direction: -1 | 1) => void;
  checklist: boolean;
  pending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
        aria-label={t("canvases:editItem")}
        disabled={pending}
        onClick={onEdit}
      >
        <span className="text-xs">{t("common:edit")}</span>
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
        aria-label={t("canvases:moveItemUp")}
        disabled={pending || index === 0}
        onClick={() => onMove(index - 1)}
      >
        <IconArrowUp className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
        aria-label={t("canvases:moveItemDown")}
        disabled={pending || index === count - 1}
        onClick={() => onMove(index + 1)}
      >
        <IconArrowDown className="h-4 w-4" />
      </Button>
      {onMoveColumn && (
        <>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
            aria-label={t("canvases:moveItemLeft")}
            disabled={pending}
            onClick={() => onMoveColumn(-1)}
          >
            <IconArrowLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
            aria-label={t("canvases:moveItemRight")}
            disabled={pending}
            onClick={() => onMoveColumn(1)}
          >
            <IconArrowRight className="h-4 w-4" />
          </Button>
        </>
      )}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="min-h-11 min-w-11 text-destructive hover:text-destructive md:min-h-7 md:min-w-7"
        aria-label={t("canvases:deleteItem")}
        disabled={pending}
        onClick={onDelete}
      >
        <IconTrash className="h-4 w-4" />
      </Button>
      {checklist && <span className="sr-only">{item.id}</span>}
    </div>
  );
}

function StructuredItemEditor({
  draft,
  pending,
  onSave,
  onCancel,
}: {
  draft: string;
  pending: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 gap-1">
      <Button
        type="button"
        size="icon"
        className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
        aria-label={t("common:save")}
        disabled={!draft.trim() || pending}
        onClick={onSave}
      >
        <IconCheck className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
        aria-label={t("common:cancel")}
        onClick={onCancel}
      >
        <IconX className="h-4 w-4" />
      </Button>
    </div>
  );
}

function StructuredItemValue({
  item,
  checklist,
  editing,
  draft,
  onDraftChange,
}: {
  item: CanvasItemRecord;
  checklist: boolean;
  editing: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  if (editing) {
    return (
      <Input
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        aria-label={t("canvases:itemValue")}
        className="min-h-11 min-w-0 flex-1 md:min-h-7"
        autoFocus
      />
    );
  }
  const detail = itemDetail(item);
  return (
    <>
      <span
        className={
          checklist && item.completed === true
            ? "min-w-0 flex-1 line-through opacity-60"
            : "min-w-0 flex-1"
        }
      >
        {itemLabel(item)}
      </span>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
    </>
  );
}

function StructuredItemRow({
  item,
  index,
  count,
  checklist,
  pending,
  editing,
  editingDraft,
  onDraftChange,
  onSave,
  onCancel,
  onEdit,
  onDelete,
  onMove,
  onMoveColumn,
  onToggle,
}: {
  item: CanvasItemRecord;
  index: number;
  count: number;
  checklist: boolean;
  pending: boolean;
  editing: boolean;
  editingDraft: string;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (position: number) => void;
  onMoveColumn?: (direction: -1 | 1) => void;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li
      className="flex min-w-0 flex-col gap-2 rounded-md border border-border/60 p-2 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`canvas-item-${item.id}`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {checklist && (
          <Button
            type="button"
            size="icon"
            variant={item.completed === true ? "default" : "outline"}
            className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
            aria-label={t("canvases:toggleItem")}
            disabled={pending}
            onClick={onToggle}
          >
            <IconCheck className="h-4 w-4" />
          </Button>
        )}
        <StructuredItemValue
          item={item}
          checklist={checklist}
          editing={editing}
          draft={editingDraft}
          onDraftChange={onDraftChange}
        />
      </div>
      {editing ? (
        <StructuredItemEditor
          draft={editingDraft}
          pending={pending}
          onSave={onSave}
          onCancel={onCancel}
        />
      ) : (
        <ItemActions
          item={item}
          index={index}
          count={count}
          checklist={checklist}
          pending={pending}
          onEdit={onEdit}
          onDelete={onDelete}
          onMove={onMove}
          onMoveColumn={onMoveColumn}
        />
      )}
    </li>
  );
}

function AddStructuredItemForm({
  draft,
  pending,
  onDraftChange,
  onSubmit,
}: {
  draft: string;
  pending: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <form
      className="flex flex-col gap-2 sm:flex-row"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Input
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        placeholder={t("canvases:itemPlaceholder")}
        aria-label={t("canvases:itemValue")}
        className="min-h-11 min-w-0 flex-1 md:min-h-7"
      />
      <Button
        type="submit"
        variant="outline"
        className="min-h-11 md:min-h-7"
        disabled={!draft.trim() || pending}
      >
        <IconPlus className="h-4 w-4" />
        {t("canvases:addItem")}
      </Button>
    </form>
  );
}

function StructuredItemRows({
  items,
  checklist,
  pending,
  editingID,
  editingDraft,
  onDraftChange,
  onSave,
  onCancel,
  onEdit,
  onDelete,
  onMove,
  onMoveColumn,
  onToggle,
}: {
  items: CanvasItemRecord[];
  checklist: boolean;
  pending: boolean;
  editingID: string | null;
  editingDraft: string;
  onDraftChange: (value: string) => void;
  onSave: (item: CanvasItemRecord) => void;
  onCancel: () => void;
  onEdit: (item: CanvasItemRecord) => void;
  onDelete: (item: CanvasItemRecord) => void;
  onMove: (item: CanvasItemRecord, position: number) => void;
  onMoveColumn?: (item: CanvasItemRecord, direction: -1 | 1) => void;
  onToggle: (item: CanvasItemRecord) => void;
}) {
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <StructuredItemRow
          key={item.id}
          item={item}
          index={index}
          count={items.length}
          checklist={checklist}
          pending={pending}
          editing={editingID === item.id}
          editingDraft={editingDraft}
          onDraftChange={onDraftChange}
          onSave={() => onSave(item)}
          onCancel={onCancel}
          onEdit={() => onEdit(item)}
          onDelete={() => onDelete(item)}
          onMove={(position) => onMove(item, position)}
          onMoveColumn={onMoveColumn ? (direction) => onMoveColumn(item, direction) : undefined}
          onToggle={() => onToggle(item)}
        />
      ))}
    </ul>
  );
}

function StructuredItemListView({
  type,
  items,
  checklist,
  pending,
  editingID,
  editingDraft,
  draft,
  onDraftChange,
  onAddDraftChange,
  onSave,
  onCancel,
  onEdit,
  onDelete,
  onMove,
  onMoveColumn,
  onToggle,
  onAdd,
}: {
  type: CanvasBlock["type"];
  items: CanvasItemRecord[];
  checklist: boolean;
  pending: boolean;
  editingID: string | null;
  editingDraft: string;
  draft: string;
  onDraftChange: (value: string) => void;
  onAddDraftChange: (value: string) => void;
  onSave: (item: CanvasItemRecord) => void;
  onCancel: () => void;
  onEdit: (item: CanvasItemRecord) => void;
  onDelete: (item: CanvasItemRecord) => void;
  onMove: (item: CanvasItemRecord, position: number) => void;
  onMoveColumn?: (item: CanvasItemRecord, direction: -1 | 1) => void;
  onToggle: (item: CanvasItemRecord) => void;
  onAdd: () => void;
}) {
  return (
    <div className="space-y-3" data-testid={`canvas-${type}-items`}>
      {items.length > 0 && (
        <StructuredItemRows
          items={items}
          checklist={checklist}
          pending={pending}
          editingID={editingID}
          editingDraft={editingDraft}
          onDraftChange={onDraftChange}
          onSave={onSave}
          onCancel={onCancel}
          onEdit={onEdit}
          onDelete={onDelete}
          onMove={onMove}
          onMoveColumn={onMoveColumn}
          onToggle={onToggle}
        />
      )}
      <AddStructuredItemForm
        draft={draft}
        pending={pending}
        onDraftChange={onAddDraftChange}
        onSubmit={onAdd}
      />
    </div>
  );
}

function StructuredItemList({
  canvas,
  block,
  apply,
  onError,
  collection,
  actions,
  items,
  field,
  columnID,
  columns,
  readOnly,
}: StructuredItemListProps) {
  const [draft, setDraft] = useState("");
  const [editingID, setEditingID] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [pending, setPending] = useState(false);
  const checklist = block.type === "checklist";
  const execute = async (action: string, input: Record<string, unknown>) => {
    setPending(true);
    try {
      return await runCommand({ apply, canvas, action, targetID: block.id, input, onError });
    } finally {
      setPending(false);
    }
  };
  const addItem = async () => {
    const value = draft.trim();
    if (!value || pending) return;
    const itemID = generateUUID();
    const item: Record<string, unknown> = { id: itemID, revision: 1, [field]: value };
    if (checklist) item.completed = false;
    setDraft("");
    const succeeded = await execute(actions.add, {
      collection,
      item_id: itemID,
      item,
      expected_item_revision: 0,
      ...(columnID ? { destination_column_id: columnID } : {}),
    });
    if (!succeeded) setDraft(value);
  };

  const saveItem = async (item: CanvasItemRecord) => {
    const value = editingDraft.trim();
    if (!value || pending) return;
    const succeeded = await execute(actions.edit, {
      collection,
      item_id: item.id,
      patch: { [field]: value },
      expected_item_revision: item.revision,
    });
    if (succeeded) setEditingID(null);
  };

  const deleteItem = (item: CanvasItemRecord) => {
    void execute(actions.remove, {
      collection,
      item_id: item.id,
      expected_item_revision: item.revision,
    });
  };

  const moveItem = (item: CanvasItemRecord, position: number, destinationColumnID?: string) => {
    void execute(actions.move, {
      collection,
      item_id: item.id,
      position,
      expected_item_revision: item.revision,
      ...(destinationColumnID ? { destination_column_id: destinationColumnID } : {}),
    });
  };

  return (
    <StructuredItemListView
      type={block.type}
      items={items}
      checklist={checklist}
      pending={pending || readOnly}
      editingID={editingID}
      editingDraft={editingDraft}
      draft={draft}
      onDraftChange={setEditingDraft}
      onAddDraftChange={setDraft}
      onSave={saveItem}
      onCancel={() => setEditingID(null)}
      onEdit={(item) => {
        setEditingID(item.id);
        setEditingDraft(itemLabel(item));
      }}
      onDelete={deleteItem}
      onMove={(item, position) => moveItem(item, position, columnID)}
      onMoveColumn={
        columns && columnID
          ? (item, direction) => moveToAdjacentColumn(columns, columnID, item, direction, moveItem)
          : undefined
      }
      onToggle={(item) => toggleStructuredItem(actions, collection, item, execute)}
      onAdd={() => void addItem()}
    />
  );
}

function KanbanBlock({ canvas, block, readOnly, apply, onError }: StructuredBlockProps) {
  const columns = kanbanColumns(block);
  const columnSummary = columns.map((column) => ({
    id: column.id,
    cardCount: column.cards.length,
  }));
  return (
    <div className="grid min-w-0 gap-3 xl:grid-cols-2" data-testid={`canvas-kanban-${block.id}`}>
      {columns.map((column) => (
        <Card key={column.id} className="min-w-0 bg-muted/20">
          <CardHeader className="px-3 py-3">
            <CardTitle className="truncate text-sm">{column.id}</CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3">
            <StructuredItemList
              canvas={canvas}
              block={block}
              readOnly={readOnly}
              apply={apply}
              onError={onError}
              collection="cards"
              actions={KANBAN_ACTIONS}
              items={column.cards}
              field="title"
              columnID={column.id}
              columns={columnSummary}
            />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function CanvasStructuredBlock({
  canvas,
  block,
  readOnly,
  apply,
  onError,
}: StructuredBlockProps) {
  if (block.type === "kanban")
    return (
      <KanbanBlock
        canvas={canvas}
        block={block}
        readOnly={readOnly}
        apply={apply}
        onError={onError}
      />
    );
  if (block.type === "checklist") {
    return (
      <StructuredItemList
        canvas={canvas}
        block={block}
        readOnly={readOnly}
        apply={apply}
        onError={onError}
        collection="items"
        actions={CHECKLIST_ACTIONS}
        items={blockCollection(block, "items")}
        field="label"
      />
    );
  }
  if (block.type === "metrics") {
    return (
      <StructuredItemList
        canvas={canvas}
        block={block}
        readOnly={readOnly}
        apply={apply}
        onError={onError}
        collection="metrics"
        actions={METRICS_ACTIONS}
        items={blockCollection(block, "metrics")}
        field="name"
      />
    );
  }
  return (
    <StructuredItemList
      canvas={canvas}
      block={block}
      readOnly={readOnly}
      apply={apply}
      onError={onError}
      collection="events"
      actions={TIMELINE_ACTIONS}
      items={blockCollection(block, "events")}
      field="label"
    />
  );
}
