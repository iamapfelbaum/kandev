"use client";

import { useTranslation } from "react-i18next";
import { IconArrowLeft } from "@tabler/icons-react";
import { Button } from "@kandev/ui/button";
import { CanvasBlockCard } from "./canvas-block-card";
import { CanvasPageHeader } from "./canvas-page-header";
import { useCanvasPageActions } from "./canvas-page-actions";
import { useCanvas } from "@/hooks/domains/canvas/use-canvas";
import { useResponsiveBreakpoint } from "@/hooks/use-responsive-breakpoint";
import Link from "@/components/routing/app-link";

export function CanvasPage({
  canvasId,
  embedded = false,
}: {
  canvasId: string;
  embedded?: boolean;
}) {
  const { t } = useTranslation();
  const { isMobile } = useResponsiveBreakpoint();
  const {
    canvas,
    loading,
    error,
    conflict,
    subscriptionState,
    lastEvent,
    apply,
    refresh,
    reportError,
  } = useCanvas(canvasId);
  const { busy, addBlock, download, archive, remove } = useCanvasPageActions({
    canvas,
    apply,
    refresh,
  });
  const readOnly = Boolean(canvas?.archived_at) || subscriptionState?.status !== "connected";

  if (loading && !canvas) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center" role="status">
        {t("canvases:loadingCanvases")}
      </div>
    );
  }

  if (!canvas) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-destructive">{error ?? t("canvases:canvasNotFound")}</p>
        <Button asChild variant="outline" className="min-h-11 md:min-h-7">
          <Link href="/">
            <IconArrowLeft className="h-4 w-4" />
            {t("common:back")}
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <main
      className={`flex min-h-0 w-full flex-col overflow-hidden bg-background ${embedded || !isMobile ? "h-full" : "h-dvh"}`}
      data-testid="canvas-page"
    >
      <CanvasPageHeader
        canvas={canvas}
        embedded={embedded}
        busy={busy}
        readOnly={readOnly}
        onAddBlock={(type) => void addBlock(type)}
        onDownload={() => void download()}
        onArchive={() => void archive()}
        onRemove={() => void remove()}
      />
      <CanvasStatus
        subscriptionState={subscriptionState}
        lastEvent={lastEvent}
        conflict={conflict !== null}
      />
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6">
        {canvas.blocks.length === 0 ? (
          <div className="flex min-h-48 items-center justify-center text-center text-sm text-muted-foreground">
            {t("canvases:emptyBlock")}
          </div>
        ) : (
          <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 lg:grid-cols-2">
            {canvas.blocks.map((block) => (
              <CanvasBlockCard
                key={block.id}
                canvas={canvas}
                block={block}
                readOnly={readOnly}
                apply={apply}
                onError={reportError}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function CanvasStatus({
  subscriptionState,
  lastEvent,
  conflict,
}: {
  subscriptionState: ReturnType<typeof useCanvas>["subscriptionState"];
  lastEvent: ReturnType<typeof useCanvas>["lastEvent"];
  conflict: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {(subscriptionState?.status === "recovering" || subscriptionState?.status === "error") && (
        <div
          className="mx-4 mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
          role="status"
        >
          {subscriptionState.status === "error"
            ? t("canvases:connectionLost")
            : t("canvases:recoveringCanvas")}
        </div>
      )}
      {lastEvent?.actor_kind === "agent" && (
        <div
          className="mx-4 mt-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
          role="status"
        >
          {t("canvases:agentChanges")}
        </div>
      )}
      {conflict && (
        <div
          className="mx-4 mt-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          role="alert"
          data-testid="canvas-conflict-recovery"
        >
          {t("canvases:conflictRecovery")}
        </div>
      )}
    </>
  );
}
