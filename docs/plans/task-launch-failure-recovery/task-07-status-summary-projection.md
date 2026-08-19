---
id: "07-status-summary-projection"
title: "Project failure category and recovery actions to TaskStatusSummary"
status: pending
wave: 4
depends_on: ["01-failure-taxonomy-contracts", "04-launch-failure-classification"]
plan: "plan.md"
spec: "../../specs/task-launch-failure-recovery/spec.md"
---

# Task 07: Project failure category and recovery actions to TaskStatusSummary

Carry the typed failure reason to the frontend through the existing bounded status projection so the
kanban card and task surface can render it.

- **Acceptance:**
  1. `TaskStatusSummary.active_error` gains `category string` and `recovery_actions []string`,
     populated from the session `LastAgentError` metadata wherever `preview` is populated today.
  2. The DTO + `ToAPI` in `pkg/api/v1/` and the `task.status_summary.updated` WS payload carry the new
     fields.
  3. No unbounded transcript data is added to the summary (respects the bounded-status contract in
     `docs/specs/platform/bounded-task-status-delivery.md`).

- **Verification:**
  `cd apps/backend && go test ./internal/task/... ./internal/orchestrator/... -race`

- **Files likely touched:**
  the `TaskStatusSummary` projection builder, `pkg/api/v1/` DTO + `ToAPI`, and the projection test.

- **Dependencies:** Task 01, Task 04.
- **Parallelism:** sequential.
- **Inputs:** plan "Bounded status projection"; spec "API surface".

## Results
Pending.
