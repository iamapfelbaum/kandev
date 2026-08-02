---
spec: docs/specs/platform/workspace-git-status.md
created: 2026-08-02
status: draft
---

# Implementation Plan: Git Upstream Poll Reliability

## Overview

This repair makes upstream polling distinguish a configured-but-missing ref from a transient
Git failure, then carries remote-count freshness through the existing coalesced status
observation. The poller may continue publishing best-effort status for UI continuity, but it
only acknowledges an upstream transition after the upstream identity and remote counts are
fresh. There are no route, payload, persistence, frontend, or E2E changes.

**Confirmed root causes.** First, `getRemoteAheadBehindCounts` intentionally carries the prior
`RemoteAhead`/`RemoteBehind` values when `git rev-list` fails, while `updateGitStatus` reports
only that some status was published. `handleUpstreamOnlyChange` therefore advances the cached
upstream SHA even when the push-sensitive counts are stale, so no later tick retries the push.
Second, `readGitPollSnapshot` treats every failed `@{upstream}` lookup as a whole-snapshot
failure. When the configured remote-tracking ref is persistently missing, the repository health
probe succeeds and resets the failure counter on every tick, so `checkGitChanges` never runs and
unrelated HEAD/index changes remain unobserved.

The existing tests reproduce both underlying states on `main`:

- `TestCarryRemoteAheadBehind/same_head_preserves_counts` confirms that a failed remote count
  can deliberately retain stale values.
- `TestReadGitPollSnapshot_UpstreamLookupErrorPropagates` confirms that a configured but missing
  upstream currently rejects the complete snapshot.

---

## Backend

### Explicit upstream-ref state in the lightweight poll snapshot

Files:

- `apps/backend/internal/agentctl/server/process/workspace_git_poll.go`
- `apps/backend/internal/agentctl/server/process/workspace_tracker.go`

Replace the ambiguous cached upstream SHA string with a private value that records the upstream
name, SHA, and one of three states: not configured, resolved, or configured but missing. Resolve
a configured upstream with `git rev-parse --verify --quiet`; exit code 1 is the expected missing
ref state, following the existing `errors.As(*exec.ExitError)` classification pattern in
`GitOperator.IsAncestor`. Context cancellation, timeout/process termination, and all other exit
codes remain snapshot errors.

Compare and cache the complete upstream value rather than only its SHA. A transition from a
resolved ref to a missing ref is therefore observable once without becoming indistinguishable
from a branch that never had an upstream. Missing-ref snapshots continue through
`checkGitChanges`, allowing the status stream and every other Git-poll signal to progress.

### Freshness-aware status publication and upstream acknowledgement

Files:

- `apps/backend/internal/agentctl/server/process/workspace_git_status.go`
- `apps/backend/internal/agentctl/server/process/workspace_tracker.go`
- `apps/backend/internal/agentctl/server/process/workspace_git_poll.go`

Introduce a private `gitStatusObservation` result containing the existing
`types.GitStatusUpdate` plus `remoteStateFresh`. Carry that private result through the tracker-owned
singleflight observation and test observer. `GetGitStatus` and all API callers continue receiving
only `types.GitStatusUpdate`; no serialized contract changes.

Change the upstream-name lookup in `getGitBranchInfo` to use a quiet verified ref lookup. Exit
code 1 means a fresh, valid absence; any other lookup failure propagates and prevents publication.
Change `getRemoteAheadBehindCounts` to return whether it calculated or validly cleared the remote
counts. Carry-forward on a failed or malformed `rev-list` remains visible to ordinary status
consumers but marks the observation stale for upstream acknowledgement.

Return a private publication result from `updateGitStatus`/`tryUpdateGitStatus` that separates
"published" from "remote state fresh." `handleUpstreamOnlyChange` updates the cached upstream
value only when both are true. Lock contention, observation errors, and carried remote counts all
leave the transition pending for the next tick. Other poll handlers preserve their current
best-effort behavior.

---

## Tests

- **Configured but missing upstream is valid poll state.**
  File: `apps/backend/internal/agentctl/server/process/workspace_git_poll_test.go`.
  Replace the existing error-propagation expectation with a real repository test that deletes
  only the remote-tracking ref and asserts a successful snapshot with the explicit missing state.
  This regression test must fail before task 01 changes production code.
- **Missing upstream does not stall other polling.**
  File: `apps/backend/internal/agentctl/server/process/workspace_git_poll_test.go`.
  After deleting the remote-tracking ref, change the index or HEAD, run poll ticks, and assert the
  corresponding cached state/status advances while the remote branch is empty.
- **Transient upstream lookup still retries.**
  File: `apps/backend/internal/agentctl/server/process/workspace_git_poll_test.go`.
  Exercise cancellation or a non-exit-1 lookup failure and assert that the prior cached upstream
  state remains untouched.
- **Remote-count carry-forward is explicitly stale.**
  File: `apps/backend/internal/agentctl/server/process/workspace_git_status_test.go`.
  Point the count helper at an unresolved remote ref with the same HEAD and assert that it retains
  the prior counts while returning `remoteStateFresh=false`; valid 0/0 and successful counts return
  true.
- **Upstream-only change retries after a stale publication.**
  File: `apps/backend/internal/agentctl/server/process/workspace_git_poll_test.go`.
  Use the status-observer seam to return a published observation with stale remote counts on the
  first tick and fresh counts on the second. Assert the cached upstream value advances only after
  the second tick.
- **Singleflight and caller contract stay unchanged.**
  File: `apps/backend/internal/agentctl/server/process/workspace_git_status_concurrency_test.go`.
  Adapt the private observer result and retain the existing sharing, cancellation, timeout, and
  tracker-stop assertions.

No browser E2E is planned: the repaired behavior is an internal agentctl polling guarantee with
deterministic real-Git package coverage and no UI or protocol changes.

---

## Verification Results

Pending. Implementation tasks must record red/green evidence and exact command outcomes in their
`## Results` sections, then synchronize them here.

---

## Implementation Waves And Parallel Candidates

Sequential execution in the primary conversation:

```text
Wave 1:
- [ ] [task-01-explicit-upstream-state](task-01-explicit-upstream-state.md)

Wave 2:
- [ ] [task-02-fresh-status-acknowledgement](task-02-fresh-status-acknowledgement.md)
```

Task 02 depends on task 01 and both touch the poller/tracker internals. Neither task is
parallel-safe, and the plan does not authorize subagents.

## Open Questions

None.
