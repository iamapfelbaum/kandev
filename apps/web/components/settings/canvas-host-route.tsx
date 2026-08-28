"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconDots,
  IconEdit,
  IconExternalLink,
  IconListDetails,
  IconSparkles,
} from "@tabler/icons-react";
import { Button } from "@kandev/ui/button";
import { PageShell } from "@/components/page-shell";
import { CanvasPage } from "@/components/plugins/canvas-page";
import { MobilePickerSheet } from "@/components/task/mobile/mobile-picker-sheet";
import { useResponsiveBreakpoint } from "@/hooks/use-responsive-breakpoint";
import { useRouter } from "@/lib/routing/client-router";
import {
  canvasHref,
  getCanvas,
  getCanvasRuntime,
  startCanvasEdit,
  type Canvas,
  type CanvasRuntimeResponse,
} from "@/lib/api/domains/canvas-api";
import { canvasErrorMessage } from "@/lib/api/domains/canvas-error-copy";
import { useCanvasLifecycleRevision } from "@/lib/canvas-lifecycle";
import { CanvasPromotionDialog, CanvasReleaseDialog } from "./canvas-lifecycle-dialogs";

type CanvasHostState =
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

function stateForCanvas(canvas: Canvas): CanvasHostState {
  if (canvas.status === "archived") return "archived";
  if (
    !canvas.active_release_id &&
    canvas.pending_release?.validation_status === "pending_permission"
  ) {
    return "pending_permission";
  }
  if (!canvas.active_release_id) return "pending_first_release";
  if (canvas.active_release_status === "pending_permission") return "pending_permission";
  if (canvas.active_release_status === "invalid") return "invalid_release";
  if (canvas.active_release_status === "unavailable") return "unavailable";
  return "loading_runtime";
}

function useRuntimeRenewal() {
  const renewalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renewRuntimeRef = useRef<() => void>(() => undefined);

  const clearRuntimeRenewal = useCallback(() => {
    if (renewalTimerRef.current !== null) {
      clearTimeout(renewalTimerRef.current);
      renewalTimerRef.current = null;
    }
  }, []);

  const scheduleRuntimeRenewal = useCallback(
    (expiresInSeconds: number | undefined) => {
      clearRuntimeRenewal();
      if (!Number.isFinite(expiresInSeconds) || !expiresInSeconds || expiresInSeconds <= 0) {
        return;
      }
      const delay = Math.max(100, (expiresInSeconds - 30) * 1000);
      renewalTimerRef.current = setTimeout(() => {
        renewalTimerRef.current = null;
        renewRuntimeRef.current();
      }, delay);
    },
    [clearRuntimeRenewal],
  );

  return { clearRuntimeRenewal, scheduleRuntimeRenewal, renewRuntimeRef };
}

function useCanvasHost(canvasId: string) {
  const { t } = useTranslation();
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [runtimeUrl, setRuntimeUrl] = useState<string | null>(null);
  const [state, setState] = useState<CanvasHostState>("loading_metadata");
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const renewingRef = useRef(false);
  const { clearRuntimeRenewal, scheduleRuntimeRenewal, renewRuntimeRef } = useRuntimeRenewal();
  const lifecycleRevision = useCanvasLifecycleRevision();

  const applyRuntime = useCallback(
    (runtime: CanvasRuntimeResponse) => {
      if (runtime.runtime_url) {
        setRuntimeUrl(runtime.runtime_url);
        setState("ready");
        scheduleRuntimeRenewal(runtime.expires_in_seconds);
      } else {
        clearRuntimeRenewal();
        setState("unavailable");
      }
    },
    [clearRuntimeRenewal, scheduleRuntimeRenewal],
  );

  const renewRuntime = useCallback(() => {
    if (renewingRef.current) return;
    const requestId = ++requestRef.current;
    renewingRef.current = true;
    clearRuntimeRenewal();
    setState("loading_runtime");
    setError(null);
    getCanvasRuntime(canvasId)
      .then((runtime) => {
        if (requestRef.current !== requestId) return;
        applyRuntime(runtime);
      })
      .catch((reason: unknown) => {
        if (requestRef.current !== requestId) return;
        clearRuntimeRenewal();
        setState(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "unavailable");
        setError(canvasErrorMessage(reason, t, "canvases:loadFailed"));
      })
      .finally(() => {
        renewingRef.current = false;
      });
  }, [applyRuntime, canvasId, clearRuntimeRenewal, t]);

  const load = useCallback(() => {
    const requestId = ++requestRef.current;
    clearRuntimeRenewal();
    setCanvas(null);
    setRuntimeUrl(null);
    setState("loading_metadata");
    setError(null);

    getCanvas(canvasId)
      .then((nextCanvas) => {
        if (requestRef.current !== requestId) return;
        setCanvas(nextCanvas);
        const nextState = stateForCanvas(nextCanvas);
        setState(nextState);
        if (nextState !== "loading_runtime") return;
        return getCanvasRuntime(canvasId).then((runtime) => {
          if (requestRef.current !== requestId) return;
          applyRuntime(runtime);
        });
      })
      .catch((reason: unknown) => {
        if (requestRef.current !== requestId) return;
        clearRuntimeRenewal();
        setState(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "unavailable");
        setError(canvasErrorMessage(reason, t, "canvases:loadFailed"));
      });
  }, [applyRuntime, canvasId, clearRuntimeRenewal, t]);

  useEffect(() => {
    renewRuntimeRef.current = renewRuntime;
    return () => {
      renewRuntimeRef.current = () => undefined;
    };
  }, [renewRuntime]);

  useEffect(() => {
    load();
    return () => {
      requestRef.current += 1;
      clearRuntimeRenewal();
    };
  }, [clearRuntimeRenewal, lifecycleRevision, load]);

  return {
    canvas,
    runtimeUrl,
    state,
    error,
    lifecycleRevision,
    load,
    renewRuntime,
    setHostError: setError,
  };
}

