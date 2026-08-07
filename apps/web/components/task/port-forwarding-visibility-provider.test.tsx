import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PortForwardingVisibilityProvider,
  usePortForwardingVisibility,
} from "./port-forwarding-visibility-provider";

const { updateTaskPortForwardingMock, toastMock } = vi.hoisted(() => ({
  updateTaskPortForwardingMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock("@/lib/api/domains/kanban-api", () => ({
  updateTaskPortForwarding: updateTaskPortForwardingMock,
}));

vi.mock("@/components/toast-provider", () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function wrapper({ children }: PropsWithChildren) {
  return (
    <PortForwardingVisibilityProvider
      taskId="task-1"
      metadata={{ port_forwarding_enabled: true }}
      sessionId="session-1"
      isAgentctlReady
    >
      {children}
    </PortForwardingVisibilityProvider>
  );
}

describe("PortForwardingVisibilityProvider", () => {
  beforeEach(() => {
    updateTaskPortForwardingMock.mockReset();
    toastMock.mockReset();
  });

  it("rolls back a failed preference write and reports translated feedback", async () => {
    updateTaskPortForwardingMock.mockRejectedValueOnce(new Error("network"));
    const { result } = renderHook(() => usePortForwardingVisibility(), { wrapper });

    await act(async () => {
      await result.current.togglePortForwarding();
    });

    expect(updateTaskPortForwardingMock).toHaveBeenCalledWith("task-1", false);
    expect(result.current.enabled).toBe(true);
    expect(toastMock).toHaveBeenCalledWith({
      variant: "error",
      description: "task:portForwardingPreferenceUpdateFailed",
    });
  });

  it("opens the existing dialog after a successful enable", async () => {
    updateTaskPortForwardingMock.mockResolvedValueOnce({
      metadata: { port_forwarding_enabled: true },
    });
    const { result } = renderHook(() => usePortForwardingVisibility(), {
      wrapper: ({ children }) => (
        <PortForwardingVisibilityProvider
          taskId="task-1"
          metadata={{ port_forwarding_enabled: false }}
          sessionId="session-1"
          isAgentctlReady
        >
          {children}
        </PortForwardingVisibilityProvider>
      ),
    });

    await act(async () => {
      await result.current.togglePortForwarding({ openDialogOnEnable: true });
    });

    expect(updateTaskPortForwardingMock).toHaveBeenCalledWith("task-1", true);
    expect(result.current.enabled).toBe(true);
    expect(result.current.dialogOpen).toBe(true);
  });
});
