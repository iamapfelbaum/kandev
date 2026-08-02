import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginRegistry } from "./registry";
import { PLUGIN_USER_STATE_UPDATED_ACTION, subscribeToUserStateChanges } from "./user-state-sync";

function dispatch(payload: unknown) {
  pluginRegistry
    .getWsHandlers(PLUGIN_USER_STATE_UPDATED_ACTION)
    .forEach((handler) => handler(payload));
}

afterEach(() => {
  pluginRegistry.unregisterPlugin("plugin-a");
  pluginRegistry.unregisterPlugin("plugin-b");
});

describe("subscribeToUserStateChanges", () => {
  it("delivers a matching change for the subscribed plugin", () => {
    const handler = vi.fn();
    subscribeToUserStateChanges("plugin-a", "tab-1", {}, handler);

    dispatch({
      pluginId: "plugin-a",
      scope: "task",
      scopeId: "task_1",
      key: "note",
      updatedAt: "2026-01-01T00:00:00Z",
      writerId: "tab-2",
    });

    expect(handler).toHaveBeenCalledWith({
      scope: "task",
      scopeId: "task_1",
      key: "note",
      updatedAt: "2026-01-01T00:00:00Z",
      deleted: undefined,
    });
  });

  it("ignores notifications for a different plugin (AC25 own-plugin filter)", () => {
    const handler = vi.fn();
    subscribeToUserStateChanges("plugin-a", "tab-1", {}, handler);

    dispatch({
      pluginId: "plugin-b",
      scope: "task",
      scopeId: "task_1",
      key: "note",
      writerId: "tab-2",
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("suppresses its own tab's echo (AC25)", () => {
    const handler = vi.fn();
    subscribeToUserStateChanges("plugin-a", "tab-1", {}, handler);

    dispatch({
      pluginId: "plugin-a",
      scope: "task",
      scopeId: "task_1",
      key: "note",
      writerId: "tab-1",
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("filters by scope/scopeId/key when the filter narrows them", () => {
    const handler = vi.fn();
    subscribeToUserStateChanges(
      "plugin-a",
      "tab-1",
      { scope: "task", scopeId: "task_1", key: "note" },
      handler,
    );

    dispatch({
      pluginId: "plugin-a",
      scope: "task",
      scopeId: "task_2",
      key: "note",
      writerId: "tab-2",
    });
    expect(handler).not.toHaveBeenCalled();

    dispatch({
      pluginId: "plugin-a",
      scope: "task",
      scopeId: "task_1",
      key: "note",
      writerId: "tab-2",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("subscribeToUserStateChanges — unsubscribe and revocation", () => {
  it("stops delivering after unsubscribe, without disturbing other subscriptions", () => {
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const unsubscribeA = subscribeToUserStateChanges("plugin-a", "tab-1", {}, handlerA);
    subscribeToUserStateChanges("plugin-a", "tab-1", {}, handlerB);

    unsubscribeA();
    dispatch({
      pluginId: "plugin-a",
      scope: "task",
      scopeId: "task_1",
      key: "note",
      writerId: "tab-2",
    });

    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  // AC26: disabling/uninstalling a plugin bulk-revokes every subscription it
  // holds (via the existing unregisterPlugin path), and re-subscribing after
  // a reload still reaches the registry.
  it("bulk-revokes on unregisterPlugin, and a fresh subscribe after reload works again", () => {
    const handler = vi.fn();
    subscribeToUserStateChanges("plugin-a", "tab-1", {}, handler);
    expect(pluginRegistry.getWsHandlers(PLUGIN_USER_STATE_UPDATED_ACTION)).toHaveLength(1);

    pluginRegistry.unregisterPlugin("plugin-a");
    expect(pluginRegistry.getWsHandlers(PLUGIN_USER_STATE_UPDATED_ACTION)).toHaveLength(0);

    const reloadedHandler = vi.fn();
    subscribeToUserStateChanges("plugin-a", "tab-1", {}, reloadedHandler);
    dispatch({
      pluginId: "plugin-a",
      scope: "task",
      scopeId: "task_1",
      key: "note",
      writerId: "tab-2",
    });

    expect(handler).not.toHaveBeenCalled();
    expect(reloadedHandler).toHaveBeenCalledTimes(1);
  });
});
