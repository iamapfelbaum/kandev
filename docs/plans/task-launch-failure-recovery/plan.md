---
spec: docs/specs/task-launch-failure-recovery/spec.md
created: 2026-08-19
status: draft
---

# Implementation Plan: Task Launch Failure Recovery

## Overview

Three concerns, built bottom-up so the product works after each wave: (1) harden default-branch
resolution and the worktree fallback so a stale/feature default no longer dead-ends a launch;
(2) classify launch failures into a persisted, typed reason and gate PR-review auto-start when the PR
is already merged/closed; (3) project the reason to the frontend and expose one-click recovery
actions. Backend contracts and the failure taxonomy land first, service behavior next, then WS
recovery wiring, then UI and E2E.

## Confirmed root cause

- `gitref.DefaultBranch` (`internal/common/gitref/gitref.go:34-70`) falls back to the current local
  `HEAD` (`readHEADBranchFallback`, `:232-248`) when no origin refs resolve, so a repo imported on a
  feature branch records that branch as the default.
- `FindOrCreateRepository` (`internal/task/service/service_resources.go:921-1009`) writes
  `default_branch` once and never overwrites; `backfillRepoDefaultBranch`
  (`internal/orchestrator/executor/executor_resume.go:456-477`) re-runs the same detection, so the bad
  value re-cements.
- `resolveBaseRefWithFallback` (`internal/worktree/manager_lifecycle.go:183-237`) returns
  `ErrInvalidBaseBranch` ("base branch does not exist: … (fallback … also not found)") when both the
  requested base and the recorded fallback default are missing — the observed launch failure.
- `autoStartTaskForLoadedStep` (`internal/orchestrator/event_handlers_workflow.go:1060-1123`)
  launches via `StartTask` with no PR-lifecycle check, so it reviews already-merged PRs.

---

## Backend

### Failure taxonomy + typed reason (contracts)

- `internal/task/models/models.go`: extend `LastAgentError` with `RecoveryActions []string`
  (`json:"recovery_actions,omitempty"`). Add a `FailureCategory` string-const set
  (`base_branch_missing`, `pr_already_closed`, `default_branch_unresolved`,
  `generic_launch_failure`) reused as the existing `Code` field value. No DB migration (metadata JSON).
- `internal/worktree/errors.go`: keep `ErrInvalidBaseBranch`; add a sentinel or typed check the
  executor can map to `base_branch_missing` (e.g. `errors.Is(err, ErrInvalidBaseBranch)`).

### gitref hardening

- `internal/common/gitref/gitref.go`: make the current-HEAD last resort distinguishable. Simplest:
  in `DefaultBranchOrEmpty`, return empty when the resolved value came only from
  `readHEADBranchFallback` (no origin/local main/master ref existed). Add an internal helper that
  returns `(branch string, fromHEADFallback bool)` so `DefaultBranchOrEmpty` can collapse the
  fallback-only case to `""`. `DefaultBranch` keeps its current contract for changes-panel callers.
- Add a live-resolution helper `ResolveRemoteDefaultBranch(ctx, repoPath)` (thin wrapper over
  `origin/HEAD` read + optional `git remote set-head -a`) used by the retry path when the stored
  default is stale.

### Worktree fallback resolves live default

- `internal/worktree/manager_lifecycle.go` `resolveBaseRefWithFallback`: when the recorded fallback is
  empty or itself missing, attempt one live remote-default resolution
  (`gitref.ResolveRemoteDefaultBranch`) before returning `ErrInvalidBaseBranch`. Preserve the existing
  warning/detail surfacing (the resolved name is already reflected onto `req.BaseBranch` and surfaced
  as `Worktree.BaseBranch` + `BaseBranchFallbackWarning`). Callers unchanged.

### Task base-branch self-heal (Policy B)

The worktree `Manager` is task-agnostic (keyed by `RepositoryPath`; it has no `TaskRepository.ID` and
no task-service handle), so the self-heal write cannot live inside `resolveBaseRefWithFallback`. The
resolved branch already surfaces up to the launch layer: `resolveBaseRefWithFallback` sets
`req.BaseBranch = fallback` and the created `Worktree.BaseBranch` carries the resolved name plus
`BaseBranchFallbackWarning`. The env preparer already reads this signal in
`completeCreateWorktreeStep` (`internal/agent/runtime/lifecycle/env_preparer_worktree.go`).

