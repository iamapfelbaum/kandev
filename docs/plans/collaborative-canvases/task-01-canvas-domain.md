---
id: "01-canvas-domain"
title: "Canvas domain"
status: complete
wave: 1
depends_on: []
plan: "plan.md"
requirements:
  - REQ-CANVASES-COLLABORATIVE-CANVASES-001
  - REQ-CANVASES-COLLABORATIVE-CANVASES-002
  - REQ-CANVASES-COLLABORATIVE-CANVASES-003
  - REQ-CANVASES-COLLABORATIVE-CANVASES-004
  - REQ-CANVASES-COLLABORATIVE-CANVASES-007
  - REQ-CANVASES-COLLABORATIVE-CANVASES-010
  - REQ-CANVASES-COLLABORATIVE-CANVASES-011
acceptance_criteria:
  - AC-CANVASES-COLLABORATIVE-CANVASES-001.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-001.2
  - AC-CANVASES-COLLABORATIVE-CANVASES-001.3
  - AC-CANVASES-COLLABORATIVE-CANVASES-001.4
  - AC-CANVASES-COLLABORATIVE-CANVASES-002.2
  - AC-CANVASES-COLLABORATIVE-CANVASES-003.2
  - AC-CANVASES-COLLABORATIVE-CANVASES-004.2
  - AC-CANVASES-COLLABORATIVE-CANVASES-007.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-010.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-011.1
system_design:
  - ../../specs/canvases/system-design/collaborative-canvases.md
---

# Task 01: Canvas domain

## Summary

Create the server-owned canvas model and command service. This service is the
only mutation path for later adapters.

## In scope

- Add replayable migrations for canvases, task links, blocks, events, and
  command receipts.
- Require one workspace for each canvas and same-workspace task links.
- Add the repository, block registry, owner access, task-agent access, limits,
  commands, leases, compaction, and base HTTP routes.
- Apply commands with one transaction and publish only after commit.
- Preserve canvases when linked tasks are removed.

## Out of scope

- WebSocket delivery, portable files, MCP tools, and web UI.

## Acceptance

- Database replay supports SQLite and Postgres.
- Duplicate, stale, unauthorized, and over-limit commands have stable results.
- Many-to-many task links stay inside one workspace and do not own canvas
  lifetime.

## Verification

```bash
cd apps/backend && go test ./internal/canvas/... ./internal/backendapp/...
```

## Files likely touched

- `apps/backend/internal/canvas/**`
- `apps/backend/internal/backendapp/**`
- backend route registration

## Dependencies

None.

## Risks

- Event compaction can remove idempotency without a separate command receipt.

## Parallelism

`sequential`

## Inputs

- Canvas persistence, block schema, command, and access design sections.
- Existing database migration and task access patterns.

## Results

Completed on 2026-08-26.

- Added the workspace-scoped canvas repository, migrations, block validation,
  command service, task-link checks, Markdown leases, event receipts, and
  compaction.
- Added owner-authorized HTTP routes and content-free operation metrics.
- `go test ./internal/canvas/... ./internal/backendapp/...` passed as part of
  the focused backend suite.
