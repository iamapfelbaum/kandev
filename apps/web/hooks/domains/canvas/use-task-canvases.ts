import { useEffect, useState } from "react";
import { listTaskCanvases } from "@/lib/api/domains/canvas-api";
import type { Canvas } from "@/lib/types/canvas";

export function useTaskCanvases(
  workspaceId: string | undefined,
  taskId: string | null | undefined,
) {
  const [canvases, setCanvases] = useState<Canvas[]>([]);

  useEffect(() => {
    let cancelled = false;
    setCanvases([]);
    if (!workspaceId || !taskId) return () => undefined;
    void listTaskCanvases(workspaceId, taskId)
      .then((items) => {
        if (!cancelled) setCanvases(items);
      })
      .catch(() => {
        if (!cancelled) setCanvases([]);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, workspaceId]);

  return { canvases };
}
