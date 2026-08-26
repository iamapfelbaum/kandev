"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconPlus, IconUpload } from "@tabler/icons-react";
import { Button } from "@kandev/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@kandev/ui/dialog";
import { Input } from "@kandev/ui/input";
import { Label } from "@kandev/ui/label";
import { WorkspaceSectionHeader } from "@/components/settings/workspaces/workspace-section-header";
import { useWorkspaceCanvases } from "@/hooks/domains/canvas/use-workspace-canvases";
import {
  addCanvasTaskLink,
  exportCanvas,
  previewCanvasImport,
  removeCanvasTaskLink,
} from "@/lib/api/domains/canvas-api";
import { useRouter } from "@/lib/routing/client-router";
import type { Canvas, CanvasImportPreview } from "@/lib/types/canvas";
import { triggerBlobDownload } from "@/lib/utils/file-download";
import { CanvasSettingsRow } from "./canvas-settings-row";

type CanvasSettingsActions = {
  onRename: (canvasId: string, title: string) => Promise<void>;
  onArchive: (canvasId: string, archived: boolean) => Promise<void>;
  onRemove: (canvasId: string) => Promise<void>;
  onExport: (canvasId: string) => Promise<void>;
  onLinkTask: (canvasId: string, taskId: string) => Promise<void>;
  onUnlinkTask: (canvasId: string, taskId: string) => Promise<void>;
};

const IMPORT_CANVAS_LABEL = "canvases:importCanvas";
const TASK_ID_LABEL = "canvases:taskId";
const TASK_ID_PLACEHOLDER = "canvases:taskIdPlaceholder";
const IMPORT_TASK_ID_INPUT = "canvas-import-task-id";

function CanvasImportPreviewCard({ preview }: { preview: CanvasImportPreview }) {
  const { t } = useTranslation();
  return (
    <div
      className="rounded-md border border-border/60 bg-muted/20 p-3 text-sm"
      data-testid="canvas-import-preview"
    >
      <p className="font-medium">{preview.title}</p>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <div>
          <dt>{t("canvases:importFormatVersion")}</dt>
          <dd>{preview.format_version}</dd>
        </div>
        <div>
          <dt>{t("canvases:importBlockCount")}</dt>
          <dd>{preview.block_count}</dd>
        </div>
        <div>
          <dt>{t("canvases:importSize")}</dt>
          <dd>{preview.size_bytes}</dd>
        </div>
        <div className="col-span-2 sm:col-span-3">
          <dt>{t("canvases:importBlockTypes")}</dt>
          <dd>{preview.block_types.join(", ") || t("canvases:emptyBlock")}</dd>
        </div>
        {preview.task_id && (
          <div className="col-span-2 sm:col-span-3">
            <dt>{t(TASK_ID_LABEL)}</dt>
            <dd>{preview.task_id}</dd>
          </div>
        )}
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">{t("canvases:importIndependentCopy")}</p>
    </div>
  );
}

function CanvasImportFields({
  file,
  taskId,
  onFileChange,
  onTaskIdChange,
}: {
  file: File | null;
  taskId: string;
  onFileChange: (file: File | null) => void;
  onTaskIdChange: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <Label htmlFor="canvas-import-file">{t(IMPORT_CANVAS_LABEL)}</Label>
      <input
        id="canvas-import-file"
        type="file"
        accept=".kandev-canvas,application/vnd.kandev.canvas+json,application/json"
        className="block min-h-11 w-full cursor-pointer text-sm text-muted-foreground file:mr-4 file:min-h-11 file:border-0 file:bg-primary file:px-4 file:font-medium file:text-primary-foreground"
        onChange={(event) => {
          onFileChange(event.target.files?.[0] ?? null);
          event.target.value = "";
        }}
      />
      {file && (
        <p className="text-sm text-muted-foreground">
          {t("canvases:importFileSelected", { fileName: file.name })}
        </p>
      )}
      <div className="space-y-2">
        <Label htmlFor={IMPORT_TASK_ID_INPUT}>{t(TASK_ID_LABEL)}</Label>
        <Input
          id={IMPORT_TASK_ID_INPUT}
          value={taskId}
          onChange={(event) => onTaskIdChange(event.target.value)}
          placeholder={t(TASK_ID_PLACEHOLDER)}
          aria-label={t(TASK_ID_LABEL)}
          className="min-h-11 md:min-h-7"
        />
      </div>
    </div>
  );
}

