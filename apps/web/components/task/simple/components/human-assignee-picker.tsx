"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@kandev/ui/button";
import { Combobox, type ComboboxOption } from "@/components/combobox";
import { useAppStore } from "@/components/state-provider";
import { updateTask } from "@/lib/api/domains/office-extended-api";
import { listDirectoryUsers, listWorkspaceMembers } from "@/lib/api/domains/team-access-api";
import type { DirectoryUser, WorkspaceMember } from "@/lib/types/team-access";
import { useOptimisticTaskMutation } from "@/hooks/use-optimistic-task-mutation";
import type { Task } from "@/app/office/tasks/[id]/types";
import { useTranslation } from "react-i18next";

type HumanAssigneePickerProps = {
  task: Task;
};

// i18n-exempt: sentinel compared with ===, never displayed.
const UNASSIGNED = "__unassigned__";

/**
 * The human assignee: who on the team owns this task.
 *
 * Deliberately separate from AssigneePicker, which sets the agent that runs
 * the task. The two are independent — a task can be assigned to a person and
 * a runner at once — so this control never touches the agent assignee.
 *
 * Assignment is advisory. It gates nothing: taking a task over is a
 * reassignment plus a prompt, not a lock, which is why "Assign to me" needs
 * no confirmation and works whether or not the task is already assigned.
 */
export function HumanAssigneePicker({ task }: HumanAssigneePickerProps) {
  const { t } = useTranslation();
  const workspaceId = useAppStore((s) => s.workspaces.activeId);
  const currentUser = useAppStore((s) => s.auth.user);
  const mutate = useOptimisticTaskMutation();
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([]);

  // Two sources, because neither alone is the set of people who can be
  // assigned. The member list misses everyone who reaches an org-visible
  // workspace without a member row, which is the common case and would leave
  // their name showing as a raw user id. The directory covers those, but a
  // private workspace can hold a member the directory omits.
  useEffect(() => {
    let cancelled = false;
    // The directory is not workspace-scoped, so it is fetched even when no
    // active workspace is set: the office task route does not always populate
    // one, and gating both calls on it left every name showing as a raw id.
    Promise.allSettled([
      listDirectoryUsers(),
      workspaceId ? listWorkspaceMembers(workspaceId) : Promise.resolve({ members: [], total: 0 }),
    ]).then(([directory, members]) => {
      if (cancelled) return;
      const byId = new Map<string, string>();
      if (directory.status === "fulfilled") {
        for (const u of (directory.value.users ?? []) as DirectoryUser[]) {
          byId.set(u.id, u.display_name || u.id);
        }
      }
      if (members.status === "fulfilled") {
        for (const m of (members.value.members ?? []) as WorkspaceMember[]) {
          if (!byId.has(m.user_id)) byId.set(m.user_id, m.display_name || m.user_id);
        }
      }
      setPeople(Array.from(byId, ([id, name]) => ({ id, name })));
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const assignee = task.assigneeUserId ?? "";

  const options = useMemo<ComboboxOption[]>(() => {
    const unassigned: ComboboxOption = {
      value: UNASSIGNED,
      label: t("task:unassigned"),
      keywords: ["none", "unassigned"],
      renderLabel: () => <span className="text-muted-foreground">{t("task:unassigned")}</span>,
    };
    const known = new Map(people.map((p) => [p.id, p.name]));
    // A task can hold an assignee neither source returned (a disabled account,
    // or a list the caller cannot read). Keep them selectable so the control
    // shows the truth rather than silently reading as unassigned.
    if (assignee && !known.has(assignee)) known.set(assignee, assignee);
    return [
      unassigned,
      ...Array.from(known, ([userId, name]) => ({
        value: userId,
        label: name,
        keywords: [name, userId],
      })),
    ];
  }, [people, assignee, t]);

  const apply = async (next: string) => {
    if (next === assignee) return;
    try {
      await mutate(task.id, { assigneeUserId: next || undefined }, () =>
        updateTask(task.id, { assignee_user_id: next }),
      );
    } catch {
      /* toast already raised */
    }
  };

  const isMine = Boolean(currentUser) && assignee === currentUser?.id;

  return (
    <span className="flex min-w-0 items-center justify-end gap-1 ml-auto">
      {currentUser && !isMine && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          data-testid="assign-to-me"
          onClick={() => void apply(currentUser.id)}
        >
          {t("task:assignToMe")}
        </Button>
      )}
      <Combobox
        options={options}
        value={assignee || UNASSIGNED}
        onValueChange={(next) => void apply(next === UNASSIGNED ? "" : next)}
        placeholder={t("task:unassigned")}
        searchPlaceholder={t("task:searchPeople")}
        emptyMessage={t("task:noPeopleFound")}
        triggerClassName="h-7 w-auto justify-end px-2"
        popoverAlign="end"
        testId="human-assignee-picker-trigger"
      />
    </span>
  );
}
