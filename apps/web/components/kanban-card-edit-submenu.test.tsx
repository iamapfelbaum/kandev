import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@kandev/ui/dropdown-menu";
import { pluginRegistry } from "@/lib/plugins/registry";
import type { PluginTaskMenuContext } from "@/lib/plugins/types";
import { KanbanCardDropdownMenuItems } from "./kanban-card-menu-items";
import { buildEditMenuEntry } from "./kanban-card-edit-submenu";

const PLUGIN_ID = "kandev-plugin-notes";
const ACTION_LABEL = "Enhance with AI";

const CONTEXT: PluginTaskMenuContext = {
  workspaceId: "ws-1",
  taskId: "task-1",
  taskTitle: "Fix the bug",
  workflowStepId: "step-1",
  presentation: "desktop",
};

function renderEntry(onEdit?: () => void, context: PluginTaskMenuContext = CONTEXT) {
  const entry = buildEditMenuEntry({ onEdit, context });
  render(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <KanbanCardDropdownMenuItems entries={[entry]} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  return entry;
}

function registerEnhanceAction(
  overrides: {
    run?: () => Promise<void> | void;
    visible?: (context: PluginTaskMenuContext) => boolean;
  } = {},
) {
  pluginRegistry.forPlugin(PLUGIN_ID).registerTaskMenuAction({
    id: "enhance",
    label: ACTION_LABEL,
    group: "edit",
    run: overrides.run ?? vi.fn(),
    ...(overrides.visible ? { visible: overrides.visible } : {}),
  });
}

afterEach(() => {
  cleanup();
  pluginRegistry.unregisterPlugin(PLUGIN_ID);
});

describe("buildEditMenuEntry — AC10 (no plugin actions)", () => {
  it("renders the flat Edit item exactly as before", () => {
    const entry = renderEntry(vi.fn());
    expect(entry.kind).toBe("item");
    expect(screen.getByRole("menuitem", { name: "Edit" })).not.toBeNull();
    expect(screen.queryByText("Edit task")).toBeNull();
  });

  it("clicking the flat item calls onEdit", () => {
    const onEdit = vi.fn();
    renderEntry(onEdit);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});

describe("buildEditMenuEntry — AC9 (plugin action registered)", () => {
  it("becomes a submenu with 'Edit task' plus the plugin's item", () => {
    registerEnhanceAction();

    const entry = renderEntry(vi.fn());
    expect(entry.kind).toBe("submenu");
    if (entry.kind === "submenu") {
      expect(entry.children.map((c) => c.key)).toEqual([
        "edit-task",
        `plugin-edit-${PLUGIN_ID}-enhance`,
      ]);
    }
  });
});

describe("buildEditMenuEntry — AC11 (run invoked with context, rejection caught, menu still closes)", () => {
  it("invokes run(context) on select", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    registerEnhanceAction({ run });

    renderEntry(vi.fn());
    fireEvent.click(screen.getByTestId("kanban-edit-submenu"));
    const pluginItem = await screen.findByRole("menuitem", { name: ACTION_LABEL });
    fireEvent.click(pluginItem);

    expect(run).toHaveBeenCalledWith(CONTEXT);
  });

  it("catches a rejecting run without throwing", async () => {
    const run = vi.fn().mockRejectedValue(new Error("boom"));
    registerEnhanceAction({ run });
    const originalConsoleError = console.error;
    console.error = () => {};

    renderEntry(vi.fn());
    fireEvent.click(screen.getByTestId("kanban-edit-submenu"));
    const pluginItem = await screen.findByRole("menuitem", { name: ACTION_LABEL });
    expect(() => fireEvent.click(pluginItem)).not.toThrow();

    await Promise.resolve();
    await Promise.resolve();
    console.error = originalConsoleError;
  });
});

describe("buildEditMenuEntry — AC12 (visible filter)", () => {
  it("hides an action whose visible(context) returns false", () => {
    registerEnhanceAction({ visible: () => false });

    const entry = renderEntry(vi.fn());
    expect(entry.kind).toBe("item");
  });

  it("shows an action whose visible(context) returns true", () => {
    registerEnhanceAction({ visible: (context) => context.taskId === CONTEXT.taskId });

    const entry = renderEntry(vi.fn());
    expect(entry.kind).toBe("submenu");
  });
});
