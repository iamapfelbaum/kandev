/**
 * Implements `host.storage.subscribe` (approach F1,
 * docs/plans/plugins/PLUGIN-API.md): a thin, typed wrapper over
 * `registerWsHandler("plugin.user-state.updated", …)` with own-plugin
 * filtering, scope/scopeId/key filtering, and own-tab echo suppression.
 */
import { pluginRegistry } from "./registry";
import type { PluginStorageScope, PluginUserStateChange } from "./types";

/** Must match `ActionPluginUserStateUpdated` in apps/backend/pkg/websocket/actions.go. */
export const PLUGIN_USER_STATE_UPDATED_ACTION = "plugin.user-state.updated";

export interface UserStateSubscribeFilter {
  scope?: PluginStorageScope;
  scopeId?: string;
  key?: string;
}

/** Shape of the WS notification payload published by the backend on write/delete. */
interface UserStateUpdatedPayload {
  pluginId?: string;
  scope?: PluginStorageScope;
  scopeId?: string;
  key?: string;
  updatedAt?: string;
  writerId?: string;
  deleted?: boolean;
}

function matchesFilter(filter: UserStateSubscribeFilter, change: PluginUserStateChange): boolean {
  if (filter.scope && filter.scope !== change.scope) return false;
  if (filter.scopeId && filter.scopeId !== change.scopeId) return false;
  if (filter.key && filter.key !== change.key) return false;
  return true;
}

/**
 * Subscribes `pluginId` to live per-user storage updates. `localWriterId` is
 * the writer id this browser tab stamps on its own writes (see
 * `host-api.ts`'s TAB_WRITER_ID) — a notification carrying the same
 * writerId is this tab's own echo and is skipped (AC25) so an editor never
 * clobbers its own caret/selection from its own write.
 *
 * Registers one WS handler per call (via `registerWsHandler`), so the
 * returned unsubscribe can remove exactly this subscription
 * (`unregisterWsHandler`) without disturbing any other subscription the
 * plugin holds, while a full plugin disable/uninstall still bulk-revokes it
 * via the existing `unregisterPlugin` path (AC26).
 */
export function subscribeToUserStateChanges(
  pluginId: string,
  localWriterId: string,
  filter: UserStateSubscribeFilter,
  handler: (change: PluginUserStateChange) => void,
): () => void {
  const wsHandler = (payload: unknown): void => {
    const raw = payload as UserStateUpdatedPayload | undefined;
    if (!raw || raw.pluginId !== pluginId) return;
    if (raw.writerId && raw.writerId === localWriterId) return;

    const change: PluginUserStateChange = {
      scope: (raw.scope ?? "instance") as PluginStorageScope,
      scopeId: raw.scopeId ?? "",
      key: raw.key ?? "",
      updatedAt: raw.updatedAt ?? "",
      deleted: raw.deleted,
    };
    if (!matchesFilter(filter, change)) return;
    handler(change);
  };

  pluginRegistry.registerWsHandler(pluginId, PLUGIN_USER_STATE_UPDATED_ACTION, wsHandler);
  return () => {
    pluginRegistry.unregisterWsHandler(pluginId, PLUGIN_USER_STATE_UPDATED_ACTION, wsHandler);
  };
}
