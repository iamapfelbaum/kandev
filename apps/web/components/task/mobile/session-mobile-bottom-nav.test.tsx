import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginRegistry } from "@/lib/plugins/registry";
import { pluginPanelId } from "@/lib/state/layout-manager/plugin-panels";
import { SessionMobileBottomNav } from "./session-mobile-bottom-nav";

const PLUGIN_A = "plugin-a";
const PLUGIN_B = "plugin-b";

afterEach(() => {
  cleanup();
  pluginRegistry.unregisterPlugin(PLUGIN_A);
  pluginRegistry.unregisterPlugin(PLUGIN_B);
});

describe("SessionMobileBottomNav", () => {
  it("offers a touch-sized review route for linked merge requests", () => {
    const onPanelChange = vi.fn();
    render(
      <SessionMobileBottomNav
        activePanel="chat"
        onPanelChange={onPanelChange}
        hasReview
        showStatus
        onOpenStatus={vi.fn()}
      />,
    );

    const review = screen.getByRole("button", { name: "Review" });
    expect(review.className).toContain("min-h-11");
    fireEvent.click(review);
    expect(onPanelChange).toHaveBeenCalledWith("review");
  });

  it("does not consume navigation space without a linked merge request", () => {
    render(
      <SessionMobileBottomNav
        activePanel="chat"
        onPanelChange={vi.fn()}
        showStatus
        onOpenStatus={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  });

  it("opens Status as an action without changing the selected mobile panel", () => {
    const onPanelChange = vi.fn();
    const onOpenStatus = vi.fn();

    render(
      <SessionMobileBottomNav
        activePanel="chat"
        onPanelChange={onPanelChange}
        showStatus
        onOpenStatus={onOpenStatus}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Status" }));

    expect(onOpenStatus).toHaveBeenCalledOnce();
    expect(onPanelChange).not.toHaveBeenCalled();
  });

  it("describes an active connectivity warning on the Status action", () => {
    render(
      <SessionMobileBottomNav
        activePanel="chat"
        onPanelChange={vi.fn()}
        showStatus
        onOpenStatus={vi.fn()}
        connectionIssueSeverity="lost"
      />,
    );

    const status = screen.getByRole("button", {
      name: "Connection lost for at least 10 seconds. Live updates may be stale.",
    });
    expect(status.getAttribute("data-connection-severity")).toBe("lost");
  });

  it("does not reserve navigation space when Status is disabled", () => {
    render(
      <SessionMobileBottomNav
        activePanel="chat"
        onPanelChange={vi.fn()}
        showStatus={false}
        onOpenStatus={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Status" })).toBeNull();
  });

  it("keeps two same-titled plugin panels independently navigable (distinct keys, not label)", () => {
    function Notes() {
      return null;
    }
    pluginRegistry
      .forPlugin(PLUGIN_A)
      .registerTaskPanel({ id: "notes", title: "Notes", Component: Notes, mobileEnabled: true });
    pluginRegistry
      .forPlugin(PLUGIN_B)
      .registerTaskPanel({ id: "notes", title: "Notes", Component: Notes, mobileEnabled: true });
    const onPanelChange = vi.fn();

    render(
      <SessionMobileBottomNav
        activePanel="chat"
        onPanelChange={onPanelChange}
        showStatus={false}
        onOpenStatus={vi.fn()}
      />,
    );

    const notesButtons = screen.getAllByRole("button", { name: "Notes" });
    expect(notesButtons).toHaveLength(2);

    fireEvent.click(notesButtons[0]);
    expect(onPanelChange).toHaveBeenLastCalledWith(pluginPanelId(PLUGIN_A, "notes"));

    fireEvent.click(notesButtons[1]);
    expect(onPanelChange).toHaveBeenLastCalledWith(pluginPanelId(PLUGIN_B, "notes"));
  });
});
