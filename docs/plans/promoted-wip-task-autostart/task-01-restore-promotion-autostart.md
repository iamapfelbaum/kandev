---
id: "01-restore-promotion-autostart"
title: "Restore promotion auto-start"
status: completed
wave: 1
depends_on: []
plan: "plan.md"
requirements:
  - REQ-TASKS-WIP-LIMIT-PULL-SYSTEM-001
acceptance_criteria:
  - AC-TASKS-WIP-LIMIT-PULL-SYSTEM-001.2
system_design:
  - ../../specs/tasks/system-design/wip-limit-pull-system.md
---

# Task 01: Restore Promotion Auto-Start

## Summary

Make queue promotion accept the expected missing-session result.
Then the existing no-session branch can consume the deferred launch and create one session.

## In scope

- Handle `models.ErrTaskSessionNotFound` as a `nil` active session.
- Preserve the current retry behavior for all other repository errors.
- Add focused regression tests for successful launch and repository failure.

## Out of scope

- Session creation from task inspection.
- WIP admission and queue selection.
- Deferred launch storage changes.

## Acceptance

- Promotion of a task with no session reaches the no-session launch path.
- A deferred launch creates exactly one session without UI interaction.
- A different active-session lookup error leaves the promotion token unchanged.

## Verification

```bash
rtk go test -tags fts5 ./internal/orchestrator -run 'TestQueuePromotion(WithoutSessionLaunchesDeferredTask|SessionLookupFailureKeepsToken)' -count=1
```

Run this command from `apps/backend`.

## Files likely touched

- `apps/backend/internal/orchestrator/event_handlers_workflow.go`
- `apps/backend/internal/orchestrator/event_handlers_queue_promotion_test.go`

## Dependencies

None.

## Risks

- Broad error suppression can hide a database failure and consume the retry token.

## Parallelism

`sequential`

## Inputs

- `AC-TASKS-WIP-LIMIT-PULL-SYSTEM-001.2`.
- `docs/specs/tasks/system-design/wip-limit-pull-system.md`.
- Issue 3079 and the failing focused reproduction.
- `handleTaskQueuePromoted` and `TestQueuePromotionTokenRemainsPendingWhenTargetLookupFails`.

## Results

Implemented the sentinel-only session lookup handling in
`handleTaskQueuePromoted`.

Verification passed:

```text
rtk go test -tags fts5 ./internal/orchestrator -run 'TestQueuePromotion(WithoutSessionLaunchesDeferredTask|SessionLookupFailureKeepsToken)' -count=1
Go test: 2 passed in 1 packages
```
