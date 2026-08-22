package service

import (
	"context"
	"errors"
	"time"

	"github.com/kandev/kandev/internal/authz"
	"github.com/kandev/kandev/internal/task/models"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	"go.uber.org/zap"
)

// Workspace membership errors. Each failure mode gets its own sentinel so the
// UI can say what actually went wrong instead of "bad request".
var (
	ErrMemberUserNotFound      = errors.New("user not found")
	ErrMemberUserDisabled      = errors.New("user account is disabled")
	ErrMemberIsOwner           = errors.New("the workspace owner cannot be removed; transfer ownership first")
	ErrMemberRoleInvalid       = errors.New("role must be collaborator or viewer")
	ErrMemberSelf              = errors.New("you already own this workspace")
	ErrTransferTargetNotMember = errors.New("add the user as a member before transferring ownership")
	ErrVisibilityOwnerIsGuest  = errors.New("a guest-owned workspace cannot be shared with the organization")
)

// DirectoryUser is the reduced user record exposed to a member picker: an ID
// and a display name, never an email, role, or status. Reaching a colleague's
// name is what adding a member needs; anything more is a directory leak to
// every authenticated user.
type DirectoryUser struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}

// UserDirectory resolves users for membership operations.
type UserDirectory interface {
	ListDirectory(ctx context.Context) ([]DirectoryUser, error)
	// LookupStatus returns the user's status ("active"/"disabled") and role,
	// or ok=false when no such user exists.
	LookupStatus(ctx context.Context, userID string) (status string, role string, ok bool, err error)
}

// SetUserDirectory wires the account lookup used by membership operations.
func (s *Service) SetUserDirectory(directory UserDirectory) { s.userDirectory = directory }

// ListWorkspaceMembers returns the workspace's membership. Any caller who can
// read the workspace can see who else is in it.
func (s *Service) ListWorkspaceMembers(ctx context.Context, workspaceID string) ([]*models.WorkspaceMember, error) {
	if err := s.authorizeWorkspaceID(ctx, workspaceID); err != nil {
		return nil, err
	}
	return s.workspaces.ListWorkspaceMembers(ctx, workspaceID)
}

