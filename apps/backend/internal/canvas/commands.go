package canvas

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
)

type blockCommandInput struct {
	ID                    string          `json:"id,omitempty"`
	Type                  string          `json:"type,omitempty"`
	State                 json.RawMessage `json:"state,omitempty"`
	Position              *int            `json:"position,omitempty"`
	ExpectedBlockRevision *int64          `json:"expected_block_revision,omitempty"`
}

type reorderCommandInput struct {
	BlockIDs []string `json:"block_ids"`
}

func applyCommand(ctx context.Context, tx *sqlx.Tx, canvas *Canvas, req ApplyCanvasCommandRequest, now time.Time) error {
	var err error
	switch req.Action {
	case ActionCanvasRename:
		err = applyRename(ctx, tx, canvas, req.Input)
	case ActionBlockCreate:
		err = applyBlockCreate(ctx, tx, canvas, req.Input, now)
	case ActionBlockUpdate:
		err = applyBlockUpdate(ctx, tx, canvas, req, now)
	case ActionItemUpsert, ActionItemDelete, ActionItemMove:
		err = applyItemAction(ctx, tx, canvas, req, now)
	case ActionBlockDelete:
		err = applyBlockDelete(ctx, tx, canvas, req)
	case ActionBlockReorder:
		err = applyBlockReorder(ctx, tx, canvas, req.Input)
	default:
		if isStructuredItemAction(req.Action) {
			var normalized ApplyCanvasCommandRequest
			normalized, err = normalizeStructuredItemCommand(req)
			if err == nil {
				err = applyItemAction(ctx, tx, canvas, normalized, now)
			}
		} else {
			err = fmt.Errorf("%w: unsupported action %q", ErrCanvasValidation, req.Action)
		}
	}
	if err != nil {
		return err
	}
	canvas.Revision++
	canvas.UpdatedAt = now
	_, err = tx.ExecContext(ctx, tx.Rebind(`
UPDATE canvases SET revision = ?, updated_at = ? WHERE id = ?`),
		canvas.Revision, canvas.UpdatedAt, canvas.ID)
	return err
}

func applyRename(ctx context.Context, tx *sqlx.Tx, canvas *Canvas, input json.RawMessage) error {
	var payload struct {
		Title string `json:"title"`
	}
	if err := decodeStrictJSON(input, &payload); err != nil {
		return fmt.Errorf("%w: invalid rename input", ErrCanvasValidation)
	}
	if err := validateTitle(payload.Title); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, tx.Rebind(`UPDATE canvases SET title = ? WHERE id = ?`),
		strings.TrimSpace(payload.Title), canvas.ID)
	return err
}

func applyBlockCreate(ctx context.Context, tx *sqlx.Tx, canvas *Canvas, input json.RawMessage, now time.Time) error {
	var payload blockCommandInput
	if err := decodeStrictJSON(input, &payload); err != nil {
		return fmt.Errorf("%w: invalid block input", ErrCanvasValidation)
	}
	if len(canvas.Blocks) >= MaxBlocks {
		return ErrCanvasLimit
	}
	if err := validateBlock(payload.Type, payload.State); err != nil {
		return err
	}
	if canvasStateBytes(canvas.Blocks)+len(payload.State) > MaxCanvasBytes {
		return ErrCanvasLimit
	}
	position := len(canvas.Blocks)
	if payload.Position != nil {
		position = *payload.Position
	}
	if position < 0 || position > len(canvas.Blocks) {
		return fmt.Errorf("%w: block position is out of range", ErrCanvasValidation)
	}
	if payload.ID == "" {
		payload.ID = newID()
	}
	if err := shiftBlockPositions(ctx, tx, canvas.ID, position, 1); err != nil {
		return err
	}
	return insertBlock(ctx, tx, Block{
		ID: payload.ID, CanvasID: canvas.ID, Type: payload.Type, Position: position,
		State: cloneJSON(payload.State), CreatedAt: now, UpdatedAt: now,
	})
}

func applyBlockUpdate(ctx context.Context, tx *sqlx.Tx, canvas *Canvas, req ApplyCanvasCommandRequest, now time.Time) error {
	if req.TargetID == "" {
		return fmt.Errorf("%w: target_id is required", ErrCanvasValidation)
	}
	var payload blockCommandInput
	if err := decodeStrictJSON(req.Input, &payload); err != nil {
		return fmt.Errorf("%w: invalid block input", ErrCanvasValidation)
	}
	var current Block
	if err := tx.GetContext(ctx, &current, tx.Rebind(`
SELECT block_id AS id, canvas_id, block_type, position, state_json,
 block_revision, created_at, updated_at FROM canvas_blocks
WHERE canvas_id = ? AND block_id = ?`), canvas.ID, req.TargetID); err != nil {
		if err == sql.ErrNoRows {
			return ErrCanvasNotFound
		}
		return err
	}
	if payload.Type == "" {
		payload.Type = current.Type
	}
	if err := validateBlock(payload.Type, payload.State); err != nil {
		return err
	}
	if canvasStateBytes(canvas.Blocks)-len(current.State)+len(payload.State) > MaxCanvasBytes {
		return ErrCanvasLimit
	}
	if payload.ExpectedBlockRevision != nil {
		if current.BlockRevision != *payload.ExpectedBlockRevision {
			return fmt.Errorf("%w: block revision is %d", ErrRevisionConflict, current.BlockRevision)
		}
	}
	if current.Type == BlockTypeMarkdown || payload.Type == BlockTypeMarkdown {
		if payload.ExpectedBlockRevision == nil {
			return fmt.Errorf("%w: markdown updates require block revision", ErrRevisionConflict)
		}
		if err := requireMarkdownLease(ctx, tx, canvas.ID, req.TargetID, req.LeaseHolderID, now); err != nil {
			return err
		}
	}
	result, err := tx.ExecContext(ctx, tx.Rebind(`
UPDATE canvas_blocks SET block_type = ?, state_json = ?,
 block_revision = block_revision + 1, updated_at = ?
WHERE canvas_id = ? AND block_id = ?`), payload.Type, payload.State, now, canvas.ID, req.TargetID)
	if err != nil {
		return err
	}
	return requireOneRow(result, ErrCanvasNotFound)
}

