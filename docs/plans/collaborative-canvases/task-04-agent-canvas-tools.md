---
id: "04-agent-canvas-tools"
title: "Agent canvas tools"
status: complete
wave: 4
depends_on:
  - "03-portable-canvas-files"
plan: "plan.md"
requirements:
  - REQ-CANVASES-COLLABORATIVE-CANVASES-003
  - REQ-CANVASES-COLLABORATIVE-CANVASES-007
  - REQ-CANVASES-COLLABORATIVE-CANVASES-008
  - REQ-CANVASES-COLLABORATIVE-CANVASES-010
acceptance_criteria:
  - AC-CANVASES-COLLABORATIVE-CANVASES-003.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-007.2
  - AC-CANVASES-COLLABORATIVE-CANVASES-008.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-008.2
  - AC-CANVASES-COLLABORATIVE-CANVASES-010.1
system_design:
  - ../../specs/canvases/system-design/collaborative-canvases.md
---

# Task 04: Agent canvas tools

## Summary

Expose safe canvas discovery and content actions to Task and Office agents.
Keep portability and lifecycle actions human-only.

## In scope

- Add list, create, get, and action MCP tools.
- Add one canvas group to Task and Office task profiles.
- Derive user, task, and session context from the trusted connection.
- Limit Task agents to linked canvases.
- Route mutations through the shared command service.
- Add compact prompt guidance and instruction budgets.

## Out of scope

- Export, import, unlink, archive, remove, identity, and arbitrary code inputs.

## Acceptance

- Tool inventories match the intended profiles.
- A Task agent cannot access an unlinked canvas.
- Tool schemas contain no portability or lifecycle capability.

## Verification

```bash
cd apps/backend && go test ./internal/mcp/server/... ./internal/canvas/...
```

## Files likely touched

- `apps/backend/internal/mcp/server/**`
- `apps/backend/config/prompts/kandev-context.md`
- `apps/backend/config/prompts/office-context.md`
- `apps/backend/internal/canvas/**`

## Dependencies

- Tasks 01 through 03 establish the domain and excluded portable boundary.

## Risks

- Broad tools can let a task agent escape its linked canvas scope.

## Parallelism

`sequential`

## Inputs

- Agent tools and access policy design sections.
- Existing typed MCP profile groups and prompt budget tests.

## Results

Completed on 2026-08-26.

- Added Task and Office canvas MCP groups with list, create, get, and action
  tools.
- Task access is limited to linked canvases, while lifecycle and portability
  actions remain human-only.
- MCP, canvas, and prompt synchronization tests passed in the focused backend
  suite.
