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
2. Scaffold beside durable feature docs or another reviewed source location.
   Use the canonical executable story unchanged when evaluating the pipeline:

   ```bash
   node scripts/highlights.mjs scaffold ./quick-start.scenario.json --template quick-start
   ```

   The `quick-start` template has pinned identity and delivery metadata.
   `--template quick-start` does not accept `--id`, `--title`, or `--profile`;
   those flags cannot override the canonical fixture. For a general story, use
   the customizable scaffold instead:
   - `--template quick-start` with `--id` is rejected and cannot override ID.
   - `--template quick-start` with `--title` is rejected and cannot override title.
   - `--template quick-start` with `--profile` is rejected and cannot override profile.

   ```bash
   node scripts/highlights.mjs scaffold ./my-highlight.scenario.json --id my-highlight --title "My highlight" --profile desktop
   ```

3. Leave the canonical quick-start bytes unchanged. For a general scaffold,
   replace its placeholders using [authoring.md](references/authoring.md) and
   compare structure with
   `scripts/highlights/examples/quick-start.scenario.json`.
4. Validate and inspect the cheap timeline before recording:

   ```bash
   node scripts/highlights.mjs validate ./my-highlight.scenario.json --dry-run
   node scripts/highlights.mjs storyboard ./my-highlight.scenario.json --format markdown --dry-run
   ```

5. Prove the full execution plan without writing artifacts, then run it with a
   new artifact root outside every repository:

   ```bash
   node scripts/highlights.mjs run ./my-highlight.scenario.json --artifact-root /external/highlights --source pr_head --pr-number 123 --pr-base-sha <40-char-sha> --landing-root <landing-repo> --runtime kandev-isolated-e2e --dry-run
   node scripts/highlights.mjs run ./my-highlight.scenario.json --artifact-root /external/highlights --source pr_head --pr-number 123 --pr-base-sha <40-char-sha> --landing-root <landing-repo> --runtime kandev-isolated-e2e
   ```

   The default is the only closed runtime: `kandev-isolated-e2e`. Showing
   `--runtime kandev-isolated-e2e` makes that trust boundary explicit. It owns
   the registered seed, route, profiles, primitives, and scanner coverage in
   `scripts/highlights/runtime-catalog.mjs`. `--landing-root` selects the clean
   compatible landing checkout whose adapter owns camera compilation and
   encoding.

   `run` validates, storyboards, captures, renders, runs automatic QA, then
   writes a content-addressed technical review bundle with `review.json` under
   its manifest digest. Capture/render/QA
   prerequisites are real gates; missing Chrome, Xvfb, FFmpeg, landing adapter,
   or isolated runtime must fail with an actionable message.

6. Review contact sheet, keyframes, full playback, and QA report.
   Promotion stays separate. After explicit acceptance:

   ```bash
   node scripts/highlights.mjs promote /external/highlights/my-highlight/stages/<manifest-digest>/review.json --accept-reviewed-by reviewer-42 --dry-run
   node scripts/highlights.mjs promote /external/highlights/my-highlight/stages/<manifest-digest>/review.json --accept-reviewed-by reviewer-42
   ```

   `technical_pass` is never approval and is never promotable alone. The stable
   reviewer ID is recorded in descriptor and compact provenance. Promotion
   creates one immutable revision and refuses overwrite or revision collision.

   For a real native-mobile delivery, set `delivery.mobileRequired: true` in
   both desktop and native-mobile scenarios, capture them independently, then
   promote the desktop review with `--mobile-review <native-review.json>`. The
   pair must have the same semantic delivery, source, seed, tool, and landing
   identities. Promotion retains `scenario.json` and `scenario.mobile.json`;
   it never relabels a desktop capture as mobile.

## Individual Phases

Use these for recovery or focused diagnosis; do not change their order:

```bash
node scripts/highlights.mjs capture ./my-highlight.scenario.json --artifact-root /external/highlights --source pr_head --pr-number 123 --pr-base-sha <40-char-sha> --landing-root <landing-repo> --runtime kandev-isolated-e2e --dry-run
node scripts/highlights.mjs render ./my-highlight.scenario.json --artifact-root /external/highlights --landing-root <landing-repo> --run-id <run-id> --dry-run
node scripts/highlights.mjs qa ./my-highlight.scenario.json --artifact-root /external/highlights --landing-root <landing-repo> --run-id <run-id> --dry-run
node scripts/highlights.mjs stage ./my-highlight.scenario.json --artifact-root /external/highlights --run-id <run-id> --dry-run
```

`storyboard` always runs before expensive capture. Static `--dry-run` resolves
schema, timeline, profiles, source plan, runtime, run ID, exact paths, and planned
commands with zero writes. It does not build, reserve a run, record, encode,
stage, promote, or overwrite. Selector resolution and app-state checks occur in
the trusted runtime during real capture.

Use `--source pr_head` for feature work. It binds checked-out HEAD: it must match
the selected head SHA. Supply `--pr-number` and `--pr-base-sha` explicitly, or
allow exact `gh pr view` lookup. Use `--source current_main` only for deliberate
backfill from a clean checkout equal to freshly fetched `origin/main`. A new
capture gets a unique automatic run ID. Preserve the printed ID; use explicit
`--run-id` for render/QA/stage recovery and whenever more than one run exists.
A unique automatic run ID is printed; use `--run-id` to select recovery input.

## Hard Contracts

- Schema: `scripts/highlights/scenario.schema.json`; types:
  `scripts/highlights/scenario.d.ts`; checked example:
  `scripts/highlights/examples/quick-start.scenario.json`; executable E2E fixture:
  `apps/web/e2e/highlights/quick-start.scenario.json`.
- Runtime catalog: `scripts/highlights/runtime-catalog.mjs`. The canonical
  end-to-end integration/eval entry point is forthcoming as
  `pnpm e2e:highlight-pipeline`; app-local `e2e:highlight-capture` remains only
  a lower-level runtime contract test, not the production pipeline command.
- Stable selectors only: `testId`, or role plus exact accessible name. No CSS,
  XPath, coordinates, regex names, or arbitrary code.
- Default without camera directives is centered 1x identity: no zoom. Camera
  intent uses only `cameraFocus`, `cameraZoom`, `cameraHold`, and `cameraReturn`.
- Desktop and native mobile are separate product routes and captures. Declare
  pairing with `delivery.mobileRequired`; never make mobile by cropping desktop.
- External review stage keeps raw masters and QA outside repo. Only explicitly
  accepted delivery media, `scenario.json`, optional `scenario.mobile.json`,
  and compact `provenance.json` enter Git.
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
