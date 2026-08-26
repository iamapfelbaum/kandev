package canvas

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/common/logger"
)

// Repository stores the server-owned canvas state and event log.
type Repository struct {
	db       *sqlx.DB
	ro       *sqlx.DB
	mu       sync.Mutex
	clockNow func() time.Time
}

type queryer interface {
	GetContext(context.Context, interface{}, string, ...interface{}) error
	SelectContext(context.Context, interface{}, string, ...interface{}) error
	Rebind(string) string
}

func NewRepository(writer, reader *sqlx.DB, _ *logger.Logger) (*Repository, error) {
	if writer == nil || reader == nil {
		return nil, fmt.Errorf("canvas database connections are required")
	}
	r := &Repository{db: writer, ro: reader}
	if err := r.initSchema(); err != nil {
		return nil, fmt.Errorf("canvas schema init: %w", err)
	}
	return r, nil
}

func (r *Repository) nowUTC() time.Time {
	if r.clockNow != nil {
		return r.clockNow().UTC()
	}
	return time.Now().UTC()
}

func (r *Repository) initSchema() error {
	_, err := r.db.Exec(`
CREATE TABLE IF NOT EXISTS canvases (
 id TEXT PRIMARY KEY,
 owner_user_id TEXT NOT NULL DEFAULT '',
 workspace_id TEXT NOT NULL,
 title TEXT NOT NULL,
 schema_version INTEGER NOT NULL DEFAULT 1,
 revision BIGINT NOT NULL DEFAULT 0,
 compacted_through_revision BIGINT NOT NULL DEFAULT 0,
 source_export_id TEXT,
 imported_at TIMESTAMP,
 archived_at TIMESTAMP,
 created_at TIMESTAMP NOT NULL,
 updated_at TIMESTAMP NOT NULL,
 FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_canvases_workspace_active
 ON canvases(workspace_id, archived_at, updated_at DESC);
CREATE TABLE IF NOT EXISTS canvas_task_links (
 canvas_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 linked_by TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMP NOT NULL,
 PRIMARY KEY (canvas_id, task_id),
 FOREIGN KEY (canvas_id) REFERENCES canvases(id) ON DELETE CASCADE,
 FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_canvas_task_links_task ON canvas_task_links(task_id);
CREATE TABLE IF NOT EXISTS canvas_blocks (
 canvas_id TEXT NOT NULL,
 block_id TEXT NOT NULL,
 block_type TEXT NOT NULL,
 position INTEGER NOT NULL,
 state_json TEXT NOT NULL,
 block_revision BIGINT NOT NULL DEFAULT 0,
 created_at TIMESTAMP NOT NULL,
 updated_at TIMESTAMP NOT NULL,
 PRIMARY KEY (canvas_id, block_id),
 FOREIGN KEY (canvas_id) REFERENCES canvases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_canvas_blocks_position
 ON canvas_blocks(canvas_id, position, block_id);
CREATE TABLE IF NOT EXISTS canvas_events (
 canvas_id TEXT NOT NULL,
 revision BIGINT NOT NULL,
 command_id TEXT NOT NULL UNIQUE,
 actor_kind TEXT NOT NULL DEFAULT '',
 actor_id TEXT NOT NULL DEFAULT '',
 action TEXT NOT NULL,
 target_id TEXT NOT NULL DEFAULT '',
 payload_json TEXT NOT NULL DEFAULT '{}',
 created_at TIMESTAMP NOT NULL,
 PRIMARY KEY (canvas_id, revision),
 FOREIGN KEY (canvas_id) REFERENCES canvases(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_canvas_events_canvas_revision
 ON canvas_events(canvas_id, revision);
CREATE TABLE IF NOT EXISTS canvas_command_receipts (
 command_id TEXT PRIMARY KEY,
 canvas_id TEXT NOT NULL,
 result_json TEXT NOT NULL,
 resulting_revision BIGINT NOT NULL,
 created_at TIMESTAMP NOT NULL,
 FOREIGN KEY (canvas_id) REFERENCES canvases(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS canvas_markdown_leases (
 canvas_id TEXT NOT NULL,
 block_id TEXT NOT NULL,
 holder_id TEXT NOT NULL,
 expires_at TIMESTAMP NOT NULL,
 PRIMARY KEY (canvas_id, block_id),
 FOREIGN KEY (canvas_id, block_id) REFERENCES canvas_blocks(canvas_id, block_id) ON DELETE CASCADE
);`)
	return err
}

func (r *Repository) CreateCanvas(ctx context.Context, canvas *Canvas) error {
	_, err := r.db.ExecContext(ctx, r.db.Rebind(`
INSERT INTO canvases (id, owner_user_id, workspace_id, title, schema_version,
 revision, compacted_through_revision, source_export_id, imported_at,
 archived_at, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`), canvas.ID, canvas.OwnerUserID,
		canvas.WorkspaceID, canvas.Title, canvas.SchemaVersion, canvas.Revision,
		canvas.CompactedThroughRevision, canvas.SourceExportID, canvas.ImportedAt,
		canvas.ArchivedAt, canvas.CreatedAt, canvas.UpdatedAt)
	return err
}

func (r *Repository) GetCanvas(ctx context.Context, canvasID string) (*Canvas, error) {
	canvas, err := scanCanvas(ctx, r.ro, canvasID)
	if err != nil {
		return nil, err
	}
	if err := r.loadChildren(ctx, r.ro, canvas); err != nil {
		return nil, err
	}
	return canvas, nil
}

