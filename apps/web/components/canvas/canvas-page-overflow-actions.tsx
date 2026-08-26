"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IconArchive, IconDots, IconDownload, IconRestore, IconTrash } from "@tabler/icons-react";
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

type CanvasPageOverflowActionsProps = {
  canvas: Canvas;
  embedded: boolean;
  busy: boolean;
  settingsHref: string;
  onDownload: () => void;
  onArchive: () => void;
  onRemove: () => void;
};

function ActionButton({
  label,
  onClick,
  disabled,
  destructive = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className={`min-h-11 w-full justify-start gap-2 ${destructive ? "text-destructive hover:text-destructive" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
      {label}
    </Button>
  );
}

function CanvasOverflowList({
  canvas,
  embedded,
  busy,
  settingsHref,
  onDownload,
  onArchive,
  onRemove,
  close,
}: CanvasPageOverflowActionsProps & { close: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-1">
      <ActionButton
        label={t("canvases:exportCanvas")}
        disabled={busy}
        onClick={() => {
          onDownload();
          close();
        }}
      >
        <IconDownload className="h-4 w-4" />
      </ActionButton>
      <ActionButton
        label={canvas.archived_at ? t("canvases:restoreCanvas") : t("canvases:archiveCanvas")}
        disabled={busy}
        onClick={() => {
          onArchive();
          close();
        }}
      >
        {canvas.archived_at ? (
          <IconRestore className="h-4 w-4" />
        ) : (
          <IconArchive className="h-4 w-4" />
        )}
      </ActionButton>
      {!embedded && (
        <ActionButton
          label={t("canvases:removeCanvas")}
          disabled={busy}
          destructive
          onClick={() => {
            onRemove();
            close();
          }}
        >
          <IconTrash className="h-4 w-4" />
        </ActionButton>
      )}
      <Button
        asChild
        type="button"
        variant="ghost"
        className="min-h-11 w-full justify-start gap-2"
        onClick={close}
      >
        <Link href={settingsHref}>{t("canvases:taskLinks")}</Link>
      </Button>
    </div>
  );
}

export function CanvasPageOverflowActions({
  canvas,
  embedded,
  busy,
  settingsHref,
  onDownload,
  onArchive,
  onRemove,
}: CanvasPageOverflowActionsProps) {
  const { t } = useTranslation();
  const touch = useTouchDrawer();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  if (touch) {
    return (
      <>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="min-h-11 min-w-11"
          aria-label={t("canvases:canvasActions")}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <IconDots className="h-4 w-4" />
        </Button>
        <MobilePickerSheet
          open={open}
          onOpenChange={setOpen}
          title={t("canvases:canvasActions")}
          contentTestId="canvas-page-action-drawer"
        >
          <CanvasOverflowList
            canvas={canvas}
            embedded={embedded}
            busy={busy}
            settingsHref={settingsHref}
            onDownload={onDownload}
            onArchive={onArchive}
            onRemove={onRemove}
            close={close}
          />
        </MobilePickerSheet>
      </>
    );
  }

  return (
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
  );
}
