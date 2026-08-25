import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSaveProvider } from "@/components/settings/settings-save-provider";
import type { PluginRecord } from "@/lib/types/plugins";

const { getPluginConfigSpy } = vi.hoisted(() => ({ getPluginConfigSpy: vi.fn() }));

vi.mock("@/lib/api/domains/plugins-api", () => ({
  listPlugins: () => Promise.resolve([]),
  getPluginConfig: (...args: unknown[]) => {
    getPluginConfigSpy(...args);
    return Promise.resolve({});
  },
  updatePluginConfig: () => Promise.resolve({ updated: true }),
  enablePlugin: () => Promise.resolve({ enabled: true }),
  disablePlugin: () => Promise.resolve({ disabled: true }),
  uninstallPlugin: () => Promise.resolve({ deleted: true }),
  installPluginFromUrl: () => Promise.resolve({}),
  installPluginUpload: () => Promise.resolve({}),
  syncPlugins: () => Promise.resolve({ added: [], installed: [], missing: [], errors: [] }),
  setPluginAutoUpdate: () => Promise.resolve(undefined),
}));

vi.mock("@/lib/plugins/host", () => ({
  loadPlugins: () => Promise.resolve(),
  unloadPlugin: vi.fn(),
}));
vi.mock("@/lib/plugins/host-api", () => ({ buildHostApi: (pluginId: string) => ({ pluginId }) }));
vi.mock("@/lib/routing/client-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/plugins/plugin-slot", () => ({ PluginSlot: () => null }));

let storeState: Record<string, unknown> = {};
vi.mock("@/components/state-provider", () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(storeState),
  useAppStoreApi: () => ({
    getState: () => storeState,
    setState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  }),
}));

import { PluginDetail } from "./plugin-detail";

const PLUGIN_ID = "acme";

function plugin(): PluginRecord {
  return {
    id: PLUGIN_ID,
    api_version: 1,
    version: "1.0.0",
    display_name: "Acme",
    description: "",
    author: "acme",
    categories: [],
    capabilities: {},
    status: "active",
    install_path: "/p",
    signed: true,
    installed_at: "2026-01-01T00:00:00Z",
    restart_count: 0,
    config_schema: { type: "object", properties: { token: { type: "string" } } },
  };
}

function setStoreState(role?: "admin" | "member") {
  storeState = {
    auth: { user: role ? { role } : null },
    plugins: { items: [plugin()], loading: false, loaded: true, error: null },
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

function renderDetail() {
  return render(
    <SettingsSaveProvider>
      <PluginDetail pluginId={PLUGIN_ID} />
    </SettingsSaveProvider>,
  );
}

describe("PluginDetail authorization", () => {
  it("hides the config form and lifecycle actions from a member, and never reads the config", () => {
    setStoreState("member");

    renderDetail();

    expect(screen.queryByTestId("plugin-settings-card")).toBeNull();
    expect(screen.queryByRole("button", { name: /uninstall/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /disable/i })).toBeNull();
    expect(screen.getByTestId("plugin-detail-admin-only")).toBeTruthy();
    expect(getPluginConfigSpy).not.toHaveBeenCalled();
  });

  it("keeps the config form and lifecycle actions for an admin", () => {
    setStoreState("admin");

    renderDetail();

    expect(screen.getByTestId("plugin-settings-card")).toBeTruthy();
    expect(screen.getByRole("button", { name: /uninstall/i })).toBeTruthy();
    expect(screen.queryByTestId("plugin-detail-admin-only")).toBeNull();
    expect(getPluginConfigSpy).toHaveBeenCalledWith(PLUGIN_ID, { cache: "no-store" });
  });

  it("keeps them in auth-disabled single-user mode", () => {
    setStoreState();

    renderDetail();

    expect(screen.getByTestId("plugin-settings-card")).toBeTruthy();
    expect(screen.getByRole("button", { name: /uninstall/i })).toBeTruthy();
  });
});
