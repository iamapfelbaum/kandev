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

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const next = await getCanvas(canvasId, { cache: "no-store" });
      if (requestRef.current !== requestId) return next;
      setCanvas(next);
      setError(null);
      return next;
    } catch (err: unknown) {
      if (requestRef.current === requestId) {
        setCanvas(null);
        setError(err instanceof Error ? err.message : t("canvases:canvasNotFound"));
      }
      return null;
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [canvasId]);

  useEffect(() => {
    const client = getWebSocketClient();
    const unsubscribeEvent = client?.on("canvas.event", (message) => {
      if (message.payload.canvas_id !== canvasId) return;
      void refresh();
    });
    const unsubscribeCanvas = client?.subscribeCanvas(canvasId);
    void refresh();
    return () => {
      unsubscribeEvent?.();
      unsubscribeCanvas?.();
    };
  }, [canvasId, refresh]);

  const apply = useCallback(
    async (command: ApplyCanvasCommandRequest): Promise<ApplyCanvasCommandResult | null> => {
      if (!canvas) return null;
      const result = await applyCanvasCommand(canvas.id, command);
      setCanvas(result.canvas);
      setError(null);
      return result;
    },
    [canvas],
  );

  return { canvas, loading, error, refresh, apply };
}
