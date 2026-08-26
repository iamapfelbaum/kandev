---
created: 2026-08-25
updated: 2026-08-26
status: complete
requirements:
  - REQ-CANVASES-COLLABORATIVE-CANVASES-001
  - REQ-CANVASES-COLLABORATIVE-CANVASES-002
  - REQ-CANVASES-COLLABORATIVE-CANVASES-003
  - REQ-CANVASES-COLLABORATIVE-CANVASES-004
  - REQ-CANVASES-COLLABORATIVE-CANVASES-005
  - REQ-CANVASES-COLLABORATIVE-CANVASES-006
  - REQ-CANVASES-COLLABORATIVE-CANVASES-007
  - REQ-CANVASES-COLLABORATIVE-CANVASES-008
  - REQ-CANVASES-COLLABORATIVE-CANVASES-009
  - REQ-CANVASES-COLLABORATIVE-CANVASES-010
  - REQ-CANVASES-COLLABORATIVE-CANVASES-011
system_design:
  - ../../specs/canvases/system-design/collaborative-canvases.md
legacy_specs: []
---

# Implementation Plan: Portable canvases

## Overview

Implement a workspace-scoped owner canvas with task links, agent actions, live
owner updates, native desktop and mobile surfaces, and portable snapshot files.

Build the storage and command boundary first. Add live delivery next. Add the
portable codec before agent and UI adapters. Finish with focused browser
evidence.

## Scope

### In scope

- One owner and one workspace for each canvas.
- Many-to-many canvas and task links.
- Native Markdown, checklist, Kanban, metrics, and timeline blocks.
- Human and agent actions through one command service.
- Ordered WebSocket updates for the owner.
- Single-file `.kandev-canvas` export and atomic import.
- A folded Canvases sidebar section modeled on Automations and Integrations.
- A workspace Canvases settings page for management and portability.
- Canvas creation from workspace settings or a task.
- A first-party canvas Dockview panel.
- A full-height native mobile route.

### Out of scope

- Local collaborators, roles, invitations, shared links, and presence.
- Live cross-instance sharing or federation.
- Import merge, update, or synchronization.
- Templates, executable UI, remote pages, and plugin block types.
- Agent export, import, unlink, archive, or remove actions.
- New canvas or Import canvas actions in the sidebar.

## Technical approach

### Canvas domain

Add `apps/backend/internal/canvas/` with workspace-scoped migrations,
repository, block registry, command service, owner access, task links, leases,
receipts, compaction, HTTP routes, and content-free metrics.

### Live protocol

Add owner-authorized canvas subscriptions to
`apps/backend/internal/gateway/websocket/`. Publish committed agent and human
events. Replay retained events or return a complete snapshot.

### Portable files

Add one deterministic codec for `application/vnd.kandev.canvas+json`. Export
only the current portable snapshot. Import validates the full file before it
creates new canvas and block identifiers.

### Agent tools

Add list, create, get, and action tools to Task and Office MCP profiles. Task
agents use linked canvases. Office agents use canvases in their trusted user
context.

### Web surfaces

Add `canvases` to `WORKSPACE_SETTINGS_TABS` and the settings tree. Add the
workspace route `/settings/workspaces/:workspaceId/canvases`. Add
`/canvases/:canvasId` for the focused editor.

Add a folded `CanvasesSection` beside Automations and Integrations. Its header
links to workspace settings. Its rows open canvases. It has no create or import
action.

Reuse one canvas store, API domain, WebSocket handler, and command hooks in the
workspace page, direct route, and Dockview view.

### Mobile contract

Use `task-layout.tsx` for full-height ownership. Use
`mobile-picker-sheet.tsx` for block and canvas actions. Use
`kanban-with-preview.tsx` for direct focused navigation.

The phone workspace page uses vertical cards and visible New canvas and Import
actions. The editor route uses `h-dvh`, one scroll owner, safe-area padding,
and 44-pixel targets. It does not mount Dockview.

## Tests

- `apps/backend/internal/canvas/*_test.go` covers migrations, actions, task
  links, owner access, leases, compaction, export, and atomic import.
- Gateway tests cover owner authorization, ordered delivery, replay, snapshot
  recovery, and socket lease cleanup.
- MCP tests cover trusted context, linked task scope, schemas, and excluded
  actions.
- Frontend tests cover the workspace settings catalog, folded sidebar, creation,
  import preview, recovery, conflicts, Dockview, and mobile wrappers.

Every focused test records its applicable `AC-*` identifier when the file path
does not make the mapping clear.

## E2E tests

- `apps/web/e2e/tests/canvas/portable-canvas.spec.ts` covers workspace settings,
  sidebar rows, task links, agent changes, export, repeated import, and
  Dockview in Chromium.
- `apps/web/e2e/tests/canvas/mobile-portable-canvas.spec.ts` covers import,
  mobile capability, touch targets, and viewport containment in
  `mobile-chrome`.
- Backend integration tests cover malformed import, denied ownership, restart,
  compaction, and recovery criteria that do not need browser geometry.

## Work orders

- [x] [Task 01: Canvas domain](task-01-canvas-domain.md)
- [x] [Task 02: Live canvas protocol](task-02-live-canvas-protocol.md)
- [x] [Task 03: Portable canvas files](task-03-portable-canvas-files.md)
- [x] [Task 04: Agent canvas tools](task-04-agent-canvas-tools.md)
- [x] [Task 05: Responsive canvas UI](task-05-responsive-canvas-ui.md)
- [x] [Task 06: Canvas acceptance evidence](task-06-canvas-acceptance-evidence.md)

Execution is sequential in the primary conversation. This plan does not
authorize implementation subagents.

## Verification results

Completed on 2026-08-26.

- Backend canvas, gateway, MCP, backend application, and prompt tests passed:
  1,628 tests across six packages. The canvas package passed seven tests in a
  standalone run.
- Frontend canvas API, block utilities, SPA routing, and WebSocket tests passed:
  four files and 18 tests.
- Web typecheck, full web lint, i18n checks, targeted E2E sleep lint, and
  `git diff --check` passed.
- The rebuilt desktop Chromium flow passed two tests. The rebuilt mobile Chrome
  flow passed one test. The final capture runs passed the same desktop and
  mobile paths and produced two desktop plus two mobile screenshots.
- The repository-wide `lint:e2e-sleeps` command still reports 187 existing
  errors and 297 warnings in unrelated files. The two new canvas specs pass the
  standalone sleep rule configuration.

## Risks

- Stale writers can overwrite data if the service omits item preconditions.
- A gateway topic can leak state if it omits the owner access callback.
- An export can leak identity or task data if it reuses database models.
- An import can leave partial state if validation occurs inside incremental
  writes.
- File versions can become incompatible without strict registry tests.
- A desktop Dockview composition can become unusable on phones if the mobile
  route mounts it.
- Agent tool descriptions can increase prompt size without instruction budgets.
- Settings navigation can omit Canvases if the workspace catalog and menu tree
  do not use one shared tab entry.
