# Declarative Highlight authoring

Author one checked-in schema-v1 scenario, review its deterministic storyboard,
then run capture/render/QA into external staging. Promotion remains an explicit
reviewed operation.

## Start

```bash
node scripts/highlights.mjs scaffold ./my-highlight.scenario.json --id my-highlight --profile desktop
node scripts/highlights.mjs validate ./my-highlight.scenario.json --dry-run
node scripts/highlights.mjs storyboard ./my-highlight.scenario.json --format markdown --dry-run
node scripts/highlights.mjs run ./my-highlight.scenario.json --artifact-root /external/highlights/my-highlight --source pr_head --dry-run
node scripts/highlights.mjs run ./my-highlight.scenario.json --artifact-root /external/highlights/my-highlight --source pr_head
```

Schema and example:

- `scripts/highlights/scenario.schema.json`
- `scripts/highlights/scenario.d.ts`
- `scripts/highlights/examples/quick-start.scenario.json`
- `apps/web/e2e/highlights/quick-start.scenario.json` (executable integration fixture)

Use deterministic `seed.recipe`, allowlisted `setup.primitives`, and visible
`story.actions`. Every target is a stable `testId`, or role plus exact accessible
name. Arbitrary shell/JavaScript, CSS/XPath, raw coordinates, and regex names are
rejected.

Desktop is CSS 1920x1200 DPR2, source 3840x2400, delivery 1920x1200, 25 FPS.
Native mobile is CSS 430x932 DPR3 and native 1290x2796 source/delivery, 25 FPS.
Never crop desktop into mobile.

Set `delivery.mobileRequired: false` for desktop-only delivery. Set it to `true`
on both the desktop and separately authored native-mobile scenarios when native
mobile is promised. Omission defaults false on desktop and true on native mobile;
native mobile cannot explicitly declare false. Paired reviews must preserve the
same semantic delivery, source, seed, tool, and landing identities.

Native mobile rejects hover and middle/right click. Tap and drag use trusted
touch input. Use `pr_head` for feature work; `current_main` is deliberate clean
fetched-main backfill only.

Default camera is centered 1x with no zoom. Optional intent is sequential
`cameraFocus`, `cameraZoom`, `cameraHold`, and `cameraReturn`; cursor remains
independent. Desktop cap is 1.5x and mobile cap is 1.18x.

## Review and promote

Review automatic schema/selector/timing, media/codec/faststart, pointer/glyph,
camera-motion, settle, sensitive-data, keyframe/contact-sheet, browser playback,
hash, and byte evidence. Then:

```bash
node scripts/highlights.mjs promote /external/highlights/my-highlight/<id>/stages/<review-digest>/review.json --accept-reviewed-by reviewer-42 --dry-run
node scripts/highlights.mjs promote /external/highlights/my-highlight/<id>/stages/<review-digest>/review.json --accept-reviewed-by reviewer-42
```

`technical_pass` is not approval and never promotes without the stable reviewer
ID. When `mobileRequired` is true, add `--mobile-review <native-review.json>` to
both commands. Promotion refuses a missing or mismatched pair and never relabels
desktop media. Raw and full QA stay external; only immutable delivery media,
`scenario.json`, optional `scenario.mobile.json`, and compact `provenance.json`
enter revision.

## Failures

- Selector zero/multiple: inspect current UI and replace with one stable semantic
  target; never add CSS/XPath fallback.
- Timing/settle: fix deterministic state or bounded action timing; do not cut or
  speed-ramp.
- Camera jerk/zoom/containment: remove needless directive, lengthen motion, widen
  safely, or keep identity.
- FFmpeg/browser probe: repair prerequisite or shared adapter and rerun; do not
  bless incomplete formats.
- Source gate/digest: use clean eligible checkout or exact staged inputs; never
  rewrite hash.

Detailed agent workflow lives in `.agents/skills/feature-highlight/SKILL.md` and
its `references/`. Migration guide maps old Playwright/camera/encoder/promotion
artifacts. Do not recapture solely for migration: reuse a clean raw for framing,
poster, or pacing when source digest and required evidence still pass.
