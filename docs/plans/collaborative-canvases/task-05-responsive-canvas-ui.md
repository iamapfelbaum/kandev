---
id: "05-responsive-canvas-ui"
title: "Responsive canvas UI"
status: complete
wave: 5
depends_on:
  - "04-agent-canvas-tools"
plan: "plan.md"
requirements:
  - REQ-CANVASES-COLLABORATIVE-CANVASES-001
  - REQ-CANVASES-COLLABORATIVE-CANVASES-002
  - REQ-CANVASES-COLLABORATIVE-CANVASES-004
  - REQ-CANVASES-COLLABORATIVE-CANVASES-005
  - REQ-CANVASES-COLLABORATIVE-CANVASES-006
  - REQ-CANVASES-COLLABORATIVE-CANVASES-009
  - REQ-CANVASES-COLLABORATIVE-CANVASES-010
acceptance_criteria:
  - AC-CANVASES-COLLABORATIVE-CANVASES-001.3
  - AC-CANVASES-COLLABORATIVE-CANVASES-001.4
  - AC-CANVASES-COLLABORATIVE-CANVASES-002.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-004.3
  - AC-CANVASES-COLLABORATIVE-CANVASES-005.3
  - AC-CANVASES-COLLABORATIVE-CANVASES-006.2
  - AC-CANVASES-COLLABORATIVE-CANVASES-006.3
  - AC-CANVASES-COLLABORATIVE-CANVASES-009.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-009.2
  - AC-CANVASES-COLLABORATIVE-CANVASES-009.3
  - AC-CANVASES-COLLABORATIVE-CANVASES-009.4
  - AC-CANVASES-COLLABORATIVE-CANVASES-009.5
  - AC-CANVASES-COLLABORATIVE-CANVASES-010.2
system_design:
  - ../../specs/canvases/system-design/collaborative-canvases.md
---

# Task 05: Responsive canvas UI

## Summary

Deliver the workspace settings page, folded sidebar section, creation flow,
Dockview panel, and native phone route. All surfaces use one domain state.

## In scope

- Add the `canvases` workspace settings tab and settings tree row.
- Add `/settings/workspaces/:workspaceId/canvases` and `/canvases/:canvasId`.
- Add a folded sidebar section with count, rows, and settings shortcut.
- Keep New canvas and Import canvas off the sidebar.
- Put New canvas and Import on the workspace page with translated dialogs.
- Add search, archive, export, import, and task links to that page.
- Add the canvas API, store slice, WebSocket handler, and hooks.
- Add native renderers for all version 1 blocks.
- Register the first-party canvas Dockview panel.
- Add a direct `h-dvh` phone route and inset action drawer.
- Use one Kanban column, 44-pixel targets, safe areas, and one scroll owner on
  phones.
- Add copy in every required locale.

## Out of scope

- Collaborator controls, invitation routes, presence, templates, and Dockview
  on phones.

## Acceptance

- Sidebar, workspace page, direct route, and Dockview open the same canvas.
- The sidebar follows the Automations section pattern and has no action rows.
- Import preview does not show content before complete validation.
- The phone path contains every required canvas action without page overflow.

## Verification

```bash
cd apps && pnpm --filter @kandev/web test -- components/canvas lib/state/slices/canvas lib/ws/handlers/canvas lib/navigation
cd apps/web && pnpm run typecheck
cd apps/web && pnpm run lint
cd apps/web && pnpm run i18n:check && pnpm run i18n:ratchet
```

## Files likely touched

- `apps/web/lib/settings/workspace-settings-tabs.ts`
- settings menu branch and workspace page routing
- `apps/web/components/app-sidebar/sections/canvases-section.tsx`
- desktop sidebar and mobile navigation components
- `apps/web/src/spa-routes.tsx`
- `apps/web/lib/state/slices/canvas/**`
- `apps/web/lib/api/domains/canvas-api.ts`
- `apps/web/lib/ws/handlers/canvas.ts`
- `apps/web/hooks/domains/canvas/**`
- `apps/web/components/canvas/**`
- `apps/web/components/task/dockview-*.tsx`
- `apps/web/src/locales/**`

## Dependencies

- Tasks 01 through 04 provide every server and agent contract.

## Risks

- A responsive wrapper can hide Dockview instead of avoiding its phone mount.

## Parallelism

`sequential`

## Inputs

- Desktop information architecture, import interaction, and mobile contract.
- Current Automations, Integrations, Dockview, and mobile picker patterns.

## Results

Completed on 2026-08-26.

- Added workspace canvas settings, translated create/import dialogs, search,
  rename, export, archive, remove, and task-link management.
- Added the folded sidebar section, direct route, Dockview panel, API/hooks,
  safe block rendering, and localized copy in all required catalogs.
- Frontend focused tests, typecheck, full lint, and i18n checks passed.
- Desktop and Pixel 5 browser flows passed, including touch-target and
  single-scroll-owner assertions.
