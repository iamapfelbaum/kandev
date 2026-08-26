export type CanvasSubscriptionAction = "canvas.subscribe" | "canvas.unsubscribe";
type CanvasSubscriptionSender = (
  action: CanvasSubscriptionAction,
  canvasId: string,
  afterRevision?: number,
) => void;

export class CanvasSubscriptionRegistry {
  private counts = new Map<string, number>();
  private revisions = new Map<string, number>();

  subscribe(
    canvasId: string,
    isConnected: () => boolean,
    send: CanvasSubscriptionSender,
  ): () => void {
    const nextCount = (this.counts.get(canvasId) ?? 0) + 1;
    this.counts.set(canvasId, nextCount);
    if (isConnected() && nextCount === 1) {
      send("canvas.subscribe", canvasId, this.revisions.get(canvasId) ?? 0);
    }
    return () => this.unsubscribe(canvasId, isConnected, send);
  }

  unsubscribe(canvasId: string, isConnected: () => boolean, send: CanvasSubscriptionSender): void {
    const currentCount = this.counts.get(canvasId);
    if (!currentCount) return;
    if (currentCount === 1) {
      this.counts.delete(canvasId);
      if (isConnected()) send("canvas.unsubscribe", canvasId);
      return;
    }
    this.counts.set(canvasId, currentCount - 1);
  }

  resubscribe(send: CanvasSubscriptionSender): void {
    this.counts.forEach((_count, canvasId) =>
      send("canvas.subscribe", canvasId, this.revisions.get(canvasId) ?? 0),
    );
  }

  forEachActive(callback: (canvasId: string) => void): void {
    this.counts.forEach((_count, canvasId) => callback(canvasId));
  }

  revision(canvasId: string): number {
    return this.revisions.get(canvasId) ?? 0;
  }

  recordRevision(canvasId: string, revision: number): void {
    if (!Number.isFinite(revision) || revision < 0) return;
    this.revisions.set(canvasId, Math.max(this.revision(canvasId), revision));
  }
}
