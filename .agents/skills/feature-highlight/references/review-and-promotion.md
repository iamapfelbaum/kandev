# Review, QA, And Promotion

## Cheap First

Run validation and storyboard before capture:

```bash
node scripts/highlights.mjs validate ./my-highlight.scenario.json --dry-run
node scripts/highlights.mjs storyboard ./my-highlight.scenario.json --format markdown --dry-run
node scripts/highlights.mjs run ./my-highlight.scenario.json --artifact-root /external/highlights --source pr_head --pr-number 123 --pr-base-sha <40-char-sha> --landing-root <landing-repo> --runtime kandev-isolated-e2e --dry-run
```

Review story order, planned duration, seed/setup, exact profile, selector intent,
cursor journeys, default identity camera, explicit camera directives, output
paths, source gate, and allocated run ID. `--dry-run` performs zero writes: it
does not build, reserve directories, capture, render, stage, or modify Git. Live
selector resolution happens only in the trusted runtime during real capture.

## Content-Addressed Stage

Use one artifact root outside Kandev and landing repositories. A capture gets a
unique automatic run ID; an explicitly supplied run ID must also be new. The
exact external tree is:

```text
<artifact-root>/
├── runtime-builds/<run-id>/
├── runtime-host/<run-id>/
└── <id>/
    ├── runs/<run-id>/
    │   ├── evidence/
    │   ├── capture/
    │   ├── render/
    │   └── qa/
    └── stages/<manifest-digest>/review.json
```

In path form those roots are `runtime-builds/<run-id>`,
`runtime-host/<run-id>`, `<id>/runs/<run-id>/evidence`,
`<id>/runs/<run-id>/capture`, `<id>/runs/<run-id>/render`,
`<id>/runs/<run-id>/qa`, and `<id>/stages/<manifest-digest>/review.json`.
The content-addressed `<id>/stages/<manifest-digest>/review.json` is keyed by
the stage manifest digest. Failed attempts remain diagnosable without dirtying
Git, and no phase overwrites an existing immutable file.

## Resume And Recover

Capture is not resumed in place. A capture retry uses a fresh run ID so the
failed run remains evidence. Once capture succeeds, resume the same attempt:

```bash
node scripts/highlights.mjs render ./my-highlight.scenario.json --artifact-root /external/highlights --landing-root <landing-repo> --run-id <run-id>
node scripts/highlights.mjs qa ./my-highlight.scenario.json --artifact-root /external/highlights --landing-root <landing-repo> --run-id <run-id>
node scripts/highlights.mjs stage ./my-highlight.scenario.json --artifact-root /external/highlights --run-id <run-id>
```

Each error prints an actionable next command. With one recoverable attempt the
phase may select it automatically; with multiple runs, run selection is
ambiguous and `--run-id` is required. Preserve a failed run or attempt until its
host, phase, and teardown evidence explains the failure.

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

Scanner coverage is truthful and bound to the closed runtime catalog:

| Surface            | Covered |
| ------------------ | ------- |
| `metadata`         | `true`  |
| `visibleDomText`   | `true`  |
| `browserConsole`   | `true`  |
| `runtimeLogs`      | `false` |
| `renderedPixelOcr` | `false` |

Raw visible DOM text and browser console logs remain outside Git in external
evidence. Runtime-host logs, masters, and full QA stay there too. OCR is not covered and
`renderedPixelOcr: false` means no pixel OCR claim is made. Compact provenance
stores scanner coverage, result status, and evidence digests only. A passing
scan is necessary; human review is mandatory and required because neither the
scanner nor browser probes can judge the complete visual story.

`technical_pass` is necessary, not approval, and never permits promotion alone.
Reviewer watches full loop and checks
opening context, action legibility, cursor continuity, calm ending, native mobile
truthfulness, and absence of product/capture artifacts. Supply a stable reviewer
ID only after that review; do not edit `review.json` or its QA report to
manufacture acceptance.

## Immutable Promotion

Promotion is separate from capture and requires explicit acceptance:

```bash
node scripts/highlights.mjs promote /external/highlights/<id>/stages/<manifest-digest>/review.json --accept-reviewed-by reviewer-42 --dry-run
node scripts/highlights.mjs promote /external/highlights/<id>/stages/<manifest-digest>/review.json --accept-reviewed-by reviewer-42
```

The reviewer ID uses stable lowercase ID/email-safe characters, not a display
name. `promote --dry-run` re-reads every source, capture, QA, and asset digest
and validates acceptance and pairing without creating a destination or lock.
Real promotion uses copy-validate-swap. It creates an immutable revision once,
refuses overwrite or collision, validates catalog before swap, and leaves no
partial destination on failure. Normal CLI promote only accepts the exact `kandev-highlight-review-stage-v2` contract.
Legacy accepted-stage-v1 data may
remain programmatically readable for migration, but legacy input has no CLI
promotion route and is never accepted by normal `promote`. New `run` output is
always a non-promotable review-stage-v2 bundle.

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
