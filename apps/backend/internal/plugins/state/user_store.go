package state

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db"
)

// ErrConflict is returned by UserStore.Set when the caller supplies
// ifUnmodifiedSince and the stored row was modified after that time
// (Approach H1's optimistic-concurrency guard, AC28). The stored value is
// left unchanged.
var ErrConflict = errors.New("plugin user state: conflict")

// UserStateEntry is a single row returned by UserStore.List.
type UserStateEntry struct {
	Key       string          `db:"state_key" json:"key"`
	Value     json.RawMessage `db:"value_json" json:"value"`
	UpdatedAt time.Time       `db:"updated_at" json:"updatedAt"`
}

// UserStore persists per-user, browser-authenticated plugin state in the
// plugin_user_state table — the counterpart to Store (plugin_state), which
// has no user dimension and is only ever written by a plugin's own
// gRPC-connected backend. A row here is keyed by
// (plugin_id, user_id, scope, scope_id, state_key); no plugin or user can
// read another's row (docs/decisions/2026-08-01-per-user-plugin-storage.md).
type UserStore struct {
	db *sqlx.DB
	ro *sqlx.DB
}

// NewUserStore creates a UserStore and initializes the plugin_user_state
// schema if needed.
func NewUserStore(pool *db.Pool) (*UserStore, error) {
	s := &UserStore{db: pool.Writer(), ro: pool.Reader()}
	if err := s.initSchema(); err != nil {
		return nil, fmt.Errorf("plugin user state schema init: %w", err)
	}
	return s, nil
}

