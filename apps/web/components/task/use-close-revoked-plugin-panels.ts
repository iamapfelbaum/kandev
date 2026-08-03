import { useEffect } from "react";
import type { DockviewApi } from "dockview-react";
import { pluginRegistry, usePluginRegistry } from "@/lib/plugins/registry";
import { parsePluginPanelId } from "@/lib/state/layout-manager/plugin-panels";

/**
 * A live reload (disable+re-enable, an update, or `loadPlugin`'s idempotent
 * re-init path in host.ts) unregisters a plugin before its bundle's
 * `initialize()` re-registers it — the registry is briefly, legitimately
 * empty mid-reload, not because the plugin is gone. Closing on that first
 * empty tick would drop a panel the plugin is about to re-register. Waiting
 * this long for the registration to reappear tells a genuine removal (AC4)
 * apart from a reload in flight without new cross-cutting "is reloading"
 * state on the registry.
 */
const REVOCATION_GRACE_MS = 500;

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
    const missing = api.panels.filter((panel) => {
      const parsed = parsePluginPanelId(panel.id);
      return parsed && !pluginRegistry.getTaskPanel(parsed.pluginId, parsed.panelKey);
    });
    if (missing.length === 0) return;

    const timer = setTimeout(() => {
      for (const panel of missing) {
        const parsed = parsePluginPanelId(panel.id);
        if (parsed && !pluginRegistry.getTaskPanel(parsed.pluginId, parsed.panelKey)) {
          api.removePanel(panel);
        }
      }
    }, REVOCATION_GRACE_MS);
    return () => clearTimeout(timer);
    // registryVersion drives the re-run; api.panels is read fresh each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, registryVersion]);
}
