import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import {
  archiveCanvas,
  createCanvas,
  importCanvas,
  listCanvases,
  renameCanvas,
  removeCanvas,
} from "@/lib/api/domains/canvas-api";
import type { Canvas } from "@/lib/types/canvas";

const EMPTY_CANVASES: Canvas[] = [];

type LoadedCanvases = {
  workspaceId: string | undefined;
  canvases: Canvas[];
};

const NOTHING_LOADED: LoadedCanvases = {
  workspaceId: undefined,
  canvases: EMPTY_CANVASES,
};

export function useWorkspaceCanvases(workspaceId: string | undefined, includeArchived = true) {
  const [loaded, setLoaded] = useState<LoadedCanvases>(NOTHING_LOADED);
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(() => {
    const requestId = ++requestRef.current;
    if (!workspaceId) {
      setLoading(false);
      setLoaded(NOTHING_LOADED);
      return;
    }
    setLoading(true);
    listCanvases(workspaceId, includeArchived)
      .then((canvases) => {
        if (requestRef.current !== requestId) return;
        setLoaded({ workspaceId, canvases });
        setError(null);
      })
      .catch((err: unknown) => {
        if (requestRef.current !== requestId) return;
        setLoaded({ workspaceId, canvases: EMPTY_CANVASES });
        setError(err instanceof Error ? err.message : t("canvases:failedToLoadCanvases"));
      })
      .finally(() => {
        if (requestRef.current === requestId) setLoading(false);
      });
  }, [includeArchived, workspaceId]);

  useEffect(() => refresh(), [refresh]);

  const switching = loaded.workspaceId !== workspaceId;
  const canvases = switching ? EMPTY_CANVASES : loaded.canvases;
  return {
    canvases,
    loading: loading || (switching && Boolean(workspaceId)),
    error: switching ? null : error,
    refresh,
    create: async (title: string, taskId?: string) => {
      if (!workspaceId) return null;
      const canvas = await createCanvas(workspaceId, title, taskId);
      refresh();
      return canvas;
    },
    importFile: async (file: string, taskId?: string) => {
      if (!workspaceId) return null;
      const canvas = await importCanvas(workspaceId, file, taskId);
      refresh();
      return canvas;
    },
    archive: async (canvasId: string, archived: boolean) => {
      await archiveCanvas(canvasId, archived);
      refresh();
    },
    rename: async (canvasId: string, title: string) => {
      await renameCanvas(canvasId, title);
      refresh();
    },
    remove: async (canvasId: string) => {
      await removeCanvas(canvasId);
      refresh();
    },
  };
}
