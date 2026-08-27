---
created: 2026-08-27
status: complete
requirements:
  - REQ-TASKS-WIP-LIMIT-PULL-SYSTEM-001
system_design:
  - ../../specs/tasks/system-design/wip-limit-pull-system.md
legacy_specs: []
---

# Implementation Plan: Promoted WIP Task Auto-Start

## Overview

This fix restores automatic launch after Kandev promotes a WIP-queued task.
It also prevents task inspection from creating runtime resources before promotion.

The first work order corrects the promotion handler and proves the deferred launch.
The second work order closes the task-open bypass in the backend and the shared web hook.

## Scope

### In scope

- Treat `models.ErrTaskSessionNotFound` as the expected no-session promotion state.
- Preserve the retry token for other active-session lookup errors.
- Consume the deferred launch after promotion and create one session.
- Make `EnsureSession` return a successful no-session result for queued tasks.
- Prevent the shared task-open hook from calling `session.ensure` while a task is queued.
- Retry normal session creation when a task update clears its queue destination.

### Out of scope

- Changes to WIP admission, promotion order, or queue persistence.
- Changes to direct user-requested session launch operations.
- Changes to task cards, queue badges, layouts, or mobile navigation.
- New queue controls or public documentation.

## Technical approach

### Promotion without an active session

Update `handleTaskQueuePromoted` in
`apps/backend/internal/orchestrator/event_handlers_workflow.go`.
Convert only `models.ErrTaskSessionNotFound` to a `nil` session.
Keep the current early return for all other repository errors.

The handler will then claim `MetaKeyQueuePromotionPending` and enter the existing
no-session branch. `launchDeferredTask` will claim the durable launch intent and
call `LaunchSession` after the promotion is committed.

Add focused tests in a new orchestrator test file. One test will use the SQLite
repository's real missing-session result. It will assert that promotion creates
one session without an `EnsureSession` call. A second test will inject a different
repository error and assert that the promotion token remains available for retry.

### Queued task inspection

Update `EnsureSession` in `apps/backend/internal/orchestrator/session_ensure.go`.
Load the task before existing-session resume logic. If `QueuedForStepID` is not
empty, return a successful response with source `skipped_wip_queue` and no session.
This check also prevents `EnsureExecution` from resuming an old queued session.

Extend `EnsureSessionResponse` and the frontend response union with the new source.
Add `queuedForStepId` to `EnsureTaskInput` in the shared session hook.
The hook will remain idle while that field is present. When promotion clears the
field, the same hook will run its normal session-ensure path.

The full task route will map `task.queued_for_step_id` into the hook input.
The Kanban preview already passes the mapped `KanbanTask`, which carries
`queuedForStepId`.

## Tests

- `AC-TASKS-WIP-LIMIT-PULL-SYSTEM-001.2`: A promoted task without a session
  consumes its promotion token and launches its deferred session.
- `AC-TASKS-WIP-LIMIT-PULL-SYSTEM-001.2`: A genuine repository error keeps the
  promotion token for retry.
- `AC-TASKS-WIP-LIMIT-PULL-SYSTEM-001.2`: `EnsureSession` creates no session or
  execution for a queued task.
- `AC-TASKS-WIP-LIMIT-PULL-SYSTEM-001.2`: The shared task-open hook skips queued
  tasks and runs after a task update clears the queue destination.

## E2E tests

No new Playwright test is required. The frontend change only normalizes shared
state inside the existing desktop and mobile task-open hook. Targeted backend and
hook tests cover the changed boundary without a layout or touch change.

## Work orders

- [x] [Task 01: Restore promotion auto-start](task-01-restore-promotion-autostart.md)
- [x] [Task 02: Guard queued task inspection](task-02-guard-queued-task-inspection.md)

## Verification results

Passed the exact work-order checks:

```text
rtk go test -tags fts5 ./internal/orchestrator -run 'TestQueuePromotion(WithoutSessionLaunchesDeferredTask|SessionLookupFailureKeepsToken)' -count=1
Go test: 2 passed in 1 packages

rtk go test -tags fts5 ./internal/orchestrator -run 'TestEnsureSession.*Queued' -count=1
Go test: 2 passed in 1 packages

rtk pnpm exec vitest run hooks/domains/session/use-ensure-task-session.test.ts lib/services/session-launch-service.test.ts
Test Files  2 passed (2)
Tests  25 passed (25)
```

No new mobile Playwright test was added because the frontend change only
normalizes shared task-open state and has no layout, navigation, touch, or
viewport-dependent behavior.

## Risks

- The missing-session sentinel must not hide database errors.
- A no-session skip response must not latch the frontend after promotion.
- Existing queued tasks can contain stale sessions from the current bypass.
  The backend guard must run before `EnsureExecution` resume logic.
