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
  removeCanvasTaskLink,
} from "@/lib/api/domains/canvas-api";
import { useRouter } from "@/lib/routing/client-router";
import type { Canvas } from "@/lib/types/canvas";
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

function CanvasImportDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (file: File) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const importFile = async () => {
    if (!file || busy) return;
    setBusy(true);
    try {
      if (await onImport(file)) {
        setFile(null);
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
          if (!nextOpen) setFile(null);
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(IMPORT_CANVAS_LABEL)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Label htmlFor="canvas-import-file">{t(IMPORT_CANVAS_LABEL)}</Label>
          <input
            id="canvas-import-file"
            type="file"
            accept=".kandev-canvas,application/vnd.kandev.canvas+json,application/json"
            className="block min-h-11 w-full cursor-pointer text-sm text-muted-foreground file:mr-4 file:min-h-11 file:border-0 file:bg-primary file:px-4 file:font-medium file:text-primary-foreground"
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
          />
          {file && (
            <p className="text-sm text-muted-foreground">
              {t("canvases:importFileSelected", { fileName: file.name })}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 md:min-h-7"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("common:cancel")}
          </Button>
          <Button
            type="button"
            className="min-h-11 md:min-h-7"
            data-testid="canvas-import-submit"
            onClick={() => void importFile()}
            disabled={!file || busy}
          >
            <IconUpload className="h-4 w-4" />
            {t(IMPORT_CANVAS_LABEL)}
          </Button>
        </DialogFooter>
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

  const importFile = async (file: File) => {
    const canvas = await run(async () => state.importFile(await file.text()));
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
      <CanvasImportDialog open={importOpen} onOpenChange={setImportOpen} onImport={importFile} />
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
