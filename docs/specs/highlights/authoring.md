# Declarative Highlight authoring

Author one checked-in schema-v1 scenario, inspect its deterministic storyboard,
then run trusted capture/render/QA into recoverable external staging. Promotion
is a separate human-reviewed operation.

## Scaffold

Use the pinned executable fixture for a smoke test or fresh-agent evaluation:

```bash
node scripts/highlights.mjs scaffold ./quick-start.scenario.json --template quick-start
```

The `quick-start` template is canonical. It does not accept `--id`, `--title`,
or `--profile`; those flags cannot override its identity, desktop profile, seed,
story, or delivery metadata. For a real feature, use the customizable scaffold:

```bash
node scripts/highlights.mjs scaffold ./my-highlight.scenario.json --id my-highlight --title "My highlight" --profile desktop
```

Checked contracts:

- schema: `scripts/highlights/scenario.schema.json`
- types: `scripts/highlights/scenario.d.ts`
- canonical example: `scripts/highlights/examples/quick-start.scenario.json`
- executable runtime fixture:
  `apps/web/e2e/highlights/quick-start.scenario.json`
- closed runtime catalog: `scripts/highlights/runtime-catalog.mjs`

The repository-level executable integration/eval command is
`pnpm --dir apps/web e2e:highlight-pipeline`. App-local
`e2e:highlight-capture` is a lower-level runtime contract test, not the
production authoring command.

## Validate and storyboard

```bash
node scripts/highlights.mjs validate ./my-highlight.scenario.json --dry-run
node scripts/highlights.mjs storyboard ./my-highlight.scenario.json --format markdown --dry-run
```

Review story order, expected duration, semantic selectors, cursor journeys,
camera intent, and opening/ending settle before paying for capture. `--dry-run`
performs zero writes. A `run --dry-run` also resolves runtime, source plan,
unique run ID, build/host paths, landing checkout, prerequisites, and phase order
without building, reserving directories, starting a process, capturing, rendering,
running QA, staging, or promoting.

Pointer duration fields describe visible motion. Machine storyboard events also
show `runtimeOverheadBudgetMs`: a fixed 1000ms per semantic pointer target
(2000ms for a two-target drag) that bounds target/glyph measurement and trusted
browser-input transport without making agents guess host latency. Unused budget
is absorbed before the next event; exceeding it fails at the action JSON pointer
instead of silently changing total video duration.

## Run the trusted pipeline

Feature-PR capture, with every trust choice explicit:

```bash
node scripts/highlights.mjs run ./my-highlight.scenario.json --artifact-root /external/highlights --source pr_head --pr-number 123 --pr-base-sha <40-char-sha> --landing-root <landing-repo> --runtime kandev-isolated-e2e --dry-run
node scripts/highlights.mjs run ./my-highlight.scenario.json --artifact-root /external/highlights --source pr_head --pr-number 123 --pr-base-sha <40-char-sha> --landing-root <landing-repo> --runtime kandev-isolated-e2e
```

`kandev-isolated-e2e` is the only closed runtime and therefore the default. Its
catalog allowlists profile, seed, route, setup/extension primitives, and scanner
coverage. Do not substitute an arbitrary Playwright host, seed callback, shell,
or JavaScript.

`pr_head` binds checked-out HEAD; it must match the selected head SHA. The PR
number and exact base SHA may be supplied as above or resolved by `gh pr view`,
but resolved PR head must equal source SHA. For deliberate backfill only, use
`--source current_main` from a clean checkout equal to freshly fetched
`origin/main`:

```bash
node scripts/highlights.mjs run ./my-highlight.scenario.json --artifact-root /external/highlights --source current_main --landing-root <landing-repo> --runtime kandev-isolated-e2e
```

`--landing-root <landing-repo>` identifies the clean compatible landing checkout.
Its `scripts/product-loop-highlight.mjs` adapter owns camera compilation and
encoding. A new capture receives a unique automatic run ID. Pass a new explicit
`--run-id` only when deterministic orchestration needs one; never reuse an
existing capture ID.

`run` executes validate, storyboard, capture, render, QA, then stage. Its exact
external tree is:

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

Raw masters, visible DOM/browser-console evidence, host logs, build/worker
receipts, render candidates, keyframes, contact sheet, browser proof, and full QA
remain here outside Git.

## Resume a captured run

Do not repeat a successful capture because a later phase failed. Use its printed
run ID:

