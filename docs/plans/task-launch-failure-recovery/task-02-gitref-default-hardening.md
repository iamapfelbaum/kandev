---
id: "02-gitref-default-hardening"
title: "gitref default-branch detection hardening"
status: pending
wave: 1
depends_on: []
plan: "plan.md"
spec: "../../specs/task-launch-failure-recovery/spec.md"
---

# Task 02: gitref default-branch detection hardening

Stop persisting a feature branch as a repository default, and add a live remote-default resolver used
by the retry path.

- **Acceptance:**
  1. `DefaultBranchOrEmpty` (`internal/common/gitref/gitref.go:74-80`) returns `""` when the resolved
     value came only from the current-HEAD last resort (`readHEADBranchFallback`) with no origin or
     local `main`/`master` ref present. `DefaultBranch` keeps its existing contract for changes-panel
     callers.
  2. A new exported `ResolveRemoteDefaultBranch(repoPath string) (string, error)` reads the live
     `origin/HEAD` (best-effort `git remote set-head -a` allowed via `subproc` classified git helper)
     and returns the real default, or an error when it cannot be determined.
  3. Detection order and existing behavior for repos that DO have origin refs is unchanged.

- **Verification:**
  `cd apps/backend && go test ./internal/common/gitref/...`

- **Files likely touched:**
  `apps/backend/internal/common/gitref/gitref.go`,
  `apps/backend/internal/common/gitref/gitref_test.go`.

- **Dependencies:** None.
- **Parallelism:** parallel-safe (disjoint from task-01).
- **Inputs:** spec "What" (default-branch hardening), plan "gitref hardening"; note `subproc`
  git-command rule in `apps/backend/AGENTS.md`.

## Results
Pending.
