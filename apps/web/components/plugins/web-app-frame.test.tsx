import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebAppFrame } from "./web-app-frame";

const responsive = { isMobile: false };

vi.mock("@/hooks/use-responsive-breakpoint", () => ({
  useResponsiveBreakpoint: () => responsive,
}));

describe("WebAppFrame", () => {
  afterEach(() => {
    cleanup();
    responsive.isMobile = false;
  });

  it("uses an opaque sandbox and does not send host capabilities to the iframe", () => {
    render(
      <WebAppFrame runtimeUrl="/api/v1/plugins/web-apps/runtime/capability/" title="Task board" />,
    );

    const frame = screen.getByTitle("Task board");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("allow-same-origin")).toBeNull();
    expect(frame.getAttribute("allow")).toBeNull();
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("src")).toContain("/api/v1/plugins/web-apps/runtime/");
  });

  it("keeps loading state outside the document rectangle and reports load callbacks", () => {
    const onLoad = vi.fn();
    render(<WebAppFrame runtimeUrl="/runtime/one/" title="Canvas" onLoad={onLoad} />);

    expect(screen.getByRole("status")).not.toBeNull();
    const frame = screen.getByTitle("Canvas");
    fireEvent.load(frame);
    expect(onLoad).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("uses the phone safe-area inset and renders no iframe without a capability", () => {
    responsive.isMobile = true;
    const { rerender } = render(<WebAppFrame title="Canvas" />);
    expect(screen.queryByTitle("Canvas")).toBeNull();
    expect(screen.getByTestId("web-app-frame").dataset.mobile).toBe("true");
    expect(screen.getByRole("alert")).not.toBeNull();

    rerender(<WebAppFrame runtimeUrl="/runtime/two/" title="Canvas" />);
    expect(screen.getByTitle("Canvas")).not.toBeNull();
    responsive.isMobile = false;
  });
});
