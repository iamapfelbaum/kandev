# Authoring A Highlight Scenario

Scenario is checked-in intent. Raw captures and QA remain disposable external
artifacts. For the exact canonical executable story, run:

```bash
node scripts/highlights.mjs scaffold ./quick-start.scenario.json --template quick-start
```

`--template quick-start` is canonical and cannot override identity or delivery
metadata. `--id`, `--title`, and `--profile` are rejected and not accepted with
that template, even when the supplied value would equal the canonical value.
Use the separate general scaffold for customization:

```bash
node scripts/highlights.mjs scaffold ./my-highlight.scenario.json --id my-highlight --title "My highlight" --profile desktop
```

The checked template is
`scripts/highlights/examples/quick-start.scenario.json`; validate against
`scripts/highlights/scenario.schema.json` and use
`scripts/highlights/scenario.d.ts` when generating typed tooling. Executable
runtime fixture is `apps/web/e2e/highlights/quick-start.scenario.json`.
The forthcoming canonical integration/eval command is
`pnpm e2e:highlight-pipeline`. App-local `e2e:highlight-capture` is a lower-level
runtime contract test, not the authoring or production pipeline entry point.

## Runtime And Source

`capture` and `run` default to the only closed runtime,
`kandev-isolated-e2e`. Pass `--runtime kandev-isolated-e2e` explicitly in
durable instructions. The allowlisted runtime, seed recipe, route, profiles,
primitives, and scanner coverage are checked in at
`scripts/highlights/runtime-catalog.mjs`; an unknown ID fails before capture.

Feature work uses `--source pr_head`. Its checked-out HEAD must match the
selected head SHA. Pass `--pr-number <number>` and
`--pr-base-sha <40-char-sha>`, or let the tool resolve the same values with
`gh pr view`; mismatched PR/head metadata fails. `--source current_main` is only
for deliberate backfill from a clean checkout equal to freshly fetched
`origin/main`.

Pass `--landing-root <landing-repo>` when the compatible checkout is not the
configured default. Every real capture gets a unique automatic run ID. An
explicit safe `--run-id` is useful for deterministic evaluation and is required
to select recovery input when an artifact root contains multiple runs.

## Top-Level Shape

```json
{
  "$schema": "./scripts/highlights/scenario.schema.json",
  "schemaVersion": 1,
  "id": "quick-start",
  "title": "Create a task",
  "profile": {
    "kind": "desktop",
    "viewport": { "width": 1920, "height": 1200 },
    "deviceScaleFactor": 2
  },
  "seed": {
    "recipe": "kandev.empty-workspace",
    "parameters": { "workspaceName": "Atlas" }
  },
  "setup": {
    "route": "workspace.board",
    "primitives": []
  },
  "story": {
    "openingSettleMs": 600,
    "actions": [
      {
        "kind": "click",
        "target": { "role": "button", "name": "New task" },
        "cursorDurationMs": 350,
        "settleMs": 300
      }
    ],
    "endingSettleMs": 700
  }
}
```

Keep story under 15 seconds. Opening and ending settles are each at least 400ms.
Generated storyboard carries canonical scenario digest and includes setup before
recording, every action duration, cursor control, camera control, and final hold.

Promotion scenarios also declare `delivery`. Set `mobileRequired: false` for a
desktop-only revision. Set it to `true` on both independently authored desktop
and native-mobile scenarios when the revision promises native mobile media:

```json
{
  "delivery": {
    "revision": "r1",
    "releaseVersion": "1.2.3",
    "summary": "One deterministic product story.",
    "caption": "Complete the workflow and hold the result.",
    "featureFlags": ["features.highlights"],
    "docs": { "page": "guide.md", "section": "My highlight" },
    "mobileDeclaration": "Feature has a native mobile surface.",
    "mobileRequired": true
  }
}
```

Omission remains backward-compatible: desktop defaults false and native-mobile
defaults true. A native-mobile scenario cannot declare false. Pairing never
changes either profile or substitutes cropped desktop media.

## Stable Semantic Targets

Every visible target is exactly one of:

```json
{ "testId": "task-title" }
```

```json
{ "role": "button", "name": "New task" }
```

Use `testId`, or role plus exact accessible name. Names are exact strings, not
regex. Prefer existing durable `data-testid` and ARIA semantics. Do not use CSS,
XPath, snapshot refs, text-position guesses, raw coordinates, or DOM structure.
Selector validation cannot prove runtime uniqueness, so rehearsal must resolve
each target to exactly one visible element and report candidate matches on error.

## Seed And Setup

