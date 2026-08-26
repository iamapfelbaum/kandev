"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@kandev/ui/button";
import { Textarea } from "@kandev/ui/textarea";
import { MarkdownPreviewRenderer } from "@/components/task/markdown-preview-content";
import { acquireMarkdownLease, releaseMarkdownLease } from "@/lib/api/domains/canvas-api";
import { generateUUID } from "@/lib/utils";
import type {
  ApplyCanvasCommandRequest,
  ApplyCanvasCommandResult,
  Canvas,
  CanvasBlock,
} from "@/lib/types/canvas";
import { asStateRecord } from "./canvas-utils";

type CanvasMarkdownBlockProps = {
  canvas: Canvas;
  block: CanvasBlock;
  readOnly: boolean;
  apply: (command: ApplyCanvasCommandRequest) => Promise<ApplyCanvasCommandResult | null>;
  onError: (error: unknown) => void;
};

function useMarkdownLeaseCleanup(
  canvasID: string,
  blockID: string,
  holderID: { current: string },
  editing: boolean,
) {
  useEffect(() => {
    if (!editing) return undefined;
    return () => {
      void releaseMarkdownLease(canvasID, blockID, holderID.current).catch(() => undefined);
    };
  }, [blockID, canvasID, editing, holderID]);
}

function MarkdownEditor({
  blockId,
  draft,
  pending,
  onDraftChange,
  onSave,
  onCancel,
}: {
  blockId: string;
  draft: string;
  pending: boolean;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3" data-testid={`canvas-markdown-editor-${blockId}`}>
      <Textarea
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        aria-label={t("canvases:markdownEditor")}
        className="min-h-40 resize-y font-mono text-sm"
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

function MarkdownPreview({
  blockId,
  markdown,
  pending,
  readOnly,
  onEdit,
}: {
  blockId: string;
  markdown: string;
  pending: boolean;
  readOnly: boolean;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="prose prose-sm max-w-none break-words dark:prose-invert">
        <MarkdownPreviewRenderer content={markdown} />
      </div>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 md:min-h-7"
        onClick={onEdit}
        disabled={pending || readOnly}
        data-testid={`canvas-markdown-edit-${blockId}`}
      >
        {t("common:edit")}
      </Button>
    </div>
  );
}

export function CanvasMarkdownBlock({
  canvas,
  block,
  readOnly,
  apply,
  onError,
}: CanvasMarkdownBlockProps) {
  const state = asStateRecord(block.state);
  const markdown = typeof state.markdown === "string" ? state.markdown : "";
  const holderID = useRef(generateUUID());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(markdown);
  const [leaseHeld, setLeaseHeld] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!editing || !leaseHeld) return undefined;
    const timer = window.setInterval(() => {
      void acquireMarkdownLease(canvas.id, block.id, holderID.current).catch((error: unknown) => {
        setLeaseHeld(false);
        setEditing(false);
        onError(error);
      });
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [block.id, canvas.id, editing, leaseHeld, onError]);

  useEffect(() => {
    if (!editing) setDraft(markdown);
  }, [editing, markdown]);
  useMarkdownLeaseCleanup(canvas.id, block.id, holderID, editing);
  useEffect(() => {
    if (editing && readOnly) {
      setEditing(false);
      setLeaseHeld(false);
    }
  }, [editing, readOnly]);

  const stopEditing = () => {
    setEditing(false);
    setLeaseHeld(false);
  };

  const beginEditing = async () => {
    if (pending || editing) return;
    setPending(true);
    try {
      await acquireMarkdownLease(canvas.id, block.id, holderID.current);
      setDraft(markdown);
      setLeaseHeld(true);
      setEditing(true);
    } catch (error: unknown) {
      onError(error);
    } finally {
      setPending(false);
    }
  };

  const save = async () => {
    if (pending || !leaseHeld) return;
    setPending(true);
    try {
      await apply({
        command_id: generateUUID(),
        base_revision: canvas.revision,
        action: "block.update",
        target_id: block.id,
        lease_holder_id: holderID.current,
        input: {
          type: "markdown",
          state: { markdown: draft },
          expected_block_revision: block.block_revision,
        },
      });
      stopEditing();
    } catch (error: unknown) {
      onError(error);
    } finally {
      setPending(false);
    }
  };

  if (editing) {
    return (
      <MarkdownEditor
        blockId={block.id}
        draft={draft}
        pending={pending}
        onDraftChange={setDraft}
        onSave={() => void save()}
        onCancel={stopEditing}
      />
    );
  }

  return (
    <MarkdownPreview
      blockId={block.id}
      markdown={markdown}
      pending={pending}
      readOnly={readOnly}
      onEdit={() => void beginEditing()}
    />
  );
}
