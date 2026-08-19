---
id: "01-failure-taxonomy-contracts"
title: "Failure taxonomy and typed reason contracts"
status: pending
wave: 1
depends_on: []
plan: "plan.md"
spec: "../../specs/task-launch-failure-recovery/spec.md"
---

# Task 01: Failure taxonomy and typed reason contracts

Introduce the typed launch-failure taxonomy and extend the persisted reason structure, without
changing behavior yet. This is the shared contract every other backend task consumes.

- **Acceptance:**
  1. `internal/task/models/models.go` `LastAgentError` has a new
     `RecoveryActions []string` field with tag `json:"recovery_actions,omitempty"`.
  2. A `FailureCategory` string constant set exists (`base_branch_missing`, `pr_already_closed`,
     `default_branch_unresolved`, `generic_launch_failure`) plus a `RecoveryAction` constant set
     (`retry_default`, `pick_base_branch`, `mark_review_done`), in a single place callers import.
  3. `internal/worktree/errors.go` exposes a way for callers to detect the missing-base case
     (confirm `ErrInvalidBaseBranch` is usable with `errors.Is`; add a doc note if so).

- **Verification:**
  `cd apps/backend && go build ./... && go test ./internal/task/models/... ./internal/worktree/...`

- **Files likely touched:**
  `apps/backend/internal/task/models/models.go`,
  `apps/backend/internal/worktree/errors.go` (doc/const only).

- **Dependencies:** None.
- **Parallelism:** parallel-safe (disjoint from task-02).
- **Inputs:** spec "Data model" and "Failure modes"; plan "Failure taxonomy + typed reason".

## Results
Pending.
