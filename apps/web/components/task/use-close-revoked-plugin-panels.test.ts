import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
  pluginRegistry.unregisterPlugin(PLUGIN_ID);
});

describe("useCloseRevokedPluginPanels", () => {
  it("does nothing when api is null", () => {
    expect(() => renderHook(() => useCloseRevokedPluginPanels(null))).not.toThrow();
  });

  it("leaves non-plugin panels and registered plugin panels alone", () => {
    function Notes() {
      return null;
    }
    pluginRegistry
      .forPlugin(PLUGIN_ID)
      .registerTaskPanel({ id: "notes", title: "Notes", Component: Notes });
    const { api } = makeFakeApi(["chat", PLUGIN_PANEL_ID]);

    renderHook(() => useCloseRevokedPluginPanels(api as never));

    expect(api.panels.map((p) => p.id)).toEqual(["chat", PLUGIN_PANEL_ID]);
  });

  it("closes a plugin panel whose plugin is no longer registered (AC4)", () => {
    const { api, removed } = makeFakeApi(["chat", "plugin:plugin-gone:notes"]);

    renderHook(() => useCloseRevokedPluginPanels(api as never));

    expect(api.panels.map((p) => p.id)).toEqual(["chat"]);
    expect(removed).toEqual(["plugin:plugin-gone:notes"]);
  });

  it("closes a plugin panel after its plugin is unregistered mid-session (AC4)", () => {
    function Notes() {
      return null;
    }
    pluginRegistry
      .forPlugin(PLUGIN_ID)
      .registerTaskPanel({ id: "notes", title: "Notes", Component: Notes });
    const { api } = makeFakeApi([PLUGIN_PANEL_ID]);

    const { rerender } = renderHook(() => useCloseRevokedPluginPanels(api as never));
    expect(api.panels.map((p) => p.id)).toEqual([PLUGIN_PANEL_ID]);

    pluginRegistry.unregisterPlugin(PLUGIN_ID);
    rerender();

    expect(api.panels.map((p) => p.id)).toEqual([]);
  });
});
