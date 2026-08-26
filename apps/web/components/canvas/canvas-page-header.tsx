import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconArrowLeft, IconPlus } from "@tabler/icons-react";
import { Button } from "@kandev/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@kandev/ui/dropdown-menu";
import { MobilePickerSheet } from "@/components/task/mobile/mobile-picker-sheet";
import Link from "@/components/routing/app-link";
import { useTouchDrawer } from "@/hooks/use-compact-task-chrome";
import type { Canvas } from "@/lib/types/canvas";
import type { CanvasBlockType } from "@/lib/types/canvas";
import { CanvasPageOverflowActions } from "./canvas-page-overflow-actions";

type CanvasPageHeaderProps = {
  canvas: Canvas;
  embedded: boolean;
  busy: boolean;
  readOnly: boolean;
  onAddBlock: (type: CanvasBlockType) => void;
  onDownload: () => void;
  onArchive: () => void;
  onRemove: () => void;
};

function AddBlockMenu({
  busy,
  archived,
  onAddBlock,
}: {
  busy: boolean;
  archived: boolean;
  onAddBlock: (type: CanvasBlockType) => void;
}) {
  const { t } = useTranslation();
  const touch = useTouchDrawer();
  const [open, setOpen] = useState(false);
  const blockTypes: CanvasBlockType[] = ["markdown", "checklist", "kanban", "metrics", "timeline"];
  const selectBlockType = (type: CanvasBlockType) => {
    onAddBlock(type);
    setOpen(false);
  };
  if (touch) {
    return (
      <>
        <Button
          type="button"
          size="sm"
          className="min-h-11"
          disabled={busy || archived}
          data-testid="canvas-add-block"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <IconPlus className="h-4 w-4" />
          {t("canvases:addBlock")}
        </Button>
        <MobilePickerSheet
          open={open}
          onOpenChange={setOpen}
          title={t("canvases:addBlock")}
          contentTestId="canvas-add-block-picker"
        >
          <div className="grid gap-1">
            {blockTypes.map((type) => (
              <Button
                key={type}
                type="button"
                variant="ghost"
                className="min-h-11 w-full justify-start"
                onClick={() => selectBlockType(type)}
              >
                {t(`canvases:${type}`)}
              </Button>
            ))}
          </div>
        </MobilePickerSheet>
      </>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          className="min-h-11 md:min-h-7"
          disabled={busy || archived}
          data-testid="canvas-add-block"
        >
          <IconPlus className="h-4 w-4" />
          {t("canvases:addBlock")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {blockTypes.map((type) => (
          <DropdownMenuItem key={type} onClick={() => selectBlockType(type)}>
            {t(`canvases:${type}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CanvasPageHeader({
  canvas,
  embedded,
  busy,
  readOnly,
  onAddBlock,
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
          disabled={busy || readOnly || !!canvas.archived_at}
          onClick={() => onAddBlock("markdown")}
        >
          <IconPlus className="h-4 w-4" />
          {t("canvases:addMarkdownBlock")}
        </Button>
        <AddBlockMenu
          busy={busy || readOnly}
          archived={!!canvas.archived_at}
          onAddBlock={onAddBlock}
        />
        <CanvasPageOverflowActions
          canvas={canvas}
          embedded={embedded}
          busy={busy}
          settingsHref={settingsHref}
          onDownload={onDownload}
          onArchive={onArchive}
          onRemove={onRemove}
        />
      </div>
    </header>
  );
}
