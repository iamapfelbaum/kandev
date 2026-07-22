# Troubleshooting

Preserve failed external stage and read phase-specific error. Fix declared
intent or runtime source; never patch delivery bytes or provenance after QA.

## Selector Errors

- `target resolved to 0 elements`: inspect current UI, route, seed, and wait.
  Replace stale selector with durable `testId` or role plus exact accessible
  name; do not add CSS/XPath fallback.
- `target resolved to multiple elements`: choose narrower existing semantic
  identifier or improve product accessibility/test ID in normal application
  code. Revalidate and storyboard.
- selector appears only on desktop: author native-mobile actions against native
  sheet/navigation. Never replay desktop coordinates.

## Timing Errors

- `planned duration ... exceeds 15000ms`: remove dead work through deterministic
  state/waits or split story. Do not speed-ramp.
- wait timeout: verify seed invariant and target state. `timeoutMs` is only a
  failure bound and adds no storyboard hold.
- `waitForVisible`/`waitForState` deterministic timing overrun: make seeded
  state resolve immediately. Use explicit `pause` or `settleMs` when viewers
  should see a hold; do not inflate assertion timeout.
- opening/ending settle failure: use at least 400ms and ensure UI, camera, and
  cursor are motionless for full interval.
- trusted pointer cadence failure: reduce capture load or use measured recorder
  capacity. Do not interpolate metadata over stepped recorded pixels.

## Camera Errors

- unexpected zoom: delete camera directives. Default is centered 1x identity.
- zoom cap/depth reversal/zoom-rate failure: lower explicit depth, lengthen move,
  or remove needless depth change. Desktop cap 1.5x; mobile cap 1.18x.
- camera jerk, pan velocity, or acceleration failure: reduce semantic targets,
  extend camera move beyond 1.2 seconds, add stable hold, or return after subject.
- pointer/glyph containment failure: widen crop, increase safe margin, preserve
  full dialog/sheet, or adjust cursor glyph orientation. Never hide product UI.
- camera moves with jitter while cursor travels: camera and cursor are
  independent. Focus semantic target and keep stable working zoom.

## FFmpeg And Media Errors

- `ffmpeg`/`ffprobe` missing: install required executable and rerun dry-run.
- wrong dimensions/FPS/audio/codec: fix selected profile or landing adapter;
  never transcode a wrong desktop crop into mobile.
- missing MP4 faststart: use shared landing encoder, not custom flags.
- duplicate/drop/cadence failure: recorder lacks exact-profile realtime
  capacity. Lower system load or change tested capture codec; recapture raw.

## Browser QA Errors

- WebM works but MP4 fails: inspect browser log, MIME, H.264 probe, and complete
  file hash. Both sources must pass.
- poster mismatch: choose settled pointer-free poster from same delivery timeline
  and rerun configured browser checks.
- player crops controls: reject `cover` behavior; verify actual responsive source
  and native mobile selection.

## Source Gate And Stage Errors

- `current_main requires HEAD ... to equal origin/main`: fetch, build clean
  detached `origin/main`, and rerun deliberate backfill. Feature-PR capture uses
  `pr_head`; do not relabel stale SHA.
- dirty source or landing worktree: preserve unrelated changes and use clean
  checkout. Do not hide changes with shared excludes.
- artifact root inside repository: choose new external root.
- scenario/capture/report/stage digest mismatch: restore exact staged inputs or
  rerun affected phase. Do not edit manifest hash.
- promotion collision: choose next immutable revision only after verifying ID and
  accepted stage. Never overwrite accepted revision.