`seed.recipe` selects a registered deterministic recipe. Parameters are plain
JSON. A recipe owns fixed IDs, timestamps, copy, ordering, provider fixtures,
state hash, reset, and teardown. Use `/product-demo-seeding` to define or choose
it; no live credentials, user database, or inherited app instance.

`setup.primitives` run before RECORD and are absent from video. Setup primitives
and story extension primitives require a caller-provided allowlist. Unknown
primitive IDs fail validation. No arbitrary or inline shell, JavaScript, JS,
CSS, or network callbacks are accepted. Add a narrow registered primitive with
typed JSON input and tests only when ordinary actions cannot express truthful
product setup.

## Actions

| Kind             | Intent                                                                                         | Key fields                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `click`          | Smooth cursor arrival, then trusted activation                                                 | `target`, optional `button`, `clickCount`, `cursorDurationMs`, `settleMs` |
| `type`           | Focus by real input, optionally clear, then type                                               | `target`, `text`, `clear`, `keystrokeDelayMs`                             |
| `press`          | Press key on semantic target                                                                   | `target`, `key`                                                           |
| `hover`          | Smooth trusted pointer travel and hover                                                        | `target`, `durationMs`                                                    |
| `moveCursor`     | Move pointer without activation                                                                | `target`, `durationMs`, `easing`                                          |
| `waitForVisible` | Zero-duration assertion that target is visible                                                 | `target`, failure-bound `timeoutMs`                                       |
| `waitForState`   | Zero-duration assertion of attached/detached/visible/hidden/enabled/disabled/checked/unchecked | `target`, `state`, failure-bound `timeoutMs`                              |
| `drag`           | Smooth approach and real drag between targets                                                  | `from`, `to`, `approachDurationMs`, `durationMs`                          |
| `pause`          | Readable source hold                                                                           | `durationMs`                                                              |
| `cameraFocus`    | Pan to semantic target at current depth                                                        | `target`, `durationMs`                                                    |
| `cameraZoom`     | Explicitly change depth around current focus                                                   | `zoom`, `durationMs`                                                      |
| `cameraHold`     | Hold identical camera state                                                                    | `durationMs`                                                              |
| `cameraReturn`   | Return to centered 1x identity                                                                 | `durationMs`                                                              |
| `extension`      | Allowlisted narrow primitive                                                                   | `primitiveId`, JSON `input`                                               |

Wait actions reserve `0ms` in storyboard. `timeoutMs` only caps assertion
failure; it never becomes recorded hold time. Seed state so waits resolve within
timing tolerance. Slow resolution fails as nondeterministic with action JSON
pointer. Use `pause` for viewer readability or `settleMs` for an intentional
post-action hold. Every pointer journey uses dense trusted input samples; a
click, hover, type focus, or drag cannot teleport directly to its target.

## Profiles

- Desktop: CSS viewport `1920x1200` DPR2; physical source `3840x2400` at 25 fps;
  delivery `1920x1200` at 25 fps.
- Native mobile: CSS viewport `430x932` DPR3 with `isMobile` and touch enabled;
  native source and delivery `1290x2796` at 25 fps.

Never create mobile by cropping desktop. Give mobile its own scenario when
native navigation, sheet, touch, or selector intent differs. Shared seed recipe
and copy are fine; actions must describe native surface. Paired scenarios keep
the same id/title, delivery metadata, seed identity, source revision, and landing
adapter contract; promotion preserves both scenario digests.

Native mobile has no hover and cannot request middle/right click. Activation is
trusted touch tap; drag uses trusted touch movement. Reject unsupported pointer
semantics instead of pretending mouse behavior on phone.

## Camera Intent

Without camera directives, default is centered 1x identity and no zoom. Add no
camera action merely to make timeline look cinematic. Use `cameraFocus` to name
semantic subject, `cameraZoom` only when explicit depth improves readability,
`cameraHold` for stable reading, then `cameraReturn` when identity is desired.

- Desktop maximum zoom cap is 1.5x; mobile maximum zoom cap is 1.18x.
- Every semantic camera move is at least 1.2 seconds (1,200ms).
- Every camera hold is at least 240ms.
- Opening and ending settle are each at least 400ms.
- Safe margin and target glyph containment are audited for every frame.
- Pan velocity, acceleration, easing, jerk, and zoom-rate stay bounded.
- Camera movement and cursor movement remain independently controllable. Camera
  never chases pointer micro-jitter or moves against active cursor travel.

The compiler emits sequential intent for landing's shared
`scripts/product-loop-highlight.mjs` adapter. The landing adapter owns both
camera compilation and encoding. Do not hand-author keyframes or copy its
camera/encoder implementation into Kandev.