// UpsertWorkspaceMember adds a member or changes an existing member's role.
func (s *Service) UpsertWorkspaceMember(ctx context.Context, workspaceID, userID, role string) (*models.WorkspaceMember, error) {
	workspace, err := s.requireMemberManage(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	wantRole := authz.NormalizeWorkspaceRole(role)
	if !authz.IsAssignableWorkspaceRole(wantRole) {
		return nil, ErrMemberRoleInvalid
	}
	if userID == workspace.OwnerID {
		return nil, ErrMemberSelf
	}
	if err := s.requireAssignableUser(ctx, userID); err != nil {
		return nil, err
	}

	actor, _ := callerScope(ctx)
	member := &models.WorkspaceMember{
		WorkspaceID: workspaceID,
		UserID:      userID,
		Role:        string(wantRole),
		AddedBy:     actor,
		CreatedAt:   time.Now().UTC(),
	}
	if err := s.workspaces.UpsertWorkspaceMember(ctx, member); err != nil {
		return nil, err
	}
	s.publishWorkspaceAccessChanged(ctx, workspace)
	s.logger.Info("workspace member upserted",
		zap.String("workspace_id", workspaceID), zap.String("user_id", userID), zap.String("role", string(wantRole)))
	return member, nil
}

// RemoveWorkspaceMember drops a membership row. The accountable owner's row
// cannot be removed: ownership is transferred, never vacated.
func (s *Service) RemoveWorkspaceMember(ctx context.Context, workspaceID, userID string) error {
	workspace, err := s.requireMemberManage(ctx, workspaceID)
	if err != nil {
		return err
	}
	if userID == workspace.OwnerID {
		return ErrMemberIsOwner
	}
	if err := s.workspaces.DeleteWorkspaceMember(ctx, workspaceID, userID); err != nil {
		return err
	}
	s.publishWorkspaceAccessChanged(ctx, workspace)
	s.logger.Info("workspace member removed",
		zap.String("workspace_id", workspaceID), zap.String("user_id", userID))
	return nil
}

// TransferWorkspaceOwnership moves the accountable owner to an existing
// member, demoting the previous owner to collaborator.
func (s *Service) TransferWorkspaceOwnership(ctx context.Context, workspaceID, toUserID string) error {
	workspace, err := s.requireMemberManage(ctx, workspaceID)
	if err != nil {
		return err
	}
	if toUserID == workspace.OwnerID {
		return ErrMemberSelf
	}
	if err := s.requireAssignableUser(ctx, toUserID); err != nil {
		return err
	}
	member, err := s.workspaces.GetWorkspaceMember(ctx, workspaceID, toUserID)
	if err != nil {
		return err
	}
	if member == nil {
		return ErrTransferTargetNotMember
	}
	if err := s.workspaces.TransferWorkspaceOwnership(ctx, workspaceID, workspace.OwnerID, toUserID); err != nil {
		return err
	}
	workspace.OwnerID = toUserID
	s.publishWorkspaceAccessChanged(ctx, workspace)
	s.logger.Info("workspace ownership transferred",
		zap.String("workspace_id", workspaceID), zap.String("to_user_id", toUserID))
	return nil
}

// SetWorkspaceVisibility switches a workspace between private and org-visible.
func (s *Service) SetWorkspaceVisibility(ctx context.Context, workspaceID, visibility string) (*models.Workspace, error) {
	workspace, err := s.workspaces.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	if err := s.requireWorkspaceManage(ctx, workspace); err != nil {
		return nil, err
	}
	want := authz.NormalizeVisibility(visibility)
	// A guest reaches only workspaces they hold a row on, so a guest-owned
	// workspace marked org-visible would be published to an organization its
	// own owner cannot see. Refuse rather than create that asymmetry.
	if want == authz.VisibilityOrg && workspace.OwnerID != "" {
		if _, role, ok, lookupErr := s.lookupUser(ctx, workspace.OwnerID); lookupErr == nil && ok {
			if authz.NormalizeOrgRole(role) == authz.OrgRoleGuest {
				return nil, ErrVisibilityOwnerIsGuest
			}
		}
	}
	workspace.Visibility = string(want)
	workspace.UpdatedAt = time.Now().UTC()
	if err := s.workspaces.UpdateWorkspace(ctx, workspace); err != nil {
		return nil, err
	}
	s.publishWorkspaceAccessChanged(ctx, workspace)
	s.logger.Info("workspace visibility changed",
		zap.String("workspace_id", workspaceID), zap.String("visibility", string(want)))
	return workspace, nil
}

// ListDirectoryUsers returns the reduced user list for a member picker.
func (s *Service) ListDirectoryUsers(ctx context.Context) ([]DirectoryUser, error) {
	if s.userDirectory == nil {
		return []DirectoryUser{}, nil
	}
	return s.userDirectory.ListDirectory(ctx)
}

// requireMemberManage resolves the workspace and enforces member.manage.
func (s *Service) requireMemberManage(ctx context.Context, workspaceID string) (*models.Workspace, error) {
	workspace, err := s.workspaces.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return nil, err
	}
	if _, scoped := callerScope(ctx); !scoped {
		return workspace, nil
	}
	decision := s.workspaceDecision(ctx, workspace)
	if !decision.CanRead() {
		return nil, repoerrors.ErrWorkspaceNotFound
	}
	if !decision.Has(authz.ScopeMemberManage) {
		return nil, ErrForbidden
	}
	return workspace, nil
}

// requireAssignableUser rejects unknown and disabled accounts before a write.
func (s *Service) requireAssignableUser(ctx context.Context, userID string) error {
	status, _, ok, err := s.lookupUser(ctx, userID)
	if err != nil {
		return err
	}
	if !ok {
		return ErrMemberUserNotFound
	}
	if status == "disabled" {
		return ErrMemberUserDisabled
	}
	return nil
}

func (s *Service) lookupUser(ctx context.Context, userID string) (string, string, bool, error) {
	if s.userDirectory == nil {
		// No directory wired (pre-auth single-user installs): accept the ID
		// rather than blocking membership entirely.
		return "active", string(authz.OrgRoleMember), true, nil
	}
	return s.userDirectory.LookupStatus(ctx, userID)
}

// OrgSettings supplies instance-wide defaults that membership depends on.
type OrgSettings interface {
	DefaultWorkspaceVisibility(ctx context.Context) authz.Visibility
	SetDefaultWorkspaceVisibility(ctx context.Context, visibility authz.Visibility) error
}

// SetOrgSettings wires the org-level defaults provider.
func (s *Service) SetOrgSettings(settings OrgSettings) { s.orgSettings = settings }

