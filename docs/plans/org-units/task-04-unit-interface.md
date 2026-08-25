---
id: "04-unit-interface"
title: "Unit tree and placement interface"
status: todo
wave: 3
depends_on: ["03-unit-management-api"]
plan: "plan.md"
spec: "../../specs/workspaces/requirements/org-units.md"
---

# Task 04: Unit Tree and Placement Interface

## Outcome

An organization administrator can build the tree, manage a unit's members, and
move a workspace between units, on desktop and on a phone.

## In scope

- A unit tree in settings under Access Control, with create, rename, move and
  delete.
- A unit members view reusing the existing member picker and role control.
- Workspace placement shown on the workspace, with a move control gated on the
  caller's scopes.
- Copy in all five locales.

## Out of scope

- Removing the visibility control, order 05.
- Screenshots and public documentation, order 06.

## Requirements

`REQ-WORKSPACES-ORG-UNITS-001`, `REQ-WORKSPACES-ORG-UNITS-002`,
`REQ-WORKSPACES-ORG-UNITS-005`.

Acceptance criteria: `AC-WORKSPACES-ORG-UNITS-001.8`,
`AC-WORKSPACES-ORG-UNITS-002.1`, `AC-WORKSPACES-ORG-UNITS-005.2`.

## System design

[Organization units](../../specs/workspaces/system-design/org-units.md), section
Components and responsibilities.

## Implementation acceptance

1. The tree renders an organization's units in hierarchy order and hides
   controls the caller's scopes do not permit.
2. Moving a workspace updates its displayed placement without a reload.
3. The interface works at a phone viewport, per `/mobile-parity`.

## Verification

```bash
cd apps/web
pnpm run typecheck && pnpm run lint
pnpm test -- components/settings/units lib/api/domains/org-units-api.test.ts
pnpm run i18n:check && pnpm run i18n:ratchet
```

## Likely files

- `apps/web/components/settings/units/` (new)
- `apps/web/lib/api/domains/org-units-api.ts` (new)
- `apps/web/components/app-sidebar/sections/settings/settings-menu-sections.ts`
- `apps/web/src/locales/*/settings.json`

## Results

Pending.
