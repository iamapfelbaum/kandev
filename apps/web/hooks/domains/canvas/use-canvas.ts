import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { applyCanvasCommand, getCanvas } from "@/lib/api/domains/canvas-api";
import { getWebSocketClient } from "@/lib/ws/connection";
import type {
  ApplyCanvasCommandRequest,
  ApplyCanvasCommandResult,
  Canvas,
} from "@/lib/types/canvas";

export function useCanvas(canvasId: string) {
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const canvasRevisionRef = useRef(0);

  const setCanvasSnapshot = useCallback((next: Canvas | null) => {
    if (next && next.revision < canvasRevisionRef.current) return false;
    canvasRevisionRef.current = next?.revision ?? 0;
    setCanvas(next);
    return true;
  }, []);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const next = await getCanvas(canvasId, { cache: "no-store" });
      if (requestRef.current !== requestId) return next;
      setCanvasSnapshot(next);
      setError(null);
      return next;
    } catch (err: unknown) {
      if (requestRef.current === requestId) {
        if (canvasRevisionRef.current === 0) setCanvasSnapshot(null);
        setError(err instanceof Error ? err.message : t("canvases:canvasNotFound"));
      }
      return null;
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [canvasId, setCanvasSnapshot]);

  useEffect(() => {
    const client = getWebSocketClient();
    setCanvas(null);
    setError(null);
    canvasRevisionRef.current = 0;
    const unsubscribeSnapshot = client?.onCanvasSubscription(canvasId, (payload) => {
      if (payload.canvas?.id !== canvasId) return;
      setCanvasSnapshot(payload.canvas);
      setError(null);
    });
    const unsubscribeEvent = client?.on("canvas.event", (message) => {
      if (message.payload.canvas_id !== canvasId) return;
      void refresh();
    });
    const unsubscribeCanvas = client?.subscribeCanvas(canvasId);
    void refresh();
    return () => {
      unsubscribeEvent?.();
      unsubscribeSnapshot?.();
      unsubscribeCanvas?.();
    };
  }, [canvasId, refresh, setCanvasSnapshot]);

  const apply = useCallback(
    async (command: ApplyCanvasCommandRequest): Promise<ApplyCanvasCommandResult | null> => {
      if (!canvas) return null;
      const result = await applyCanvasCommand(canvas.id, command);
      setCanvasSnapshot(result.canvas);
      setError(null);
      return result;
    },
    [canvas, setCanvasSnapshot],
  );

  return { canvas, loading, error, refresh, apply };
}
