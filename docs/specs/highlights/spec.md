---
status: building
created: 2026-07-20
owner: Kandev
---

# Highlights content contract

## Why

Product Highlights are small, release-linked demonstrations. They need to be
reviewable, reproducible, and safe to consume without a database or a bespoke
publisher. A checked-in contract lets Kandev and the landing publisher agree
on the same immutable media, provenance, release state, and review gate.

## What

- Every Highlight is one directory under `docs/public/media/highlights/<id>/`.
- The directory contains `highlight.json`, immutable revision directories, and
  optional append-only `published-history.json`.
- Each revision stores a desktop WebM/MP4 clip and WebP poster. If the
  descriptor declares mobile capability, it also stores native mobile clip and
  poster assets.
- The descriptor names the current revision, release version, feature flags,
  documentation owner, source commit, capture mode, and source digest.
- `pr_head` capture is tied to the exact pull-request head and keeps the
  descriptor, media, and SHA-pinned PR snippet in that PR. `current_main`
  capture is a deliberate backfill from freshly fetched `origin/main`.
- Validation uses `ffprobe` for codec, dimensions, FPS, duration, and audio;
  checks bytes and SHA-256 digests; rejects stale provenance, unsafe revision
  paths, orphan files, oversized assets, invalid docs ownership, and invalid
  mobile declarations.
- The optional PR gate recognizes only `highlight:required` and
  `highlight:approved`. Unlabeled PRs are exempt unless they change Highlight
  assets. Required Highlights need media, docs, link, QA, and freshness checks;
  approval without required is invalid, and approval is invalidated by a new
  PR head.
- Promotion computes and records the source digest. A queued Highlight becomes
  active only when explicitly activated for the matching release. Activation
  appends a publication event; withdrawal requires a reason and appends a
  withdrawal event. Published history is append-only and there is no six-item
  limit.
- Agents author one schema-v1 scenario containing a seed recipe, explicit
  pre-recording setup, fixed desktop or native-mobile profile, stable semantic
  targets, bounded actions/settles, and optional sequential camera intent.
- `scaffold`, scenario-aware `validate`, and `storyboard` run before expensive
  capture. Storyboards are deterministic Markdown or machine JSON and carry the
  canonical scenario digest.
- Capture/QA output is staged outside Git under its manifest digest. Explicit
  promotion requires accepted QA and exact scenario, raw-capture, report, and
  delivery hashes; it refuses revision collisions and validates before swap.
- Promoted revisions include only WebM/MP4/WebP, `scenario.json`, and compact
  `provenance.json`. Raw masters and full QA artifacts remain outside Git.

## Descriptor contract

`highlight.json` is JSON with this shape (additional fields are ignored only
when they do not weaken validation):

```json
{
  "schema_version": 1,
  "id": "my-highlight",
  "title": "Short title",
  "summary": "One sentence.",
  "caption": "What the viewer should notice.",
  "status": "queued",
  "release_version": "0.20.0",
  "feature_flags": ["features.example"],
  "qa_status": "accepted",
  "docs": { "page": "docs/public/features/example.md", "section": "Example" },
  "mobile": { "available": false, "declaration": "Desktop-only workflow" },
  "active_revision": "r1",
  "source_digest": "sha256:<64 hex characters>",
  "provenance": {
    "capture_mode": "pr_head",
    "source_sha": "<40 hex characters>",
    "captured_at": "2026-07-20T12:00:00Z",
    "seed_id": "seed-name",
    "seed_digest": "sha256:<64 hex characters>",
    "tool_version": "product-video-capture/1",
    "pr_number": 123,
    "pr_base_sha": "<40 hex characters>",
    "pr_head_sha": "<same 40-character SHA as source_sha>"
  }
}
```

Statuses are `queued`, `active`, `withdrawn`, or `docs_only`. A queued item is not
published. An active item must have a matching release activation event. A
withdrawn item retains its immutable revision and must carry an explicit
withdrawal reason.

`qa_status` must be `accepted` before a descriptor can pass validation. A
`pr_head` provenance record must include PR number/base/head and its head SHA
must equal `source_sha`. A `current_main` record must name `origin/main` as its
source reference.

## Media rules

The active revision path is immutable in meaning: assets live below
`revisions/<revision>/` and may not escape the Highlight directory. Desktop
media is always required. Declarative production capture uses 1920x1200;
legacy 960x600 docs backfills remain valid for migration. Mobile media is required exactly when
`mobile.available` is true. Clips are 1–15 seconds, 25 FPS, silent, and use
VP9/H.264 video; posters are WebP. Each asset is at most 25 MiB and each
Highlight is at most 100 MiB. The validator rejects files in the Highlight
directory that are not part of the descriptor, revision, or history contract.

## Tooling

The repository tools are executable in CI and locally:

```bash
node scripts/highlights.mjs scaffold ./my-highlight.scenario.json --id my-highlight
node scripts/highlights.mjs validate ./my-highlight.scenario.json
node scripts/highlights.mjs storyboard ./my-highlight.scenario.json --dry-run
node scripts/highlights.mjs promote /external/stages/<digest>/stage.json --dry-run
node scripts/highlights.mjs promote /external/stages/<digest>/stage.json
node scripts/validate-highlights.mjs
node scripts/highlight-source-digest.mjs docs/public/media/highlights/my-highlight
node scripts/promote-highlight.mjs docs/public/media/highlights/my-highlight
node scripts/activate-highlight.mjs docs/public/media/highlights/my-highlight 0.20.0
node scripts/activate-highlights-release.mjs 0.20.0
node scripts/highlight-pr-snippet.mjs docs/public/media/highlights/my-highlight <40-char-sha>
```

`validate-public-docs.mjs` also validates the Highlights tree when present.
The opt-in GitHub workflow runs the PR gate on pull-request label and head
changes. Release tooling never rewrites prior history entries.

## Out of scope

This contract does not implement app UI, backend seen state, landing-site
publication, Playwright execution, camera rendering, ffmpeg QA, or pilot
Highlight videos. Those consumers read the checked-in contracts and own their
presentation or runtime state separately.