```bash
node scripts/highlights.mjs render ./my-highlight.scenario.json --artifact-root /external/highlights --landing-root <landing-repo> --run-id <run-id>
node scripts/highlights.mjs qa ./my-highlight.scenario.json --artifact-root /external/highlights --landing-root <landing-repo> --run-id <run-id>
node scripts/highlights.mjs stage ./my-highlight.scenario.json --artifact-root /external/highlights --run-id <run-id>
```

Each failed phase reports an actionable next command. A single recoverable run
may be selected automatically; multiple runs require explicit `--run-id`.
Capture itself is immutable: a capture retry gets a fresh run ID and preserves
the failed attempt for diagnosis.

## Scenario and media contracts

Use deterministic `seed.recipe`, allowlisted `setup.primitives`, and visible
`story.actions`. Every target is a stable `testId`, or role plus exact accessible
name. Arbitrary shell/JavaScript, CSS/XPath, raw coordinates, and regex names are
rejected.

Desktop is the exact CSS `1920x1200` surface at DPR2, producing a `3840x2400`
25 FPS master and `1920x1200` 25 FPS delivery. Native mobile is a real mobile and
touch browser context at CSS `430x932` DPR3, producing native `1290x2796` 25 FPS
source and delivery. Never fake mobile by cropping desktop.

Set `delivery.mobileRequired: false` for desktop-only delivery. Set it to `true`
on both independently authored desktop and native-mobile scenarios when mobile
is promised. A pair keeps the same ID, title, revision, semantic delivery
metadata, source, seed, runtime/tool, and landing adapter identity. Profiles,
scenario digests, capture receipts, and native actions remain form-specific.

Without camera directives, camera stays centered 1x: no zoom. Optional intent is
sequential `cameraFocus`, `cameraZoom`, `cameraHold`, and `cameraReturn`. Camera
and cursor are independently controlled. Desktop zoom is bounded to 1.5x;
native mobile to 1.18x. QA enforces safe margins, target and pointer glyph
containment, pan velocity/acceleration/easing/jerk, zoom rate, and settled
opening/end frames. Prefer one stable working zoom; do not make the camera chase
cursor micro-motion.

## QA and human review

Automatic QA checks schema/selectors/timing, source/build/runtime binding,
duration/FPS/dimensions/audio/codecs/MP4 faststart, exact hashes and bytes,
pointer-frame and glyph containment, camera bounds/motion, opening/end settle,
keyframes, contact sheet, full normal-speed playback, and real-browser playback.

The closed runtime reports truthful sensitive-scan coverage:

| Surface            | Covered |
| ------------------ | ------- |
| `metadata`         | `true`  |
| `visibleDomText`   | `true`  |
| `browserConsole`   | `true`  |
| `runtimeLogs`      | `false` |
| `renderedPixelOcr` | `false` |

Runtime logs and OCR are not scanned, so human review is required. Raw DOM,
console/log evidence, masters, and QA remain external. Only compact provenance
with coverage/result/evidence digests can enter Git.

## Review and promote

The content-addressed stage writes
`<id>/stages/<manifest-digest>/review.json` with exact contract
`kandev-highlight-review-stage-v2`. `technical_pass` is never promotable: it is
technical evidence, not human acceptance. After watching the complete loop,
keyframes/contact sheet, and browser playback, supply a stable reviewer ID:

```bash
node scripts/highlights.mjs promote /external/highlights/<id>/stages/<manifest-digest>/review.json --accept-reviewed-by reviewer-42 --dry-run
node scripts/highlights.mjs promote /external/highlights/<id>/stages/<manifest-digest>/review.json --accept-reviewed-by reviewer-42
```

Normal CLI promote accepts only `kandev-highlight-review-stage-v2`; legacy stage
input has no CLI promotion route. `promote --dry-run` verifies bytes, hashes,
acceptance, pairing, and destination without writing. Real promotion uses an
immutable copy-validate-swap transaction and refuses every overwrite/collision.

When `mobileRequired` is true, add
`--mobile-review <native-review.json>` to both promotion commands. Missing,
unexpected, relabeled, or identity-mismatched native reviews fail. Only accepted
WebM/MP4/WebP, `scenario.json`, optional `scenario.mobile.json`, descriptor
metadata, and compact `provenance.json` enter the repository.

For actionable origin/popup, build/source, lock, host/retry/run-selection,
stage-tamper, sensitive-scan, camera/media, and mobile-pair failures, read
`.agents/skills/feature-highlight/references/troubleshooting.md`. The migration
guide maps bespoke seed/action/camera/encoder/promotion scripts to this pipeline
without forcing unnecessary recapture.
