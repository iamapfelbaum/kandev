---
id: "03-worktree-live-default-fallback"
title: "Worktree fallback resolves live remote default"
status: pending
wave: 2
depends_on: ["02-gitref-default-hardening"]
plan: "plan.md"
spec: "../../specs/task-launch-failure-recovery/spec.md"
---

# Task 03: Worktree fallback resolves live remote default

When the recorded fallback default is empty or itself missing, attempt one live remote-default
resolution before failing, so a stale `default_branch` no longer dead-ends a launch.

- **Acceptance:**
  1. `resolveBaseRefWithFallback` (`internal/worktree/manager_lifecycle.go:183-237`): when
     `fallback == ""` or the fallback branch does not exist, call
     `gitref.ResolveRemoteDefaultBranch` and, if it yields an existing branch different from the
     requested base, use it (with the existing warning/detail surfacing).
  2. When neither the requested base, the recorded fallback, nor the live default resolves, the
     function still returns `ErrInvalidBaseBranch` with the existing message shape.
  3. The `could not verify base branch` timeout/stall path is unchanged.
  4. The resolved branch continues to surface to callers unchanged: `req.BaseBranch` is set to the
     resolved name and the created `Worktree.BaseBranch` + `BaseBranchFallbackWarning` carry it (this
     is the signal task-10 consumes for self-heal). Do not add a task-service dependency here — the
     Manager stays task-agnostic.

- **Verification:**
  `cd apps/backend && go test ./internal/worktree/...`

- **Files likely touched:**
  `apps/backend/internal/worktree/manager_lifecycle.go`,
  `apps/backend/internal/worktree/manager_lifecycle_test.go`.

- **Dependencies:** Task 02 (uses `ResolveRemoteDefaultBranch`).
- **Parallelism:** sequential.
- **Inputs:** plan "Worktree fallback resolves live default"; spec "Failure modes".

## Results
Pending.
