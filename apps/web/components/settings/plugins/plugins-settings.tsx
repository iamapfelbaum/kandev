"use client";

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { IconRefresh } from "@tabler/icons-react";
import { Button } from "@kandev/ui/button";
import { Switch } from "@kandev/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@kandev/ui/tabs";
import { SettingsPageTemplate } from "@/components/settings/settings-page-template";
import { useIsAdmin } from "@/hooks/domains/auth/use-is-admin";
import { useResponsiveBreakpoint } from "@/hooks/use-responsive-breakpoint";
import { useAutoUpdateSettings } from "@/hooks/domains/plugins/use-auto-update-settings";
import { usePlugins } from "@/hooks/domains/plugins/use-plugins";
import { usePluginSetupStatus } from "@/hooks/domains/plugins/use-plugin-setup-status";
import { usePluginUpdates } from "@/hooks/domains/plugins/use-plugin-updates";
import { InstallPluginDialog } from "./install-plugin-dialog";
import { MarketplaceBrowser } from "./marketplace-browser";
import { PluginRow, type PluginRowUpdateState } from "./plugin-row";
import { PluginUpdateStatus } from "./plugin-update-status";
import { usePluginActions } from "./use-plugin-actions";
import { usePluginUpdateAction } from "./use-plugin-update-action";
import { settingsActionClassName } from "@/components/settings/settings-control";

/**
 * Operator UI to browse, install, enable, disable, uninstall, and update kandev
 * plugins (docs/specs/plugins/requirements/marketplace.md). Gated on the `plugins` feature
 * flag by the page-level default export.
 */
