# Review, QA, And Promotion

## Cheap First

Run validation and storyboard before capture:

```bash
node scripts/highlights.mjs validate ./my-highlight.scenario.json --dry-run
node scripts/highlights.mjs storyboard ./my-highlight.scenario.json --format markdown --dry-run
node scripts/highlights.mjs run ./my-highlight.scenario.json --artifact-root /external/highlights/my-highlight --source pr_head --dry-run
```

Review story order, planned duration, seed/setup, exact profile, selector intent,
cursor journeys, default identity camera, explicit camera directives, output
paths, and source gate. Static dry-run does not promise live selector resolution;
runtime-backed rehearsal adds it when seeded app is available. Dry-run writes no
raw, delivery, QA, repository media, or descriptor.

## Content-Addressed Stage

Use a unique artifact root outside Kandev and landing repositories. Pipeline
creates recoverable attempts there and gives a technically passing candidate a
content-addressed review directory keyed by manifest digest. External stage keeps
raw masters and QA reports together; failed attempts remain diagnosable without
dirtying Git.

Expected evidence includes scenario and capture digests, semantic cursor ledger,
camera plan/config, raw master, WebM/MP4/WebP delivery candidates, probes,
keyframes, contact sheet, browser playback records, full QA report,
commands, logs, hashes, and bytes. `review.json` pins exact paths and digests,
records `technical_pass`, and remains `promotable: false`.

Promotion copies only WebM, MP4, WebP deliveries, `scenario.json`, optional
`scenario.mobile.json`, and compact `provenance.json` into
`docs/public/media/highlights/<id>/revisions/<revision>/`.
Raw masters, full QA, browser logs, and contact sheets stay external.

## Automatic QA Gate

`qa` must fail on any required check:

- schema, stable selectors, extension allowlists, timing bounds, and source gate;
- duration, constant 25 FPS, decoded dimensions, audio absence, codec, MP4
  faststart, exact bytes, and SHA-256;
- dense pointer cadence, full pointer-frame and target glyph containment;
- camera bounds, safe margin, pan velocity/acceleration, camera jerk, zoom-rate,
  depth reversal, motion direction, and opening/end settle;
- sensitive-data scan hooks for credentials, local paths, host identity, fixture
  markers, and unexpected provider copy;
- keyframes, contact sheet, complete normal-speed playback, and browser playback
  evidence for required delivery video formats;
- exact scenario, seed, source, landing, capture, report, stage, and delivery
  provenance.

`technical_pass` is necessary, not approval, and never permits promotion alone.
Reviewer watches full loop and checks
opening context, action legibility, cursor continuity, calm ending, native mobile
truthfulness, and absence of product/capture artifacts. Supply a stable reviewer
ID only after that review; do not edit `review.json` or its QA report to
manufacture acceptance.

## Immutable Promotion

Promotion is separate from capture and requires explicit acceptance:

```bash
node scripts/highlights.mjs promote /external/highlights/my-highlight/<id>/stages/<review-digest>/review.json --accept-reviewed-by reviewer-42 --dry-run
node scripts/highlights.mjs promote /external/highlights/my-highlight/<id>/stages/<review-digest>/review.json --accept-reviewed-by reviewer-42
```

The reviewer ID uses stable lowercase ID/email-safe characters, not a display
name. `promote --dry-run` re-reads every source, capture, QA, and asset digest
and validates acceptance and pairing without creating a destination or lock.
Real promotion uses copy-validate-swap. It creates an immutable revision once,
refuses overwrite or collision, validates catalog before swap, and leaves no
partial destination on failure. Legacy already-accepted `stage.json` manifests
remain readable, but new `run` output is always a non-promotable review bundle.

## Native-Mobile Pairing

Native mobile is a second native capture, never a desktop crop. Set
`delivery.mobileRequired: true` in the desktop scenario and its native-mobile
counterpart. Both scenarios use the same id, title, revision, delivery metadata,
seed, source identity, tool version, and landing adapter contract; their
profiles and native actions may differ. Capture each separately, then pass the
mobile review explicitly:

```bash
node scripts/highlights.mjs promote /external/highlights/desktop/<id>/stages/<desktop-digest>/review.json --mobile-review /external/highlights/mobile/<id>/stages/<mobile-digest>/review.json --accept-reviewed-by reviewer-42 --dry-run
node scripts/highlights.mjs promote /external/highlights/desktop/<id>/stages/<desktop-digest>/review.json --mobile-review /external/highlights/mobile/<id>/stages/<mobile-digest>/review.json --accept-reviewed-by reviewer-42
```

Promotion refuses a missing required mobile review, an unexpected mobile review,
any semantic/source/seed/landing mismatch, and any form relabel. Compact
provenance retains each form's scenario, capture, QA-report, source, seed, tool,
landing, and review digests plus the explicit acceptance record.

Compact provenance records schema, per-form source SHA/mode, scenario digest,
capture digest, technical QA report digest/status, review digest, seed digest,
tool/landing identity, and timestamps. Descriptor provenance mirrors these
records and the accepted reviewer/time. Asset records carry exact delivery
hashes and bytes. Never change any of them by hand.
