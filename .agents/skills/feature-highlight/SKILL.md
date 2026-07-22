---
name: feature-highlight
description: Author, capture, render, QA, review, and immutably promote a short Kandev feature video from one checked-in schema-v1 scenario. Use for Highlights, release-linked product loops, deterministic short demos, native-mobile highlight media, or migration from bespoke capture/camera/encoder scripts.
---

# Feature Highlight

Use one declarative scenario as story source. Do not invent a Playwright script,
camera JSON, encoder wrapper, or promotion copy command.

## Fast Path

1. Invoke `/product-demo-seeding`. Pick a deterministic seed recipe and prove
   current source, isolation, reset, and teardown ownership.
2. Scaffold beside durable feature docs or another reviewed source location:

   ```bash
   node scripts/highlights.mjs scaffold ./my-highlight.scenario.json --id my-highlight --profile desktop
   ```

3. Replace placeholders using
   [authoring.md](references/authoring.md) and scaffold example
   `scripts/highlights/examples/quick-start.scenario.json`.
4. Validate and inspect the cheap timeline before recording:

   ```bash
   node scripts/highlights.mjs validate ./my-highlight.scenario.json --dry-run
   node scripts/highlights.mjs storyboard ./my-highlight.scenario.json --format markdown --dry-run
   ```

5. Prove the full execution plan without writing artifacts, then run it with a
   new artifact root outside every repository:

   ```bash
   node scripts/highlights.mjs run ./my-highlight.scenario.json --artifact-root /external/highlights/my-highlight --source pr_head --dry-run
   node scripts/highlights.mjs run ./my-highlight.scenario.json --artifact-root /external/highlights/my-highlight --source pr_head
   ```

   `run` validates, storyboards, captures, renders, runs automatic QA, then
   writes a content-addressed stage under its manifest digest. Capture/render/QA
   prerequisites are real gates; missing Chrome, Xvfb, FFmpeg, landing adapter,
   or isolated runtime must fail with an actionable message.

6. Review contact sheet, keyframes, full playback, and QA report.
   Promotion stays separate. After explicit acceptance:

   ```bash
   node scripts/highlights.mjs promote /external/highlights/my-highlight/<stage-digest>/stage.json --dry-run
   node scripts/highlights.mjs promote /external/highlights/my-highlight/<stage-digest>/stage.json
   ```

   Promotion requires accepted QA, creates one immutable revision, and refuses
   overwrite or revision collision.

## Individual Phases

Use these for recovery or focused diagnosis; do not change their order:

```bash
node scripts/highlights.mjs capture ./my-highlight.scenario.json --artifact-root /external/highlights/my-highlight --source pr_head --dry-run
node scripts/highlights.mjs render ./my-highlight.scenario.json --artifact-root /external/highlights/my-highlight --dry-run
node scripts/highlights.mjs qa ./my-highlight.scenario.json --artifact-root /external/highlights/my-highlight --dry-run
```

`storyboard` always runs before expensive capture. Static `--dry-run` resolves
schema, timeline, profiles, stage paths, and planned commands without recording,
encoding, promoting, or overwriting files. Selector resolution and app-state
checks occur only when a seeded app runtime is available to that dry run.

Use `--source pr_head` for feature work: exact clean PR head stays with scenario
and delivery changes. `--source current_main` is only a deliberate backfill from
a clean checkout proven equal to freshly fetched `origin/main`.

## Hard Contracts

- Schema: `scripts/highlights/scenario.schema.json`; types:
  `scripts/highlights/scenario.d.ts`; checked example:
  `scripts/highlights/examples/quick-start.scenario.json`; executable E2E fixture:
  `apps/web/e2e/highlights/quick-start.scenario.json`.
- Stable selectors only: `testId`, or role plus exact accessible name. No CSS,
  XPath, coordinates, regex names, or arbitrary code.
- Default without camera directives is centered 1x identity: no zoom. Camera
  intent uses only `cameraFocus`, `cameraZoom`, `cameraHold`, and `cameraReturn`.
- Desktop and native mobile are separate product routes and captures. Never
  make mobile by cropping desktop.
- External stage keeps raw masters and QA outside repo. Only accepted delivery
  media, `scenario.json`, and compact `provenance.json` enter Git.
- Source, scenario, seed, capture, report, stage, and delivery hashes must agree.
  Fail rather than repair provenance by hand.

Read progressively:

- [authoring.md](references/authoring.md): schema, actions, seed/setup, profiles,
  selectors, camera intent, timing.
- [review-and-promotion.md](references/review-and-promotion.md): staging,
  automatic QA, review, hashes, immutable promotion.
- [troubleshooting.md](references/troubleshooting.md): actionable failure paths.
- [migration.md](references/migration.md): move old bespoke pilots to this
  contract without unnecessary recapture.
