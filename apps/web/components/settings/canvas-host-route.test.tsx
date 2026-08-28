import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Canvas } from "@/lib/api/domains/canvas-api";

const { mockGetCanvas, mockGetCanvasRuntime, mockPush } = vi.hoisted(() => ({
  mockGetCanvas: vi.fn(),
  mockGetCanvasRuntime: vi.fn(),
  mockPush: vi.fn(),
}));

const FRAME_TEST_ID = "canvas-frame";
const RUNTIME_URL_ATTRIBUTE = "data-runtime-url";

vi.mock("@/lib/api/domains/canvas-api", () => ({
  canvasHref: (canvasId: string) => `/canvases/${canvasId}`,
  getCanvas: mockGetCanvas,
  getCanvasRuntime: mockGetCanvasRuntime,
  startCanvasEdit: vi.fn(),
}));

vi.mock("@/components/page-shell", () => ({
  PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/plugins/canvas-page", () => ({
  CanvasPage: ({ runtimeUrl, onError }: { runtimeUrl?: string; onError?: () => void }) => (
    <button
      type="button"
      data-testid={FRAME_TEST_ID}
      data-runtime-url={runtimeUrl ?? ""}
      onClick={onError}
    >
      frame
    </button>
  ),
}));

vi.mock("@/components/settings/canvas-lifecycle-dialogs", () => ({
  CanvasPromotionDialog: () => null,
}));

vi.mock("@/hooks/use-responsive-breakpoint", () => ({
  useResponsiveBreakpoint: () => ({ isMobile: false }),
}));

vi.mock("@/lib/routing/client-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

import { CanvasHostRoute } from "./canvas-host-route";

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
  mockGetCanvas.mockReset().mockResolvedValue(canvas);
  mockGetCanvasRuntime
    .mockReset()
    .mockResolvedValueOnce({
      runtime_url: "/runtime/old",
      release_id: "release-1",
      expires_in_seconds: 900,
    })
    .mockResolvedValueOnce({
      runtime_url: "/runtime/renewed",
      release_id: "release-1",
      expires_in_seconds: 900,
    });
  mockPush.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("CanvasHostRoute runtime recovery", () => {
  it("renews the capability URL for the same active release after a frame failure", async () => {
    render(<CanvasHostRoute canvasId="canvas-1" />);

    await waitFor(() =>
      expect(screen.getByTestId(FRAME_TEST_ID).getAttribute(RUNTIME_URL_ATTRIBUTE)).toBe(
        "/runtime/old",
      ),
    );

    fireEvent.click(screen.getByTestId(FRAME_TEST_ID));

    await waitFor(() => {
      expect(mockGetCanvasRuntime).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId(FRAME_TEST_ID).getAttribute(RUNTIME_URL_ATTRIBUTE)).toBe(
        "/runtime/renewed",
      );
    });
  });

  it("renews the capability URL before its expiry", async () => {
    mockGetCanvasRuntime
      .mockReset()
      .mockResolvedValueOnce({
        runtime_url: "/runtime/expiring",
        release_id: "release-1",
        expires_in_seconds: 30,
      })
      .mockResolvedValueOnce({
        runtime_url: "/runtime/refreshed",
        release_id: "release-1",
        expires_in_seconds: 900,
      });

    render(<CanvasHostRoute canvasId="canvas-1" />);
    await waitFor(() =>
      expect(screen.getByTestId(FRAME_TEST_ID).getAttribute(RUNTIME_URL_ATTRIBUTE)).toBe(
        "/runtime/expiring",
      ),
    );

    await waitFor(() => {
      expect(mockGetCanvasRuntime).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId(FRAME_TEST_ID).getAttribute(RUNTIME_URL_ATTRIBUTE)).toBe(
        "/runtime/refreshed",
      );
    });
  });
});
