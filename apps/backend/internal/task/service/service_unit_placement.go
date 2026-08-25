package service

import (
	"context"

	"go.uber.org/zap"
)

// UnitPlacer answers where a new workspace belongs.
//
// Placement is resolved lazily rather than through a user-creation hook: the
// personal unit is ensured on demand, so an account created by any path, at any
// time, gets one the first time it needs one. There is no ordering to get wrong
// and no account that can slip past a hook that was not wired.
type UnitPlacer interface {
	// PersonalUnitID returns the caller's personal unit, creating it if needed.
	PersonalUnitID(ctx context.Context, orgID, userID, displayName string) (string, error)
	// RootUnitID returns the organization's root unit, creating it if needed.
	RootUnitID(ctx context.Context, orgID string) (string, error)
}

// SetUnitPlacer wires the placement seam.
func (s *Service) SetUnitPlacer(p UnitPlacer) { s.unitPlacer = p }

// placementFor decides the unit a new workspace goes in.
//
// A workspace created by a signed-in caller lands in their personal unit, which
// is where "only I can see this" lives now that there is no private flag. One
// created by an internal or pre-authentication caller has no person to belong
// to and lands at the root, which reproduces the everyone-reaches-it behaviour
// those workspaces already had.
func (s *Service) placementFor(ctx context.Context, ownerID, orgID string) string {
	if s.unitPlacer == nil {
		return ""
	}
	if ownerID != "" {
		unitID, err := s.unitPlacer.PersonalUnitID(ctx, orgID, ownerID, "")
		if err == nil {
			return unitID
		}
		s.logger.Warn("personal unit lookup failed; placing at the organization root",
			zap.String("user_id", ownerID), zap.Error(err))
	}
	unitID, err := s.unitPlacer.RootUnitID(ctx, orgID)
	if err != nil {
		s.logger.Warn("root unit lookup failed; workspace is left unplaced", zap.Error(err))
		return ""
	}
	return unitID
}
