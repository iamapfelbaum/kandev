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

The current touch-scroll handler works in the phone layout. Coarse-pointer layouts at 768 CSS pixels or more do not activate it consistently across terminal callers.

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

Have `PassthroughTerminal` resolve touch activation from terminal mode, pointer precision, and the optional caller request. Shell terminals default to touch scrolling for coarse pointers, agent callers opt in, and fine pointers always disable the handler. Keep the toolbar's pointer-aware request and remove the mobile shell pane's unconditional override.

Extend the toolbar component test and add resolver coverage for shell defaults and fine-pointer protection. Capture the terminal prop and cover fine-pointer and coarse-pointer results.

Extend `mobile-terminal-scroll.spec.ts` with the reported `cli_passthrough` path. Use an 820-pixel coarse-pointer viewport and trusted browser touch input.

The browser test must create more output than one xterm viewport. It must assert xterm movement and stable document scroll position.

## Tests

| Acceptance criterion | Evidence |
| --- | --- |
| `AC-UI-TERMINAL-TOUCH-SCROLLING-001.1` | The tablet TUI Playwright flow moves `viewportY` after trusted touch input. |
| `AC-UI-TERMINAL-TOUCH-SCROLLING-001.2` | Toolbar and `PassthroughTerminal` resolver tests cover pointer capability instead of viewport width. |
| `AC-UI-TERMINAL-TOUCH-SCROLLING-001.3` | The tablet TUI Playwright flow keeps document scroll position unchanged. |
| `AC-UI-TERMINAL-TOUCH-SCROLLING-001.4` | Existing `touch-scroll.test.ts` cases cover tap, multi-touch, and horizontal movement. |
| `AC-UI-TERMINAL-TOUCH-SCROLLING-001.5` | The toolbar component test keeps the handler disabled for a fine pointer. |

## E2E tests

`apps/web/e2e/tests/terminal/mobile-terminal-scroll.spec.ts` uses the `mobile-chrome` project. The added flow widens that touch context to 820 CSS pixels.

The flow creates a `cli_passthrough` TUI and produces 200 lines. It sends trusted touch input to the xterm canvas.

## Files

- `apps/web/components/task/passthrough-terminal.tsx`
- `apps/web/components/task/use-passthrough-terminal.test.ts`
- `apps/web/components/task/mobile/mobile-terminal-pane.tsx`
- `apps/web/components/task/passthrough-toolbar.tsx`
- `apps/web/components/task/passthrough-toolbar.test.tsx`
- `apps/web/e2e/helpers/api-client.ts`
- `apps/web/e2e/helpers/api-client.test.ts`
- `apps/web/e2e/tests/terminal/mobile-terminal-scroll.spec.ts`

## Work orders

- [x] [Task 01: Enable coarse-pointer terminal scrolling](task-01-enable-coarse-pointer-terminal-scrolling.md) (`done`)

## Verification results

- RED unit evidence: the new coarse-pointer toolbar test failed before the production change because `enableTouchScroll` was `false`.
- RED browser evidence: the trusted-touch 820-pixel coarse-pointer flow failed before the production change because `viewportY` stayed at `172` after the downward swipe.
- `(cd apps/web && pnpm exec vitest run components/task/passthrough-toolbar.test.tsx lib/terminal/touch-scroll.test.ts)`: passed, 2 files and 41 tests.
- `(cd apps/web && pnpm exec eslint components/task/passthrough-toolbar.tsx components/task/passthrough-toolbar.test.tsx e2e/tests/terminal/mobile-terminal-scroll.spec.ts)`: passed.
- `(cd apps/web && pnpm run typecheck)`: passed.
- `(cd apps/web && pnpm e2e:run --project mobile-chrome tests/terminal/mobile-terminal-scroll.spec.ts -- --retries=0)`: passed, 1 test. The managed run built the production web bundle and verified trusted touch scrollback movement with stable document scroll.
- Fixup RED evidence: the new shell resolver tests failed before centralization because the resolver was missing, and the API helper test failed because `auto_approve` was omitted from the request body.
- Fixup GREEN evidence: `(cd apps/web && pnpm exec vitest run components/task/use-passthrough-terminal.test.ts e2e/helpers/api-client.test.ts components/task/passthrough-toolbar.test.tsx lib/terminal/touch-scroll.test.ts)`: passed, 4 files and 71 tests.
- Fixup lint: `(cd apps/web && pnpm exec eslint components/task/passthrough-terminal.tsx components/task/use-passthrough-terminal.test.ts components/task/mobile/mobile-terminal-pane.tsx e2e/helpers/api-client.ts e2e/helpers/api-client.test.ts e2e/tests/terminal/mobile-terminal-scroll.spec.ts components/task/passthrough-toolbar.tsx components/task/passthrough-toolbar.test.tsx)`: passed.
- Fixup typecheck: `(cd apps/web && pnpm run typecheck)`: passed.
- Fixup browser regression: `(cd apps/web && pnpm e2e:run --project mobile-chrome tests/terminal/mobile-terminal-scroll.spec.ts -- --retries=0)`: passed, 1 test after centralizing shell activation and preserving the agent flow.
- Specification lint: `python3 scripts/lint-spec-files.py --all`: passed.
- AC-UI-TERMINAL-TOUCH-SCROLLING-001.3 is verified for the Chromium trusted-touch flow. iOS Safari pull-to-refresh remains unverified in this Linux runner and is a device-level follow-up.

## Risks

- Synthetic DOM touch events can hide browser gesture behavior. The E2E flow must use browser input.
- A width-based assertion can pass while pointer gating stays wrong. The tests must assert `(pointer: coarse)`.
- Headless Chromium cannot prove iOS Safari pull-to-refresh behavior. The application overscroll rule remains a device-level risk.
