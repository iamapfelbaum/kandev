"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconArchive,
  IconCheck,
  IconDownload,
  IconExternalLink,
  IconLink,
  IconPencil,
  IconPlus,
  IconRestore,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { Badge } from "@kandev/ui/badge";
import { Button } from "@kandev/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@kandev/ui/card";
import { Input } from "@kandev/ui/input";
import Link from "@/components/routing/app-link";
import type { Canvas } from "@/lib/types/canvas";

export type CanvasSettingsRowProps = {
  canvas: Canvas;
  onRename: (title: string) => Promise<void>;
  onArchive: (archived: boolean) => Promise<void>;
  onRemove: () => Promise<void>;
  onExport: () => Promise<void>;
  onLinkTask: (taskId: string) => Promise<void>;
  onUnlinkTask: (taskId: string) => Promise<void>;
};

function TaskLinks({
  canvas,
  onLinkTask,
  onUnlinkTask,
}: Pick<CanvasSettingsRowProps, "canvas" | "onLinkTask" | "onUnlinkTask">) {
  const { t } = useTranslation();
  const [taskId, setTaskId] = useState("");
  const [busy, setBusy] = useState(false);

  const link = async () => {
    const value = taskId.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onLinkTask(value);
      setTaskId("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="space-y-2 border-t border-border/60 pt-3"
      data-testid={`canvas-task-links-${canvas.id}`}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <IconLink className="h-4 w-4" />
        {t("canvases:taskLinks")}
      </div>
      {canvas.task_links.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {canvas.task_links.map((link) => (
            <li
              key={link.task_id}
              className="flex items-center gap-1 rounded-md bg-muted/50 px-2 py-1 text-xs"
            >
              <Link className="hover:underline" href={`/t/${encodeURIComponent(link.task_id)}`}>
                {link.task_id}
              </Link>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="min-h-5 min-w-5"
                aria-label={t("canvases:removeTaskLink")}
                onClick={() => void onUnlinkTask(link.task_id)}
              >
                <IconX />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t("canvases:noTaskLinks")}</p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={taskId}
          onChange={(event) => setTaskId(event.target.value)}
          placeholder={t("canvases:taskIdPlaceholder")}
          aria-label={t("canvases:taskId")}
          className="min-h-11 sm:max-w-xs md:min-h-7"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 md:min-h-7"
          disabled={!taskId.trim() || busy}
          onClick={() => void link()}
        >
          <IconPlus className="h-4 w-4" />
          {t("canvases:linkTask")}
        </Button>
      </div>
    </div>
  );
}

function CanvasRowTitle({
  canvas,
  editing,
  title,
  onTitleChange,
  onSave,
  onCancel,
}: {
  canvas: Canvas;
  editing: boolean;
  title: string;
  onTitleChange: (title: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 space-y-2">
      {editing ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            aria-label={t("canvases:canvasTitle")}
            className="min-h-11 sm:max-w-sm md:min-h-7"
            autoFocus
            onKeyDown={(event) => {
              if (event.key === "Enter") onSave();
              if (event.key === "Escape") onCancel();
            }}
          />
          <Button
            type="button"
            size="icon"
            className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
            aria-label={t("common:save")}
            onClick={onSave}
          >
            <IconCheck />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
            aria-label={t("common:cancel")}
            onClick={onCancel}
          >
            <IconX />
          </Button>
        </div>
      ) : (
        <CardTitle className="flex min-w-0 items-center gap-2">
          <Link
            className="truncate hover:underline"
            href={`/canvases/${encodeURIComponent(canvas.id)}`}
          >
            {canvas.title}
          </Link>
          {canvas.archived_at && <Badge variant="outline">{t("canvases:archived")}</Badge>}
        </CardTitle>
      )}
      <p className="text-xs text-muted-foreground">
        {t("canvases:canvasRevision", { revision: canvas.revision })}
      </p>
    </div>
  );
}

function CanvasRowActions({
  canvas,
  busy,
  onEdit,
  onExport,
  onArchive,
  onRemove,
}: {
  canvas: Canvas;
  busy: boolean;
  onEdit: () => void;
  onExport: () => void;
  onArchive: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-7" asChild>
        <Link href={`/canvases/${encodeURIComponent(canvas.id)}`}>
          <IconExternalLink className="h-4 w-4" />
          {t("canvases:openCanvas")}
        </Link>
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
        aria-label={t("canvases:canvasTitle")}
        disabled={busy}
        onClick={onEdit}
      >
        <IconPencil />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
        aria-label={t("canvases:exportCanvas")}
        disabled={busy}
        onClick={onExport}
      >
        <IconDownload />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
        aria-label={canvas.archived_at ? t("canvases:restoreCanvas") : t("canvases:archiveCanvas")}
        disabled={busy}
        onClick={onArchive}
      >
        {canvas.archived_at ? <IconRestore /> : <IconArchive />}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="min-h-11 min-w-11 text-destructive hover:text-destructive md:min-h-7 md:min-w-7"
        aria-label={t("canvases:removeCanvas")}
        disabled={busy}
        onClick={onRemove}
      >
        <IconTrash />
      </Button>
    </div>
  );
}

export function CanvasSettingsRow({
  canvas,
  onRename,
  onArchive,
  onRemove,
  onExport,
  onLinkTask,
  onUnlinkTask,
}: CanvasSettingsRowProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(canvas.title);
  const [busy, setBusy] = useState(false);

  const cancelEditing = () => {
    setTitle(canvas.title);
    setEditing(false);
  };

  const saveTitle = async () => {
    const value = title.trim();
    if (!value || busy || value === canvas.title) {
      cancelEditing();
      return;
    }
    setBusy(true);
    try {
      await onRename(value);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    if (window.confirm(t("canvases:confirmRemoveCanvas"))) void run(onRemove);
  };

  return (
    <Card data-testid={`canvas-settings-row-${canvas.id}`}>
      <CardHeader className="flex flex-col gap-3 border-b border-border/60 sm:flex-row sm:items-start sm:justify-between">
        <CanvasRowTitle
          canvas={canvas}
          editing={editing}
          title={title}
          onTitleChange={setTitle}
          onSave={() => void saveTitle()}
          onCancel={cancelEditing}
        />
        <CanvasRowActions
          canvas={canvas}
          busy={busy}
          onEdit={() => setEditing(true)}
          onExport={() => void run(onExport)}
          onArchive={() => void run(() => onArchive(!canvas.archived_at))}
          onRemove={remove}
        />
      </CardHeader>
      <CardContent>
        <TaskLinks canvas={canvas} onLinkTask={onLinkTask} onUnlinkTask={onUnlinkTask} />
      </CardContent>
    </Card>
  );
}