// initSchema creates the plugin_user_state table. scope_id follows Store's
// convention (NOT NULL DEFAULT ”) rather than a nullable column, for the
// same reason: SQLite's UNIQUE index treats every NULL as distinct, so a
// nullable scope_id would let ON CONFLICT silently miss conflicts between
// instance-scoped rows.
func (s *UserStore) initSchema() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS plugin_user_state (
			id TEXT PRIMARY KEY,
			plugin_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			scope TEXT NOT NULL DEFAULT 'instance',
			scope_id TEXT NOT NULL DEFAULT '',
			state_key TEXT NOT NULL,
			value_json TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE (plugin_id, user_id, scope, scope_id, state_key)
		);
	`)
	return err
}

// Get returns the value and updated_at stored for the given
// plugin/user/scope/scopeID/key. found is false if no row exists.
func (s *UserStore) Get(
	ctx context.Context, pluginID, userID, scope, scopeID, key string,
) (json.RawMessage, time.Time, bool, error) {
	var raw, updatedAtStr string
	err := s.ro.QueryRowContext(ctx, s.ro.Rebind(`
		SELECT value_json, updated_at FROM plugin_user_state
		WHERE plugin_id = ? AND user_id = ? AND scope = ? AND scope_id = ? AND state_key = ?
	`), pluginID, userID, scope, scopeID, key).Scan(&raw, &updatedAtStr)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, time.Time{}, false, nil
		}
		return nil, time.Time{}, false, err
	}
	updatedAt, err := time.Parse(time.RFC3339, updatedAtStr)
	if err != nil {
		return nil, time.Time{}, false, fmt.Errorf("parse updated_at for key %q: %w", key, err)
	}
	return json.RawMessage(raw), updatedAt, true, nil
}

// Set upserts the value for the given plugin/user/scope/scopeID/key, setting
// updated_at to the current time (returned) in RFC3339 UTC. When
// ifUnmodifiedSince is non-nil, the write is rejected with ErrConflict if a
// stored row already exists with updated_at strictly after that time — the
// caller lost a race and should refetch (Approach H1, AC28). A nil
// ifUnmodifiedSince, or no existing row, always writes (today's unconditional
// last-write-wins). The read-then-write is wrapped in one transaction so the
// check is atomic against a concurrent Set for the same tuple.
func (s *UserStore) Set(
	ctx context.Context, pluginID, userID, scope, scopeID, key string,
	value json.RawMessage, ifUnmodifiedSince *time.Time,
) (time.Time, error) {
	now := time.Now().UTC()

	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return time.Time{}, err
	}
	defer func() { _ = tx.Rollback() }()

	if ifUnmodifiedSince != nil {
		conflict, err := userStoreHasNewerRow(ctx, tx, pluginID, userID, scope, scopeID, key, *ifUnmodifiedSince)
		if err != nil {
			return time.Time{}, err
		}
		if conflict {
			return time.Time{}, ErrConflict
		}
	}

	if _, err := tx.ExecContext(ctx, tx.Rebind(`
		INSERT INTO plugin_user_state (id, plugin_id, user_id, scope, scope_id, state_key, value_json, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(plugin_id, user_id, scope, scope_id, state_key)
		DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
	`), uuid.New().String(), pluginID, userID, scope, scopeID, key, string(value), now.Format(time.RFC3339)); err != nil {
		return time.Time{}, err
	}

	if err := tx.Commit(); err != nil {
		return time.Time{}, err
	}
	return now, nil
}

// userStoreHasNewerRow reports whether a plugin_user_state row for the given
// tuple exists with updated_at strictly after since. A missing row is not a
// conflict — the caller is creating the document for the first time.
func userStoreHasNewerRow(
	ctx context.Context, tx *sqlx.Tx, pluginID, userID, scope, scopeID, key string, since time.Time,
) (bool, error) {
	var updatedAtStr string
	err := tx.QueryRowContext(ctx, tx.Rebind(`
		SELECT updated_at FROM plugin_user_state
		WHERE plugin_id = ? AND user_id = ? AND scope = ? AND scope_id = ? AND state_key = ?
	`), pluginID, userID, scope, scopeID, key).Scan(&updatedAtStr)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	updatedAt, err := time.Parse(time.RFC3339, updatedAtStr)
	if err != nil {
		return false, fmt.Errorf("parse updated_at: %w", err)
	}
	return updatedAt.After(since), nil
}

// Delete removes the row for the given plugin/user/scope/scopeID/key. It is
// not an error if no matching row exists.
func (s *UserStore) Delete(ctx context.Context, pluginID, userID, scope, scopeID, key string) error {
	_, err := s.db.ExecContext(ctx, s.db.Rebind(`
		DELETE FROM plugin_user_state
		WHERE plugin_id = ? AND user_id = ? AND scope = ? AND scope_id = ? AND state_key = ?
	`), pluginID, userID, scope, scopeID, key)
	return err
}

// List returns every state entry for the given plugin/user/scope/scopeID,
// ordered by key (AC27), mirroring Store.List's ORDER BY state_key.
func (s *UserStore) List(ctx context.Context, pluginID, userID, scope, scopeID string) ([]UserStateEntry, error) {
	rows, err := s.ro.QueryContext(ctx, s.ro.Rebind(`
		SELECT state_key, value_json, updated_at FROM plugin_user_state
		WHERE plugin_id = ? AND user_id = ? AND scope = ? AND scope_id = ?
		ORDER BY state_key
	`), pluginID, userID, scope, scopeID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var entries []UserStateEntry
	for rows.Next() {
		var key, raw, updatedAtStr string
		if err := rows.Scan(&key, &raw, &updatedAtStr); err != nil {
			return nil, err
		}
		updatedAt, err := time.Parse(time.RFC3339, updatedAtStr)
		if err != nil {
			return nil, fmt.Errorf("parse updated_at for key %q: %w", key, err)
		}
		entries = append(entries, UserStateEntry{Key: key, Value: json.RawMessage(raw), UpdatedAt: updatedAt})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return entries, nil
}

// DeleteAllForPlugin removes every plugin_user_state row for pluginID,
// across every user, scope, and scope_id. Called by Service.Uninstall (AC20)
// so a reinstalled or id-reused plugin never inherits stale per-user state.
func (s *UserStore) DeleteAllForPlugin(ctx context.Context, pluginID string) error {
	_, err := s.db.ExecContext(ctx, s.db.Rebind(`
		DELETE FROM plugin_user_state WHERE plugin_id = ?
	`), pluginID)
	return err
}

// DeleteAllForUser removes every plugin_user_state row for userID, across
// every plugin, scope, and scope_id. Not currently wired into a user
// deletion path — no such cascade hook exists yet in this codebase (R6) —
// but exposed so one can call it directly when that hook is added.
func (s *UserStore) DeleteAllForUser(ctx context.Context, userID string) error {
	_, err := s.db.ExecContext(ctx, s.db.Rebind(`
		DELETE FROM plugin_user_state WHERE user_id = ?
	`), userID)
	return err
}
