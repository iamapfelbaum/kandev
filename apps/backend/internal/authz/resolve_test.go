package authz

import "testing"

const (
	userAna   = "user-ana"
	userBruno = "user-bruno"
)

func member(role WorkspaceRole) WorkspaceRole { return role }

func TestResolveWorkspaceReachTable(t *testing.T) {
	cases := []struct {
		name     string
		subject  Subject
		ref      WorkspaceRef
		wantRole WorkspaceRole
		wantRead bool
	}{
		{
			name:     "owner reaches own private workspace",
			subject:  Subject{UserID: userAna, OrgRole: OrgRoleMember},
			ref:      WorkspaceRef{OwnerID: userAna, Visibility: VisibilityPrivate},
			wantRole: WorkspaceRoleOwner,
			wantRead: true,
		},
		{
			name:     "non-member cannot reach a private workspace",
			subject:  Subject{UserID: userBruno, OrgRole: OrgRoleMember},
			ref:      WorkspaceRef{OwnerID: userAna, Visibility: VisibilityPrivate},
			wantRole: WorkspaceRoleNone,
			wantRead: false,
		},
		{
			name:     "member reaches an org-visible workspace with no row",
			subject:  Subject{UserID: userBruno, OrgRole: OrgRoleMember},
			ref:      WorkspaceRef{OwnerID: userAna, Visibility: VisibilityOrg},
			wantRole: WorkspaceRoleCollaborator,
			wantRead: true,
		},
		{
			name:     "admin reaches an org-visible workspace as a plain collaborator",
			subject:  Subject{UserID: userBruno, OrgRole: OrgRoleAdmin},
			ref:      WorkspaceRef{OwnerID: userAna, Visibility: VisibilityOrg},
			wantRole: WorkspaceRoleCollaborator,
			wantRead: true,
		},
		{
			name:     "admin does NOT reach a private workspace it is not in",
			subject:  Subject{UserID: userBruno, OrgRole: OrgRoleAdmin},
			ref:      WorkspaceRef{OwnerID: userAna, Visibility: VisibilityPrivate},
			wantRole: WorkspaceRoleNone,
			wantRead: false,
		},
		{
			name:     "guest does NOT reach an org-visible workspace",
			subject:  Subject{UserID: userBruno, OrgRole: OrgRoleGuest},
			ref:      WorkspaceRef{OwnerID: userAna, Visibility: VisibilityOrg},
			wantRole: WorkspaceRoleNone,
			wantRead: false,
		},
		{
			name:     "guest reaches a workspace it holds a row on",
			subject:  Subject{UserID: userBruno, OrgRole: OrgRoleGuest},
			ref:      WorkspaceRef{OwnerID: userAna, Visibility: VisibilityPrivate, MemberRole: member(WorkspaceRoleCollaborator)},
			wantRole: WorkspaceRoleCollaborator,
			wantRead: true,
		},
		{
			name:     "explicit viewer row narrows a member on an org-visible workspace",
			subject:  Subject{UserID: userBruno, OrgRole: OrgRoleMember},
			ref:      WorkspaceRef{OwnerID: userAna, Visibility: VisibilityOrg, MemberRole: member(WorkspaceRoleViewer)},
			wantRole: WorkspaceRoleViewer,
			wantRead: true,
		},
		{
			name:     "unscoped internal caller reaches everything",
			subject:  Subject{Unscoped: true},
			ref:      WorkspaceRef{OwnerID: userAna, Visibility: VisibilityPrivate},
			wantRole: WorkspaceRoleOwner,
			wantRead: true,
		},
		{
			name:     "pre-auth unowned workspace stays visible to everyone",
			subject:  Subject{UserID: userBruno, OrgRole: OrgRoleGuest},
			ref:      WorkspaceRef{OwnerID: "", Visibility: VisibilityPrivate},
			wantRole: WorkspaceRoleOwner,
			wantRead: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveWorkspace(tc.subject, tc.ref)
			if got.Role != tc.wantRole {
				t.Errorf("role = %q, want %q", got.Role, tc.wantRole)
			}
			if got.CanRead() != tc.wantRead {
				t.Errorf("CanRead() = %v, want %v", got.CanRead(), tc.wantRead)
			}
		})
	}
}