export function PluginsSettings() {
  const { t } = useTranslation();
  const { isFinePointer } = useResponsiveBreakpoint();
  // A plugin is install-wide, so every mutation on this page is admin-only on
  // the backend (internal/plugins/handlers.go). Members keep the read-only
  // view instead of controls whose requests can only come back 403.
  const isAdmin = useIsAdmin();
  const list = usePlugins();
  const actions = usePluginActions();
  const autoUpdate = useAutoUpdateSettings();
  const updates = usePluginUpdates();
  const installedIds = useMemo(() => new Set(list.items.map((p) => p.id)), [list.items]);
  const updateAction = usePluginUpdateAction(
    actions.marketplaceInstall,
    updates.reload,
    installedIds,
    updates.markUpdated,
  );

  const handleMarketplaceInstall = async (url: string) => {
    const result = await actions.marketplaceInstall(url);
    if (result.ok) await updates.reload(result.pluginId);
    return result;
  };

  return (
    <SettingsPageTemplate
      title={t("common:plugins")}
      description={t("plugins:settingsDescription")}
      isDirty={false}
      saveStatus="idle"
      onSave={() => undefined}
      showSaveButton={false}
    >
      <Tabs defaultValue="installed" className="space-y-6">
        <TabsList>
          <TabsTrigger
            value="installed"
            data-testid="plugins-tab-installed"
            className="cursor-pointer"
          >
            {t("plugins:tabInstalled")}
          </TabsTrigger>
          {/* Browse exists to install, which is admin-only, so it is hidden
              rather than shown as a catalog nothing can be done with. */}
          {isAdmin && (
            <TabsTrigger value="browse" data-testid="plugins-tab-browse" className="cursor-pointer">
              {t("plugins:tabBrowse")}
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="installed" className="space-y-6">
          <InstalledTab
            list={list}
            actions={actions}
            autoUpdate={autoUpdate}
            updates={updates}
            updateAction={updateAction}
            isFinePointer={isFinePointer}
            isAdmin={isAdmin}
          />
        </TabsContent>

        {isAdmin && (
          <TabsContent value="browse">
            <MarketplaceBrowser onInstallUrl={handleMarketplaceInstall} />
          </TabsContent>
        )}
      </Tabs>

      {isAdmin && (
        <InstallPluginDialog
          open={actions.installOpen}
          busy={actions.installBusy}
          error={actions.installError}
          onOpenChange={actions.setInstallOpen}
          onSubmitUrl={actions.submitInstallUrl}
          onSubmitFile={actions.submitInstallFile}
        />
      )}
    </SettingsPageTemplate>
  );
}

type InstalledTabProps = {
  list: ReturnType<typeof usePlugins>;
  actions: ReturnType<typeof usePluginActions>;
  autoUpdate: ReturnType<typeof useAutoUpdateSettings>;
  updates: ReturnType<typeof usePluginUpdates>;
  updateAction: ReturnType<typeof usePluginUpdateAction>;
  isFinePointer: boolean;
  isAdmin: boolean;
};

/** The Installed tab: auto-update toggle, sync/install toolbar, update status, sync errors, and the plugin list. */
function InstalledTab({
  list,
  actions,
  autoUpdate,
  updates,
  updateAction,
  isFinePointer,
  isAdmin,
}: InstalledTabProps) {
  const { t } = useTranslation();

  return (
    <>
      {!isAdmin && (
        <div
          data-testid="plugins-admin-only-notice"
          className="rounded-lg border border-border/70 bg-muted/40 p-4 text-sm text-muted-foreground"
        >
          {t("plugins:adminOnlyNotice")}
        </div>
      )}
      <GlobalAutoUpdateToggle settings={autoUpdate} canManage={isAdmin} />

      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="text-sm font-medium text-foreground">{t("plugins:installedPlugins")}</div>
        {isAdmin && (
          <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row">
            <Button
              data-testid="plugins-sync-button"
              variant="secondary"
              disabled={actions.syncBusy}
              onClick={actions.handleSync}
              className={settingsActionClassName("cursor-pointer")}
            >
              <IconRefresh className={`h-4 w-4 ${actions.syncBusy ? "animate-spin" : ""}`} />
              {t("plugins:sync")}
            </Button>
            <Button
              data-testid="plugins-check-updates-button"
              variant="secondary"
              disabled={updates.checking}
              onClick={updates.checkForUpdates}
              className={settingsActionClassName("cursor-pointer")}
            >
              <IconRefresh className={`h-4 w-4 ${updates.checking ? "animate-spin" : ""}`} />
              {t("plugins:checkForUpdates")}
            </Button>
            <Button
              data-testid="install-plugin-trigger"
              onClick={actions.openInstall}
              className={settingsActionClassName("cursor-pointer")}
            >
              {t("plugins:installPlugin")}
            </Button>
          </div>
        )}
      </div>

      <PluginUpdateStatus
        checking={updates.checking}
        lastCheckedAt={updates.lastCheckedAt}
        error={updates.error}
      />

      {actions.syncErrors.length > 0 && (
        <div
          data-testid="plugins-sync-errors"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-400 space-y-1"
        >
          {actions.syncErrors.map((err) => (
            <div key={err.path} className="font-mono text-xs">
              {err.path}: {err.reason}
            </div>
          ))}
        </div>
      )}

      <PluginList
        list={list}
        actions={actions}
        autoUpdateDefault={autoUpdate.autoUpdateDefault}
        updates={updates}
        updateAction={updateAction}
        isFinePointer={isFinePointer}
        isAdmin={isAdmin}
      />
    </>
  );
}

/**
 * The instance-wide "Automatically update plugins" switch. When on, every
 * installed plugin without its own per-row override is auto-updated in the
 * background. Individual rows can still override this either way.
 */
function GlobalAutoUpdateToggle({
  settings,
  canManage,
}: {
  settings: ReturnType<typeof useAutoUpdateSettings>;
  canManage: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border/70 bg-background p-4">
      <div className="min-w-0 space-y-1">
        <label
          htmlFor="plugins-auto-update-default"
          className="text-sm font-medium text-foreground cursor-pointer"
        >
          {t("plugins:autoUpdateTitle")}
        </label>
        <p className="text-xs text-muted-foreground">{t("plugins:autoUpdateDescription")}</p>
      </div>
      <Switch
        id="plugins-auto-update-default"
        data-testid="plugins-auto-update-default"
        checked={settings.autoUpdateDefault}
        disabled={!settings.loaded || !canManage}
        onCheckedChange={settings.setDefault}
        className="cursor-pointer"
      />
    </div>
  );
}

type PluginListProps = {
  list: ReturnType<typeof usePlugins>;
  actions: ReturnType<typeof usePluginActions>;
  autoUpdateDefault: boolean;
  updates: ReturnType<typeof usePluginUpdates>;
  updateAction: ReturnType<typeof usePluginUpdateAction>;
  isFinePointer: boolean;
  isAdmin: boolean;
};

function PluginList({
  list,
  actions,
  autoUpdateDefault,
  updates,
  updateAction,
  isFinePointer,
  isAdmin,
}: PluginListProps) {
  const { t } = useTranslation();
  const { items, loaded, loading, error } = list;
  // The badge probes GET /api/plugins/:id/config, which is admin-only, and it
  // points at a form only an admin can fill in — so members do not probe.
  const needsSetup = usePluginSetupStatus(isAdmin ? items : []);

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (!loaded && loading) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 p-6 text-sm text-muted-foreground">
        {t("plugins:loadingPlugins")}
      </div>
    );
  }

  if (loaded && items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 p-6 text-sm text-muted-foreground">
        {t("plugins:noPluginsYet")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((plugin) => {
        const rowUpdate: PluginRowUpdateState = {
          latest: updates.latestById.get(plugin.id),
          hasUpdate: updates.updates.has(plugin.id),
          checked: updates.checked,
          sourcesDegraded: updates.sourcesDegraded,
          busy: updateAction.updatingIds.has(plugin.id),
          error: updateAction.errorsById.get(plugin.id),
        };
        return (
          <PluginRow
            key={plugin.id}
            plugin={plugin}
            busy={actions.busyId === plugin.id || rowUpdate.busy}
            update={rowUpdate}
            autoUpdateDefault={autoUpdateDefault}
            autoUpdateBusy={actions.autoUpdateBusyId === plugin.id}
            needsSetup={needsSetup.has(plugin.id)}
            isFinePointer={isFinePointer}
            uninstallBusy={actions.uninstallBusy}
            canManage={isAdmin}
            onEnable={actions.handleEnable}
            onDisable={actions.handleDisable}
            onConfirmUninstall={async (target) => {
              await actions.confirmUninstall(target);
            }}
            onUpdate={updateAction.runUpdate}
            onSetAutoUpdate={actions.handleSetAutoUpdate}
          />
        );
      })}
    </div>
  );
}
