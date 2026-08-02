---
id: "02-fresh-status-acknowledgement"
title: "Acknowledge only fresh upstream status"
status: pending
wave: 2
depends_on: ["01-explicit-upstream-state"]
plan: "plan.md"
spec: "../../specs/platform/workspace-git-status.md"
---

# Task 02: Acknowledge only fresh upstream status

Carry remote-state freshness through the existing coalesced status observation so publishing a
best-effort status with carried counts cannot consume a push-sensitive upstream transition.

## Acceptance

- Public status methods and serialized payloads remain unchanged.
- A valid missing/no-upstream state and a successful remote count are fresh; a failed or malformed
  remote `rev-list` that carries prior counts is stale.
- `handleUpstreamOnlyChange` caches task 01's upstream value only after a status is both published
  and remote-state-fresh. Lock contention, observation failure, or stale carried counts retry on a
  later tick.
- Existing singleflight sharing, per-waiter cancellation, observation timeout, and tracker-stop
  behavior remain intact.

## TDD sequence

1. Add a helper test showing the same-HEAD carry-forward retains counts but reports stale.
2. Add an upstream-handler test whose observer publishes stale remote state once and fresh state
   on retry; record the expected pre-change failure because the first publication advances the
   cache.
3. Add the private observation/publication metadata and implement the acknowledgement gate.
4. Adapt existing status concurrency tests without weakening their observation-count or
   cancellation assertions.
5. Run the focused tests, then the complete process package under the race detector.

## Implementation

- Add a private `gitStatusObservation` containing `types.GitStatusUpdate` and
  `remoteStateFresh`; carry it through `gitStatusObserver` and the singleflight value.
- Keep `GetGitStatus`/`GetCurrentGitStatus` signatures unchanged by unwrapping the private result.
- Make the remote branch lookup use `rev-parse --verify --quiet --abbrev-ref`. Treat exit code 1
  as a fresh empty remote; propagate other errors so no status is published.
- Make `getRemoteAheadBehindCounts` return freshness. Empty `RemoteBranch` and successfully parsed
  counts are fresh; command errors or malformed output that invoke `carryRemoteAheadBehind` are
  stale.
- Return a private result from `updateGitStatus`/`tryUpdateGitStatus` separating publication from
  remote freshness. Only the upstream-only handler consumes both flags; preserve other handlers'
  existing best-effort behavior.

## Verification

```shell
cd apps/backend && go test -race ./internal/agentctl/server/process \
  -run 'Test(GetRemoteAheadBehindCounts|HandleUpstreamOnlyChange|WorkspaceTracker.*Status)' \
  -count=1
cd apps/backend && go test -race ./internal/agentctl/server/process -count=1
cd apps/backend && golangci-lint run ./internal/agentctl/server/process/... \
  --new-from-rev=origin/main --timeout=5m
```

## Files likely touched

- `apps/backend/internal/agentctl/server/process/workspace_git_status.go`
- `apps/backend/internal/agentctl/server/process/workspace_tracker.go`
- `apps/backend/internal/agentctl/server/process/workspace_git_poll.go`
- `apps/backend/internal/agentctl/server/process/workspace_git_status_test.go`
- `apps/backend/internal/agentctl/server/process/workspace_git_status_concurrency_test.go`
- `apps/backend/internal/agentctl/server/process/workspace_git_poll_test.go`

## Dependencies

Task 01 (`01-explicit-upstream-state`).

## Parallelism

`sequential`. It modifies and validates task 01's poller/tracker state.

## Inputs

- Spec: `docs/specs/platform/workspace-git-status.md`, remote-count retry requirements.
- Plan: `plan.md`, "Freshness-aware status publication and upstream acknowledgement."
- Existing carry-forward policy: `getRemoteAheadBehindCounts` and
  `carryRemoteAheadBehind` in `workspace_git_status.go`.
- Existing coalescing contract and test seam: `getGitStatus`, `gitStatusObserver`, and
  `workspace_git_status_concurrency_test.go`.

## Output contract

Report the private result shapes, how public contracts stayed unchanged, red/green test evidence,
files changed, commands and outcomes, blockers, and risks. Mark this task `in_progress` before
editing; on completion mark it `done`, fill `## Results`, tick task 02 in `plan.md`, and synchronize
the plan's verification results.

## Results

Pending.
