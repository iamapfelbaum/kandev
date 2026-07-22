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
- pointer action `overran planned slot`: inspect the machine storyboard's
  `runtimeOverheadBudgetMs`. This fixed bound already covers semantic
  bounds/glyph lookup and trusted-input transport; increasing
  `cursorDurationMs` lengthens visible motion but cannot repair additive browser
  overhead. Reduce host/capture contention and retry with a fresh run ID. If a
  clean supported host reproducibly exceeds the bound, change the shared timing
  contract with a failing test; do not add an untyped scenario delay.
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

## Runtime, Recovery, And Trust Errors

- origin mismatch or popup violation: capture must remain on the seeded app
  origin and must not open a popup. Fix the declared route/action or product
  flow; do not broaden navigation policy, inject a redirect, or crop evidence.
- build mismatch: preserve `runtime-builds/<run-id>` and compare its manifest
  with runtime request/capture receipts. Rebuild from the selected source; do
  not reuse an output directory from another checkout.
- source mismatch: stop. For `pr_head`, checked-out HEAD and selected PR head
  must match; for `current_main`, HEAD and freshly fetched `origin/main` must
  match. Never relabel the captured SHA.
- lock conflict: display/CDP coordinate locks are host-global across run roots.
  First verify the recorded PID and process-start token. Let owned teardown
  finish; the runtime reclaims only a proven-dead lock. Never delete another
  run's lock or kill an unowned process.
- Chromium `SingletonSocket` path failure: the runtime must use its serialized
  short worker temp lease; long retained artifact roots are supported. Inspect
  `result.json.runtimeTemp`. If `KANDEV_HIGHLIGHT_RUNTIME_TEMP_ROOT` is set, it
  must name a short, absolute, private, uid-owned directory outside repository
  and artifact roots. Never work around this with a symlink or by moving raw
  evidence into the repository.
- runtime temp verification/removal failure: preserve the worker temp root for
  forensics. A changed inode, lease digest, owner start token, or namespace mode
  is treated as tampering. Read `result.json.runtimeTemp.verification`: its
  typed `phase`/`code`, digest-only reason, and exact `preservedRoot` distinguish
  lease/namespace/cleanup tamper, a live process group, retained entries, and an
  ordinary release failure. Start a new run after resolving ownership instead
  of deleting the retained root by hand.
- Chromium network-policy mismatch or UDP escape: capture evidence must retain
  the fixed WebRTC non-proxied-UDP and QUIC switches, the Direct Sockets feature
  disable, and the pre-navigation immutable direct-transport constructor guard.
  The Docker eval also proves an OS-level `network=none` egress boundary. Do not
  drop a switch or init guard to make a local probe pass; fix the trusted runtime
  or browser version and rerun the real loopback STUN/WebTransport test.
- host failure: inspect `runtime-host/<run-id>/failure.json`, `result.json`, the
  bounded host log, worker result, and teardown receipt. Fix the first failed
  invariant before a capture retry; a capture retry always uses a new run ID.
- retry after capture succeeded: keep the run ID and execute the printed
  render/QA/stage recovery command. Do not recapture when only a downstream
  landing encoder, media probe, browser QA, or stage step failed.
- run selection failure: more than one attempt exists. Choose the intended
  immutable attempt with `--run-id <run-id>`; never guess by modification time.
- stage tamper failure: a path, byte count, digest, contract, or report changed
  after staging. Restore the exact external evidence or rerun the affected
  phase; do not edit `review.json` or recompute one field by hand.
- scan finding: inspect the redacted rule and covered source, remove the
  sensitive fixture/content at seed or product source, then recapture or rerun
  the required phase. Never suppress mandatory built-in rules.
- mobile mismatch: desktop and native-mobile reviews disagree on delivery,
  source, seed, runtime/tool, or landing identity. Rebuild the incorrect native
  form; never pair unrelated reviews or relabel desktop media.

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