func (r *Repository) ListCanvases(ctx context.Context, workspaceID string, includeArchived bool) ([]*Canvas, error) {
	query := `SELECT id, owner_user_id, workspace_id, title, schema_version,
 revision, compacted_through_revision, source_export_id, imported_at,
 archived_at, created_at, updated_at FROM canvases WHERE workspace_id = ?`
	if !includeArchived {
		query += " AND archived_at IS NULL"
	}
	query += " ORDER BY updated_at DESC, id"
	var rows []*Canvas
	if err := r.ro.SelectContext(ctx, &rows, r.ro.Rebind(query), workspaceID); err != nil {
		return nil, err
	}
	for _, canvas := range rows {
		if err := r.loadChildren(ctx, r.ro, canvas); err != nil {
			return nil, err
		}
	}
	return rows, nil
}

func (r *Repository) UpdateTitle(ctx context.Context, canvasID, title string, updatedAt time.Time) error {
	result, err := r.db.ExecContext(ctx, r.db.Rebind(
		`UPDATE canvases SET title = ?, updated_at = ? WHERE id = ?`), title, updatedAt, canvasID)
	if err != nil {
		return err
	}
	return requireOneRow(result, ErrCanvasNotFound)
}

func (r *Repository) SetArchived(ctx context.Context, canvasID string, archivedAt *time.Time, updatedAt time.Time) error {
	result, err := r.db.ExecContext(ctx, r.db.Rebind(
		`UPDATE canvases SET archived_at = ?, updated_at = ? WHERE id = ?`), archivedAt, updatedAt, canvasID)
	if err != nil {
		return err
	}
	return requireOneRow(result, ErrCanvasNotFound)
}

func (r *Repository) DeleteCanvas(ctx context.Context, canvasID string) error {
	result, err := r.db.ExecContext(ctx, r.db.Rebind(`DELETE FROM canvases WHERE id = ?`), canvasID)
	if err != nil {
		return err
	}
	return requireOneRow(result, ErrCanvasNotFound)
}

func (r *Repository) AddTaskLink(ctx context.Context, link TaskLink) error {
	_, err := r.db.ExecContext(ctx, r.db.Rebind(`
INSERT INTO canvas_task_links (canvas_id, task_id, linked_by, created_at)
VALUES (?, ?, ?, ?)
ON CONFLICT (canvas_id, task_id) DO NOTHING`), link.CanvasID, link.TaskID, link.LinkedBy, link.CreatedAt)
	return err
}

func (r *Repository) DeleteTaskLink(ctx context.Context, canvasID, taskID string) error {
	result, err := r.db.ExecContext(ctx, r.db.Rebind(
		`DELETE FROM canvas_task_links WHERE canvas_id = ? AND task_id = ?`), canvasID, taskID)
	if err != nil {
		return err
	}
	return requireOneRow(result, ErrCanvasNotFound)
}

func (r *Repository) EventsAfter(ctx context.Context, canvasID string, afterRevision int64) ([]CanvasEvent, error) {
	var events []CanvasEvent
	err := r.ro.SelectContext(ctx, &events, r.ro.Rebind(`
SELECT canvas_id, revision, command_id, actor_kind, actor_id, action,
 target_id, payload_json, created_at FROM canvas_events
WHERE canvas_id = ? AND revision > ? ORDER BY revision LIMIT ?`),
		canvasID, afterRevision, MaxEventCount)
	return events, err
}

func compactEvents(ctx context.Context, tx *sqlx.Tx, canvas *Canvas) error {
	through := canvas.Revision - MaxEventCount
	if through <= canvas.CompactedThroughRevision {
		return nil
	}
	if _, err := tx.ExecContext(ctx, tx.Rebind(`
DELETE FROM canvas_events WHERE canvas_id = ? AND revision <= ?`), canvas.ID, through); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, tx.Rebind(`
UPDATE canvases SET compacted_through_revision = ? WHERE id = ?`), through, canvas.ID); err != nil {
		return err
	}
	canvas.CompactedThroughRevision = through
	return nil
}

func requireOneRow(result sql.Result, notFound error) error {
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return notFound
	}
	return nil
}

func scanCanvas(ctx context.Context, db queryer, canvasID string) (*Canvas, error) {
	var canvas Canvas
	err := db.GetContext(ctx, &canvas, db.Rebind(`
SELECT id, owner_user_id, workspace_id, title, schema_version, revision,
 compacted_through_revision, source_export_id, imported_at, archived_at,
 created_at, updated_at FROM canvases WHERE id = ?`), canvasID)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, ErrCanvasNotFound
		}
		return nil, err
	}
	return &canvas, nil
}

func (r *Repository) loadChildren(ctx context.Context, db queryer, canvas *Canvas) error {
	if err := db.SelectContext(ctx, &canvas.Blocks, db.Rebind(`
SELECT block_id AS id, canvas_id, block_type, position, state_json,
 block_revision, created_at, updated_at FROM canvas_blocks
WHERE canvas_id = ? ORDER BY position, block_id`), canvas.ID); err != nil {
		return err
	}
	if canvas.Blocks == nil {
		canvas.Blocks = []Block{}
	}
	if err := db.SelectContext(ctx, &canvas.TaskLinks, db.Rebind(`
SELECT canvas_id, task_id, linked_by, created_at FROM canvas_task_links
WHERE canvas_id = ? ORDER BY created_at, task_id`), canvas.ID); err != nil {
		return err
	}
	if canvas.TaskLinks == nil {
		canvas.TaskLinks = []TaskLink{}
	}
	return nil
}

func marshalJSON(value any) ([]byte, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return data, nil
}

func newID() string { return uuid.NewString() }
