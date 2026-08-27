---
id: "02-guard-queued-task-inspection"
title: "Guard queued task inspection"
status: completed
wave: 2
depends_on:
  - "01-restore-promotion-autostart"
plan: "plan.md"
requirements:
  - REQ-TASKS-WIP-LIMIT-PULL-SYSTEM-001
acceptance_criteria:
  - AC-TASKS-WIP-LIMIT-PULL-SYSTEM-001.2
system_design:
  - ../../specs/tasks/system-design/wip-limit-pull-system.md
---

# Task 02: Guard Queued Task Inspection

## Summary

Prevent task inspection from creating or resuming a session before WIP promotion.
Enable normal session creation after a task update clears the queue destination.

## In scope

- Return `skipped_wip_queue` from `EnsureSession` while a task is queued.
- Run the queue guard before existing-session execution resume logic.
- Extend the frontend response source union.
- Skip `session.ensure` in the shared task-open hook while `queuedForStepId` is present.
- Map the HTTP task queue field into the full task route's hook input.
- Add backend and frontend unit tests for the guard and promotion update.

## Out of scope

- Direct user-requested launch operations.
- New rendered states, copy, controls, or responsive layouts.
- A new mobile Playwright test. The shared hook has no viewport-specific behavior.

## Acceptance

- `EnsureSession` creates no session or execution for a queued task.
- The task-open hook does not call `session.ensure` while the task is queued.
- The hook calls `session.ensure` after the same task becomes admitted.

## Verification

```bash
rtk go test -tags fts5 ./internal/orchestrator -run 'TestEnsureSession.*Queued' -count=1
```

Run this command from `apps/backend`.

```bash
rtk pnpm exec vitest run hooks/domains/session/use-ensure-task-session.test.ts lib/services/session-launch-service.test.ts
```

Run this command from `apps/web`.

## Files likely touched

- `apps/backend/internal/orchestrator/session_ensure.go`
- `apps/backend/internal/orchestrator/session_ensure_queue_test.go`
- `apps/web/lib/services/session-launch-service.ts`
- `apps/web/hooks/domains/session/use-ensure-task-session.ts`
- `apps/web/hooks/domains/session/use-ensure-task-session.test.ts`
- `apps/web/components/task/task-page-content.tsx`

## Dependencies

Task 01 restores the promotion launch that replaces the task-open workaround.

## Risks

- The frontend can remain latched if queue admission is not a hook dependency.
- A late task update can overwrite a newer session list.

## Parallelism

`sequential`

## Inputs

- `AC-TASKS-WIP-LIMIT-PULL-SYSTEM-001.2`.
- `docs/specs/tasks/system-design/wip-limit-pull-system.md`.
- `EnsureSession`, `useEnsureTaskSession`, and their current tests.
- The shared desktop and mobile task-open path.

## Results

Implemented the backend queue guard, the frontend source union and task
mapping, and the shared hook dependency/early return.

Verification passed:

```text
rtk go test -tags fts5 ./internal/orchestrator -run 'TestEnsureSession.*Queued' -count=1
Go test: 2 passed in 1 packages

rtk pnpm exec vitest run hooks/domains/session/use-ensure-task-session.test.ts lib/services/session-launch-service.test.ts
Test Files  2 passed (2)
Tests  25 passed (25)
```

No mobile Playwright test was added because this is shared state and request
normalization only. It changes no layout, navigation, touch behavior, or
viewport-dependent interaction.
