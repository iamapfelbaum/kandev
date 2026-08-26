import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { applyCanvasCommand, getCanvas } from "@/lib/api/domains/canvas-api";
import { ApiError } from "@/lib/api/client";
import { getWebSocketClient } from "@/lib/ws/connection";
import type {
  ApplyCanvasCommandRequest,
  ApplyCanvasCommandResult,
  Canvas,
  CanvasConflictDetails,
  CanvasEvent,
} from "@/lib/types/canvas";
import type { CanvasSubscriptionState } from "@/lib/ws/client";

function conflictDetails(error: unknown): CanvasConflictDetails | null {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object") return null;
  const details = (error.body as { details?: unknown }).details;
  return details && typeof details === "object" ? (details as CanvasConflictDetails) : null;
}

// eslint-disable-next-line max-lines-per-function
export function useCanvas(canvasId: string) {
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<CanvasConflictDetails | null>(null);
  const [subscriptionState, setSubscriptionState] = useState<CanvasSubscriptionState | null>(null);
  const [lastEvent, setLastEvent] = useState<CanvasEvent | null>(null);
  const requestRef = useRef(0);
  const canvasRevisionRef = useRef(0);
  const reportError = useCallback((err: unknown) => {
    setConflict(conflictDetails(err));
    setError(err instanceof Error ? err.message : t("canvases:canvasActionFailed"));
  }, []);
  const setCanvasSnapshot = useCallback(
    (next: Canvas | null) => {
      const subscribedRevision =
        getWebSocketClient()?.getCanvasSubscriptionState(canvasId).revision ?? 0;
      if (next && next.revision < Math.max(canvasRevisionRef.current, subscribedRevision))
        return false;
      canvasRevisionRef.current = next?.revision ?? 0;
      setCanvas(next);
      return true;
    },
    [canvasId],
  );
  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const next = await getCanvas(canvasId, { cache: "no-store" });
      if (requestRef.current !== requestId) return next;
      if (setCanvasSnapshot(next)) {
        getWebSocketClient()?.acknowledgeCanvasRevision(canvasId, next.revision);
      }
      setError(null);
      setConflict(null);
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
    setConflict(null);
    setSubscriptionState(null);
    setLastEvent(null);
    canvasRevisionRef.current = 0;
    const unsubscribeSnapshot = client?.onCanvasSubscription(canvasId, (payload) => {
      if (payload.canvas?.id !== canvasId) return;
      if (setCanvasSnapshot(payload.canvas)) {
        client.acknowledgeCanvasRevision(canvasId, payload.canvas.revision);
      }
      setLastEvent(payload.events?.at(-1) ?? null);
      setError(null);
    });
    const unsubscribeState = client?.onCanvasSubscriptionState(canvasId, setSubscriptionState);
    const unsubscribeEvent = client?.on("canvas.event", (message) => {
      if (message.payload.canvas_id !== canvasId) return;
      setLastEvent(message.payload as CanvasEvent);
      void refresh();
    });
    const unsubscribeCanvas = client?.subscribeCanvas(canvasId);
    void refresh();
    return () => {
      unsubscribeEvent?.();
      unsubscribeSnapshot?.();
      unsubscribeState?.();
      unsubscribeCanvas?.();
    };
  }, [canvasId, refresh, setCanvasSnapshot]);

  const apply = useCallback(
    async (command: ApplyCanvasCommandRequest): Promise<ApplyCanvasCommandResult | null> => {
      if (!canvas) return null;
      try {
        const result = await applyCanvasCommand(canvas.id, command);
        if (setCanvasSnapshot(result.canvas)) {
          getWebSocketClient()?.acknowledgeCanvasRevision(canvas.id, result.canvas.revision);
        }
        setConflict(null);
        setError(null);
        return result;
      } catch (err: unknown) {
        reportError(err);
        throw err;
      }
    },
    [canvas, reportError, setCanvasSnapshot],
  );

  return {
    canvas,
    loading,
    error,
    conflict,
    subscriptionState,
    lastEvent,
    refresh,
    apply,
    reportError,
  };
}
