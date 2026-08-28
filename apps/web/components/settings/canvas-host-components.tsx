"use client";

import {
  IconDots,
  IconEdit,
  IconExternalLink,
  IconLayoutGrid,
  IconListDetails,
  IconSparkles,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { Button } from "@kandev/ui/button";
import { MobilePickerSheet } from "@/components/task/mobile/mobile-picker-sheet";
import { CanvasPage } from "@/components/plugins/canvas-page";
import { canvasHref, type Canvas } from "@/lib/api/domains/canvas-api";
import { CanvasPromotionDialog, CanvasReleaseDialog } from "./canvas-lifecycle-dialogs";

export type CanvasHostState =
  | "loading_metadata"
  | "pending_first_release"
  | "pending_permission"
  | "loading_runtime"
  | "ready"
  | "offline"
  | "invalid_release"
  | "unavailable"
  | "archived";

const STATE_COPY: Record<CanvasHostState, { title: string; description: string }> = {
  loading_metadata: {
    title: "canvases:loadingCanvas",
    description: "canvases:loadingCanvasDescription",
  },
  pending_first_release: {
    title: "canvases:pendingFirstRelease",
    description: "canvases:pendingFirstReleaseDescription",
  },
  pending_permission: {
    title: "canvases:pendingPermission",
    description: "canvases:pendingPermissionDescription",
  },
  loading_runtime: {
    title: "canvases:loadingRuntime",
    description: "canvases:loadingRuntimeDescription",
  },
  ready: { title: "canvases:ready", description: "canvases:readyDescription" },
  offline: { title: "canvases:offline", description: "canvases:offlineDescription" },
  invalid_release: {
    title: "canvases:invalidRelease",
    description: "canvases:invalidReleaseDescription",
  },
  unavailable: { title: "canvases:unavailable", description: "canvases:unavailableDescription" },
  archived: { title: "canvases:archived", description: "canvases:archivedDescription" },
};

export function CanvasHostDialogs({
  canvas,
  promotionOpen,
  onPromotionOpenChange,
  releasesOpen,
  onReleasesOpenChange,
  onPromotionCompleted,
  onChanged,
}: {
  canvas: Canvas | null;
  promotionOpen: boolean;
  onPromotionOpenChange: (open: boolean) => void;
  releasesOpen: boolean;
  onReleasesOpenChange: (open: boolean) => void;
  onPromotionCompleted: () => void;
  onChanged: () => void;
}) {
  return (
    <>
      <CanvasPromotionDialog
        canvas={canvas?.scope_kind === "task" ? canvas : null}
        open={promotionOpen}
        onOpenChange={onPromotionOpenChange}
        onCompleted={onPromotionCompleted}
      />
      <CanvasReleaseDialog
        canvas={canvas}
        open={releasesOpen}
        onOpenChange={onReleasesOpenChange}
        onChanged={onChanged}
      />
    </>
  );
}

export function CanvasHostBody({
  canvasId,
  title,
  state,
  isMobile,
  menuOpen,
  runtimeUrl,
  error,
  onOpenActions,
  onRuntimeError,
  onRetry,
}: {
  canvasId: string;
  title: string;
  state: CanvasHostState;
  isMobile: boolean;
  menuOpen: boolean;
  runtimeUrl: string | null;
  error: string | null;
  onOpenActions: () => void;
  onRuntimeError: () => void;
  onRetry: () => void;
}) {
  return (
    <div
      className="flex h-dvh min-h-0 min-w-0 max-h-[calc(100dvh-2.75rem)] flex-1 flex-col overflow-hidden md:h-auto md:max-h-none"
      data-testid="canvas-host-route"
    >
      <CanvasHostHeader
        title={title}
        state={state}
        isMobile={isMobile}
        menuOpen={menuOpen}
        onOpenActions={onOpenActions}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {state === "ready" && runtimeUrl ? (
          <CanvasPage
            key={`${canvasId}:${runtimeUrl}`}
            runtimeUrl={runtimeUrl}
            title={title}
            onError={onRuntimeError}
          />
        ) : (
          <CanvasHostStatePanel state={state} error={error} onRetry={onRetry} />
        )}
      </div>
    </div>
  );
}

export function CanvasDesktopActions({
  canvas,
  editing,
  onEdit,
  onPromote,
  onReleases,
}: {
  canvas: Canvas;
  editing: boolean;
  onEdit: () => void;
  onPromote: () => void;
  onReleases: () => void;
}) {
  const { t } = useTranslation();
  const lifecycleLocked = canvas.status === "archived" || canvas.status === "disabled";
  return (
    <div className="flex items-center gap-2">
      {canvas.scope_kind === "workspace" && (
        <Button
          variant="outline"
          size="sm"
          className="cursor-pointer"
          disabled={editing || lifecycleLocked}
          onClick={onEdit}
        >
          <IconEdit className="mr-1.5 h-3.5 w-3.5" />
          {t("canvases:editCanvas")}
        </Button>
      )}
      <Button variant="outline" size="sm" className="cursor-pointer" onClick={onReleases}>
        <IconListDetails className="mr-1.5 h-3.5 w-3.5" />
        {t("canvases:releasesAndPermissions")}
      </Button>
      {canvas.scope_kind === "task" &&
        !lifecycleLocked &&
        canvas.active_release_status === "valid" && (
          <Button size="sm" className="cursor-pointer" onClick={onPromote}>
            <IconSparkles className="mr-1.5 h-3.5 w-3.5" />
            {t("canvases:promoteCanvas")}
          </Button>
        )}
    </div>
  );
}

export function CanvasHostHeader({
  title,
  state,
  isMobile,
  menuOpen,
  onOpenActions,
}: {
  title: string;
  state: CanvasHostState;
  isMobile: boolean;
  menuOpen: boolean;
  onOpenActions: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-11 shrink-0 items-center gap-2 border-b px-3 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium md:hidden">{title}</p>
        <p
          className="text-xs text-muted-foreground"
          data-testid="canvas-host-state"
          aria-live="polite"
        >
          {t(STATE_COPY[state].title)}
        </p>
      </div>
      {isMobile && (
        <Button
          variant="outline"
          size="icon"
          className="h-11 w-11 shrink-0 cursor-pointer"
          aria-label={t("canvases:canvasActions")}
          aria-expanded={menuOpen}
          onClick={onOpenActions}
          data-testid="canvas-mobile-actions"
        >
          <IconDots className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

export function CanvasHostStatePanel({
  state,
  error,
  onRetry,
}: {
  state: CanvasHostState;
  error: string | null;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const copy = STATE_COPY[state];
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
      <div className="max-w-md space-y-3">
        <h2 className="text-lg font-semibold">{t(copy.title)}</h2>
        <p className="text-sm text-muted-foreground">{error || t(copy.description)}</p>
        {state !== "loading_metadata" && state !== "loading_runtime" && (
          <Button
            variant="outline"
            className="min-h-11 cursor-pointer md:min-h-7"
            onClick={onRetry}
          >
            {t("canvases:retry")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function MobileCanvasActions({
  canvas,
  canvases,
  open,
  onOpenChange,
  onEdit,
  onPromote,
  onReleases,
  onSelectCanvas,
  editing,
}: {
  canvas: Canvas | null;
  canvases: Canvas[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onPromote: () => void;
  onReleases: () => void;
  onSelectCanvas: (canvas: Canvas) => void;
  editing: boolean;
}) {
  const { t } = useTranslation();
  const lifecycleLocked = canvas?.status === "archived" || canvas?.status === "disabled";
  return (
    <MobilePickerSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("canvases:canvasActions")}
      description={canvas?.title}
      contentTestId="canvas-mobile-actions-sheet"
    >
      <div className="flex flex-col gap-1 pb-2">
        {canvases.length > 0 && (
          <div className="mb-2 border-b pb-2" data-testid="canvas-mobile-picker">
            <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">
              {t("canvases:canvases")}
            </p>
            {canvases.map((candidate) => (
              <Button
                key={candidate.id}
                variant="ghost"
                className="min-h-11 w-full justify-start cursor-pointer"
                disabled={candidate.id === canvas?.id}
                onClick={() => onSelectCanvas(candidate)}
                data-testid={`canvas-mobile-picker-item-${candidate.id}`}
              >
                <IconLayoutGrid className="mr-2 h-4 w-4" />
                <span className="truncate">{candidate.title}</span>
              </Button>
            ))}
          </div>
        )}
        {canvas?.scope_kind === "workspace" && (
          <Button
            variant="ghost"
            className="min-h-11 justify-start cursor-pointer"
            disabled={editing || lifecycleLocked}
            onClick={onEdit}
          >
            <IconEdit className="mr-2 h-4 w-4" />
            {t("canvases:editCanvas")}
          </Button>
        )}
        <Button
          variant="ghost"
          className="min-h-11 justify-start cursor-pointer"
          onClick={onReleases}
        >
          <IconListDetails className="mr-2 h-4 w-4" />
          {t("canvases:releasesAndPermissions")}
        </Button>
        {canvas?.scope_kind === "task" &&
          !lifecycleLocked &&
          canvas.active_release_status === "valid" && (
            <Button
              variant="ghost"
              className="min-h-11 justify-start cursor-pointer"
              onClick={onPromote}
            >
              <IconSparkles className="mr-2 h-4 w-4" />
              {t("canvases:promoteCanvas")}
            </Button>
          )}
        {canvas && (
          <Button variant="ghost" className="min-h-11 justify-start cursor-pointer" asChild>
            <a href={canvasHref(canvas.id)} target="_blank" rel="noreferrer">
              <IconExternalLink className="mr-2 h-4 w-4" />
              {t("canvases:openInNewTab")}
            </a>
          </Button>
        )}
      </div>
    </MobilePickerSheet>
  );
}
