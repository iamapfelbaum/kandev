---
id: "08-frontend-failure-surface-and-recovery"
title: "Frontend failure surface and recovery actions"
status: pending
wave: 5
depends_on: ["06-recovery-actions-ws", "07-status-summary-projection"]
plan: "plan.md"
spec: "../../specs/task-launch-failure-recovery/spec.md"
---

# Task 08: Frontend failure surface and recovery actions

Render the typed failure reason persistently on the task and replace the raw-error toast with a
pointer, wiring the recovery buttons to the new WS actions.

- **Acceptance:**
  1. `apps/web/lib/types/task-status-summary.ts` `active_error` includes
     `category: string` and `recovery_actions: string[]`.
  2. `apps/web/components/task/simple/components/run-error-entry.tsx` renders a localized headline per
     `category` with the `message` as detail, and maps `recovery_actions` to buttons that call the
     existing `session.recover` WS action with `retry_default` / `pick_base_branch` /
     `mark_review_done`. `pick_base_branch` reuses the existing native branch picker to supply
     `base_branch`.
  3. The task-launch failure toast shows `task:launchFailedSeeDetails` ("Couldn't start the task, see
     the task for details"), not the raw git error.
  4. All new copy goes through `t()` (no literals); typecheck and lint pass.

- **Verification:**
  `cd apps && pnpm install --frozen-lockfile && pnpm --filter @kandev/web test -- components/task/simple/components/run-error-entry.test.tsx` then
  `cd apps/web && pnpm run typecheck`

- **Files likely touched:**
  `apps/web/lib/types/task-status-summary.ts`,
  `apps/web/components/task/simple/components/run-error-entry.tsx` (+ its `.test.tsx`),
  the task-launch toast call site.

- **Dependencies:** Task 06, Task 07.
- **Parallelism:** sequential.
- **Inputs:** plan "Frontend"; spec "Scenarios".

## Results
Pending.
