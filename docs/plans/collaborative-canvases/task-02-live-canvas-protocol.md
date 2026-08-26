---
id: "02-live-canvas-protocol"
title: "Live canvas protocol"
status: complete
wave: 2
depends_on:
  - "01-canvas-domain"
plan: "plan.md"
requirements:
  - REQ-CANVASES-COLLABORATIVE-CANVASES-003
  - REQ-CANVASES-COLLABORATIVE-CANVASES-004
  - REQ-CANVASES-COLLABORATIVE-CANVASES-005
  - REQ-CANVASES-COLLABORATIVE-CANVASES-007
  - REQ-CANVASES-COLLABORATIVE-CANVASES-011
acceptance_criteria:
  - AC-CANVASES-COLLABORATIVE-CANVASES-003.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-004.3
  - AC-CANVASES-COLLABORATIVE-CANVASES-005.1
  - AC-CANVASES-COLLABORATIVE-CANVASES-005.2
  - AC-CANVASES-COLLABORATIVE-CANVASES-005.3
  - AC-CANVASES-COLLABORATIVE-CANVASES-011.3
system_design:
  - ../../specs/canvases/system-design/collaborative-canvases.md
---

# Task 02: Live canvas protocol

## Summary

Deliver owner-authorized canvas events and deterministic reconnect recovery
through the existing WebSocket gateway.

## In scope

- Add subscribe, unsubscribe, and command client actions.
- Add snapshot, event, lease, and safe error server events.
- Add a canvas subscription map and owner access callback.
- Replay retained events or send a complete snapshot.
- Remove socket leases after disconnect.
- Add content-free subscription and recovery metrics.

## Out of scope

- User presence, collaborator access, and cross-instance traffic.

## Acceptance

- A non-owner cannot subscribe or infer canvas history.
- Agent changes reach an open owner client in revision order.
- A revision gap recovers through events or one snapshot.

## Verification

```bash
cd apps/backend && go test ./internal/canvas/... ./internal/gateway/websocket/... ./pkg/websocket/...
```

## Files likely touched

- `apps/backend/internal/gateway/websocket/**`
- `apps/backend/pkg/websocket/**`
- `apps/backend/internal/canvas/**`

## Dependencies

- Task 01 provides storage, access, events, and leases.

## Risks

- A publish path can leak state if it bypasses current owner access.

## Parallelism

`sequential`

## Inputs

- WebSocket protocol and access policy design sections.
- Existing task and user subscription patterns.

## Results

Completed on 2026-08-26.

- Added owner-authorized canvas WebSocket subscriptions, replay and snapshot
  recovery, event broadcasts, and disconnect cleanup.
- Added subscription and recovery metrics without recording canvas content.
- Canvas, gateway, and WebSocket package tests passed in the focused backend
  suite.
