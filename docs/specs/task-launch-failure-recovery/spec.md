---
status: draft
created: 2026-08-19
owner: cfl12
---

# Task Launch Failure Recovery

## Why

When a task fails to launch (most commonly a PR-review task whose base branch was deleted after the
PR merged), the user sees only a transient toast repeating a raw git error, and the task flips to
`FAILED` with no reason and no next step. The user can neither understand what went wrong nor recover
without leaving the app. This affects anyone whose repositories have short-lived base branches or a
mis-recorded default branch.

## What

This feature has three concerns that together turn launch failures from dead ends into understandable,
recoverable states.

- **PR-review gating.** When a workflow step's `on_enter` would auto-start an agent for a task whose
  linked PR is already `merged` or `closed`, the task SHALL NOT attempt a worktree launch. Instead it
  moves to a terminal informational outcome and records why. A launch the user triggers manually is
  never gated.
- **Actionable failure reason on the task.** When a launch fails for any reason, the task SHALL carry
  a persistent, typed failure reason (category + human-readable message + suggested recovery actions)
  that survives reload and is visible on the task surface, not only as a toast. The toast is reduced
  to a pointer ("Couldn't start the task, see the task for details").
- **Default-branch resolution hardening.** When the stored `default_branch` used as a launch fallback
  does not exist on the remote, the launch SHALL resolve the repository's real default from
  `origin/HEAD` at launch time rather than failing on a stale value. Repository default-branch
  detection SHALL NOT persist a feature branch as the default: when only the current local `HEAD` is
  available (no origin refs), it stores empty and resolves lazily later.
- **Task base-branch self-heal.** When a launch confirms the task's recorded
  `task_repositories.base_branch` no longer exists on the remote and recovers by resolving a valid
  branch (the repository fallback or the live remote default), the task SHALL persist that resolved
  branch back to its `task_repositories.base_branch` so it self-heals permanently and future launches
  and the changes-panel diff use a real branch. The write reuses `Service.UpdateRepositoryBaseBranch`
  (single-row update plus its existing session-base reset and live-push fan-out). Self-heal applies
  only to the fallback-recovery case where the original base is confirmed missing; it does not rewrite
  a base branch that still exists.

## Data model

The typed failure reason is persisted so it survives restart. It reuses the existing
`TaskSession.Metadata` `LastAgentError` structure (`internal/task/models/models.go`,
`SessionMetaKeyLastAgentError`) extended with a stable `category` and machine-readable
`recovery_actions`, rather than adding a new table.

```
LastAgentError (stored in task_sessions.metadata JSON under key "last_agent_error")
  message           string      human-readable, sanitized (existing)
  occurred_at       timestamp   (existing)
  agent_execution_id string     (existing, optional)
  code              string      (existing, optional) — reused as the stable category code
  details           string      (existing, optional)
  recovery_actions  []string    NEW — ordered subset of {"retry_default","pick_base_branch","mark_review_done"}
  dismissed_at      timestamp   (existing, nullable)
```

Failure categories (the `code` value):
`base_branch_missing`, `pr_already_closed`, `default_branch_unresolved`, `generic_launch_failure`.

PR lifecycle state used for gating already exists in `github_task_prs`
(`internal/github/models.go` `TaskPR`): `state` (`open`/`closed`/`merged`), `merged_at`, `closed_at`,
linked by `(task_id, repository_id, pr_number)`. No schema change for gating.

Repository default branch: `repositories.default_branch TEXT DEFAULT ''`
(`internal/task/models/models.go` `Repository.DefaultBranch`). No schema change; behavior change only.

## API surface

- **WS `session.recover`** (existing, `internal/orchestrator` recovery path). Extend the `action`
  enum with `retry_default` (retry launch resolving the live remote default), `pick_base_branch`
  (client supplies a `base_branch` field; relaunch on it), and `mark_review_done` (move the task to
  its completed/terminal step without launching). Existing actions (`resume`, `fresh_start`,
  `runtime_retry`, `cancel_retry`) are unchanged.
- **`TaskStatusSummary.active_error`** (existing bounded projection, see
  `docs/specs/platform/bounded-task-status-delivery.md`) gains `category: string` and
  `recovery_actions: string[]` alongside the existing `preview`. This is how the failure reason
  reaches the kanban card and task surface.
- **`gitref.DefaultBranch` / `DefaultBranchOrEmpty`** (`internal/common/gitref/gitref.go`): a new
  behavior where the current-HEAD last-resort branch is treated as "unresolved" for persistence
  callers (returns empty), so a feature branch is never recorded as default.

## State machine

Auto-start gating on step `on_enter` (extends `autoStartTaskForLoadedStep`):

