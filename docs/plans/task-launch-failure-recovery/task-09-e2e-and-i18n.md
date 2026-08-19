---
id: "09-e2e-and-i18n"
title: "E2E coverage and i18n propagation"
status: pending
wave: 6
depends_on: ["08-frontend-failure-surface-and-recovery"]
plan: "plan.md"
spec: "../../specs/task-launch-failure-recovery/spec.md"
---

# Task 09: E2E coverage and i18n propagation

Prove the user-visible flows end to end and complete translations in all five locales.

- **Acceptance:**
  1. `apps/web/e2e/tests/task/launch-failure-recovery.spec.ts` covers: (a) auto-start of a task linked
     to a merged PR is gated — no `FAILED`, `pr_already_closed` reason with "Mark review done"
     visible; (b) a base-branch-missing launch shows the `base_branch_missing` reason with the three
     recovery actions, and invoking `retry_default`/`pick_base_branch` relaunches AND self-heals the
     task base (assert the recovered branch persists on the task after a reload, e.g. the changes-panel
     "Compare against" shows the resolved branch); (c) the launch toast shows the pointer copy, not the
     raw error. Follow the recovery-button pattern in
     `apps/web/e2e/tests/session/transient-retry.spec.ts` and causal `watchWs` waits.
  2. New copy exists in `en`, `pt-pt`, `zh-cn`; `zh-hk`/`zh-tw` generated via `pnpm run i18n:zh-hant`.
  3. `pnpm run i18n:check` passes (key parity, placeholders, no em-dash).

- **Verification:**
  `cd apps && pnpm install --frozen-lockfile` then
  `cd apps/web && pnpm run i18n:check && pnpm e2e:raw -- launch-failure-recovery`

- **Files likely touched:**
  `apps/web/e2e/tests/task/launch-failure-recovery.spec.ts`,
  `apps/web/src/locales/{en,pt-pt,zh-cn,zh-hk,zh-tw}/task.json`.

- **Dependencies:** Task 08.
- **Parallelism:** sequential.
- **Inputs:** plan "E2E Tests"; spec "Scenarios"; i18n rules in root `AGENTS.md`.

## Results
Pending.
