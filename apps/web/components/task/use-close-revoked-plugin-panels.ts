import { useEffect } from "react";
import type { DockviewApi } from "dockview-react";
import { pluginRegistry, usePluginRegistry } from "@/lib/plugins/registry";
import { parsePluginPanelId } from "@/lib/state/layout-manager/plugin-panels";

/**
 * Closes any open plugin-panel dockview tab whose owning plugin/panel
 * registration has disappeared — a disable, an uninstall, or a plugin
 * reload that dropped the panel (AC4). Re-runs whenever the plugin registry
 * changes; a no-op before dockview is ready.
 */
export function useCloseRevokedPluginPanels(api: DockviewApi | null): void {
  usePluginRegistry();
  const registryVersion = pluginRegistry.getVersion();

  useEffect(() => {
    if (!api) return;
    for (const panel of api.panels) {
      const parsed = parsePluginPanelId(panel.id);
      if (!parsed) continue;
      if (!pluginRegistry.getTaskPanel(parsed.pluginId, parsed.panelKey)) {
        api.removePanel(panel);
      }
    }
    // registryVersion drives the re-run; api.panels is read fresh each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, registryVersion]);
}