| Condition | Outcome |
|---|---|
| Step has `auto_start_agent` AND task's linked PR `state` is `merged` or `closed` | Skip launch; set failure reason `pr_already_closed` with actions `["mark_review_done"]`; task does not enter `FAILED` for this cause, it stays in its current step with the informational reason attached |
| Step has `auto_start_agent` AND launch fails because base and fallback both missing | Session `FAILED`; failure reason `base_branch_missing` with actions `["retry_default","pick_base_branch","mark_review_done"]` |
| Manual launch (user-triggered) | Never gated by PR state |

## Failure modes

- **PR lookup fails / no linked PR:** gating is skipped (fail open to the normal launch path). Absence
  of a PR row is not treated as "closed".
- **Live `origin/HEAD` resolution fails during `retry_default`:** the retry fails with
  `default_branch_unresolved` and surfaces `pick_base_branch` as the remaining action.
- **`branchExists` cannot be determined (timeout/fs stall):** unchanged — surfaces the real cause
  (`could not verify base branch ...`), not a missing-branch failure.
- **Recovery action on a task whose PR is not merged:** `mark_review_done` is still permitted (user
  choice) but is only surfaced automatically for `pr_already_closed` and `base_branch_missing`.
- **Self-heal write fails (DB/live-push error):** best-effort, mirroring `UpdateRepositoryBaseBranch`
  fan-out semantics — the launch/relaunch is not rolled back, the failure is logged at warn, and the
  next launch re-resolves. The worktree still uses the resolved branch for this run.
- **Multi-repo task, only some bases missing:** self-heal writes only the `task_repositories` row(s)
  whose base was confirmed missing and recovered; rows with a still-existing base are untouched.

## Persistence guarantees

The typed failure reason persists in `task_sessions.metadata` and survives a kandev restart, so the
task surface renders the reason and recovery actions after reload. Gating decisions are not persisted
(re-evaluated on each auto-start attempt). A corrected `default_branch` written during `retry_default`
persists to `repositories.default_branch`. A confirmed-missing task base that is recovered persists the
resolved branch to `task_repositories.base_branch` (self-heal), so the correction survives restart and
future launches read a valid base directly.

## Scenarios

- **GIVEN** a PR-review task whose linked PR is `merged`, **WHEN** the workflow step's `on_enter`
  auto-start fires, **THEN** no worktree launch is attempted, the task is not marked `FAILED` for this
  cause, and the task shows a `pr_already_closed` reason offering "Mark review done".
- **GIVEN** a PR-review task whose PR is still `open`, **WHEN** `on_enter` auto-start fires, **THEN**
  the launch proceeds normally.
- **GIVEN** a launch whose requested base branch and the repository fallback default both no longer
  exist on the remote, **WHEN** the launch runs, **THEN** the session becomes `FAILED` with a
  `base_branch_missing` reason and actions "Retry on default branch", "Pick a base branch",
  "Mark review done", persisted and visible after reload.
- **GIVEN** a launch whose requested base branch is confirmed missing but the repository fallback (or
  live remote default) resolves, **WHEN** the worktree recovers on that branch, **THEN** the task's
  `task_repositories.base_branch` is rewritten to the resolved branch (self-heal), and the changes
  panel and next launch use it; the correction survives reload.
- **GIVEN** a `FAILED` task with a `base_branch_missing` reason, **WHEN** the user invokes
  `retry_default` and the live `origin/HEAD` resolves, **THEN** the task relaunches on the real
  default branch, the corrected `default_branch` is persisted, and the task's `base_branch` self-heals
  to that branch.
- **GIVEN** a `FAILED` task with a `base_branch_missing` reason, **WHEN** the user invokes
  `pick_base_branch` with an existing branch, **THEN** the task relaunches on that branch and its
  `base_branch` is set to the chosen branch.
- **GIVEN** a local repository imported while checked out on a feature branch with no origin refs,
  **WHEN** its `default_branch` is detected for persistence, **THEN** the stored value is empty (not
  the feature branch) and is resolved lazily on the next launch.
- **GIVEN** any launch failure, **WHEN** it surfaces, **THEN** the toast reads "Couldn't start the
  task, see the task for details" rather than the raw git error.

## Out of scope

- A background poller that re-syncs every repository's `default_branch` from the provider API.
- Bulk data repair of existing mis-recorded `default_branch` rows (handled separately as a one-off).
- Gating manual launches on PR state.
- Non-GitHub providers' PR lifecycle gating (GitLab/Azure) — GitHub only in this iteration.
- Changing worktree creation, `Configure`, or ACP resume semantics beyond the fallback resolution.
- Choosing a "smarter" self-heal target than the resolved fallback/default (e.g. a merged stacked PR's
  original parent branch). Accepted tradeoff: self-heal writes the branch the worktree actually
  recovered on. For a merged stacked PR that means the diff base becomes the repository default, which
  can widen the changes-panel diff; the user can re-point it via the existing "Compare against" picker.

## Open questions

- Should `mark_review_done` route to the workflow's terminal step generically, or to a specific
  "Done/Reviewed" step when one is configured? (Assumption: the task's workflow terminal step; confirm
  during planning.)
