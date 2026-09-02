---
created: 2026-09-02
status: done
requirements:
  - REQ-TASKS-WORKFLOW-STEP-AGENT-START-OWNERSHIP-003
  - REQ-TASKS-MCP-TOOL-NAMES-001
system_design:
  - ../../specs/tasks/system-design/workflow-step-agent-start-ownership.md
  - ../../specs/tasks/system-design/mcp-tool-name-stability.md
legacy_specs:
  - ../../specs/workflow-on-enter-action-dispatch/spec.md
---

# Implementation Plan: Deduplicate Empty Workflow Prompts

## Overview

The backend will use an atomically claimed durable session prompt boundary before it applies the task-description fallback. Then the frontend will correct two plan-tool names.

The backend work owns the duplicate dispatch. The frontend correction is independent, but the primary session will implement work orders sequentially.

## Scope

### In scope

- Stop repeated task-description prompts on empty automatic-start steps.
- Apply one fallback rule to automatic step entry and explicit workflow-step launch.
- Preserve non-empty step prompts for prompted sessions.
- Preserve the first task-description prompt for unprompted sessions.
- Correct `plan_get` and `plan_update` in the active-plan context.
- Add focused Go, TypeScript, and Playwright regressions.

### Out of scope

- Do not change plan-mode placement at the first workflow step.
- Do not change `is_start_step` or `auto_start_agent` routing.
- Do not change workflow prompts that contain text.
- Do not add a database column or migration.
- Do not change MCP tool registration or transport names.

## Technical approach

### Durable prompt history

Add a bounded repository query for `task_session_prompt_seq.last_seq` and an atomic initial-fallback claim. The claim and direct user-message creation use the same per-session persistence boundary, so concurrent automatic and explicit admissions cannot both qualify as the first prompt. The claim uses a zero-valued counter row as its reservation marker, so the first visible message still receives prompt ordinal 1.

Expose this query and claim through the repository contract that the orchestrator uses. Keep message deletion behavior unchanged because the counter never decreases.

### Shared workflow prompt decision

Add an orchestrator helper that composes a workflow-entry prompt for one session. For an empty `WorkflowStep.Prompt` only, use the task description only when the atomic initial-fallback claim succeeds. Non-empty step prompts, including `{{task_prompt}}` expansion, retain their existing semantics.

Call the helper from `launchAfterOnEnterDispatch` before its ACP or passthrough split. Call the same helper from `StartSessionForWorkflowStep`.

Keep `buildWorkflowPromptWithTrustedContext` as the string composer. Keep non-empty `WorkflowStep.Prompt` behavior unchanged.

Apply plan-mode and session-config transforms before deciding whether the composed prompt is empty. If the composed ACP prompt is empty, let `autoStartStepPrompt` inspect any queued handoff first. Return without message creation or dispatch only when the merged prompt and attachments are empty. Attachment-only handoffs are admitted and persisted with their metadata.

### Plan-tool names

Change the active-plan context in `apps/web/hooks/use-message-handler.ts`. Use `get_task_plan_kandev` and `update_task_plan_kandev`.

Export the pure context helper for focused unit coverage. Do not localize this model-facing instruction.

## Tests

- `AC-TASKS-WORKFLOW-STEP-AGENT-START-OWNERSHIP-003.1`: add a Go test for an unprompted session on an empty automatic-start step.
- `AC-TASKS-WORKFLOW-STEP-AGENT-START-OWNERSHIP-003.2`: add a Go test for a prompted plan-mode session that later enters an empty automatic-start step.
- `AC-TASKS-WORKFLOW-STEP-AGENT-START-OWNERSHIP-003.3`: add a Go test that a non-empty step prompt still dispatches after earlier prompts.
- `AC-TASKS-WORKFLOW-STEP-AGENT-START-OWNERSHIP-003.4`: assert that an empty result creates no user row and no runtime prompt, while an attachment-only handoff remains durable input.
- `AC-TASKS-WORKFLOW-STEP-AGENT-START-OWNERSHIP-003.5`: add a focused `StartSessionForWorkflowStep` regression.
- `AC-TASKS-WORKFLOW-STEP-AGENT-START-OWNERSHIP-003.6`: cover the shared decision before the transport split.
- `AC-TASKS-MCP-TOOL-NAMES-001.3`: add a TypeScript test for canonical plan-tool names.

## E2E tests

Extend `apps/web/e2e/tests/workflow/start-step-vs-auto-start-step.spec.ts`. Create a plan-mode task in the first step and wait for its first turn to finish.

Move the idle task into an empty automatic-start step. Wait for the asynchronous on-enter session write and a stable backend transcript/turn snapshot. Assert that the description appears in exactly one user message, no empty user row exists, and no additional turn was created.

Use backend state polling for session readiness. Use the transcript only for the final user-visible assertion.

## Work orders

- [x] [Task 01: Deduplicate empty workflow prompts](task-01-deduplicate-empty-workflow-prompts.md)
- [x] [Task 02: Correct plan-tool names](task-02-correct-plan-tool-names.md)
- [x] [Task 03: Prove the plan-mode workflow flow](task-03-prove-plan-mode-workflow-flow.md)

## Verification results

- Backend focused race suite: 18 tests passed after the PR fixup, including prompt-admission races, plan-only and attachment-only inputs, passthrough draining, and session-ID reuse cleanup.
- Backend full suite: all packages passed with the task-session internal
  configuration handoff variables cleared. The plain command was blocked by
  the inherited launcher-selected `/root/.kandev/config.yaml`, which made
  isolated config-discovery tests select the operator config.
- Backend `make lint`: 0 issues.
- Backend new-from-`origin/main` `golangci-lint`: no issues.
- Frontend focused hook suite: 27 tests passed.
- Frontend typecheck, targeted ESLint, i18n check, and i18n ratchet: passed.
- Frontend production build and targeted Playwright regression: passed.

## Risks

- A transcript scan can grow with session size. The implementation must use the bounded prompt counter.
- Suppression before queued-message merge can lose a handoff. The ACP path must merge first.
- A broad guard can suppress non-empty step prompts. The claim applies only to the empty `WorkflowStep.Prompt` fallback; non-empty prompts, including `{{task_prompt}}`, retain their existing semantics.
- A session-ID reuse can leak a prompt claim if the counter is not removed with the session. Delete the counter explicitly because the replay-safe table has no foreign key.
- The explicit workflow-step path also manages resume state. Prompt suppression must not change its existing lifecycle behavior.
