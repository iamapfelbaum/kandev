---
id: "01-enable-coarse-pointer-terminal-scrolling"
title: "Enable coarse-pointer terminal scrolling"
status: done
wave: 1
depends_on: []
plan: "plan.md"
requirements:
  - REQ-UI-TERMINAL-TOUCH-SCROLLING-001
acceptance_criteria:
  - AC-UI-TERMINAL-TOUCH-SCROLLING-001.1
  - AC-UI-TERMINAL-TOUCH-SCROLLING-001.2
  - AC-UI-TERMINAL-TOUCH-SCROLLING-001.3
  - AC-UI-TERMINAL-TOUCH-SCROLLING-001.4
  - AC-UI-TERMINAL-TOUCH-SCROLLING-001.5
system_design:
  - ../../specs/ui/system-design/terminal-touch-scrolling.md
---

# Task 01: Enable Coarse-Pointer Terminal Scrolling

## Summary

Add red evidence for the coarse-pointer TUI path. Then activate the current touch-scroll handler from pointer precision instead of viewport width.

## In scope

- Add component tests for touch-scroll activation in `PassthroughToolbar`.
- Add a trusted-touch TUI regression at an 820-pixel coarse-pointer viewport.
- Keep document scroll position fixed during the terminal gesture.
- Change the toolbar activation rule to `!isFinePointer`.
- Keep existing gesture, xterm, transport, and layout behavior.

## Out of scope

- Replace or redesign `attachTouchScroll`.
- Add touch inertia or terminal selection features.
- Change Quick Chat terminal behavior.
- Change application layout or terminal transport.

## Acceptance

- Before the correction, the new coarse-pointer E2E test fails because `viewportY` does not change.
- After the correction, trusted touch input moves TUI scrollback and does not move the document.
- Fine-pointer terminal paths do not activate the custom touch-scroll handler.

## Verification

The E2E command must fail for the documented reason before the production change.

```bash
cd apps/web && pnpm e2e:run --project mobile-chrome tests/terminal/mobile-terminal-scroll.spec.ts -- --retries=0
```

After the production change, run these commands.

```bash
cd apps/web && pnpm exec vitest run components/task/passthrough-toolbar.test.tsx lib/terminal/touch-scroll.test.ts
```

```bash
cd apps/web && pnpm exec eslint components/task/passthrough-toolbar.tsx components/task/passthrough-toolbar.test.tsx e2e/tests/terminal/mobile-terminal-scroll.spec.ts
```

```bash
cd apps/web && pnpm run typecheck
```

```bash
cd apps/web && pnpm e2e:run --project mobile-chrome tests/terminal/mobile-terminal-scroll.spec.ts -- --retries=0
```

## Files likely touched

- `apps/web/components/task/passthrough-toolbar.tsx`
- `apps/web/components/task/passthrough-toolbar.test.tsx`
- `apps/web/e2e/tests/terminal/mobile-terminal-scroll.spec.ts`

## Dependencies

None.

## Risks

- The mobile E2E file can contain both phone and tablet-width touch flows. Each flow must target its visible terminal.
- The browser cannot emulate iOS Safari pull-to-refresh. The test proves the shared handler and document-scroll contract in Chromium.

## Parallelism

`sequential`

## Inputs

- `REQ-UI-TERMINAL-TOUCH-SCROLLING-001`
- `docs/specs/ui/system-design/terminal-touch-scrolling.md`
- GitHub issues 2808 and 1035.
- PR 1046 and the current touch-scroll implementation.

## Results

- RED unit evidence: the coarse-pointer toolbar test failed before the production change because `enableTouchScroll` was `false`.
- RED browser evidence: the trusted-touch 820-pixel coarse-pointer flow failed before the production change because `viewportY` stayed at `172` after the downward swipe.
- GREEN focused tests: `pnpm exec vitest run components/task/passthrough-toolbar.test.tsx lib/terminal/touch-scroll.test.ts` passed with 2 files and 41 tests.
- Focused lint: `pnpm exec eslint components/task/passthrough-toolbar.tsx components/task/passthrough-toolbar.test.tsx e2e/tests/terminal/mobile-terminal-scroll.spec.ts` passed.
- Frontend typecheck: `pnpm run typecheck` passed.
- GREEN browser regression: `pnpm e2e:run --project mobile-chrome tests/terminal/mobile-terminal-scroll.spec.ts -- --retries=0` passed with 1 test. The managed run built the production web bundle and verified trusted touch scrollback movement with stable document scroll.
