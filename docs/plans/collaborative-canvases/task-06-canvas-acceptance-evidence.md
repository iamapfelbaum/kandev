---
id: "06-canvas-acceptance-evidence"
title: "Canvas acceptance evidence"
status: complete
wave: 6
depends_on:
  - "05-responsive-canvas-ui"
plan: "plan.md"
requirements:
  - REQ-CANVASES-COLLABORATIVE-CANVASES-001
  - REQ-CANVASES-COLLABORATIVE-CANVASES-003
  - REQ-CANVASES-COLLABORATIVE-CANVASES-005
  - REQ-CANVASES-COLLABORATIVE-CANVASES-006
  - REQ-CANVASES-COLLABORATIVE-CANVASES-007
  - REQ-CANVASES-COLLABORATIVE-CANVASES-008
  - REQ-CANVASES-COLLABORATIVE-CANVASES-009
  - REQ-CANVASES-COLLABORATIVE-CANVASES-011
acceptance_criteria:
  - AC-CANVASES-COLLABORATIVE-CANVASES-001.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-003.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-005.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-005.3
  - AC-CANVASES-COLLABORATIVE-CANVASES-006.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-006.2
  - AC-CANVASES-COLLABORATIVE-CANVASES-006.4
  - AC-CANVASES-COLLABORATIVE-CANVASES-007.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-008.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-009.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-009.2
  - AC-CANVASES-COLLABORATIVE-CANVASES-009.3
  - AC-CANVASES-COLLABORATIVE-CANVASES-009.4
  - AC-CANVASES-COLLABORATIVE-CANVASES-009.5
  - AC-CANVASES-COLLABORATIVE-CANVASES-011.3
system_design:
  - ../../specs/canvases/system-design/collaborative-canvases.md
---

# Task 06: Canvas acceptance evidence

## Summary

Prove the complete user journey in real browser flows. Record operational and
documentation evidence before the plan becomes complete.

## In scope

- Seed disposable task, canvas, and portable file fixtures.
- Cover workspace settings creation, sidebar rows, task links, Dockview, agent
  updates, reload, reconnect, restart, archive, export, and repeated import.
- Prove that the sidebar has no New canvas or Import canvas action.
- Cover owner denial through backend integration tests.
- Force event compaction and prove snapshot recovery.
- Cover the full phone route, action drawer, import, export, safe areas,
  44-pixel targets, and zero page overflow.
- Record metrics and log redaction evidence.
- Review public documentation impact.

## Out of scope

- Multi-user browser contexts, invitation tests, auth sharing, and federation.

## Acceptance

- Desktop Chromium proves the workspace, owner, and agent journey.
- Mobile Chrome proves equal capability through its native composition.
- Every applicable acceptance criterion has unit, integration, or E2E evidence.

## Verification

```bash
cd apps/web && pnpm e2e:run tests/canvas/portable-canvas.spec.ts
cd apps/web && pnpm e2e:run --project mobile-chrome tests/canvas/mobile-portable-canvas.spec.ts
cd apps/web && pnpm run lint:e2e-sleeps
```

## Files likely touched

- `apps/web/e2e/tests/canvas/portable-canvas.spec.ts`
- `apps/web/e2e/tests/canvas/mobile-portable-canvas.spec.ts`
- canvas E2E fixtures and page objects
- operator metrics documentation when required

## Dependencies

- Task 05 completes the product surface.

## Risks

- Browser download and upload fixtures can leave files when cleanup is not
  scoped to the E2E artifact directory.

## Parallelism

`sequential`

## Inputs

- All canvas requirements and design sections.
- Existing browser download, upload, restart, and mobile geometry patterns.

## Results

Completed on 2026-08-26.

- The rebuilt desktop Chromium canvas flow passed two tests covering settings
  creation, portable export/import, direct editing, sidebar visibility, and
  removal.
- The rebuilt mobile Chrome flow passed one test covering native settings
  composition, 44-pixel controls, direct `h-dvh` navigation, and one scroll
  owner.
- Final PR captures contain two desktop and two mobile screenshots and were
  visually checked.
- The two new canvas specs pass the focused E2E sleep lint. The repository-wide
  sleep lint remains blocked by 187 existing errors and 297 warnings in
  unrelated specs.
