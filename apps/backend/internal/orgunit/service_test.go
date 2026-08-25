package orgunit

import (
	"context"
	"errors"
	"testing"
)

type stubCounter struct {
	counts map[string]int
	err    error
}

func (s stubCounter) CountWorkspacesInUnit(_ context.Context, unitID string) (int, error) {
	return s.counts[unitID], s.err
}

func newTestService(t *testing.T) *Service {
	t.Helper()
	svc := NewService(newTestStore(t), nil)
	svc.SetWorkspaceCounter(stubCounter{counts: map[string]int{}})
	return svc
}

// Both are idempotent because boot, the data migration, and organization or
// user creation all reach for them without coordinating. A second call that
// created a second unit would give a user two ancestries.
func TestEnsureRootAndPersonalAreIdempotent(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)

	first, err := svc.EnsureRoot(ctx, "org-1", "Acme")
	if err != nil {
		t.Fatalf("ensure root: %v", err)
	}
	second, err := svc.EnsureRoot(ctx, "org-1", "Acme")
	if err != nil {
		t.Fatalf("ensure root again: %v", err)
	}
	if first.ID != second.ID {
		t.Fatalf("root ids differ: %s vs %s", first.ID, second.ID)
	}

	p1, err := svc.EnsurePersonal(ctx, "org-1", "ada", "Ada Lovelace")
	if err != nil {
		t.Fatalf("ensure personal: %v", err)
	}
	p2, err := svc.EnsurePersonal(ctx, "org-1", "ada", "Ada Lovelace")
	if err != nil {
		t.Fatalf("ensure personal again: %v", err)
	}
	if p1.ID != p2.ID {
		t.Fatalf("personal ids differ: %s vs %s", p1.ID, p2.ID)
	}
	if p1.ParentID != first.ID {
		t.Fatalf("personal unit parent = %q, want the root %q", p1.ParentID, first.ID)
	}
}

// A personal unit is private because nobody else can be in it. If a member
// could be added, privacy would become a property some units have, which is
// the flag this model set out to remove.
func TestPersonalUnitRefusesMembers(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	if _, err := svc.EnsureRoot(ctx, "org-1", "Acme"); err != nil {
		t.Fatalf("ensure root: %v", err)
	}
	personal, err := svc.EnsurePersonal(ctx, "org-1", "ada", "Ada")
	if err != nil {
		t.Fatalf("ensure personal: %v", err)
	}

	err = svc.SetMember(ctx, personal.ID, "grace", "collaborator", "ada")
	if !errors.Is(err, ErrPersonalNoMember) {
		t.Fatalf("adding a member to a personal unit returned %v, want ErrPersonalNoMember", err)
	}
}

// Moving a unit under its own descendant would detach the subtree from the
// root, and every reach answer for it afterwards would be a guess.
func TestMoveRefusesCycle(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	root, err := svc.EnsureRoot(ctx, "org-1", "Acme")
	if err != nil {
		t.Fatalf("ensure root: %v", err)
	}
	dept, err := svc.Create(ctx, root.ID, "Platform")
	if err != nil {
		t.Fatalf("create dept: %v", err)
	}
	team, err := svc.Create(ctx, dept.ID, "Runtime")
	if err != nil {
		t.Fatalf("create team: %v", err)
	}

	if err := svc.Move(ctx, dept.ID, team.ID); !errors.Is(err, ErrCycle) {
		t.Fatalf("moving a unit beneath its own child returned %v, want ErrCycle", err)
	}
	if err := svc.Move(ctx, root.ID, dept.ID); !errors.Is(err, ErrProtectedUnit) {
		t.Fatalf("moving the root returned %v, want ErrProtectedUnit", err)
	}
}

// Deleting a unit that still holds workspaces would strand them: they would
// have a placement pointing at nothing and no ancestry to resolve reach from.
func TestDeleteRefusesWhileOccupied(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t)
	root, err := svc.EnsureRoot(ctx, "org-1", "Acme")
	if err != nil {
		t.Fatalf("ensure root: %v", err)
	}
	dept, err := svc.Create(ctx, root.ID, "Platform")
	if err != nil {
		t.Fatalf("create dept: %v", err)
	}
	team, err := svc.Create(ctx, dept.ID, "Runtime")
	if err != nil {
		t.Fatalf("create team: %v", err)
	}

	if err := svc.Delete(ctx, dept.ID); !errors.Is(err, ErrNotEmpty) {
		t.Fatalf("deleting a unit with a child returned %v, want ErrNotEmpty", err)
	}

	svc.SetWorkspaceCounter(stubCounter{counts: map[string]int{team.ID: 1}})
	if err := svc.Delete(ctx, team.ID); !errors.Is(err, ErrNotEmpty) {
		t.Fatalf("deleting a unit holding a workspace returned %v, want ErrNotEmpty", err)
	}

	svc.SetWorkspaceCounter(stubCounter{counts: map[string]int{}})
	if err := svc.Delete(ctx, team.ID); err != nil {
		t.Fatalf("deleting an empty unit: %v", err)
	}
}

// An unwired occupancy seam must not read as "no workspaces here". Failing
// closed keeps a construction mistake from deleting a populated unit.
func TestDeleteFailsClosedWithoutCounter(t *testing.T) {
	ctx := context.Background()
	svc := NewService(newTestStore(t), nil)
	root, err := svc.EnsureRoot(ctx, "org-1", "Acme")
	if err != nil {
		t.Fatalf("ensure root: %v", err)
	}
	dept, err := svc.Create(ctx, root.ID, "Platform")
	if err != nil {
		t.Fatalf("create dept: %v", err)
	}
	if err := svc.Delete(ctx, dept.ID); !errors.Is(err, ErrNotEmpty) {
		t.Fatalf("delete with no counter wired returned %v, want a refusal", err)
	}
}