func applyBlockDelete(ctx context.Context, tx *sqlx.Tx, canvas *Canvas, req ApplyCanvasCommandRequest) error {
	if req.TargetID == "" {
		return fmt.Errorf("%w: target_id is required", ErrCanvasValidation)
	}
	var position int
	if err := tx.GetContext(ctx, &position, tx.Rebind(
		`SELECT position FROM canvas_blocks WHERE canvas_id = ? AND block_id = ?`), canvas.ID, req.TargetID); err != nil {
		return ErrCanvasNotFound
	}
	result, err := tx.ExecContext(ctx, tx.Rebind(
		`DELETE FROM canvas_blocks WHERE canvas_id = ? AND block_id = ?`), canvas.ID, req.TargetID)
	if err != nil {
		return err
	}
	if err := requireOneRow(result, ErrCanvasNotFound); err != nil {
		return err
	}
	return shiftBlockPositions(ctx, tx, canvas.ID, position, -1)
}

func applyBlockReorder(ctx context.Context, tx *sqlx.Tx, canvas *Canvas, input json.RawMessage) error {
	var payload reorderCommandInput
	if err := decodeStrictJSON(input, &payload); err != nil {
		return fmt.Errorf("%w: invalid reorder input", ErrCanvasValidation)
	}
	if len(payload.BlockIDs) != len(canvas.Blocks) || !sameBlockIDs(payload.BlockIDs, canvas.Blocks) {
		return fmt.Errorf("%w: block_ids must contain every block exactly once", ErrCanvasValidation)
	}
	for position, blockID := range payload.BlockIDs {
		if _, err := tx.ExecContext(ctx, tx.Rebind(`
UPDATE canvas_blocks SET position = ? WHERE canvas_id = ? AND block_id = ?`),
			position, canvas.ID, blockID); err != nil {
			return err
		}
	}
	return nil
}

func decodeStrictJSON(input json.RawMessage, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("multiple JSON values")
		}
		return err
	}
	return nil
}

func canvasStateBytes(blocks []Block) int {
	total := 0
	for _, block := range blocks {
		total += len(block.State)
	}
	return total
}

func shiftBlockPositions(ctx context.Context, tx *sqlx.Tx, canvasID string, position, delta int) error {
	if delta > 0 {
		_, err := tx.ExecContext(ctx, tx.Rebind(`
UPDATE canvas_blocks SET position = position + 1 WHERE canvas_id = ? AND position >= ?`), canvasID, position)
		return err
	}
	_, err := tx.ExecContext(ctx, tx.Rebind(`
UPDATE canvas_blocks SET position = position - 1 WHERE canvas_id = ? AND position > ?`), canvasID, position)
	return err
}

func insertCanvas(ctx context.Context, tx *sqlx.Tx, canvas *Canvas) error {
	_, err := tx.ExecContext(ctx, tx.Rebind(`
INSERT INTO canvases (id, owner_user_id, workspace_id, title, schema_version,
 revision, compacted_through_revision, source_export_id, imported_at,
 archived_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`), canvas.ID, canvas.OwnerUserID,
		canvas.WorkspaceID, canvas.Title, canvas.SchemaVersion, canvas.Revision,
		canvas.CompactedThroughRevision, canvas.SourceExportID, canvas.ImportedAt,
		canvas.ArchivedAt, canvas.CreatedAt, canvas.UpdatedAt)
	return err
}

func insertBlock(ctx context.Context, tx *sqlx.Tx, block Block) error {
	_, err := tx.ExecContext(ctx, tx.Rebind(`
INSERT INTO canvas_blocks (canvas_id, block_id, block_type, position, state_json,
 block_revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
		block.CanvasID, block.ID, block.Type, block.Position, block.State,
		block.BlockRevision, block.CreatedAt, block.UpdatedAt)
	return err
}

func sameBlockIDs(ids []string, blocks []Block) bool {
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			return false
		}
		seen[id] = true
	}
	for _, block := range blocks {
		if !seen[block.ID] {
			return false
		}
	}
	return true
}
