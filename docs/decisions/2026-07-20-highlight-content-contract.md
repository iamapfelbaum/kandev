# ADR-2026-07-20-highlight-content-contract: Repository-owned Highlight media contract

**Status:** accepted
**Date:** 2026-07-20
**Area:** docs, workflow, infra

## Context

Highlights are release content, but the repository must remain the reviewable
source of truth for their media, documentation relationship, provenance, and
publication state. A loose collection of videos cannot prove which source
commit produced a clip, whether a mobile claim is true, whether a file is
orphaned, or whether an old approval still applies to the current pull-request
head. A future landing publisher also needs stable paths and a bounded contract
without depending on Kandev application state.

## Decision

Store each Highlight in its own directory under
`docs/public/media/highlights/<id>/`. Its JSON descriptor is the entry point;
revision directories are immutable content units and carry desktop and, when
declared, native mobile WebM/MP4 and WebP assets. The descriptor includes
release, feature flags, docs ownership, active revision, source digest, and
capture provenance.

All media is checked with real `ffprobe` output plus byte counts and SHA-256
hashes. Validation rejects unsafe paths, orphan files, stale or mismatched
provenance, invalid docs ownership, unsupported media properties, bad mobile
declarations, and size-limit violations. Source digests are canonicalized over
the descriptor and revision content while lifecycle-derived fields are
excluded, so promotion and activation do not make a valid artifact drift.

Capture intent is a checked-in schema-v1 declarative scenario with exact
semantic locators, bounded timing, fixed desktop or native-mobile profiles, and
explicit sequential camera actions. Inline code is excluded; narrowly scoped
setup or story extensions are registered by primitive ID and caller allowlist.
The canonical scenario digest is independent of JSON key order.

Disposable outputs live outside the repository in a content-addressed stage.
Its manifest binds the scenario, raw capture, accepted QA report, delivery
bytes, source SHA, and provenance. Promotion verifies all of those inputs,
copies only delivery media plus the durable scenario and compact provenance,
validates a complete candidate catalog, then swaps it into place. Revision
collisions are refused; prior tracked revisions remain immutable.

Capture has two explicit modes. `pr_head` records from the exact pull-request
head and requires the descriptor, media, and SHA-pinned PR snippet to land in
that pull request. `current_main` records from freshly fetched `origin/main`
for deliberate backfills. Reusing a raw capture requires the source SHA to
match the selected mode's immutable source.

The PR gate is opt-in and recognizes only `highlight:required` and
`highlight:approved`. Unlabeled PRs are exempt unless they change Highlight
assets. Required Highlights run media, docs, link, QA, and freshness checks;
`highlight:approved` without `highlight:required` is invalid; and any new PR
head invalidates prior approval. Release state is queued until explicit
activation for the matching release, then history is append-only. Withdrawal
requires an explicit reason. There is no six-item cap.

## Consequences

- Reviewers can inspect the exact descriptor, media, source, and derived PR
  link in one PR.
- Consumers can fetch immutable revision paths without Kandev database state.
- CI catches media and provenance mistakes before publication or release
  activation.
- Maintainers must install/use `ffprobe` and keep capture provenance accurate.
- Raw masters and full QA artifacts remain recoverable staging data, not Git
  payload; checked-in revision history tracks exact promoted files and hashes.
- A Highlight change needs a new revision and digest; release activation and
  withdrawal add history rather than rewriting publication facts.
- The landing publisher and application remain separate consumers; this ADR
  intentionally does not define their UI or seen-state behavior.

## Alternatives considered

### A single shared media directory with a manifest

Rejected because ownership, orphan detection, and review scope become unclear,
and one file can accidentally be reused by unrelated Highlights.

### External object storage as the source of truth

Rejected because pull requests could not review the bytes, provenance would be
harder to reproduce, and offline/local validation would depend on a service.

### Mutable “latest” asset paths

Rejected because URLs and cached consumers could silently change after review.
Revision paths make content identity explicit.

### A required label on every pull request

Rejected because ordinary code PRs should remain exempt. The opt-in gate still
requires the label when a PR declares a Highlight or changes Highlight assets.

### Fixed six-item publication limit

Rejected because it encodes a presentation limit in the content contract and
  would make legitimate release history disappear from validation.
