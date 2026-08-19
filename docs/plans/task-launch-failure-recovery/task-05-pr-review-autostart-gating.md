---
id: "05-pr-review-autostart-gating"
title: "Gate PR-review auto-start when the PR is merged or closed"
status: pending
wave: 3
depends_on: ["01-failure-taxonomy-contracts"]
plan: "plan.md"
spec: "../../specs/task-launch-failure-recovery/spec.md"
---

# Task 05: Gate PR-review auto-start when the PR is merged or closed

Skip an `on_enter` auto-start launch for a task whose linked GitHub PR is already `merged`/`closed`,
and attach an informational `pr_already_closed` reason instead of failing.

- **Acceptance:**
  1. `autoStartTaskForLoadedStep` (`internal/orchestrator/event_handlers_workflow.go:1060-1123`):
     before launching, look up the task's linked PR rows (github store, keyed by `task_id`). If any
     linked PR `state` is `merged` or `closed`, skip `StartTask`, write a `pr_already_closed` reason
     with `["mark_review_done"]`, and do NOT mark the task `FAILED`.
  2. When the PR is `open`, launch proceeds unchanged.
  3. Fail open: no linked PR row, or a lookup error, proceeds to the normal launch path (absence is
     not treated as "closed"). Manual (user-triggered) launches are not affected.

- **Verification:**
  `cd apps/backend && go test ./internal/orchestrator/... -race`

- **Files likely touched:**
  `apps/backend/internal/orchestrator/event_handlers_workflow.go`,
  `apps/backend/internal/orchestrator/event_handlers_workflow_test.go`,
  a narrow github-store read interface if one is needed on the orchestrator.

- **Dependencies:** Task 01 (`pr_already_closed` category + `mark_review_done` action).
- **Parallelism:** sequential.
- **Inputs:** plan "PR-review auto-start gating"; spec "State machine"; `github_task_prs` columns from
  `internal/github/models.go` `TaskPR`.

## Results
Pending.
