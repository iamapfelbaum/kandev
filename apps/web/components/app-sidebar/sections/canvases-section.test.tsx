import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@kandev/ui/tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Canvas } from "@/lib/api/domains/canvas-api";

const mocks = vi.hoisted(() => ({
  listWorkspaceCanvases: vi.fn(),
  enabled: true,
  pathname: "/",
  expanded: true,
}));

const state = {
  features: { canvases: true },
  workspaces: { activeId: "workspace-1" },
  appSidebar: { sectionExpanded: { canvases: true } },
  toggleAppSidebarSection: vi.fn(),
  setAppSidebarCollapsed: vi.fn(),
};

vi.mock("@/components/state-provider", () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock("@/hooks/domains/features/use-feature", () => ({
  useFeature: () => mocks.enabled,
}));
vi.mock("@/lib/routing/client-router", () => ({
  usePathname: () => mocks.pathname,
}));
vi.mock("@/lib/api/domains/canvas-api", () => ({
  canvasHref: (id: string) => `/canvases/${encodeURIComponent(id)}`,
  workspaceCanvasSettingsHref: (id: string) =>
    `/settings/workspaces/${encodeURIComponent(id)}/canvases`,
  listWorkspaceCanvases: mocks.listWorkspaceCanvases,
}));

import { CanvasesSection, isActiveWorkspaceCanvas } from "./canvases-section";

const ACTIVE_CANVAS: Canvas = {
  id: "canvas-1",
  plugin_instance_id: "instance-1",
  plugin_id: "plugin-1",
  workspace_id: "workspace-1",
  scope_kind: "workspace",
  title: "Release readiness",
  status: "active",
  active_release_id: "release-1",
  active_release_status: "valid",
};

beforeEach(() => {
  mocks.enabled = true;
  mocks.pathname = "/";
  state.appSidebar.sectionExpanded.canvases = true;
  mocks.listWorkspaceCanvases.mockReset();
  mocks.listWorkspaceCanvases.mockResolvedValue({
    canvases: [
      ACTIVE_CANVAS,
      { ...ACTIVE_CANVAS, id: "task-canvas", scope_kind: "task", title: "Task only" },
      { ...ACTIVE_CANVAS, id: "archived-canvas", status: "archived", title: "Archived" },
      {
        ...ACTIVE_CANVAS,
        id: "pending-canvas",
        active_release_status: "pending_permission",
        title: "Pending permissions",
      },
      {
        ...ACTIVE_CANVAS,
        id: "invalid-canvas",
        active_release_status: "invalid",
        title: "Invalid release",
      },
      {
        ...ACTIVE_CANVAS,
        id: "unavailable-canvas",
        active_release_status: "unavailable",
        title: "Unavailable release",
      },
    ],
  });
});

afterEach(cleanup);

describe("CanvasesSection", () => {
  it("lists only active workspace canvases and links the settings shortcut", async () => {
    render(
      <TooltipProvider>
        <CanvasesSection collapsed={false} />
      </TooltipProvider>,
    );

    expect(await screen.findByTestId("sidebar-canvas-canvas-1")).toBeTruthy();
    expect(screen.getByTestId("sidebar-canvas-canvas-1").getAttribute("href")).toBe(
      "/canvases/canvas-1",
    );
    expect(screen.queryByText("Task only")).toBeNull();
    expect(screen.queryByText("Archived")).toBeNull();
    expect(screen.queryByText("Pending permissions")).toBeNull();
    expect(screen.queryByText("Invalid release")).toBeNull();
    expect(screen.queryByText("Unavailable release")).toBeNull();
    expect(screen.getByTestId("sidebar-canvases-settings").getAttribute("href")).toBe(
      "/settings/workspaces/workspace-1/canvases",
    );
  });

  it("starts folded while preserving the active workspace count", async () => {
    state.appSidebar.sectionExpanded.canvases = false;
    render(
      <TooltipProvider>
        <CanvasesSection collapsed={false} />
      </TooltipProvider>,
    );

    await waitFor(() => expect(screen.getByText("Canvases")).toBeTruthy());
    expect(screen.queryByTestId("sidebar-canvas-canvas-1")).toBeNull();
  });
});

describe("isActiveWorkspaceCanvas", () => {
  it("rejects task, archived, and disabled records", () => {
    expect(isActiveWorkspaceCanvas(ACTIVE_CANVAS)).toBe(true);
    expect(isActiveWorkspaceCanvas({ ...ACTIVE_CANVAS, scope_kind: "task" })).toBe(false);
    expect(isActiveWorkspaceCanvas({ ...ACTIVE_CANVAS, status: "archived" })).toBe(false);
    expect(isActiveWorkspaceCanvas({ ...ACTIVE_CANVAS, status: "disabled" })).toBe(false);
    expect(
      isActiveWorkspaceCanvas({ ...ACTIVE_CANVAS, active_release_status: "pending_permission" }),
    ).toBe(false);
    expect(isActiveWorkspaceCanvas({ ...ACTIVE_CANVAS, active_release_status: "invalid" })).toBe(
      false,
    );
    expect(
      isActiveWorkspaceCanvas({ ...ACTIVE_CANVAS, active_release_status: "unavailable" }),
    ).toBe(false);
  });
});
