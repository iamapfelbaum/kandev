# Kandev Highlights media

Each Highlight owns one directory: `<id>/highlight.json` plus immutable media
under `<id>/revisions/<revision>/`. The descriptor is the source of truth for
docs ownership, release state, feature flags, explicit review acceptance, capture provenance,
mobile declaration, and SHA-256/byte records for every delivery.

Run the contract locally from the Kandev repository:

```bash
# Author and inspect a deterministic declarative story.
node scripts/highlights.mjs scaffold ./quick-start.scenario.json --template quick-start
node scripts/highlights.mjs scaffold ./my-highlight.scenario.json --id my-highlight --title "My highlight" --profile desktop
node scripts/highlights.mjs validate ./my-highlight.scenario.json --dry-run
node scripts/highlights.mjs storyboard ./my-highlight.scenario.json --format markdown --dry-run

# Recover individual phases or run the fixed pipeline into external staging.
node scripts/highlights.mjs capture ./my-highlight.scenario.json --artifact-root /external/highlights --source pr_head --pr-number 123 --pr-base-sha <40-char-sha> --landing-root <landing-repo> --runtime kandev-isolated-e2e --dry-run
node scripts/highlights.mjs run ./my-highlight.scenario.json --artifact-root /external/highlights --source pr_head --pr-number 123 --pr-base-sha <40-char-sha> --landing-root <landing-repo> --runtime kandev-isolated-e2e
node scripts/highlights.mjs render ./my-highlight.scenario.json --artifact-root /external/highlights --landing-root <landing-repo> --run-id <run-id>
node scripts/highlights.mjs qa ./my-highlight.scenario.json --artifact-root /external/highlights --landing-root <landing-repo> --run-id <run-id>
node scripts/highlights.mjs stage ./my-highlight.scenario.json --artifact-root /external/highlights --run-id <run-id>

# Validate the checked-in delivery catalog and inspect lifecycle digests.
node scripts/highlights.mjs validate
node scripts/highlights.mjs digest docs/public/media/highlights/<id>
node scripts/highlights.mjs promote /external/highlights/<id>/stages/<manifest-digest>/review.json --accept-reviewed-by reviewer-42 --dry-run
node scripts/highlights.mjs promote /external/highlights/<id>/stages/<manifest-digest>/review.json --accept-reviewed-by reviewer-42
node scripts/activate-highlights-release.mjs 0.20.0
```

`--template quick-start` is canonical and does not accept `--id`, `--title`, or
`--profile`; those flags cannot override its pinned executable identity. Use the
separate `--id` scaffold for customization. `kandev-isolated-e2e` is the only
closed runtime and the default; its exact allowlist is
`scripts/highlights/runtime-catalog.mjs`. The explicit flag above makes the
trust boundary reviewable. The forthcoming repository integration/eval command
is `pnpm e2e:highlight-pipeline`; app-local `e2e:highlight-capture` remains a
lower-level runtime fixture test.

Scenario v1 permits only stable `testId` or exact `role` + accessible-name
targets. Setup and extension primitives require an explicit caller allowlist;
inline shell, JavaScript, CSS, and XPath are not part of the contract. Desktop
uses the 1920x1200/DPR2 profile. Native mobile uses 430x932/DPR3 and is captured
with real mobile/touch context to native 1290x2796 source/delivery, never a
desktop crop. Camera starts at 1x with no zoom and changes only through
sequential focus, zoom, hold, and return actions. Camera and cursor remain
independent; the landing adapter owns camera compilation and encoding.

`--dry-run` performs zero writes and prints the selected runtime/source plan,
unique run ID, prerequisites, commands, and exact external paths. Real capture
creates:

```text
<artifact-root>/
├── runtime-builds/<run-id>/
├── runtime-host/<run-id>/
└── <id>/
    ├── runs/<run-id>/{evidence,capture,render,qa}/
    └── stages/<manifest-digest>/review.json
```

Render, QA, and stage resume the same successful capture with `--run-id`.
Multiple attempts require explicit run selection. A capture retry uses a new run
ID, preserving the failed host and teardown evidence.

Capture, raw masters, QA reports, and contact sheets remain in an external
content-addressed review stage. `technical_pass` in `review.json` is not human
approval and is never promotable. Normal CLI promotion accepts only the exact
`kandev-highlight-review-stage-v2` contract; legacy stage input has no CLI
route. Promotion requires `--accept-reviewed-by`,
then verifies the review, scenario, raw-capture digest, QA report, and delivery
bytes before a copy-validate-swap transaction. Only WebM/MP4/WebP deliveries,
`scenario.json`, optional `scenario.mobile.json`, and compact `provenance.json`
enter an immutable revision. Existing revision names are never overwritten.

Automatic QA checks schema/selectors/timing, media dimensions/FPS/audio/codec/
faststart, pointer and target-glyph containment, bounded camera motion and
settles, exact hashes/bytes, keyframes/contact sheet, and browser playback. The
closed runtime's sensitive scan truthfully declares `metadata: true`,
`visibleDomText: true`, `browserConsole: true`, `runtimeLogs: false`, and
`renderedPixelOcr: false`. Human review is required. Raw DOM, console/runtime
logs, masters, and QA stay external; compact provenance stores only bound
coverage, results, and evidence digests.

For paired native-mobile media, set `delivery.mobileRequired: true` in both
native scenarios and pass `--mobile-review <native-review.json>`. The pair must
share semantic delivery/source/seed/tool/landing identity. Promotion preserves
both per-form scenario/capture/QA/review provenance and never relabels desktop
media as mobile.

`run` order is fixed: validate, storyboard, capture, render, automatic QA, then
content-addressed stage. Missing capture prerequisites fail; command does not
silently substitute a crop, stale bundle, untrusted selector, or custom script.
Review generated keyframes, contact sheet, full browser playback, and technical
QA report before supplying the stable reviewer acceptance ID.

Use `pr_head` for feature work. Reserve `current_main` for deliberate backfill
from a clean checkout proven equal to freshly fetched `origin/main`. `pr_head`
binds checked-out HEAD to the selected head SHA and requires exact PR number/base
metadata (supplied flags or matching `gh pr view`).

`queued` entries become `active` only when their declared `release_version`
matches the release being activated. Withdrawal requires a reason and appends
an event to that Highlight's `published-history.json`; history is never
rewritten or capped.

Use `_scaffold/highlight.json` only for migrating older hand-authored delivery
directories. New declarative captures should let stage promotion build and hash
the descriptor. The scaffold directory is ignored and must never be published.

For full authoring, troubleshooting, and old-pilot migration guidance, see
`docs/specs/highlights/authoring.md` and
`.agents/skills/feature-highlight/references/`.
