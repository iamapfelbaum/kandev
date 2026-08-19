---
id: "06-recovery-actions-ws"
title: "WS recovery actions: retry_default, pick_base_branch, mark_review_done"
status: pending
wave: 3
depends_on: ["01-failure-taxonomy-contracts", "03-worktree-live-default-fallback", "10-task-base-self-heal"]
plan: "plan.md"
spec: "../../specs/task-launch-failure-recovery/spec.md"
---

# Task 06: WS recovery actions

Extend the existing `session.recover` WS action with three recovery flows the UI will call.

- **Acceptance:**
  1. `retry_default`: resolves the live remote default via `gitref.ResolveRemoteDefaultBranch`,
     persists the corrected `repositories.default_branch` (only when currently stale/empty), self-heals
     the affected `task_repositories.base_branch` to the resolved branch via the `BaseBranchSelfHealer`
     seam (task-10) / `Service.UpdateRepositoryBaseBranch`, and relaunches the task via the existing
     `StartTask` machinery. On resolution failure, surface `default_branch_unresolved` with remaining
     action `pick_base_branch`.
  2. `pick_base_branch`: reads a caller-supplied `base_branch`, validates it exists, self-heals the
     affected `task_repositories.base_branch` to that branch, and relaunches on it.
  3. `mark_review_done`: moves the task to its workflow terminal step without launching (see Open
     Question — confirm terminal vs. configured Done step).
  4. Existing actions (`resume`, `fresh_start`, `runtime_retry`, `cancel_retry`) are unchanged; the
     handler applies the standard session/task authorization guards (see `apps/backend/AGENTS.md`
     per-user scoping) before acting.

- **Verification:**
  `cd apps/backend && go test ./internal/orchestrator/... -race`

- **Files likely touched:**
  the `session.recover` handler in `apps/backend/internal/orchestrator/`,
  its test file, and any relaunch helper reused from `StartTask`.

- **Dependencies:** Task 01, Task 03, Task 10 (reuses the `BaseBranchSelfHealer` seam).
- **Parallelism:** sequential.
- **Inputs:** plan "Recovery actions (WS)"; spec "API surface".

## Results
Pending.
