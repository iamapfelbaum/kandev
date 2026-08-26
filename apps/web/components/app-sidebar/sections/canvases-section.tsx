"use client";

import { useTranslation } from "react-i18next";
import { IconLayoutDashboard, IconSettings } from "@tabler/icons-react";
import Link from "@/components/routing/app-link";
import { Tooltip, TooltipContent, TooltipTrigger } from "@kandev/ui/tooltip";
import { useAppStore } from "@/components/state-provider";
import { useWorkspaceCanvases } from "@/hooks/domains/canvas/use-workspace-canvases";
import { usePathname } from "@/lib/routing/client-router";
import { workspaceSettingsHref } from "@/lib/settings/workspace-settings-tabs";
import { cn } from "@/lib/utils";
import {
  APP_SIDEBAR_SECTION_IDS,
  SIDEBAR_ITEM_ACTIVE,
  SIDEBAR_ITEM_INACTIVE,
} from "../app-sidebar-constants";
import { AppSidebarSection } from "../app-sidebar-section";

function SettingsShortcut({ workspaceId }: { workspaceId: string | null }) {
  const { t } = useTranslation();
  if (!workspaceId) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={workspaceSettingsHref(workspaceId, "canvases")}
          aria-label={t("canvases:openCanvasSettings")}
          data-testid="canvases-settings"
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <IconSettings className="h-3.5 w-3.5" />
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">{t("canvases:openCanvasSettings")}</TooltipContent>
    </Tooltip>
  );
}

function CanvasRow({ canvas, active }: { canvas: { id: string; title: string }; active: boolean }) {
  return (
    <Link
      href={`/canvases/${encodeURIComponent(canvas.id)}`}
      data-testid={`sidebar-canvas-${canvas.id}`}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium",
        active ? SIDEBAR_ITEM_ACTIVE : SIDEBAR_ITEM_INACTIVE,
      )}
    >
      <span className="min-w-0 flex-1 truncate">{canvas.title}</span>
    </Link>
  );
}

function EmptyRow({ workspaceId }: { workspaceId: string | null }) {
  const { t } = useTranslation();
  if (!workspaceId) return null;
  return (
    <Link
      href={workspaceSettingsHref(workspaceId, "canvases")}
      data-testid="sidebar-canvases-empty"
      className="rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
    >
      {t("canvases:manageCanvases")}
    </Link>
  );
}

export function CanvasesSection({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const workspaceId = useAppStore((state) => state.workspaces.activeId);
  const { canvases } = useWorkspaceCanvases(
    collapsed ? undefined : (workspaceId ?? undefined),
    false,
  );

  return (
    <AppSidebarSection
      id={APP_SIDEBAR_SECTION_IDS.canvases}
      label={t("canvases:canvases")}
      collapsed={collapsed}
      icon={IconLayoutDashboard}
      headerAction={<SettingsShortcut workspaceId={workspaceId} />}
      headerActionVisibility="always"
      defaultExpanded={false}
      collapsedSummary={canvases.length > 0 ? canvases.length : undefined}
    >
      {canvases.length === 0 ? (
        <EmptyRow workspaceId={workspaceId} />
      ) : (
        canvases.map((canvas) => (
          <CanvasRow
            key={canvas.id}
            canvas={canvas}
            active={pathname === `/canvases/${encodeURIComponent(canvas.id)}`}
          />
        ))
      )}
    </AppSidebarSection>
  );
}
