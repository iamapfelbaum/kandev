package orgunit

import (
	"context"
	"strings"

	"github.com/kandev/kandev/internal/common/logger"
	"go.uber.org/zap"
)

// WorkspaceCounter reports how many workspaces sit in a unit.
//
// Workspaces belong to the task repository, so this package asks rather than
// reads. Without it a unit could be deleted out from under the workspaces it
// holds, which would leave them unreachable with no way to say why.
type WorkspaceCounter interface {
	CountWorkspacesInUnit(ctx context.Context, unitID string) (int, error)
}

// Service owns the tree's invariants.
type Service struct {
	store      *Store
	workspaces WorkspaceCounter
	log        *logger.Logger
}

// NewService builds the service. The workspace counter is wired separately
// because the task repository is constructed after this package.
func NewService(store *Store, log *logger.Logger) *Service {
	return &Service{store: store, log: log}
}

// SetWorkspaceCounter wires the workspace-occupancy seam. Until it is set, a
// delete is refused rather than allowed unchecked: an unwired dependency must
// not read as "no workspaces here".
func (s *Service) SetWorkspaceCounter(c WorkspaceCounter) { s.workspaces = c }

// Store exposes the store for read paths that do not need the invariants.
func (s *Service) Store() *Store { return s.store }

// EnsureRoot returns the organization's root unit, creating it when absent.
// It is idempotent so that boot, migration, and organization creation can all
// call it without coordinating.
func (s *Service) EnsureRoot(ctx context.Context, orgID, orgName string) (*Unit, error) {
	if existing, err := s.store.Root(ctx, orgID); err == nil {
		return existing, nil
	} else if err != ErrUnitNotFound {
		return nil, err
	}
	name := strings.TrimSpace(orgName)
	if name == "" {
		name = "Organization"
	}
	return s.store.Insert(ctx, &Unit{OrgID: orgID, Kind: KindRoot, Name: name})
}

// EnsurePersonal returns a user's personal unit, creating it when absent.
//
// It hangs off the root rather than standing outside the tree, so that one
// walk answers reach for every workspace. Its emptiness of members, not its
// position, is what keeps it private.
func (s *Service) EnsurePersonal(ctx context.Context, orgID, userID, displayName string) (*Unit, error) {
	if existing, err := s.store.Personal(ctx, userID); err == nil {
		return existing, nil
	} else if err != ErrUnitNotFound {
		return nil, err
	}
	root, err := s.EnsureRoot(ctx, orgID, "")
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(displayName)
	if name == "" {
		name = "Personal"
	}
	return s.store.Insert(ctx, &Unit{
		OrgID:       orgID,
		ParentID:    root.ID,
		Kind:        KindPersonal,
		OwnerUserID: userID,
		Name:        name,
	})
}

// Create adds a standard unit under a parent.
func (s *Service) Create(ctx context.Context, parentID, name string) (*Unit, error) {
	if strings.TrimSpace(name) == "" {
		return nil, ErrNameRequired
	}
	if parentID == "" {
		return nil, ErrParentRequired
	}
	parent, err := s.store.Get(ctx, parentID)
	if err != nil {
		return nil, err
	}
	unit, err := s.store.Insert(ctx, &Unit{
		OrgID:    parent.OrgID,
		ParentID: parent.ID,
		Kind:     KindStandard,
		Name:     strings.TrimSpace(name),
	})
	if err != nil {
		return nil, err
	}
	s.logInfo("unit created", unit)
	return unit, nil
}

// Rename changes a unit's display name, including a protected one: naming is
// not structural.
func (s *Service) Rename(ctx context.Context, id, name string) error {
	if strings.TrimSpace(name) == "" {
		return ErrNameRequired
	}
	return s.store.Rename(ctx, id, strings.TrimSpace(name))
}

// Move reparents a unit.
func (s *Service) Move(ctx context.Context, id, newParentID string) error {
	unit, err := s.store.Get(ctx, id)
	if err != nil {
		return err
	}
	if unit.IsProtected() {
		return ErrProtectedUnit
	}
	parent, err := s.store.Get(ctx, newParentID)
	if err != nil {
		return err
	}
	if parent.OrgID != unit.OrgID {
		return ErrCrossOrgParent
	}
	// A unit cannot be moved beneath itself. The destination's path carries
	// its whole ancestry, so containment is a prefix test rather than a walk.
	if strings.HasPrefix(parent.Path, unit.Path) {
		return ErrCycle
	}
	if err := s.store.Reparent(ctx, unit, parent); err != nil {
		return err
	}
	s.logInfo("unit moved", unit)
	return nil
}

// Delete removes an empty unit.
func (s *Service) Delete(ctx context.Context, id string) error {
	unit, err := s.store.Get(ctx, id)
	if err != nil {
		return err
	}
	if unit.IsProtected() {
		return ErrProtectedUnit
	}
	children, err := s.store.ChildCount(ctx, id)
	if err != nil {
		return err
	}
	if children > 0 {
		return ErrNotEmpty
	}
	if s.workspaces == nil {
		return ErrNotEmpty
	}
	count, err := s.workspaces.CountWorkspacesInUnit(ctx, id)
	if err != nil {
		return err
	}
	if count > 0 {
		return ErrNotEmpty
	}
	if err := s.store.Delete(ctx, id); err != nil {
		return err
	}
	s.logInfo("unit deleted", unit)
	return nil
}

// SetMember adds or re-roles a member.
func (s *Service) SetMember(ctx context.Context, unitID, userID, role, addedBy string) error {
	unit, err := s.store.Get(ctx, unitID)
	if err != nil {
		return err
	}
	// A personal unit is private because nobody else can be in it. Admitting a
	// member would make "private" a property some units have and others do
	// not, which is the flag this model removed.
	if unit.Kind == KindPersonal {
		return ErrPersonalNoMember
	}
	return s.store.SetMember(ctx, &Member{
		UnitID: unitID, UserID: userID, Role: role, AddedBy: addedBy,
	})
}

// RemoveMember drops a membership.
func (s *Service) RemoveMember(ctx context.Context, unitID, userID string) error {
	return s.store.RemoveMember(ctx, unitID, userID)
}

func (s *Service) logInfo(msg string, unit *Unit) {
	if s.log == nil {
		return
	}
	s.log.Info(msg,
		zap.String("unit_id", unit.ID),
		zap.String("org_id", unit.OrgID),
		zap.String("kind", string(unit.Kind)))
}
