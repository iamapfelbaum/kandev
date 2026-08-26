---
id: "03-portable-canvas-files"
title: "Portable canvas files"
status: complete
wave: 3
depends_on:
  - "02-live-canvas-protocol"
plan: "plan.md"
requirements:
  - REQ-CANVASES-COLLABORATIVE-CANVASES-006
  - REQ-CANVASES-COLLABORATIVE-CANVASES-007
  - REQ-CANVASES-COLLABORATIVE-CANVASES-010
  - REQ-CANVASES-COLLABORATIVE-CANVASES-011
acceptance_criteria:
  - AC-CANVASES-COLLABORATIVE-CANVASES-006.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-006.2
  - AC-CANVASES-COLLABORATIVE-CANVASES-006.3
  - AC-CANVASES-COLLABORATIVE-CANVASES-006.4
  - AC-CANVASES-COLLABORATIVE-CANVASES-007.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-010.3
  - AC-CANVASES-COLLABORATIVE-CANVASES-011.2
system_design:
  - ../../specs/canvases/system-design/collaborative-canvases.md
---

# Task 03: Portable canvas files

## Summary

Add a deterministic `.kandev-canvas` codec and owner-only HTTP endpoints.
Each import creates a new local fork.

## In scope

- Encode the current snapshot without internal identifiers or linked data.
- Decode with strict format, schema, unknown-field, block, and size validation.
- Validate the complete file before the import transaction.
- Create new canvas and block identifiers on every import.
- Add export and import routes, MIME type, safe file names, and metrics.
- Import into the selected owned workspace.
- Support an optional same-workspace task link selected during import.

## Out of scope

- ZIP assets, signatures, merge, update, synchronization, and agent file tools.

## Acceptance

- Export output is deterministic and contains no excluded data.
- Invalid files create no database rows.
- Repeated import creates independent canvases with new identifiers.

## Verification

```bash
cd apps/backend && go test ./internal/canvas/...
```

## Files likely touched

- `apps/backend/internal/canvas/portable/**`
- `apps/backend/internal/canvas/http/**`
- `apps/backend/internal/canvas/**`

## Dependencies

- Task 01 provides the repository and block registry.
- Task 02 proves that imports do not emit partial live events.

## Risks

- Reusing database JSON can leak internal fields into the portable contract.

## Parallelism

`sequential`

## Inputs

- Portable file, HTTP API, access, and observability design sections.
- Existing bounded upload and download response patterns.

## Results

Completed on 2026-08-26.

- Added deterministic `.kandev-canvas` export and strict, bounded import
  validation with fresh identifiers and optional same-workspace task links.
- Export tests prove that internal identifiers and task links are excluded;
  import validation completes before persistence.
- Canvas package tests passed, including portable format and limit coverage.
