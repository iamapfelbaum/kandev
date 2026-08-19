---
id: "10-task-base-self-heal"
title: "Self-heal task_repositories.base_branch after fallback recovery"
status: pending
wave: 3
depends_on: ["03-worktree-live-default-fallback"]
plan: "plan.md"
spec: "../../specs/task-launch-failure-recovery/spec.md"
---

# Task 10: Self-heal task base_branch after fallback recovery

When a per-repo worktree recovers on a fallback / live-default branch because the task's recorded
`task_repositories.base_branch` no longer exists, persist the resolved branch back to that row so the
task self-heals permanently (Policy B). Reuse the existing `Service.UpdateRepositoryBaseBranch`, which
already validates row ownership and fans out the session-base reset, `task.updated` publish, and live
agentctl push.

## Design constraint

The worktree `Manager` is task-agnostic (keyed by `RepositoryPath`; no `TaskRepository.ID`, no task
service). The self-heal write therefore lives at the launch/prepare layer, not in the worktree
package. The resolved branch already surfaces there via `Worktree.BaseBranch` and
`BaseBranchFallbackWarning` (see `env_preparer_worktree.go` `completeCreateWorktreeStep`), and that
layer knows the `TaskRepository.ID` for each repo it materializes.

The lifecycle tier must not import `internal/task/service` directly. Add a narrow interface (mirror the
existing `AgentBaseBranchPusher` / `BaseBranchProvider` seam) satisfied by `*service.Service`.

- **Acceptance:**
  1. A new `BaseBranchSelfHealer` interface exposes a single method, e.g.
     `SelfHealTaskRepositoryBase(ctx, taskID, taskRepositoryID, resolvedBranch string) error`, satisfied
     by `*task/service.Service` delegating to `UpdateRepositoryBaseBranch`. It is wired into the
     lifecycle `Manager` at the composition root via a `Set…` setter (mirroring `AgentBaseBranchPusher`).
  2. At the per-repo launch/prepare seam (where `TaskRepository.ID` and the created `Worktree` are both
     in scope), when `wt.BaseBranchFallbackWarning != ""` AND `strings.TrimSpace(wt.BaseBranch) != ""`
     AND `wt.BaseBranch` differs from the recorded `task_repositories.base_branch`, call the
     self-healer with that row's IDs and `wt.BaseBranch`.
  3. No call is made when the requested base still existed (no fallback warning) or when the resolved
     branch equals the recorded base (guard before calling — `UpdateRepositoryBaseBranch` rejects an
     unchanged/empty value).
  4. Best-effort: a self-healer error is logged at warn and does NOT roll back or fail the launch
     (same contract as `applyBaseBranchSideEffects`). When the self-healer is nil (not wired), the
     path is a silent no-op.
  5. Multi-repo: the check runs per materialized repo row; only recovered rows are written.

- **Verification:**
  `cd apps/backend && go build ./... && go test ./internal/agent/runtime/lifecycle/... ./internal/task/service/... -race`

- **Files likely touched:**
  `apps/backend/internal/agent/runtime/lifecycle/` (the per-repo prepare/launch path that reads
  `wt.BaseBranchFallbackWarning`, e.g. `env_preparer_worktree.go` + the manager wiring),
  a new small interface + setter alongside `AgentBaseBranchPusher`,
  the composition root that wires `*service.Service` into the lifecycle manager,
  and the corresponding `*_test.go` with a fake self-healer.

- **Dependencies:** Task 03 (relies on the resolved-branch surfacing).
- **Parallelism:** sequential (shares files with the lifecycle prepare path).
- **Inputs:** spec "Task base-branch self-heal", plan "Task base-branch self-heal (Policy B)";
  reuse `Service.UpdateRepositoryBaseBranch` (`service_branch_update.go`).

## Results
Pending.
