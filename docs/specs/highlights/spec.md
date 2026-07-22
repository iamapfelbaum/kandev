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
- Capture/QA output is staged outside Git under its technical `review.json`
  digest. `technical_pass` is never approval. Promotion requires an explicit
  stable reviewer ID plus exact scenario, raw-capture, report, and delivery
  hashes; it refuses revision collisions and validates before swap.
- Promoted revisions include only WebM/MP4/WebP, `scenario.json`, optional
  `scenario.mobile.json`, and compact `provenance.json`. Raw masters and full QA
  artifacts remain outside Git.

See [authoring.md](authoring.md) for scenario, CLI, review, troubleshooting, and
migration workflow. Agent instructions live in
`.agents/skills/feature-highlight/SKILL.md`.

## Declarative scenario contract

Schema v1 is defined by `scripts/highlights/scenario.schema.json`, typed in
`scripts/highlights/scenario.d.ts`, and exercised by
`scripts/highlights/examples/quick-start.scenario.json`. Executable capture
fixture lives at `apps/web/e2e/highlights/quick-start.scenario.json`. Schema
allows only JSON data, stable `testId` or role plus exact accessible-name
targets, registered seed recipes, allowlisted setup/extensions, bounded actions,
and sequential camera intent. Inline shell, JavaScript, CSS, XPath, raw
coordinates, and unregistered callbacks are outside contract.

No camera directive means centered 1x identity. `cameraFocus` pans at current
depth; `cameraZoom` is the only depth change; `cameraHold` preserves state;
`cameraReturn` restores identity. Camera and cursor timelines are independent.
Landing's `scripts/product-loop-highlight.mjs` owns tested keyframe generation,
motion audit, and encoding contracts; Kandev does not duplicate that engine.

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
legacy 960x600 docs backfills remain valid for migration. Mobile media is
required exactly when `mobile.available` is true. Clips are 1–15 seconds, 25
FPS, silent, and use
VP9/H.264 video; posters are WebP. Each asset is at most 25 MiB and each
Highlight is at most 100 MiB. The validator rejects files in the Highlight
directory that are not part of the descriptor, revision, or history contract.

Declarative desktop capture uses CSS 1920x1200 at DPR2, a 3840x2400 25 FPS raw
master, and 1920x1200 25 FPS delivery. Native mobile uses CSS 430x932 at DPR3
with real mobile/touch context and native 1290x2796 25 FPS source/delivery.
Mobile is never a crop of desktop. A desktop delivery sets
`delivery.mobileRequired: true` only when an independently captured matching
native-mobile scenario/review will be paired. Camera caps are 1.5x desktop and 1.18x
native mobile; opening/ending settles, safe margin, glyph containment, velocity,
acceleration, jerk, and zoom rate are validated.

## Media workflow

`run` executes validate, storyboard, capture, render, QA, then external stage in
that order. Storyboard and `--dry-run` are cheap gates before recording. Raw
masters, logs, keyframes, contact sheets, browser evidence, and full QA remain
under a content-addressed artifact root outside repository. `review.json` pins
scenario, source, seed, capture, report, review, and delivery hashes/bytes while
remaining non-promotable until explicit human acceptance.

Promotion is a separate explicit operation. It requires `--accept-reviewed-by`,
rechecks all bytes and digests, refuses existing revision/destination collisions,
copies to a temporary destination, validates catalog, and swaps only after
success. A required native-mobile form is passed with `--mobile-review`; pair
identity is exact and profiles are never relabeled. Only explicitly accepted
delivery media, scenarios, and compact provenance enter Git.

## Tooling

The stable CLI contract is:

```bash
node scripts/highlights.mjs scaffold ./my-highlight.scenario.json --id my-highlight
node scripts/highlights.mjs validate ./my-highlight.scenario.json --dry-run
node scripts/highlights.mjs storyboard ./my-highlight.scenario.json --dry-run
node scripts/highlights.mjs capture ./my-highlight.scenario.json --artifact-root /external/highlights/my-highlight --source pr_head --dry-run
node scripts/highlights.mjs render ./my-highlight.scenario.json --artifact-root /external/highlights/my-highlight --dry-run
node scripts/highlights.mjs qa ./my-highlight.scenario.json --artifact-root /external/highlights/my-highlight --dry-run
node scripts/highlights.mjs run ./my-highlight.scenario.json --artifact-root /external/highlights/my-highlight --source pr_head --dry-run
node scripts/highlights.mjs run ./my-highlight.scenario.json --artifact-root /external/highlights/my-highlight --source pr_head
node scripts/highlights.mjs promote /external/stages/<digest>/review.json --accept-reviewed-by reviewer-42 --dry-run
node scripts/highlights.mjs promote /external/stages/<digest>/review.json --accept-reviewed-by reviewer-42
# Add `--mobile-review /external/mobile-stages/<digest>/review.json` when mobileRequired is true.
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

## Implementation status

Content lifecycle, scenario schema/validation/storyboard, execution contracts,
landing adapter boundary, QA/staging contracts, and immutable promotion live in
checked-in modules under `scripts/highlights`. Runtime capture still depends on
a clean eligible Kandev source, isolated app fixture, Chrome/Xvfb, FFmpeg,
Playwright, and a clean compatible landing checkout. Documentation does not
assert a successful capture: each run must pass its source gate, dry-run,
executable integration/eval, automatic QA, and human review.

Use `pr_head` for feature-PR delivery. `current_main` exists only for deliberate
backfill from a clean checkout proven equal to freshly fetched `origin/main`.

## Out of scope

This utility does not implement Highlight browsing UI, backend seen-state,
landing-site publication, or pilot delivery videos. It does not permit arbitrary
scenario code or replace manual long-form filmmaking. Release activation and
consumer presentation remain separate lifecycle concerns.
