import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import type { Canvas } from "@/lib/api/domains/canvas-api";

const {
  mockRequestCanvasPromotion,
  mockConfirmCanvasPromotion,
  mockListCanvasReleases,
  mockApproveCanvasRelease,
  mockRejectCanvasRelease,
  mockRollbackCanvas,
} = vi.hoisted(() => ({
  mockRequestCanvasPromotion: vi.fn(),
  mockConfirmCanvasPromotion: vi.fn(),
  mockListCanvasReleases: vi.fn(),
  mockApproveCanvasRelease: vi.fn(),
  mockRejectCanvasRelease: vi.fn(),
  mockRollbackCanvas: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "canvases:runtimeTokenExpired": "The runtime token expired. Try again.",
        "canvases:actionFailed": "The canvas action failed.",
        "canvases:permissionReads": "API reads",
        "canvases:permissionWrites": "API writes",
        "canvases:permissionEvents": "Events",
        "canvases:permissionExternalOrigins": "External origins",
        "canvases:sharedState": "Shared state",
      })[key] ?? key,
  }),
}));

vi.mock("@kandev/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children, ...props }: { children: ReactNode }) => (
    <section {...props}>{children}</section>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/lib/api/domains/canvas-api", () => ({
  approveCanvasRelease: mockApproveCanvasRelease,
  confirmCanvasPromotion: mockConfirmCanvasPromotion,
  listCanvasReleases: mockListCanvasReleases,
  rejectCanvasRelease: mockRejectCanvasRelease,
  requestCanvasPromotion: mockRequestCanvasPromotion,
  rollbackCanvas: mockRollbackCanvas,
}));

import { CanvasPromotionDialog, CanvasReleaseDialog } from "./canvas-lifecycle-dialogs";

const canvas: Canvas = {
  id: "canvas-1",
  plugin_instance_id: "instance-1",
  plugin_id: "plugin-1",
  workspace_id: "workspace-1",
  task_id: "task-1",
  scope_kind: "task",
  title: "Task canvas",
  status: "active",
  active_release_id: "release-1",
  active_release_status: "valid",
};

beforeEach(() => {
  mockRequestCanvasPromotion.mockReset().mockResolvedValue({
    canvas_id: "canvas-1",
    title: "Task canvas",
    origin_task_id: "origin-task-1",
    source_actor_kind: "task_agent",
    source_user_id: "user-1",
    source_task_id: "source-task-1",
    source_session_id: "source-session-1",
    current_scope: "task",
    target_scope: "workspace",
    placement: "workspace_sidebar",
    permissions: {
      reads: ["tasks.read"],
      writes: ["tasks.write"],
      events: ["task.updated"],
      shared_state: true,
      external_origins: ["https://example.test"],
    },
  });
  mockConfirmCanvasPromotion.mockReset();
  mockListCanvasReleases.mockReset().mockResolvedValue({ releases: [] });
  mockApproveCanvasRelease.mockReset();
  mockRejectCanvasRelease.mockReset();
  mockRollbackCanvas.mockReset();
});

afterEach(() => cleanup());

describe("CanvasPromotionDialog", () => {
  it("shows promotion source scope, task/session, placement, and every permission group", async () => {
    render(<CanvasPromotionDialog canvas={canvas} open onOpenChange={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("canvas-promotion-source-scope").textContent).toContain("task"),
    );

    expect(screen.getByTestId("canvas-promotion-source-task").textContent).toContain(
      "source-task-1",
    );
    expect(screen.getByTestId("canvas-promotion-source-session").textContent).toContain(
      "source-session-1",
    );
    expect(screen.getByTestId("canvas-promotion-placement").textContent).toContain(
      "workspace_sidebar",
    );
    expect(screen.getByText("API reads")).toBeTruthy();
    expect(screen.getByText("tasks.read")).toBeTruthy();
    expect(screen.getByText("API writes")).toBeTruthy();
    expect(screen.getByText("tasks.write")).toBeTruthy();
    expect(screen.getByText("Events")).toBeTruthy();
    expect(screen.getByText("task.updated")).toBeTruthy();
    expect(screen.getByText("Shared state")).toBeTruthy();
    expect(screen.getByText("External origins")).toBeTruthy();
    expect(screen.getByText("https://example.test")).toBeTruthy();
  });

  it("maps stable API error codes to localized copy", async () => {
    mockRequestCanvasPromotion.mockRejectedValue(
      new ApiError("raw server failure", 401, { error_code: "runtime_token_expired" }),
    );

    render(<CanvasPromotionDialog canvas={canvas} open onOpenChange={vi.fn()} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The runtime token expired. Try again.");
    expect(alert.textContent).not.toContain("raw server failure");
  });

  it("localizes stable release validation codes", async () => {
    mockListCanvasReleases.mockResolvedValue({
      releases: [
        {
          id: "release-1",
          validation_status: "unavailable",
          validation_error: "runtime_token_expired",
        },
      ],
    });

    render(<CanvasReleaseDialog canvas={canvas} open onOpenChange={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByText("The runtime token expired. Try again.")).toBeTruthy(),
    );
  });
});
