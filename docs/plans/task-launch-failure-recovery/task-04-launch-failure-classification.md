---
id: "04-launch-failure-classification"
title: "Classify and persist typed launch-failure reason"
status: pending
wave: 2
depends_on: ["01-failure-taxonomy-contracts"]
plan: "plan.md"
spec: "../../specs/task-launch-failure-recovery/spec.md"
---

# Task 04: Classify and persist typed launch-failure reason

Turn a raw launch error into a persisted, typed `LastAgentError` (category + message + recovery
actions) on the session, so the reason survives reload and can be projected to the UI.

- **Acceptance:**
  1. `transitionLaunchFailure` (`internal/orchestrator/executor/executor_execute.go:1269-1293`)
     classifies `launchErr`: `errors.Is(err, worktree.ErrInvalidBaseBranch)` →
     `base_branch_missing` with actions `["retry_default","pick_base_branch","mark_review_done"]`;
     otherwise `generic_launch_failure` with no auto actions.
  2. It persists the typed `LastAgentError` (sanitized `message`, `code`=category,
     `recovery_actions`) into `task_sessions.metadata` under `SessionMetaKeyLastAgentError`, in
     addition to the existing `ErrorMessage`.
  3. The existing session→FAILED and task→FAILED transitions are unchanged.

- **Verification:**
  `cd apps/backend && go test ./internal/orchestrator/executor/... -race`

- **Files likely touched:**
  `apps/backend/internal/orchestrator/executor/executor_execute.go`,
  `apps/backend/internal/orchestrator/executor/executor_execute_test.go`.

- **Dependencies:** Task 01 (taxonomy constants + `RecoveryActions` field).
- **Parallelism:** sequential.
- **Inputs:** plan "Launch-failure classification + persistence"; spec "Data model".

## Results
Pending.