- Detect the self-heal condition at the launch/prepare layer that owns both the `TaskRepository.ID`
  and the per-repo worktree result: when `wt.BaseBranchFallbackWarning != ""` (i.e. the requested base
  was confirmed missing and a fallback/live-default was used) and `wt.BaseBranch` differs from the
  recorded `task_repositories.base_branch`, call `Service.UpdateRepositoryBaseBranch` with that row's
  `TaskID` + `TaskRepositoryID` + resolved `wt.BaseBranch`.
- Wiring: the lifecycle `Manager` reaches the task service through a narrow interface (mirror the
  existing `AgentBaseBranchPusher`/`BaseBranchProvider` seam — add a `BaseBranchSelfHealer` interface
  with a single `SelfHealTaskRepositoryBase(ctx, taskID, taskRepositoryID, resolvedBranch)` method
  satisfied by `*task/service.Service`, delegating to `UpdateRepositoryBaseBranch`). The lifecycle tier
  must not import `task/service` directly; use the interface, wired at composition root.
- Best-effort and idempotent: `UpdateRepositoryBaseBranch` already validates row ownership, resets
  session bases, republishes `task.updated`, and pushes the live map. A failed self-heal is logged at
  warn and does not roll back the launch (same contract as `applyBaseBranchSideEffects`). Skip the
  write when the resolved branch equals the recorded base (no-op) — `UpdateRepositoryBaseBranch`
  rejects an unchanged/empty value, so guard before calling.
- Multi-repo: run per recovered repo row only; untouched rows stay as-is.

### Launch-failure classification + persistence

- `internal/orchestrator/executor/executor_execute.go` `transitionLaunchFailure` (`:1269-1293`):
  classify `launchErr` into a `FailureCategory` and compute `RecoveryActions`, then persist the typed
  `LastAgentError` (message via existing `SanitizeError`, plus category + actions) into session
  metadata in addition to the existing `ErrorMessage`. Keep task→FAILED transition unchanged.

### PR-review auto-start gating

- `internal/orchestrator/event_handlers_workflow.go` `autoStartTaskForLoadedStep` (`:1060-1123`):
  before launching, look up the task's linked PR(s) via the github store
  (`ListTaskPRs…` by `task_id`). If any linked PR `state` is `merged`/`closed`, skip the launch, write
  a `pr_already_closed` reason with `["mark_review_done"]`, and do not mark the task `FAILED`. Fail
  open when there is no PR row or the lookup errors. Manual launches are not routed here.

### Recovery actions (WS)

- Orchestrator `session.recover` handler: add `retry_default`, `pick_base_branch` (reads
  `base_branch`), and `mark_review_done`. `retry_default` resolves the live remote default, persists
  the corrected `repositories.default_branch`, and relaunches. `mark_review_done` moves the task to
  its workflow terminal step without launching. Reuse existing relaunch/`StartTask` machinery.
- Both `retry_default` and `pick_base_branch` also self-heal the task base: after resolving the branch
  they call `Service.UpdateRepositoryBaseBranch` for the affected `task_repositories` row(s) so the
  relaunch and future launches read the corrected base directly, then relaunch. (The launch-path
  self-heal in the section above also covers the auto-recovery case; the recovery-action write is the
  same call for the explicit user-driven path.)

### Bounded status projection

- `TaskStatusSummary.active_error` (see `docs/specs/platform/bounded-task-status-delivery.md`) gains
  `category` and `recovery_actions`; populate from the session metadata where `preview` is populated
  today. Update the DTO + `ToAPI` and the `task.status_summary.updated` payload.

---

## Frontend

### Types + store

- `apps/web/lib/types/task-status-summary.ts`: extend `active_error` with
  `category: string` and `recovery_actions: string[]`.
- No new store slice; the existing kanban/status-summary handlers
  (`apps/web/lib/ws/handlers/tasks.ts`) already merge `active_error`.

### Failure surface + recovery actions

- `apps/web/components/task/simple/components/run-error-entry.tsx`: render the typed reason
  (category → localized headline, `message` as detail) and map `recovery_actions` to buttons that call
  the existing `session.recover` WS action with the new action values (`retry_default`,
  `pick_base_branch`, `mark_review_done`). For `pick_base_branch`, reuse the existing native branch
  picker to supply `base_branch`.
