package canvas

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/auth/authn"
)

type MarkdownLease struct {
	CanvasID  string    `json:"canvas_id" db:"canvas_id"`
	BlockID   string    `json:"block_id" db:"block_id"`
	HolderID  string    `json:"holder_id" db:"holder_id"`
	ExpiresAt time.Time `json:"expires_at" db:"expires_at"`
}

func (s *Service) ListEvents(ctx context.Context, canvasID string, afterRevision int64) ([]CanvasEvent, error) {
	if _, err := s.GetCanvas(ctx, canvasID); err != nil {
		return nil, err
	}
	return s.repo.EventsAfter(ctx, canvasID, afterRevision)
}

func (s *Service) AcquireMarkdownLease(ctx context.Context, canvasID, blockID, holderID string) (*MarkdownLease, error) {
	wireHolderID := strings.TrimSpace(holderID)
	holderID, err := resolveLeaseHolder(ctx, wireHolderID)
	if err != nil || holderID == "" {
		return nil, ErrCanvasValidation
	}
	if _, err := s.GetCanvas(ctx, canvasID); err != nil {
		return nil, err
	}
	s.repo.mu.Lock()
	defer s.repo.mu.Unlock()
	tx, err := s.repo.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	canvas, err := scanCanvas(ctx, tx, canvasID)
	if err != nil {
		return nil, err
	}
	if err := s.repo.loadChildren(ctx, tx, canvas); err != nil {
		return nil, err
	}
	if !hasMarkdownBlock(canvas.Blocks, blockID) {
		return nil, ErrCanvasNotFound
	}
	var current MarkdownLease
	err = tx.GetContext(ctx, &current, tx.Rebind(`
SELECT canvas_id, block_id, holder_id, expires_at FROM canvas_markdown_leases
WHERE canvas_id = ? AND block_id = ?`), canvasID, blockID)
	now := s.repo.nowUTC()
	if err == nil && current.ExpiresAt.After(now) && current.HolderID != holderID {
		return nil, newCanvasConflictError(CanvasBusyCode, ErrLeaseUnavailable, canvas, canvasBlock(canvas, blockID), nil, leaseState(current, now, holderID))
	}
	if wireHolderID == "" {
		wireHolderID = holderID
	}
	lease := &MarkdownLease{CanvasID: canvasID, BlockID: blockID, HolderID: wireHolderID,
		ExpiresAt: now.Add(LeaseDuration)}
	if _, err := tx.ExecContext(ctx, tx.Rebind(`
INSERT INTO canvas_markdown_leases (canvas_id, block_id, holder_id, expires_at)
VALUES (?, ?, ?, ?)
ON CONFLICT (canvas_id, block_id) DO UPDATE SET holder_id = excluded.holder_id,
	 expires_at = excluded.expires_at`), lease.CanvasID, lease.BlockID, holderID, lease.ExpiresAt); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return lease, nil
}

func (s *Service) ReleaseMarkdownLease(ctx context.Context, canvasID, blockID, holderID string) error {
	resolvedHolderID, err := resolveLeaseHolder(ctx, holderID)
	if err != nil {
		return err
	}
	if _, err := s.GetCanvas(ctx, canvasID); err != nil {
		return err
	}
	result, err := s.repo.db.ExecContext(ctx, s.repo.db.Rebind(`
DELETE FROM canvas_markdown_leases WHERE canvas_id = ? AND block_id = ? AND holder_id = ?`),
		canvasID, blockID, resolvedHolderID)
	if err != nil {
		return err
	}
	return requireOneRow(result, ErrCanvasNotFound)
}

func requireMarkdownLease(ctx context.Context, tx *sqlx.Tx, canvas *Canvas, blockID, holderID string, now time.Time) error {
	var current MarkdownLease
	leaseErr := tx.GetContext(ctx, &current, tx.Rebind(`
SELECT canvas_id, block_id, holder_id, expires_at FROM canvas_markdown_leases
WHERE canvas_id = ? AND block_id = ?`), canvas.ID, blockID)
	holderID, holderErr := resolveLeaseHolder(ctx, holderID)
	if holderErr != nil || holderID == "" || leaseErr != nil {
		lease := &CanvasLeaseState{Holder: "none"}
		if leaseErr == nil {
			lease = leaseState(current, now, holderID)
		}
		return newCanvasConflictError(CanvasBusyCode, ErrLeaseUnavailable, canvas, canvasBlock(canvas, blockID), nil, lease)
	}
	if !current.ExpiresAt.After(now) || current.HolderID != holderID {
		return newCanvasConflictError(CanvasBusyCode, ErrLeaseUnavailable, canvas, canvasBlock(canvas, blockID), nil, leaseState(current, now, holderID))
	}
	return nil
}

func leaseState(current MarkdownLease, now time.Time, holderID string) *CanvasLeaseState {
	if !current.ExpiresAt.After(now) {
		return &CanvasLeaseState{Holder: "none"}
	}
	holder := "other"
	if current.HolderID == holderID {
		holder = "self"
	}
	expiresAt := current.ExpiresAt
	return &CanvasLeaseState{Active: true, Holder: holder, ExpiresAt: &expiresAt}
}

func resolveLeaseHolder(ctx context.Context, requested string) (string, error) {
	requested = strings.TrimSpace(requested)
	identity, ok := authn.IdentityFromContext(ctx)
	if !ok || identity.Synthetic {
		return requested, nil
	}
	if requested == "" {
		if identity.SessionID != "" {
			return identity.SessionID, nil
		}
		return identity.UserID, nil
	}
	if requested != identity.UserID && requested != identity.SessionID && requested != identity.TokenID {
		if identity.UserID == "" {
			return "", ErrLeaseUnavailable
		}
		scope := identity.UserID
		if identity.SessionID != "" {
			scope += "\x00session:" + identity.SessionID
		} else if identity.TokenID != "" {
			scope += "\x00token:" + identity.TokenID
		}
		digest := sha256.Sum256([]byte(scope + "\x00holder:" + requested))
		return "auth:" + hex.EncodeToString(digest[:]), nil
	}
	return requested, nil
}

func hasMarkdownBlock(blocks []Block, blockID string) bool {
	for _, block := range blocks {
		if block.ID == blockID && block.Type == BlockTypeMarkdown {
			return true
		}
	}
	return false
}
