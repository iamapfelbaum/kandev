---
system: canvases
owner: canvases
specification_version: 1
status: draft
migration: complete
last_updated: 2026-08-25
---

# Canvases

Canvases own workspace-scoped interactive surfaces for one user and trusted
agents. The system owns canvas state, task links, history, portable files, live
owner subscriptions, and agent-facing actions.

Canvases can link to tasks for context. The task system remains authoritative
for task data and permissions. A portable file transfers a snapshot without
linked task or user data.

## Requirements

- [Collaborative canvases](requirements/collaborative-canvases.md)

## System design

- [Collaborative canvases](system-design/collaborative-canvases.md)

## Related context

- [GitHub Copilot App Canvas reference](../../copilot-canvas-reference.md)
- [Server-owned declarative canvases decision](../../decisions/2026-08-25-server-owned-declarative-canvases.md)
- [Collaborative canvases implementation plan](../../plans/collaborative-canvases/plan.md)
