"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconArrowDown, IconArrowUp, IconDots, IconEdit, IconTrash } from "@tabler/icons-react";
import { Button } from "@kandev/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@kandev/ui/card";
import { Textarea } from "@kandev/ui/textarea";
import { MobilePickerSheet } from "@/components/task/mobile/mobile-picker-sheet";
import { useTouchDrawer } from "@/hooks/use-compact-task-chrome";
import { generateUUID } from "@/lib/utils";
import type {
  ApplyCanvasCommandRequest,
  ApplyCanvasCommandResult,
  Canvas,
  CanvasBlock,
} from "@/lib/types/canvas";
import { asStateRecord, blockLabelKey } from "./canvas-utils";
import { CanvasMarkdownBlock } from "./canvas-markdown-block";
import { CanvasStructuredBlock } from "./canvas-structured-block";

type CanvasBlockCardProps = {
  canvas: Canvas;
  block: CanvasBlock;
  readOnly: boolean;
  apply: (command: ApplyCanvasCommandRequest) => Promise<ApplyCanvasCommandResult | null>;
  onError: (error: unknown) => void;
};

function BlockActionButtons({
  canEdit,
  canMoveUp,
  canMoveDown,
  pending,
  onEdit,
  onDelete,
  onMove,
}: {
  canEdit: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  pending: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMove: (position: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1">
      {canEdit && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
          aria-label={t("canvases:editBlock")}
          disabled={pending}
          onClick={onEdit}
        >
          <IconEdit className="h-4 w-4" />
        </Button>
      )}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
        aria-label={t("canvases:moveBlockUp")}
        disabled={pending || !canMoveUp}
        onClick={() => onMove(-1)}
      >
        <IconArrowUp className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
        aria-label={t("canvases:moveBlockDown")}
        disabled={pending || !canMoveDown}
        onClick={() => onMove(1)}
      >
        <IconArrowDown className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="min-h-11 min-w-11 text-destructive hover:text-destructive md:min-h-7 md:min-w-7"
        aria-label={t("canvases:deleteBlock")}
        disabled={pending}
        onClick={onDelete}
      >
        <IconTrash className="h-4 w-4" />
      </Button>
    </div>
  );
}

function BlockActions({
  block,
  canEdit,
  canMoveUp,
  canMoveDown,
  pending,
  onEdit,
  onDelete,
  onMove,
  readOnly,
}: Parameters<typeof BlockActionButtons>[0] & { block: CanvasBlock; readOnly: boolean }) {
  const { t } = useTranslation();
  const touch = useTouchDrawer();
  const [open, setOpen] = useState(false);
  const buttons = (
    <BlockActionButtons
      canEdit={canEdit}
      canMoveUp={canMoveUp}
      canMoveDown={canMoveDown}
      pending={pending || readOnly}
      onEdit={() => {
        onEdit();
        setOpen(false);
      }}
      onDelete={() => {
        onDelete();
        setOpen(false);
      }}
      onMove={(position) => {
        onMove(position);
        setOpen(false);
      }}
    />
  );
  if (!touch) return buttons;
  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="min-h-11 min-w-11"
        aria-label={t("canvases:blockActions")}
        disabled={pending || readOnly}
        data-testid={`canvas-block-actions-${block.id}`}
        onClick={() => setOpen(true)}
      >
        <IconDots className="h-4 w-4" />
      </Button>
      <MobilePickerSheet
        open={open}
        onOpenChange={setOpen}
        title={t(blockLabelKey(block.type))}
        description={t("canvases:blockActionsDescription")}
        contentTestId={`canvas-block-action-drawer-${block.id}`}
      >
        <div className="p-2" data-vaul-no-drag>
          {buttons}
        </div>
      </MobilePickerSheet>
    </>
  );
}

