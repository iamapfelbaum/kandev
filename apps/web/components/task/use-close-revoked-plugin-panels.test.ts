import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { pluginRegistry } from "@/lib/plugins/registry";
import { useCloseRevokedPluginPanels } from "./use-close-revoked-plugin-panels";

const PLUGIN_ID = "plugin-a";
const PLUGIN_PANEL_ID = "plugin:plugin-a:notes";

type FakePanel = { id: string };

function makeFakeApi(panelIds: string[]) {
  const panels: FakePanel[] = panelIds.map((id) => ({ id }));
  const removed: string[] = [];
  const api = {
    get panels() {
      return panels;
    },
    removePanel(panel: FakePanel) {
      const i = panels.findIndex((p) => p.id === panel.id);
      if (i >= 0) panels.splice(i, 1);
      removed.push(panel.id);
    },
  };
  return { api, removed };
}

function registerNotesPanel() {
  function Notes() {
    return null;
  }
  pluginRegistry
    .forPlugin(PLUGIN_ID)
    .registerTaskPanel({ id: "notes", title: "Notes", Component: Notes });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  pluginRegistry.unregisterPlugin(PLUGIN_ID);
  vi.useRealTimers();
});

describe("useCloseRevokedPluginPanels", () => {
  it("does nothing when api is null", () => {
    expect(() => renderHook(() => useCloseRevokedPluginPanels(null))).not.toThrow();
  });

  it("leaves non-plugin panels and registered plugin panels alone", () => {
    registerNotesPanel();
    const { api } = makeFakeApi(["chat", PLUGIN_PANEL_ID]);

    renderHook(() => useCloseRevokedPluginPanels(api as never));
    vi.runAllTimers();

    expect(api.panels.map((p) => p.id)).toEqual(["chat", PLUGIN_PANEL_ID]);
  });

  it("closes a plugin panel whose plugin is no longer registered (AC4)", () => {
    const { api, removed } = makeFakeApi(["chat", "plugin:plugin-gone:notes"]);

    renderHook(() => useCloseRevokedPluginPanels(api as never));
    vi.runAllTimers();

    expect(api.panels.map((p) => p.id)).toEqual(["chat"]);
    expect(removed).toEqual(["plugin:plugin-gone:notes"]);
  });

  it("closes a plugin panel after its plugin is unregistered mid-session (AC4)", () => {
    registerNotesPanel();
    const { api } = makeFakeApi([PLUGIN_PANEL_ID]);

    const { rerender } = renderHook(() => useCloseRevokedPluginPanels(api as never));
    expect(api.panels.map((p) => p.id)).toEqual([PLUGIN_PANEL_ID]);

    pluginRegistry.unregisterPlugin(PLUGIN_ID);
    rerender();
    vi.runAllTimers();

    expect(api.panels.map((p) => p.id)).toEqual([]);
  });

  it("does not close a panel whose plugin re-registers within the grace window (live reload)", () => {
    registerNotesPanel();
    const { api } = makeFakeApi([PLUGIN_PANEL_ID]);

    const { rerender } = renderHook(() => useCloseRevokedPluginPanels(api as never));

    // host.ts's loadPlugin unregisters, then (after an await) re-registers —
    // simulate that in-flight reload landing before the grace window elapses.
    pluginRegistry.unregisterPlugin(PLUGIN_ID);
    rerender();
    registerNotesPanel();
    rerender();
    vi.runAllTimers();

    expect(api.panels.map((p) => p.id)).toEqual([PLUGIN_PANEL_ID]);
  });
});
