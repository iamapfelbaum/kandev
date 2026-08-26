import { useTranslation } from "react-i18next";
import {
  IconArchive,
  IconArrowLeft,
  IconDots,
  IconDownload,
  IconPlus,
  IconRestore,
  IconTrash,
} from "@tabler/icons-react";
import { Button } from "@kandev/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@kandev/ui/dropdown-menu";
import Link from "@/components/routing/app-link";
import type { Canvas } from "@/lib/types/canvas";

type CanvasPageHeaderProps = {
  canvas: Canvas;
  embedded: boolean;
  busy: boolean;
  onAddMarkdownBlock: () => void;
  onDownload: () => void;
  onArchive: () => void;
  onRemove: () => void;
};

export function CanvasPageHeader({
  canvas,
  embedded,
  busy,
  onAddMarkdownBlock,
  onDownload,
  onArchive,
  onRemove,
}: CanvasPageHeaderProps) {
  const { t } = useTranslation();
  const settingsHref = `/settings/workspaces/${encodeURIComponent(canvas.workspace_id)}/canvases`;

  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        {!embedded && (
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
          >
            <Link href={settingsHref} aria-label={t("common:back")}>
              <IconArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{canvas.title}</h1>
          <p className="text-xs text-muted-foreground">
            {t("canvases:canvasRevision", { revision: canvas.revision })}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          className="min-h-11 md:min-h-7"
          disabled={busy || !!canvas.archived_at}
          onClick={onAddMarkdownBlock}
        >
          <IconPlus className="h-4 w-4" />
          {t("canvases:addMarkdownBlock")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="min-h-11 min-w-11 md:min-h-7 md:min-w-7"
              aria-label={t("canvases:canvasActions")}
            >
              <IconDots className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onDownload} disabled={busy}>
              <IconDownload className="mr-2 h-4 w-4" />
              {t("canvases:exportCanvas")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onArchive} disabled={busy}>
              {canvas.archived_at ? (
                <IconRestore className="mr-2 h-4 w-4" />
              ) : (
                <IconArchive className="mr-2 h-4 w-4" />
              )}
              {canvas.archived_at ? t("canvases:restoreCanvas") : t("canvases:archiveCanvas")}
            </DropdownMenuItem>
            {!embedded && (
              <DropdownMenuItem
                onClick={onRemove}
                disabled={busy}
                className="text-destructive focus:text-destructive"
              >
                <IconTrash className="mr-2 h-4 w-4" />
                {t("canvases:removeCanvas")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem asChild>
              <Link href={settingsHref}>{t("canvases:taskLinks")}</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
