package authz

// Visibility decides who, beyond the owner and explicit members, can reach a
// workspace.
type Visibility string

const (
	// VisibilityPrivate restricts a workspace to its owner and explicitly
	// added members. It is the default and the value every pre-existing
	// workspace migrates to: an upgrade must never widen access.
	VisibilityPrivate Visibility = "private"
	// VisibilityOrg makes a workspace reachable by every non-guest user.
	VisibilityOrg Visibility = "org"
)

// NormalizeVisibility coerces an unknown stored value to private. Unknown
// input must never widen access.
func NormalizeVisibility(value string) Visibility {
	if Visibility(value) == VisibilityOrg {
		return VisibilityOrg
	}
	return VisibilityPrivate
}

// Subject is the caller, as far as authorization is concerned.
type Subject struct {
	UserID  string
	OrgRole OrgRole
	// Unscoped marks a caller that predates or bypasses per-user scoping: an
	// internal caller (event bus, pollers, schedulers) or the synthetic
	// identity injected while authentication is disabled. Such a caller gets
	// everything, which is exactly today's behavior.
	Unscoped bool
}

// WorkspaceRef is the workspace state authorization needs. MemberRole is
// WorkspaceRoleNone when the caller has no explicit membership row.
type WorkspaceRef struct {
	OwnerID    string
	Visibility Visibility
	MemberRole WorkspaceRole
}

// Decision is the resolved access for one (subject, workspace) pair.
type Decision struct {
	Role   WorkspaceRole
	Scopes Set
}

// CanRead reports whether the caller reaches the workspace at all. A false
// result must surface as 404, never 403: existence is not disclosed.
func (d Decision) CanRead() bool { return d.Scopes.Has(ScopeWorkspaceRead) }

// Has reports whether the decision grants a scope.
func (d Decision) Has(scope Scope) bool { return d.Scopes.Has(scope) }

// ResolveWorkspace is the only place workspace permissions are derived.
//
// Order matters, and an explicit membership row deliberately outranks the org
// default in BOTH directions: it is how a guest is admitted to one workspace,
// and how a member is narrowed to viewer on a sensitive one.
func ResolveWorkspace(subject Subject, ref WorkspaceRef) Decision {
	switch {
	case subject.Unscoped:
		return decide(WorkspaceRoleOwner)

	// A workspace created before authentication was enabled has no owner and
	// stays visible to everyone until the setup wizard claims it. Preserving
	// this keeps single-user upgrades byte-identical.
	case ref.OwnerID == "":
		return decide(WorkspaceRoleOwner)

	case subject.UserID != "" && ref.OwnerID == subject.UserID:
		return decide(WorkspaceRoleOwner)

	case ref.MemberRole != WorkspaceRoleNone:
		return decide(ref.MemberRole)

	case ref.Visibility == VisibilityOrg:
		return decide(DefaultWorkspaceRole(subject.OrgRole))

	default:
		return decide(WorkspaceRoleNone)
	}
}

// Denied is the fail-closed decision. Resolution errors return this rather
// than falling back to the org default role, which is the branch that would
// silently widen access under a transient database failure.
func Denied() Decision { return decide(WorkspaceRoleNone) }

func decide(role WorkspaceRole) Decision {
	return Decision{Role: role, Scopes: WorkspaceScopes(role)}
}

// SubjectOrgScopes returns the org scopes a subject holds. An unscoped caller
// holds every org scope.
func SubjectOrgScopes(subject Subject) Set {
	if subject.Unscoped {
		return orgScopeSet()
	}
	return OrgScopes(subject.OrgRole)
}

func orgScopeSet() Set {
	out := NewSet()
	for _, def := range registry {
		if def.Kind == KindOrg {
			out[def.Scope] = struct{}{}
		}
	}
	return out
}
