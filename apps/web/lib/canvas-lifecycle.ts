import { useSyncExternalStore } from "react";

type Listener = () => void;

let revision = 0;
const listeners = new Set<Listener>();

/**
 * Canvas metadata is intentionally fetched from the authoritative HTTP API.
 * This small external store only tells visible projections that a committed
 * lifecycle event arrived over WebSocket and that they must refetch.
 */
export function invalidateCanvasLifecycle(): void {
  revision += 1;
  listeners.forEach((listener) => listener());
}

export function subscribeCanvasLifecycle(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCanvasLifecycleRevision(): number {
  return revision;
}

export function useCanvasLifecycleRevision(): number {
  return useSyncExternalStore(
    subscribeCanvasLifecycle,
    getCanvasLifecycleRevision,
    getCanvasLifecycleRevision,
  );
}