// A viewer may read a transcript; a shell in the worktree is a different
// question, and collapsing the two is the mistake this test exists to catch.
func TestViewerHasNoExecOrWrite(t *testing.T) {
	viewer := ResolveWorkspace(
		Subject{UserID: userBruno, OrgRole: OrgRoleMember},
		WorkspaceRef{OwnerID: userAna, Visibility: VisibilityOrg, MemberRole: WorkspaceRoleViewer},
	)
	if !viewer.Has(ScopeWorkspaceRead) {
		t.Error("viewer should hold workspace.read")
	}
	for _, denied := range []Scope{ScopeSessionExec, ScopeSessionPrompt, ScopeTaskWrite, ScopeSessionControl} {
		if viewer.Has(denied) {
			t.Errorf("viewer must not hold %q", denied)
		}
	}
}

// Managing a workspace, its members, repositories and secrets belongs to the
// owner. A collaborator contributes; it does not administer.
func TestCollaboratorCannotAdminister(t *testing.T) {
	collab := WorkspaceScopes(WorkspaceRoleCollaborator)
	for _, denied := range []Scope{ScopeWorkspaceManage, ScopeMemberManage, ScopeSecretManage, ScopeRepositoryManage} {
		if collab.Has(denied) {
			t.Errorf("collaborator must not hold %q", denied)
		}
	}
	owner := WorkspaceScopes(WorkspaceRoleOwner)
	for _, granted := range []Scope{ScopeWorkspaceManage, ScopeMemberManage, ScopeSecretManage, ScopeRepositoryManage} {
		if !owner.Has(granted) {
			t.Errorf("owner should hold %q", granted)
		}
	}
}

func TestDeniedGrantsNothing(t *testing.T) {
	if Denied().CanRead() {
		t.Error("Denied() must not grant workspace.read")
	}
	if len(Denied().Scopes) != 0 {
		t.Errorf("Denied() granted %v", Denied().Scopes.List())
	}
}

func TestOrgScopes(t *testing.T) {
	admin := SubjectOrgScopes(Subject{OrgRole: OrgRoleAdmin})
	if !admin.Has(ScopeOrgMembersManage) || !admin.Has(ScopeOrgConfigManage) {
		t.Errorf("admin org scopes = %v", admin.List())
	}
	for _, role := range []OrgRole{OrgRoleMember, OrgRoleGuest} {
		if scopes := SubjectOrgScopes(Subject{OrgRole: role}); len(scopes) != 0 {
			t.Errorf("%s should hold no org scopes, got %v", role, scopes.List())
		}
	}
	if unscoped := SubjectOrgScopes(Subject{Unscoped: true}); !unscoped.Has(ScopeOrgMembersManage) {
		t.Error("unscoped caller should hold every org scope")
	}
}

// Unknown stored values must fail closed rather than widen access.
func TestNormalizersFailClosed(t *testing.T) {
	if got := NormalizeOrgRole("superuser"); got != OrgRoleGuest {
		t.Errorf("NormalizeOrgRole(unknown) = %q, want guest", got)
	}
	if got := NormalizeOrgRole(""); got != OrgRoleGuest {
		t.Errorf("NormalizeOrgRole(empty) = %q, want guest", got)
	}
	if got := NormalizeWorkspaceRole("superuser"); got != WorkspaceRoleNone {
		t.Errorf("NormalizeWorkspaceRole(unknown) = %q, want none", got)
	}
	if got := NormalizeVisibility("public"); got != VisibilityPrivate {
		t.Errorf("NormalizeVisibility(unknown) = %q, want private", got)
	}
	if got := NormalizeVisibility(""); got != VisibilityPrivate {
		t.Errorf("NormalizeVisibility(empty) = %q, want private", got)
	}
}

func TestIsAssignableWorkspaceRole(t *testing.T) {
	if IsAssignableWorkspaceRole(WorkspaceRoleOwner) {
		t.Error("owner must be reached by transfer, not assignment")
	}
	if !IsAssignableWorkspaceRole(WorkspaceRoleCollaborator) || !IsAssignableWorkspaceRole(WorkspaceRoleViewer) {
		t.Error("collaborator and viewer must be assignable")
	}
}
