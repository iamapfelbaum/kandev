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
  const { canvas, loading, error, apply, refresh } = useCanvas(canvasId);
  const { busy, addMarkdownBlock, download, archive, remove } = useCanvasPageActions({
    canvas,
    apply,
    refresh,
  });

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
        onAddMarkdownBlock={() => void addMarkdownBlock()}
        onDownload={() => void download()}
        onArchive={() => void archive()}
        onRemove={() => void remove()}
      />
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6">
        {canvas.blocks.length === 0 ? (
          <div className="flex min-h-48 items-center justify-center text-center text-sm text-muted-foreground">
            {t("canvases:emptyBlock")}
          </div>
        ) : (
          <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 lg:grid-cols-2">
            {canvas.blocks.map((block) => (
              <CanvasBlockCard key={block.id} block={block} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