// defaultWorkspaceVisibility resolves the visibility a new workspace starts
// with. A team install sets this to org once and never invites anyone; an
// install that is several individuals sharing a box leaves it private and
// behaves exactly as it does today. Unwired means private.
func (s *Service) defaultWorkspaceVisibility(ctx context.Context) authz.Visibility {
	if s.orgSettings == nil {
		return authz.VisibilityPrivate
	}
	return s.orgSettings.DefaultWorkspaceVisibility(ctx)
}

// seedWorkspaceOwnerMember mirrors workspaces.owner_id into the membership
// table so the two never disagree. Failure is logged rather than fatal: the
// owner still reaches the workspace through owner_id, and the backfill
// migration repairs a missing row on the next boot.
func (s *Service) seedWorkspaceOwnerMember(ctx context.Context, workspace *models.Workspace) {
	if workspace == nil || workspace.OwnerID == "" {
		return
	}
	member := &models.WorkspaceMember{
		WorkspaceID: workspace.ID,
		UserID:      workspace.OwnerID,
		Role:        string(authz.WorkspaceRoleOwner),
		CreatedAt:   time.Now().UTC(),
	}
	if err := s.workspaces.UpsertWorkspaceMember(ctx, member); err != nil {
		s.logger.Warn("failed to seed workspace owner membership",
			zap.String("workspace_id", workspace.ID), zap.Error(err))
	}
}

// WorkspaceAccessProjection carries the resolved access for a set of
// workspaces so handlers can build DTOs without re-resolving per row.
type WorkspaceAccessProjection struct {
	Decisions    map[string]authz.Decision
	MemberCounts map[string]int
}

// Decision returns the resolved access for one workspace, defaulting to the
// unscoped view when the projection was built for an internal caller.
func (p WorkspaceAccessProjection) Decision(workspaceID string) authz.Decision {
	if decision, ok := p.Decisions[workspaceID]; ok {
		return decision
	}
	return authz.Denied()
}

// ProjectWorkspaceAccess resolves roles and scopes for a list of workspaces
// using one membership query and one count query, regardless of list length.
func (s *Service) ProjectWorkspaceAccess(ctx context.Context, workspaces []*models.Workspace) WorkspaceAccessProjection {
	projection := WorkspaceAccessProjection{
		Decisions:    make(map[string]authz.Decision, len(workspaces)),
		MemberCounts: map[string]int{},
	}
	if counts, err := s.workspaces.CountWorkspaceMembers(ctx); err == nil {
		projection.MemberCounts = counts
	}

	subject := callerSubject(ctx)
	memberRoles := map[string]string{}
	if !subject.Unscoped {
		roles, err := s.workspaces.ListWorkspaceIDsForMember(ctx, subject.UserID)
		if err != nil {
			// Fail closed: every workspace resolves to Denied rather than
			// silently falling through to the org default role.
			s.logger.Warn("membership projection failed; denying scopes")
			for _, workspace := range workspaces {
				if workspace != nil {
					projection.Decisions[workspace.ID] = authz.Denied()
				}
			}
			return projection
		}
		memberRoles = roles
	}

	for _, workspace := range workspaces {
		if workspace == nil {
			continue
		}
		projection.Decisions[workspace.ID] = authz.ResolveWorkspace(subject, authz.WorkspaceRef{
			OwnerID:    workspace.OwnerID,
			OrgID:      workspace.OrgID,
			Visibility: authz.NormalizeVisibility(workspace.Visibility),
			MemberRole: authz.NormalizeWorkspaceRole(memberRoles[workspace.ID]),
		})
	}
	return projection
}

// DefaultWorkspaceVisibility reports the visibility new workspaces start with.
func (s *Service) DefaultWorkspaceVisibility(ctx context.Context) authz.Visibility {
	return s.defaultWorkspaceVisibility(ctx)
}

// SetDefaultWorkspaceVisibility changes the install-wide default for new
// workspaces. It never touches existing workspaces: turning the default on
// must not retroactively publish work that was private a moment ago.
func (s *Service) SetDefaultWorkspaceVisibility(ctx context.Context, visibility string) (authz.Visibility, error) {
	if !authz.SubjectOrgScopes(callerSubject(ctx)).Has(authz.ScopeOrgSettingsManage) {
		return "", ErrForbidden
	}
	if s.orgSettings == nil {
		return authz.VisibilityPrivate, nil
	}
	want := authz.NormalizeVisibility(visibility)
	if err := s.orgSettings.SetDefaultWorkspaceVisibility(ctx, want); err != nil {
		return "", err
	}
	s.logger.Info("default workspace visibility changed", zap.String("visibility", string(want)))
	return want, nil
}
