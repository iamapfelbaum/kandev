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
creates recoverable attempts there and gives accepted candidate a
content-addressed stage directory keyed by manifest digest. External stage keeps
raw masters and QA reports together; failed attempts remain diagnosable without
dirtying Git.

Expected evidence includes scenario and capture digests, semantic cursor ledger,
camera plan/config, raw master, WebM/MP4/WebP delivery candidates, probes,
keyframes, contact sheet, browser playback records, full QA report,
commands, logs, hashes, and bytes. `stage.json` pins exact paths and digests.

Promotion copies only WebM, MP4, WebP deliveries, `scenario.json`, and compact
`provenance.json` into `docs/public/media/highlights/<id>/revisions/<revision>/`.
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

Technical pass is necessary, not approval. Reviewer watches full loop and checks
opening context, action legibility, cursor continuity, calm ending, native mobile
truthfulness, and absence of product/capture artifacts. Record acceptance in QA
report; do not edit `stage.json` to manufacture it.

## Immutable Promotion

Promotion is separate from capture and requires explicit acceptance:

```bash
node scripts/highlights.mjs promote /external/highlights/my-highlight/<stage-digest>/stage.json --dry-run
node scripts/highlights.mjs promote /external/highlights/my-highlight/<stage-digest>/stage.json
```

`promote --dry-run` re-reads every digest, accepted QA, destination, descriptor,
and revision collision while leaving repository unchanged. Real promotion uses
copy-validate-swap. It creates immutable revision once, refuses overwrite or
collision, validates catalog before swap, and leaves no partial destination on
failure.

Compact provenance records schema, source SHA/mode, scenario digest, capture
digest, QA report digest/status, stage digest, seed digest, tool version, and
timestamps. Descriptor asset records carry delivery hashes and bytes. Never
change either by hand.
