# Migrating Bespoke Highlight Work

Migration removes scripts, not evidence. Do not recapture merely for migration.
First inventory old story, source SHA, seed proof, raw hash, pointer metadata,
camera config, deliveries, QA, and accepted revision.

| Old artifact | Declarative replacement |
| --- | --- |
| Hand-written Playwright action script | `story.actions` using click/type/press/hover/moveCursor/wait/drag/pause |
| Setup clicks and ad hoc API calls | registered `seed.recipe` plus allowlisted `setup.primitives` before RECORD |
| Raw CSS/XPath/coordinate lookup | stable `testId`, or role plus exact accessible name |
| Hand-authored camera JSON and keyframe iterations | sequential `cameraFocus`, `cameraZoom`, `cameraHold`, `cameraReturn` |
| Per-pilot camera implementation | shared landing `scripts/product-loop-highlight.mjs` adapter |
| Separate encoder scripts and FFmpeg flags | shared landing adapter render contract |
| Manual keyframes and contact sheets | automatic QA keyframes, contact sheets, and configured browser playback |
| Manual asset promotion/copy | content-addressed technical `review.json`, explicit `--accept-reviewed-by`, then collision-refusing `promote` |

## Reuse Or Recapture

Reuse an approved clean raw when only framing, poster, or pacing changes and its
source digest, source SHA, seed, native profile, continuous 1x capture, semantic
cursor ledger, sensitive-data scan, and technical QA still satisfy current
contract. Rebuild scenario to describe existing story, verify digest mapping,
then render and QA through shared adapter.

Recapture when visible data, feature behavior, source build, route, viewport,
native form factor, story action, selector target, cursor journey, or seed state
changes; also recapture when raw provenance or required semantic metadata is
missing. Never crop desktop raw into mobile or invent metadata after fact.

Preserve old accepted revision. Promote migrated delivery as a new immutable
revision only after side-by-side review, technical QA, and explicit reviewer
acceptance. `technical_pass` alone is never promotable. For native mobile, use a
separate native scenario/review and `--mobile-review`; never relabel old desktop
bytes. Migration itself does not authorize activation, withdrawal, asset
deletion, overwrite, or recapture.