function BlockEditor({
  block,
  draft,
  pending,
  onDraftChange,
  onSave,
  onCancel,
}: {
  block: CanvasBlock;
  draft: string;
  pending: boolean;
  onDraftChange: (draft: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3" data-testid={`canvas-block-editor-${block.id}`}>
      <Textarea
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        aria-label={t("canvases:blockState")}
        className="min-h-40 resize-y font-mono text-xs"
        disabled={pending}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" className="min-h-11 md:min-h-7" onClick={onSave} disabled={pending}>
          {t("common:save")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 md:min-h-7"
          onClick={onCancel}
          disabled={pending}
        >
          {t("common:cancel")}
        </Button>
      </div>
    </div>
  );
}

function BlockContent({
  canvas,
  block,
  apply,
  onError,
  editing,
  draft,
  pending,
  onDraftChange,
  onSave,
  onCancel,
  readOnly,
}: CanvasBlockCardProps & {
  editing: boolean;
  draft: string;
  pending: boolean;
  onDraftChange: (draft: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  if (editing) {
    return (
      <BlockEditor
        block={block}
        draft={draft}
        pending={pending}
        onDraftChange={onDraftChange}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }
  if (block.type === "markdown") {
    return (
      <CanvasMarkdownBlock
        canvas={canvas}
        block={block}
        apply={apply}
        onError={onError}
        readOnly={readOnly}
      />
    );
  }
  return (
    <CanvasStructuredBlock
      canvas={canvas}
      block={block}
      apply={apply}
      onError={onError}
      readOnly={readOnly}
    />
  );
}

export function CanvasBlockCard({ canvas, block, readOnly, apply, onError }: CanvasBlockCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(asStateRecord(block.state), null, 2));
  const [pending, setPending] = useState(false);
  const orderedBlocks = [...canvas.blocks].sort((left, right) => left.position - right.position);
  const blockIndex = orderedBlocks.findIndex((item) => item.id === block.id);

  const run = async (action: string, input: Record<string, unknown>, targetID = block.id) => {
    setPending(true);
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
    } finally {
      setPending(false);
    }
  };

  const saveBlock = async () => {
    let state: unknown;
    try {
      state = JSON.parse(draft);
    } catch (error: unknown) {
      onError(error);
      return;
    }
    if (
      await run("block.update", {
        type: block.type,
        state,
        expected_block_revision: block.block_revision,
      })
    ) {
      setEditing(false);
    }
  };

  const deleteBlock = () => {
    if (window.confirm(t("canvases:confirmDeleteBlock"))) void run("block.delete", {});
  };

  const moveBlock = (direction: number) => {
    const destination = blockIndex + direction;
    if (destination < 0 || destination >= orderedBlocks.length) return;
    const ids = orderedBlocks.map((item) => item.id);
    [ids[blockIndex], ids[destination]] = [ids[destination], ids[blockIndex]];
    void run("block.reorder", { block_ids: ids });
  };

  return (
    <Card data-testid={`canvas-block-${block.id}`} className="min-w-0">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/60">
        <CardTitle>{t(blockLabelKey(block.type))}</CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            {t("canvases:canvasRevision", { revision: block.block_revision })}
          </span>
          <BlockActions
            block={block}
            canEdit={!readOnly && block.type !== "markdown"}
            canMoveUp={blockIndex > 0}
            canMoveDown={blockIndex >= 0 && blockIndex < orderedBlocks.length - 1}
            pending={pending}
            readOnly={readOnly}
            onEdit={() => {
              setDraft(JSON.stringify(asStateRecord(block.state), null, 2));
              setEditing(true);
            }}
            onDelete={deleteBlock}
            onMove={moveBlock}
          />
        </div>
      </CardHeader>
      <CardContent className="min-w-0 space-y-3">
        <BlockContent
          canvas={canvas}
          block={block}
          readOnly={readOnly}
          apply={apply}
          onError={onError}
          editing={editing}
          draft={draft}
          pending={pending}
          onDraftChange={setDraft}
          onSave={() => void saveBlock()}
          onCancel={() => setEditing(false)}
        />
      </CardContent>
    </Card>
  );
}
