"use client";

import { useCallback, useMemo } from "react";
import { useOptionalAppStore } from "@/components/state-provider";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { usePluginRegistry } from "@/lib/plugins/registry";
import type { AppState } from "@/lib/state/store";
import type { TaskSession } from "@/lib/types/http";
import type { PluginPresentation } from "@/lib/plugins/types";

const SLOT = "chat-submit-decoration";

/**
 * Props forwarded to every plugin component registered for the
 * `chat-submit-decoration` slot (`registry.registerComponent(
 * "chat-submit-decoration", Component)`).
 *
 * Unlike `chat-input-actions`, which contributes a sibling icon button, this
 * slot renders *over* the send button's own box — for adornments that belong
 * on the send affordance itself rather than beside it (a progress ring, a
 * state dot). The host positions the layer; the plugin draws inside or around
 * it.
 *
 * These are kandev session ids. Resolving them to an agent/ACP transcript id
 * is the plugin's job — do it server-side in the plugin backend through the
 * Host data API, not here. See PLUGIN-API.md.
 */
export type ChatSubmitDecorationSlotProps = {
  /** Task the composer belongs to, or null for task-less quick chat. */
  taskId: string | null;
  /** Display title of the task, when known. */
  taskTitle?: string;
  /** Session the composer is currently bound to, or null before one exists. */
  activeSessionId: string | null;
  /** Every kandev session id on the task (includes `activeSessionId`). */
  sessionIds: string[];
  presentation: PluginPresentation;
  /** True while the composer is dispatching the current message. */
  isSending: boolean;
  /** True when the agent is mid-turn, so the next send queues behind it. */
  isAgentBusy: boolean;
  /** True when the send button itself is disabled. */
  disabled: boolean;
  /** True when plan mode is on (the button sends a plan request). */
  planModeEnabled: boolean;
};

const EMPTY_SESSIONS: TaskSession[] = [];

/**
 * Plugin extension point layered over the chat composer's send button.
 *
 * The host owns the geometry: the layer is absolutely positioned to the send
 * button's box (a 28px circle) so a decoration can size itself against
 * `inset-0` without measuring anything. Drawing *around* the button is a
 * negative inset (`-inset-1`) on the plugin's own element — the layer does not
 * clip.
 *
 * The layer is `pointer-events-none` so a decoration can never swallow a click
 * meant for send. A decoration that genuinely needs interaction (a popover
 * trigger) opts back in with `pointer-events-auto` on that child alone.
 */
export function ChatSubmitPluginDecoration(props: {
  sessionId: string | null;
  taskId: string | null;
  taskTitle?: string;
  presentation: PluginPresentation;
  isSending: boolean;
  isAgentBusy: boolean;
  isDisabled: boolean;
  planModeEnabled: boolean;
}) {
  const { sessionId, taskId, taskTitle } = props;
  // Gate the positioned layer on there being something to draw: an empty
  // absolute span over the send button is dead weight in every composer, and
  // the surrounding markup must stay identical to today when no plugin
  // contributes. Reactive through the registry's useSyncExternalStore.
  const registry = usePluginRegistry();
  const hasDecoration = registry.getSlotRegistrations(SLOT).length > 0;
  // itemsByTaskId holds a stable per-task array reference (updated only when
  // that task's sessions change), so selecting it avoids a new-array-per-render.
  // Read optionally: the composer always renders under a StateProvider in the
  // app, but rendering the toolbar in isolation (unit tests) must not crash.
  const selectSessions = useCallback(
    (s: AppState): TaskSession[] =>
      taskId ? (s.taskSessionsByTask.itemsByTaskId[taskId] ?? EMPTY_SESSIONS) : EMPTY_SESSIONS,
    [taskId],
  );
  const taskSessions = useOptionalAppStore(selectSessions, EMPTY_SESSIONS);

  const slotProps = useMemo<ChatSubmitDecorationSlotProps>(() => {
    const sessionIds: string[] = taskSessions.map((session) => session.id);
    // The active session may not yet be in the store list (freshly prepared);
    // make sure the plugin always receives it.
    if (sessionId && !sessionIds.includes(sessionId)) sessionIds.unshift(sessionId);
    return {
      taskId,
      taskTitle,
      activeSessionId: sessionId,
      sessionIds,
      presentation: props.presentation,
      isSending: props.isSending,
      isAgentBusy: props.isAgentBusy,
      disabled: props.isDisabled,
      planModeEnabled: props.planModeEnabled,
    };
  }, [taskSessions, sessionId, taskId, taskTitle, props]);

  if (!hasDecoration) return null;

  return (
    <span
      data-testid="chat-submit-decoration-layer"
      className="pointer-events-none absolute inset-0 z-10"
    >
      <PluginSlot name={SLOT} slotProps={slotProps} />
    </span>
  );
}
