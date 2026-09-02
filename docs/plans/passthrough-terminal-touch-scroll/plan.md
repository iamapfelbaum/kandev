---
created: 2026-09-02
updated: 2026-09-02
status: done
requirements:
  - REQ-UI-TERMINAL-TOUCH-SCROLLING-001
system_design:
  - ../../specs/ui/system-design/terminal-touch-scrolling.md
legacy_specs: []
---

# Implementation Plan: Passthrough Terminal Touch Scroll

## Overview

The current touch-scroll handler works in the phone layout. Coarse-pointer layouts at 768 CSS pixels or more do not activate it.

This plan adds a failing coarse-pointer TUI regression. It then changes activation from a width rule to the existing pointer-capability rule.

## Scope

### In scope

- Enable passthrough TUI touch scrolling for coarse pointers at each viewport width.
- Keep the existing touch-scroll handler and gesture rules.
- Add component evidence for fine-pointer and coarse-pointer activation.
- Add trusted browser-touch evidence for the tablet task layout.

### Out of scope

- Replace the handler with an xterm addon or CSS event pass-through.
- Add momentum, inertia, or new selection behavior.
- Change the terminal buffer, transport, WebSocket, or layout.
- Change Quick Chat or non-`PassthroughTerminal` products.

## Technical approach

Update `PassthroughToolbar` to read `isFinePointer` from `useResponsiveBreakpoint`. Pass `!isFinePointer` to `enableTouchScroll`.

Extend the toolbar component test. Capture the terminal prop and cover fine-pointer and coarse-pointer results.

Extend `mobile-terminal-scroll.spec.ts` with the reported `cli_passthrough` path. Use an 820-pixel coarse-pointer viewport and trusted browser touch input.

The browser test must create more output than one xterm viewport. It must assert xterm movement and stable document scroll position.

## Tests

| Acceptance criterion | Evidence |
| --- | --- |
| `AC-UI-TERMINAL-TOUCH-SCROLLING-001.1` | The tablet TUI Playwright flow moves `viewportY` after trusted touch input. |
| `AC-UI-TERMINAL-TOUCH-SCROLLING-001.2` | Toolbar component tests cover pointer capability instead of viewport width. |
| `AC-UI-TERMINAL-TOUCH-SCROLLING-001.3` | The tablet TUI Playwright flow keeps document scroll position unchanged. |
| `AC-UI-TERMINAL-TOUCH-SCROLLING-001.4` | Existing `touch-scroll.test.ts` cases cover tap, multi-touch, and horizontal movement. |
| `AC-UI-TERMINAL-TOUCH-SCROLLING-001.5` | The toolbar component test keeps the handler disabled for a fine pointer. |

## E2E tests

`apps/web/e2e/tests/terminal/mobile-terminal-scroll.spec.ts` uses the `mobile-chrome` project. The added flow widens that touch context to 820 CSS pixels.

The flow creates a `cli_passthrough` TUI and produces 200 lines. It sends trusted touch input to the xterm canvas.

## Work orders

- [x] [Task 01: Enable coarse-pointer terminal scrolling](task-01-enable-coarse-pointer-terminal-scrolling.md) (`done`)

## Verification results

- RED unit evidence: the new coarse-pointer toolbar test failed before the production change because `enableTouchScroll` was `false`.
- RED browser evidence: the trusted-touch 820-pixel coarse-pointer flow failed before the production change because `viewportY` stayed at `172` after the downward swipe.
- `pnpm exec vitest run components/task/passthrough-toolbar.test.tsx lib/terminal/touch-scroll.test.ts`: passed, 2 files and 41 tests.
- `pnpm exec eslint components/task/passthrough-toolbar.tsx components/task/passthrough-toolbar.test.tsx e2e/tests/terminal/mobile-terminal-scroll.spec.ts`: passed.
- `pnpm run typecheck`: passed.
- `pnpm e2e:run --project mobile-chrome tests/terminal/mobile-terminal-scroll.spec.ts -- --retries=0`: passed, 1 test. The managed run built the production web bundle and verified trusted touch scrollback movement with stable document scroll.

## Risks

- Synthetic DOM touch events can hide browser gesture behavior. The E2E flow must use browser input.
- A width-based assertion can pass while pointer gating stays wrong. The tests must assert `(pointer: coarse)`.
- Headless Chromium cannot prove iOS Safari pull-to-refresh behavior. The application overscroll rule remains a device-level risk.
