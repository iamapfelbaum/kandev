# Authoring A Highlight Scenario

Scenario is checked-in intent. Raw captures and QA remain disposable external
artifacts. Start from scaffold example
`scripts/highlights/examples/quick-start.scenario.json`;
validate against `scripts/highlights/scenario.schema.json` and use
`scripts/highlights/scenario.d.ts` when generating typed tooling.
Executable integration fixture is
`apps/web/e2e/highlights/quick-start.scenario.json`, exercised by
`cd apps/web && pnpm e2e:highlight-capture`.

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

| Kind | Intent | Key fields |
| --- | --- | --- |
| `click` | Smooth cursor arrival, then trusted activation | `target`, optional `button`, `clickCount`, `cursorDurationMs`, `settleMs` |
| `type` | Focus by real input, optionally clear, then type | `target`, `text`, `clear`, `keystrokeDelayMs` |
| `press` | Press key on semantic target | `target`, `key` |
| `hover` | Smooth trusted pointer travel and hover | `target`, `durationMs` |
| `moveCursor` | Move pointer without activation | `target`, `durationMs`, `easing` |
| `waitForVisible` | Wait for visible target | `target`, `timeoutMs` |
| `waitForState` | Wait for attached/detached/visible/hidden/enabled/disabled/checked/unchecked | `target`, `state`, `timeoutMs` |
| `drag` | Smooth approach and real drag between targets | `from`, `to`, `approachDurationMs`, `durationMs` |
| `pause` | Readable source hold | `durationMs` |
| `cameraFocus` | Pan to semantic target at current depth | `target`, `durationMs` |
| `cameraZoom` | Explicitly change depth around current focus | `zoom`, `durationMs` |
| `cameraHold` | Hold identical camera state | `durationMs` |
| `cameraReturn` | Return to centered 1x identity | `durationMs` |
| `extension` | Allowlisted narrow primitive | `primitiveId`, JSON `input` |

Prefer waits on visible/state conditions over guessed pauses. Use pause only for
viewer readability. Every pointer journey uses dense trusted input samples; a
click, hover, type focus, or drag cannot teleport directly to its target.

## Profiles

- Desktop: CSS viewport `1920x1200` DPR2; physical source `3840x2400` at 25 fps;
  delivery `1920x1200` at 25 fps.
- Native mobile: CSS viewport `430x932` DPR3 with `isMobile` and touch enabled;
  native source and delivery `1290x2796` at 25 fps.

Never create mobile by cropping desktop. Give mobile its own scenario when
native navigation, sheet, touch, or selector intent differs. Shared seed recipe
and copy are fine; actions must describe native surface.

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
`scripts/product-loop-highlight.mjs` adapter. Do not hand-author keyframes or
copy the landing camera implementation into Kandev.