export function CanvasHostRoute({ canvasId }: { canvasId: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { isMobile } = useResponsiveBreakpoint();
  const { canvas, runtimeUrl, state, error, lifecycleRevision, load, renewRuntime, setHostError } =
    useCanvasHost(canvasId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [promotionOpen, setPromotionOpen] = useState(false);
  const [releasesOpen, setReleasesOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  const edit = async () => {
    if (!canvas) return;
    setEditing(true);
    try {
      const response = await startCanvasEdit(canvas.id);
      if (response.task_id) {
        const query = response.session_id
          ? `?sessionId=${encodeURIComponent(response.session_id)}`
          : "";
        router.push(`/t/${encodeURIComponent(response.task_id)}${query}`);
      }
    } catch (reason: unknown) {
      setHostError(canvasErrorMessage(reason, t, "canvases:actionFailed"));
    } finally {
      setEditing(false);
      setMenuOpen(false);
    }
  };

  const title = canvas?.title || t("canvases:canvas");
  const desktopActions = canvas ? (
    <CanvasDesktopActions
      canvas={canvas}
      editing={editing}
      onEdit={() => void edit()}
      onPromote={() => setPromotionOpen(true)}
      onReleases={() => setReleasesOpen(true)}
    />
  ) : null;

  return (
    <PageShell
      title={title}
      backHref="/"
      backLabel={t("sidebar:home")}
      scroll="none"
      actions={!isMobile ? desktopActions : undefined}
      contentTestId="canvas-route-content"
      showNavTrigger
    >
      <div
        className="flex h-dvh min-h-0 min-w-0 max-h-[calc(100dvh-2.75rem)] flex-1 flex-col overflow-hidden md:h-auto md:max-h-none"
        data-testid="canvas-host-route"
      >
        <CanvasHostHeader
          title={title}
          state={state}
          isMobile={isMobile}
          menuOpen={menuOpen}
          onOpenActions={() => setMenuOpen(true)}
        />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {state === "ready" && runtimeUrl ? (
            <CanvasPage
              key={`${canvasId}:${lifecycleRevision}:${runtimeUrl}`}
              runtimeUrl={runtimeUrl}
              title={title}
              onError={() => void renewRuntime()}
            />
          ) : (
            <CanvasHostStatePanel state={state} error={error} onRetry={load} />
          )}
        </div>
      </div>
      <MobileCanvasActions
        canvas={canvas}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onEdit={() => void edit()}
        onPromote={() => setPromotionOpen(true)}
        onReleases={() => setReleasesOpen(true)}
        editing={editing}
      />
      <CanvasPromotionDialog
        canvas={canvas?.scope_kind === "task" ? canvas : null}
        open={promotionOpen}
        onOpenChange={setPromotionOpen}
        onCompleted={() => router.push(canvas ? canvasHref(canvas.id) : "/")}
      />
      <CanvasReleaseDialog
        canvas={canvas}
        open={releasesOpen}
        onOpenChange={setReleasesOpen}
        onChanged={load}
      />
    </PageShell>
  );
}

function CanvasDesktopActions({
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
  return (
    <div className="flex items-center gap-2">
      {canvas.scope_kind === "workspace" && (
        <Button
          variant="outline"
          size="sm"
          className="cursor-pointer"
          disabled={editing}
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
      {canvas.scope_kind === "task" && canvas.active_release_status === "valid" && (
        <Button size="sm" className="cursor-pointer" onClick={onPromote}>
          <IconSparkles className="mr-1.5 h-3.5 w-3.5" />
          {t("canvases:promoteCanvas")}
        </Button>
      )}
    </div>
  );
}

function CanvasHostHeader({
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

function CanvasHostStatePanel({
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

function MobileCanvasActions({
  canvas,
  open,
  onOpenChange,
  onEdit,
  onPromote,
  onReleases,
  editing,
}: {
  canvas: Canvas | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onPromote: () => void;
  onReleases: () => void;
  editing: boolean;
}) {
  const { t } = useTranslation();
  return (
    <MobilePickerSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t("canvases:canvasActions")}
      description={canvas?.title}
      contentTestId="canvas-mobile-actions-sheet"
    >
      <div className="flex flex-col gap-1 pb-2">
        {canvas?.scope_kind === "workspace" && (
          <Button
            variant="ghost"
            className="min-h-11 justify-start cursor-pointer"
            disabled={editing}
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
        {canvas?.scope_kind === "task" && canvas.active_release_status === "valid" && (
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