- Toast: replace the raw-error task-launch toast with the pointer copy
  (`task:launchFailedSeeDetails`).

### i18n

- Add keys to `apps/web/src/locales/en/task.json` (headlines per category + action labels + pointer
  toast), then propagate to `pt-pt`, `zh-cn`, and generate `zh-hk`/`zh-tw` via `pnpm run i18n:zh-hant`.

---

## Tests

- **gitref fallback-only collapse:** `DefaultBranchOrEmpty` returns `""` when only current HEAD
  resolves; returns real default when origin refs exist. File:
  `internal/common/gitref/gitref_test.go`. Table-driven with `t.TempDir()` git fixtures.
- **worktree live-default resolution:** `resolveBaseRefWithFallback` recovers via live remote default
  when the recorded fallback is missing; still errors when nothing resolves. File:
  `internal/worktree/manager_lifecycle_test.go`.
- **task base self-heal:** when a per-repo worktree recovers on a fallback/live-default branch
  (`wt.BaseBranchFallbackWarning != ""` and `wt.BaseBranch` differs from the recorded base), the launch
  layer calls the `BaseBranchSelfHealer` with the row's `TaskID`/`TaskRepositoryID`/resolved branch;
  no call when the base still exists; a self-healer error does not fail the launch. File:
  `internal/agent/runtime/lifecycle/` env-preparer/launch test (fake self-healer records the call).
- **launch-failure classification:** `transitionLaunchFailure` persists `base_branch_missing` +
  actions into session metadata for `ErrInvalidBaseBranch`; `generic_launch_failure` otherwise. File:
  `internal/orchestrator/executor/executor_execute_test.go`.
- **PR gating:** `autoStartTaskForLoadedStep` skips launch and writes `pr_already_closed` when the
  linked PR is merged; launches when open; fails open when no PR row. File:
  `internal/orchestrator/event_handlers_workflow_test.go`.
- **recovery actions:** `session.recover` `retry_default` persists corrected default, self-heals the
  task base via the self-healer seam, + relaunches; `pick_base_branch` self-heals to the chosen branch;
  `mark_review_done` moves to terminal step without launch. File: orchestrator recover handler test.
- **status projection:** `active_error` carries `category` + `recovery_actions`. File: bounded
  status-summary projection test.
- **frontend types/render:** `run-error-entry` renders category headline and maps actions to
  `session.recover` calls. File: `apps/web/components/task/simple/components/run-error-entry.test.tsx`.

---

## E2E Tests

- **PR-review of merged PR is gated:** seed a task linked to a merged PR on an auto-start step; assert
  no `FAILED`, and the `pr_already_closed` reason with "Mark review done" is visible. File:
  `apps/web/e2e/tests/task/launch-failure-recovery.spec.ts`.
- **Base-branch-missing recovery:** seed a launch that fails with missing base+fallback; assert the
  task shows `base_branch_missing` reason + the three actions; invoking retry/pick relaunches. Same
  file. Follow the `session/transient-retry.spec.ts` recovery-button pattern.
- **Toast pointer copy:** assert the launch-failure toast shows the pointer text, not the raw error.

---

## Verification Results
Pending.

---

## Implementation Waves And Parallel Candidates

```
Wave 1 (parallel candidates — user authorization required; disjoint files):
- [ ] task-01-failure-taxonomy-contracts (models + errors)
- [ ] task-02-gitref-default-hardening

Wave 2:
- [ ] task-03-worktree-live-default-fallback   (depends 02)
- [ ] task-04-launch-failure-classification     (depends 01)

Wave 3:
- [ ] task-05-pr-review-autostart-gating        (depends 01)
- [ ] task-10-task-base-self-heal               (depends 03)
- [ ] task-06-recovery-actions-ws               (depends 01,03,10)

Wave 4:
- [ ] task-07-status-summary-projection         (depends 01,04)

Wave 5:
- [ ] task-08-frontend-failure-surface-and-recovery (depends 06,07)

Wave 6:
- [ ] task-09-e2e-and-i18n                       (depends 08)
```

## Open Questions

- `mark_review_done` target step: the workflow's terminal step generically, or a configured
  "Done/Reviewed" step when present. Resolve before task-06.