function CanvasImportFooter({
  file,
  preview,
  busy,
  onCancel,
  onImport,
}: {
  file: File | null;
  preview: CanvasImportPreview | null;
  busy: boolean;
  onCancel: () => void;
  onImport: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogFooter>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 md:min-h-7"
        onClick={onCancel}
        disabled={busy}
      >
        {t("common:cancel")}
      </Button>
      <Button
        type="button"
        className="min-h-11 md:min-h-7"
        data-testid="canvas-import-submit"
        onClick={onImport}
        disabled={!file || !preview || busy}
      >
        <IconUpload className="h-4 w-4" />
        {t("canvases:importAsNewCanvas")}
      </Button>
    </DialogFooter>
  );
}

function CanvasImportDialog({
  open,
  onOpenChange,
  onPreview,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPreview: (file: File, taskId: string) => Promise<CanvasImportPreview | null>;
  onImport: (file: File, taskId: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [taskId, setTaskId] = useState("");
  const [preview, setPreview] = useState<CanvasImportPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setFile(null);
    setTaskId("");
    setPreview(null);
  };

  const validateFile = async () => {
    if (!file || busy) return;
    setBusy(true);
    try {
      setPreview(await onPreview(file, taskId.trim()));
    } finally {
      setBusy(false);
    }
  };

  const handleFileChange = (nextFile: File | null) => {
    setFile(nextFile);
    setPreview(null);
  };

  const importFile = async () => {
    if (!file || !preview || busy) return;
    setBusy(true);
    try {
      if (await onImport(file, taskId.trim())) {
        reset();
        onOpenChange(false);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) {
          if (!nextOpen) reset();
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(IMPORT_CANVAS_LABEL)}</DialogTitle>
        </DialogHeader>
        <CanvasImportFields
          file={file}
          taskId={taskId}
          onFileChange={handleFileChange}
          onTaskIdChange={(value) => {
            setTaskId(value);
            setPreview(null);
          }}
        />
        <div className="space-y-3">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 md:min-h-7"
            onClick={() => void validateFile()}
            disabled={!file || busy}
          >
            {t("canvases:validateImport")}
          </Button>
          {preview && <CanvasImportPreviewCard preview={preview} />}
        </div>
        <CanvasImportFooter
          file={file}
          preview={preview}
          busy={busy}
          onCancel={() => onOpenChange(false)}
          onImport={() => void importFile()}
        />
      </DialogContent>
    </Dialog>
  );
}

function CanvasSettingsHeader({
  onImportOpen,
  onCreateOpen,
}: {
  onImportOpen: () => void;
  onCreateOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <WorkspaceSectionHeader
      tab="canvases"
      description={t("canvases:canvasSettingsDescription")}
      action={
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 md:min-h-7"
            onClick={onImportOpen}
          >
            <IconUpload className="h-4 w-4" />
            {t(IMPORT_CANVAS_LABEL)}
          </Button>
          <Button type="button" className="min-h-11 md:min-h-7" onClick={onCreateOpen}>
            <IconPlus className="h-4 w-4" />
            {t("canvases:newCanvas")}
          </Button>
        </div>
      }
    />
  );
}

function CanvasCreateDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (title: string, taskId: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [taskId, setTaskId] = useState("");

  const submit = async () => {
    if (!title.trim()) return;
    if (await onCreate(title, taskId)) {
      setTitle("");
      setTaskId("");
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("canvases:newCanvas")}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="canvas-title">{t("canvases:canvasTitle")}</Label>
            <Input
              id="canvas-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("canvases:canvasTitlePlaceholder")}
              aria-label={t("canvases:canvasTitle")}
              className="min-h-11 md:min-h-7"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="canvas-task-id">{t("canvases:taskId")}</Label>
            <Input
              id="canvas-task-id"
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
              placeholder={t("canvases:taskIdPlaceholder")}
              aria-label={t("canvases:taskId")}
              className="min-h-11 md:min-h-7"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 md:min-h-7"
              onClick={() => onOpenChange(false)}
            >
              {t("common:cancel")}
            </Button>
            <Button type="submit" className="min-h-11 md:min-h-7" disabled={!title.trim()}>
              {t("canvases:createCanvas")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CanvasSearchControls({
  query,
  onQueryChange,
  canvases,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  canvases: Canvas[];
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <Input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={t("canvases:searchCanvases")}
        aria-label={t("canvases:searchCanvases")}
        className="min-h-11 sm:max-w-md md:min-h-7"
      />
      <p className="text-xs text-muted-foreground">
        {t("canvases:canvasCounts", {
          active: canvases.filter((canvas) => !canvas.archived_at).length,
          archived: canvases.filter((canvas) => !!canvas.archived_at).length,
        })}
      </p>
    </div>
  );
}

function CanvasSettingsRows({
  canvases,
  actions,
}: {
  canvases: Canvas[];
  actions: CanvasSettingsActions;
}) {
  return (
    <div className="flex flex-col gap-4">
      {canvases.map((canvas) => (
        <CanvasSettingsRow
          key={canvas.id}
          canvas={canvas}
          onRename={(title) => actions.onRename(canvas.id, title)}
          onArchive={(archived) => actions.onArchive(canvas.id, archived)}
          onRemove={() => actions.onRemove(canvas.id)}
          onExport={() => actions.onExport(canvas.id)}
          onLinkTask={(taskId) => actions.onLinkTask(canvas.id, taskId)}
          onUnlinkTask={(taskId) => actions.onUnlinkTask(canvas.id, taskId)}
        />
      ))}
    </div>
  );
}

function CanvasSettingsResults({
  loading,
  canvases,
  filteredCanvases,
  actions,
}: {
  loading: boolean;
  canvases: Canvas[];
  filteredCanvases: Canvas[];
  actions: CanvasSettingsActions;
}) {
  const { t } = useTranslation();
  if (loading && canvases.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        {t("canvases:loadingCanvases")}
      </p>
    );
  }
  if (filteredCanvases.length === 0) {
    const message = canvases.length === 0 ? "canvases:noCanvases" : "canvases:noMatchingCanvases";
    return <p className="py-12 text-center text-sm text-muted-foreground">{t(message)}</p>;
  }
  return <CanvasSettingsRows canvases={filteredCanvases} actions={actions} />;
}

export function CanvasSettingsPage({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = useWorkspaceCanvases(workspaceId, true);

  const filteredCanvases = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return state.canvases;
    return state.canvases.filter((canvas) => canvas.title.toLocaleLowerCase().includes(needle));
  }, [query, state.canvases]);

  const run = async <T,>(action: () => Promise<T>): Promise<T | null> => {
    setError(null);
    try {
      return await action();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("canvases:canvasActionFailed"));
      return null;
    }
  };

  const create = async (title: string, taskId: string) => {
    const trimmedTaskId = taskId.trim();
    const canvas = await run(() => state.create(title.trim(), trimmedTaskId || undefined));
    if (!canvas) return false;
    router.push(`/canvases/${encodeURIComponent(canvas.id)}`);
    return true;
  };

  const previewFile = async (file: File, taskId: string) =>
    run(async () => previewCanvasImport(workspaceId, await file.text(), taskId || undefined));

  const importFile = async (file: File, taskId: string) => {
    const canvas = await run(async () => state.importFile(await file.text(), taskId || undefined));
    if (!canvas) return false;
    router.push(`/canvases/${encodeURIComponent(canvas.id)}`);
    return true;
  };

  const actions: CanvasSettingsActions = {
    onRename: (canvasId, title) => run(() => state.rename(canvasId, title)).then(() => undefined),
    onArchive: (canvasId, archived) =>
      run(() => state.archive(canvasId, archived)).then(() => undefined),
    onRemove: (canvasId) => run(() => state.remove(canvasId)).then(() => undefined),
    onExport: (canvasId) =>
      run(async () => {
        const blob = await exportCanvas(canvasId);
        triggerBlobDownload(blob, "canvas.kandev-canvas");
      }).then(() => undefined),
    onLinkTask: (canvasId, taskId) =>
      run(() => addCanvasTaskLink(canvasId, taskId).then(state.refresh)).then(() => undefined),
    onUnlinkTask: (canvasId, taskId) =>
      run(() => removeCanvasTaskLink(canvasId, taskId).then(state.refresh)).then(() => undefined),
  };

  return (
    <div className="space-y-6" data-testid="canvas-settings-page">
      <CanvasSettingsHeader
        onImportOpen={() => setImportOpen(true)}
        onCreateOpen={() => setCreateOpen(true)}
      />
      <CanvasCreateDialog open={createOpen} onOpenChange={setCreateOpen} onCreate={create} />
      <CanvasImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onPreview={previewFile}
        onImport={importFile}
      />
      <CanvasSearchControls query={query} onQueryChange={setQuery} canvases={state.canvases} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <CanvasSettingsResults
        loading={state.loading}
        canvases={state.canvases}
        filteredCanvases={filteredCanvases}
        actions={actions}
      />
    </div>
  );
}
