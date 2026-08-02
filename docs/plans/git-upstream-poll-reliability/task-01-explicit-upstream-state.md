---
id: "01-explicit-upstream-state"
title: "Represent missing upstream refs explicitly"
status: pending
wave: 1
depends_on: []
plan: "plan.md"
spec: "../../specs/platform/workspace-git-status.md"
---

# Task 01: Represent missing upstream refs explicitly

Model the lightweight poller's upstream identity as explicit state so a configured but deleted
remote-tracking ref is observable without blocking all later Git polling.

## Acceptance

- The poll snapshot distinguishes no configured upstream, a resolved upstream with SHA, and a
  configured-but-missing upstream.
- A verified ref lookup exit code of 1 produces the missing state; cancellation, timeout, process
  failure, and every other exit code return an error and preserve the prior cached state.
- A resolved-to-missing transition is processed once, publishes loss of `RemoteBranch`, and later
  HEAD, branch, index, and upstream changes continue to be detected.

## TDD sequence

1. Replace `TestReadGitPollSnapshot_UpstreamLookupErrorPropagates` with a regression test expecting
   a successful explicit missing state; run it against the current code and record the expected
   failure.
2. Add a poll-tick test proving a missing upstream does not prevent a later index or HEAD change.
3. Implement the smallest explicit-state/classification change and rerun the targeted tests.
4. Add/retain a cancellation or non-exit-1 test proving transient failures still use the retry
   path rather than becoming a missing ref.

## Implementation

- In `workspace_git_poll.go`, introduce a private upstream snapshot value containing ref name,
  SHA, and state (`none`, `resolved`, `missing`). Parse the upstream name from porcelain as today.
- Resolve configured refs with a quiet verified `rev-parse`; use `errors.As` with
  `*exec.ExitError` and accept only exit code 1 as missing. Do not parse stderr text.
- In `workspace_tracker.go`, replace `cachedUpstreamSHA` with the complete upstream value.
- Update poll comparison, priming, and every handler cache write to use the complete value.
- Keep the existing Git-command timeout, throttle, and `GIT_OPTIONAL_LOCKS=0` path.

## Verification

```shell
cd apps/backend && go test -race ./internal/agentctl/server/process \
  -run 'Test(ReadGitPollSnapshot|GitPollTick_MissingUpstream|GetUpstreamSHA)' -count=1
```

## Files likely touched

- `apps/backend/internal/agentctl/server/process/workspace_git_poll.go`
- `apps/backend/internal/agentctl/server/process/workspace_tracker.go`
- `apps/backend/internal/agentctl/server/process/workspace_git_poll_test.go`

## Dependencies

None.

## Parallelism

`sequential`. Task 02 builds on the new upstream value and touches the same poller/tracker files.

## Inputs

- Spec: `docs/specs/platform/workspace-git-status.md`, upstream polling requirements and scenarios.
- Plan: `plan.md`, "Explicit upstream-ref state in the lightweight poll snapshot."
- Exit-code classification pattern:
  `apps/backend/internal/agentctl/server/process/git_log.go` (`GitOperator.IsAncestor`).
- Existing real-Git setup helpers in `workspace_git_poll_test.go`.

## Output contract

Report the state representation, exit-code handling, red/green test evidence, files changed,
commands and outcomes, blockers, and risks. Mark this task `in_progress` before editing; on
completion mark it `done`, fill `## Results`, tick task 01 in `plan.md`, and synchronize the plan's
verification results.

## Results

Pending.
