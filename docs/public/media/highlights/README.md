# Kandev Highlights media

Each Highlight owns one directory: `<id>/highlight.json` plus immutable media
under `<id>/revisions/<revision>/`. The descriptor is the source of truth for
docs ownership, release state, feature flags, accepted QA, capture provenance,
mobile declaration, and SHA-256/byte records for every delivery.

Run the contract locally from the Kandev repository:

```bash
# Author and inspect a deterministic declarative story.
node scripts/highlights.mjs scaffold ./my-highlight.scenario.json --id my-highlight
node scripts/highlights.mjs validate ./my-highlight.scenario.json
node scripts/highlights.mjs storyboard ./my-highlight.scenario.json --format markdown --dry-run

# Validate the checked-in delivery catalog and inspect lifecycle digests.
node scripts/highlights.mjs validate
node scripts/highlights.mjs digest docs/public/media/highlights/<id>
node scripts/highlights.mjs promote /external/stages/<stage-digest>/stage.json --dry-run
node scripts/highlights.mjs promote /external/stages/<stage-digest>/stage.json
node scripts/activate-highlights-release.mjs 0.20.0
```

Scenario v1 permits only stable `testId` or exact `role` + accessible-name
targets. Setup and extension primitives require an explicit caller allowlist;
inline shell, JavaScript, CSS, and XPath are not part of the contract. Desktop
uses the 1920x1200/DPR2 profile. Native mobile uses 430x932/DPR3 and is captured
as a native surface, never a desktop crop. Camera starts at 1x and changes only
through sequential focus, zoom, hold, and return actions.

Capture, raw masters, QA reports, and contact sheets remain in an external
content-addressed stage. Promotion verifies the stage, accepted QA, scenario,
raw-capture digest, and delivery bytes before a copy-validate-swap transaction.
Only WebM/MP4/WebP deliveries, `scenario.json`, and compact `provenance.json`
enter an immutable revision. Existing revision names are never overwritten.

`queued` entries become `active` only when their declared `release_version`
matches the release being activated. Withdrawal requires a reason and appends
an event to that Highlight's `published-history.json`; history is never
rewritten or capped.

Use `_scaffold/highlight.json` only for migrating older hand-authored delivery
directories. New declarative captures should let stage promotion build and hash
the descriptor. The scaffold directory is ignored and must never be published.
