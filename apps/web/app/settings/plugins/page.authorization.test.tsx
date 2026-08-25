import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSaveProvider } from "@/components/settings/settings-save-provider";
import type { PluginRecord } from "@/lib/types/plugins";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const { getPluginConfigSpy } = vi.hoisted(() => ({ getPluginConfigSpy: vi.fn() }));

vi.mock("@/lib/api/domains/plugins-api", () => ({
  listPlugins: () => Promise.resolve([]),
  enablePlugin: () => Promise.resolve({ enabled: true }),
  disablePlugin: () => Promise.resolve({ disabled: true }),
  uninstallPlugin: () => Promise.resolve({ deleted: true }),
  installPluginFromUrl: () => Promise.resolve({}),
  installPluginUpload: () => Promise.resolve({}),
  syncPlugins: () => Promise.resolve({ added: [], installed: [], missing: [], errors: [] }),
  getPluginSettings: () => Promise.resolve({ auto_update_default: false }),
  updatePluginSettings: (enabled: boolean) => Promise.resolve({ auto_update_default: enabled }),
  setPluginAutoUpdate: () => Promise.resolve(undefined),
  // The "Setup required" badge probes each plugin's stored config; that read is
  // admin-only too, so a member must never reach it.
  getPluginConfig: (...args: unknown[]) => {
    getPluginConfigSpy(...args);
    return Promise.resolve({});
  },
}));

vi.mock("@/lib/api/domains/marketplace-api", () => ({
  getMarketplaceCatalog: () => Promise.resolve({ plugins: [], sources: [] }),
  refreshMarketplace: () => Promise.resolve({ refreshed: true }),
}));

vi.mock("@/lib/plugins/host", () => ({
  loadPlugins: () => Promise.resolve(),
  unloadPlugin: vi.fn(),
}));
vi.mock("@/lib/plugins/host-api", () => ({ buildHostApi: (pluginId: string) => ({ pluginId }) }));
vi.mock("@/components/theme/app-theme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

let storeState: Record<string, unknown> = {};
vi.mock("@/components/state-provider", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(storeState),
  useAppStoreApi: () => ({
    getState: () => storeState,
    setState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  }),
}));

import PluginsSettingsPage from "./page";

const PLUGIN_ID = "acme-tools";
const PLUGIN_DISPLAY_NAME = "Acme Tools";
const SYNC_BUTTON_TESTID = "plugins-sync-button";
const CHECK_UPDATES_BUTTON_TESTID = "plugins-check-updates-button";
const INSTALL_TRIGGER_TESTID = "install-plugin-trigger";
const BROWSE_TAB_TESTID = "plugins-tab-browse";
const ADMIN_NOTICE_TESTID = "plugins-admin-only-notice";

function activePlugin(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: PLUGIN_ID,
    api_version: 1,
    version: "1.0.0",
    display_name: PLUGIN_DISPLAY_NAME,
    description: "",
    author: "acme",
    categories: [],
    capabilities: {},
    status: "active",
    install_path: "/p",
    signed: true,
    installed_at: "2026-01-01T00:00:00Z",
    restart_count: 0,
    ...overrides,
  };
}

function setStoreState(role?: "admin" | "member") {
  storeState = {
    auth: { user: role ? { role } : null },
    plugins: {
      items: [
        activePlugin({
          config_schema: {
            type: "object",
            required: ["token"],
            properties: { token: { type: "string" } },
          },
        }),
      ],
      loading: false,
      loaded: true,
      error: null,
    },
    setPlugins: vi.fn(),
    setPluginsLoading: vi.fn(),
    setPluginsError: vi.fn(),
    upsertPlugin: vi.fn(),
    removePlugin: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  storeState = {};
});

function renderPage() {
  return render(
    <SettingsSaveProvider>
      <PluginsSettingsPage />
    </SettingsSaveProvider>,
  );
}

// A plugin is an install-wide artifact, so every lifecycle mutation is
// admin-only on the backend (internal/plugins/handlers.go). This surface must
// not offer a member controls whose requests can only come back 403.
describe("PluginsSettingsPage authorization", () => {
  it("gives a member the read-only view and none of the install-wide controls", () => {
    setStoreState("member");

    renderPage();

    expect(screen.queryByTestId(SYNC_BUTTON_TESTID)).toBeNull();
    expect(screen.queryByTestId(CHECK_UPDATES_BUTTON_TESTID)).toBeNull();
    expect(screen.queryByTestId(INSTALL_TRIGGER_TESTID)).toBeNull();
    expect(screen.queryByTestId(BROWSE_TAB_TESTID)).toBeNull();
    expect(screen.getByTestId(ADMIN_NOTICE_TESTID)).toBeTruthy();
    // The list itself stays: the plugin read routes are open to members.
    expect(screen.getByTestId(`plugin-row-${PLUGIN_ID}`)).toBeTruthy();
    expect(screen.getByText(PLUGIN_DISPLAY_NAME)).toBeTruthy();
    expect(getPluginConfigSpy).not.toHaveBeenCalled();
  });

  it("hides a member's per-plugin lifecycle actions and locks auto-update", () => {
    setStoreState("member");

    renderPage();

    expect(screen.queryByRole("button", { name: /disable/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /uninstall/i })).toBeNull();
    expect(
      screen.getByTestId(`plugin-auto-update-${PLUGIN_ID}`).getAttribute("data-disabled"),
    ).not.toBeNull();
  });

  // `undefined` is auth-disabled single-user mode, whose backend identity is a
  // synthetic admin — it must keep every control it has always had.
  it.each([["admin" as const], [undefined]])("keeps every control for %s", async (role) => {
    setStoreState(role);

    renderPage();

    expect(screen.getByTestId(SYNC_BUTTON_TESTID)).toBeTruthy();
    expect(screen.getByTestId(CHECK_UPDATES_BUTTON_TESTID)).toBeTruthy();
    expect(screen.getByTestId(INSTALL_TRIGGER_TESTID)).toBeTruthy();
    expect(screen.getByTestId(BROWSE_TAB_TESTID)).toBeTruthy();
    expect(screen.queryByTestId(ADMIN_NOTICE_TESTID)).toBeNull();
    expect(screen.getByRole("button", { name: /uninstall/i })).toBeTruthy();
    await vi.waitFor(() =>
      expect(getPluginConfigSpy).toHaveBeenCalledWith(PLUGIN_ID, { cache: "no-store" }),
    );
  });
});
