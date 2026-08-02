package state

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db"
)

func TestUserStoreSetThenGetReturnsStoredValue(t *testing.T) {
	store := newTestUserStore(t)
	ctx := context.Background()

	value := json.RawMessage(`{"text":"hello"}`)
	if _, err := store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note", value, nil); err != nil {
		t.Fatalf("set: %v", err)
	}

	got, _, found, err := store.Get(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !found {
		t.Fatalf("expected found = true")
	}
	if string(got) != string(value) {
		t.Fatalf("got %q, want %q", got, value)
	}
}

func TestUserStoreGetMissingReturnsNotFound(t *testing.T) {
	store := newTestUserStore(t)
	ctx := context.Background()

	got, _, found, err := store.Get(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "missing")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if found || got != nil {
		t.Fatalf("got (%q, %v), want (nil, false)", got, found)
	}
}

// TestUserStoreIsolatesByUser pins the core trust boundary of
// plugin_user_state: two different users writing the same
// plugin/scope/scopeID/key must never see each other's value (a different
// user's Get returns not-found, matching AC15's cross-user 404).
func TestUserStoreIsolatesByUser(t *testing.T) {
	store := newTestUserStore(t)
	ctx := context.Background()

	if _, err := store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note", json.RawMessage(`"alice's note"`), nil); err != nil {
		t.Fatalf("set user_1: %v", err)
	}

	got, _, found, err := store.Get(ctx, "kandev-plugin-notes", "user_2", "task", "task_xyz", "note")
	if err != nil {
		t.Fatalf("get user_2: %v", err)
	}
	if found {
		t.Fatalf("expected user_2 to not see user_1's note, got %q", got)
	}

	// user_1 still sees their own value.
	got, _, found, err = store.Get(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note")
	if err != nil {
		t.Fatalf("get user_1: %v", err)
	}
	if !found || string(got) != `"alice's note"` {
		t.Fatalf("got (%q, %v), want (\"alice's note\", true)", got, found)
	}
}

func TestUserStoreSetUpsertsOnRepeatedWrite(t *testing.T) {
	store := newTestUserStore(t)
	ctx := context.Background()

	if _, err := store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note", json.RawMessage(`"v1"`), nil); err != nil {
		t.Fatalf("first set: %v", err)
	}
	if _, err := store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note", json.RawMessage(`"v2"`), nil); err != nil {
		t.Fatalf("second set: %v", err)
	}

	got, _, found, err := store.Get(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !found || string(got) != `"v2"` {
		t.Fatalf("got (%q, %v), want (\"v2\", true) (upsert should overwrite)", got, found)
	}

	entries, err := store.List(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected exactly 1 entry after repeated Set, got %d: %+v", len(entries), entries)
	}
}

// TestUserStoreDistinctKeysAreIndependent pins AC27: writes to distinct keys
// never clobber one another.
func TestUserStoreDistinctKeysAreIndependent(t *testing.T) {
	store := newTestUserStore(t)
	ctx := context.Background()

	if _, err := store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "a", json.RawMessage(`1`), nil); err != nil {
		t.Fatalf("set a: %v", err)
	}
	if _, err := store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "b", json.RawMessage(`2`), nil); err != nil {
		t.Fatalf("set b: %v", err)
	}

	gotA, _, _, err := store.Get(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "a")
	if err != nil {
		t.Fatalf("get a: %v", err)
	}
	gotB, _, _, err := store.Get(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "b")
	if err != nil {
		t.Fatalf("get b: %v", err)
	}
	if string(gotA) != "1" || string(gotB) != "2" {
		t.Fatalf("got a=%q b=%q, want a=1 b=2 (independent)", gotA, gotB)
	}
}

// TestUserStoreListReturnsOrderedByKey pins AC27's ordering contract, mirroring
// Store.List's ORDER BY state_key.
func TestUserStoreListReturnsOrderedByKey(t *testing.T) {
	store := newTestUserStore(t)
	ctx := context.Background()

	for _, key := range []string{"zeta", "alpha", "mu"} {
		if _, err := store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", key, json.RawMessage(`1`), nil); err != nil {
			t.Fatalf("set %s: %v", key, err)
		}
	}

	entries, err := store.List(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(entries))
	}
	want := []string{"alpha", "mu", "zeta"}
	for i, e := range entries {
		if e.Key != want[i] {
			t.Fatalf("entries[%d].Key = %q, want %q (order: %+v)", i, e.Key, want[i], entries)
		}
	}
}

func TestUserStoreListDoesNotLeakAcrossUsers(t *testing.T) {
	store := newTestUserStore(t)
	ctx := context.Background()

	if _, err := store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note", json.RawMessage(`"a"`), nil); err != nil {
		t.Fatalf("set user_1: %v", err)
	}

	entries, err := store.List(ctx, "kandev-plugin-notes", "user_2", "task", "task_xyz")
	if err != nil {
		t.Fatalf("list user_2: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("expected no entries visible to user_2, got %+v", entries)
	}
}

func TestUserStoreDeleteRemovesEntry(t *testing.T) {
	store := newTestUserStore(t)
	ctx := context.Background()

	if _, err := store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note", json.RawMessage(`"a"`), nil); err != nil {
		t.Fatalf("set: %v", err)
	}
	if err := store.Delete(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note"); err != nil {
		t.Fatalf("delete: %v", err)
	}

	_, _, found, err := store.Get(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note")
	if err != nil {
		t.Fatalf("get after delete: %v", err)
	}
	if found {
		t.Fatalf("expected not found after delete")
	}
}

func TestUserStoreDeleteMissingIsNotAnError(t *testing.T) {
	store := newTestUserStore(t)
	ctx := context.Background()

	if err := store.Delete(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "never_set"); err != nil {
		t.Fatalf("delete missing: %v", err)
	}
}

// TestUserStoreDeleteAllForPluginPurgesEveryUser pins AC20: uninstalling a
// plugin must purge plugin_user_state rows for every user, not just one.
func TestUserStoreDeleteAllForPluginPurgesEveryUser(t *testing.T) {
	store := newTestUserStore(t)
	ctx := context.Background()

	if _, err := store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note", json.RawMessage(`"a"`), nil); err != nil {
		t.Fatalf("set user_1: %v", err)
	}
	if _, err := store.Set(ctx, "kandev-plugin-notes", "user_2", "task", "task_xyz", "note", json.RawMessage(`"b"`), nil); err != nil {
		t.Fatalf("set user_2: %v", err)
	}
	if _, err := store.Set(ctx, "kandev-plugin-other", "user_1", "task", "task_xyz", "note", json.RawMessage(`"c"`), nil); err != nil {
		t.Fatalf("set other plugin: %v", err)
	}

	if err := store.DeleteAllForPlugin(ctx, "kandev-plugin-notes"); err != nil {
		t.Fatalf("DeleteAllForPlugin: %v", err)
	}

	if entries, err := store.List(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz"); err != nil || len(entries) != 0 {
		t.Fatalf("user_1 entries after DeleteAllForPlugin = %v (err=%v), want none", entries, err)
	}
	if entries, err := store.List(ctx, "kandev-plugin-notes", "user_2", "task", "task_xyz"); err != nil || len(entries) != 0 {
		t.Fatalf("user_2 entries after DeleteAllForPlugin = %v (err=%v), want none", entries, err)
	}
	// A different plugin's state is untouched.
	if entries, err := store.List(ctx, "kandev-plugin-other", "user_1", "task", "task_xyz"); err != nil || len(entries) != 1 {
		t.Fatalf("kandev-plugin-other entries after deleting kandev-plugin-notes = %v (err=%v), want 1 (untouched)", entries, err)
	}
}

// TestUserStoreDeleteAllForUserPurgesEveryPlugin covers the DeleteAllForUser
// helper (R6: a future user-deletion cascade hook).
func TestUserStoreDeleteAllForUserPurgesEveryPlugin(t *testing.T) {
	store := newTestUserStore(t)
	ctx := context.Background()

	if _, err := store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note", json.RawMessage(`"a"`), nil); err != nil {
		t.Fatalf("set plugin-notes: %v", err)
	}
	if _, err := store.Set(ctx, "kandev-plugin-other", "user_1", "task", "task_xyz", "note", json.RawMessage(`"b"`), nil); err != nil {
		t.Fatalf("set plugin-other: %v", err)
	}
	if _, err := store.Set(ctx, "kandev-plugin-notes", "user_2", "task", "task_xyz", "note", json.RawMessage(`"c"`), nil); err != nil {
		t.Fatalf("set user_2: %v", err)
	}

	if err := store.DeleteAllForUser(ctx, "user_1"); err != nil {
		t.Fatalf("DeleteAllForUser: %v", err)
	}

	if entries, err := store.List(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz"); err != nil || len(entries) != 0 {
		t.Fatalf("user_1/plugin-notes entries after DeleteAllForUser = %v (err=%v), want none", entries, err)
	}
	if entries, err := store.List(ctx, "kandev-plugin-other", "user_1", "task", "task_xyz"); err != nil || len(entries) != 0 {
		t.Fatalf("user_1/plugin-other entries after DeleteAllForUser = %v (err=%v), want none", entries, err)
	}
	if entries, err := store.List(ctx, "kandev-plugin-notes", "user_2", "task", "task_xyz"); err != nil || len(entries) != 1 {
		t.Fatalf("user_2 entries after deleting user_1 = %v (err=%v), want 1 (untouched)", entries, err)
	}
}

// TestUserStoreSetConditionalWriteConflict pins Approach H1 / AC28: a write
// carrying ifUnmodifiedSince older than the stored row's updated_at is
// rejected with ErrConflict and the stored value is left unchanged.
func TestUserStoreSetConditionalWriteConflict(t *testing.T) {
	store := newTestUserStore(t)
	ctx := context.Background()

	firstUpdatedAt, err := store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note", json.RawMessage(`"v1"`), nil)
	if err != nil {
		t.Fatalf("first set: %v", err)
	}

	stale := firstUpdatedAt.Add(-time.Minute)
	_, err = store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note", json.RawMessage(`"v2-conflict"`), &stale)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected ErrConflict, got %v", err)
	}

	got, _, _, err := store.Get(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if string(got) != `"v1"` {
		t.Fatalf("stored value changed after a conflicting write: got %q, want \"v1\"", got)
	}
}

// TestUserStoreSetConditionalWriteAcceptsCurrent pins the non-conflict path:
// a write carrying the current stored updated_at (or later) succeeds.
func TestUserStoreSetConditionalWriteAcceptsCurrent(t *testing.T) {
	store := newTestUserStore(t)
	ctx := context.Background()

	firstUpdatedAt, err := store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note", json.RawMessage(`"v1"`), nil)
	if err != nil {
		t.Fatalf("first set: %v", err)
	}

	if _, err := store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note", json.RawMessage(`"v2"`), &firstUpdatedAt); err != nil {
		t.Fatalf("second set (current updatedAt): %v", err)
	}

	got, _, _, err := store.Get(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if string(got) != `"v2"` {
		t.Fatalf("got %q, want \"v2\"", got)
	}
}

// TestUserStoreSetConditionalWriteAllowsFirstWrite pins that
// ifUnmodifiedSince is a no-op when no row exists yet — a plugin creating a
// document for the first time never needs a nil-vs-zero special case.
func TestUserStoreSetConditionalWriteAllowsFirstWrite(t *testing.T) {
	store := newTestUserStore(t)
	ctx := context.Background()

	since := time.Now().UTC()
	if _, err := store.Set(ctx, "kandev-plugin-notes", "user_1", "task", "task_xyz", "note", json.RawMessage(`"v1"`), &since); err != nil {
		t.Fatalf("first set with ifUnmodifiedSince and no existing row: %v", err)
	}
}

func TestUserStoreInitSchemaIsIdempotent(t *testing.T) {
	conn := newUserStoreSQLite(t)
	if _, err := NewUserStore(db.NewPool(conn, conn)); err != nil {
		t.Fatalf("first NewUserStore: %v", err)
	}
	if _, err := NewUserStore(db.NewPool(conn, conn)); err != nil {
		t.Fatalf("second NewUserStore (re-init on existing schema): %v", err)
	}
}

func newTestUserStore(t *testing.T) *UserStore {
	t.Helper()
	conn := newUserStoreSQLite(t)
	store, err := NewUserStore(db.NewPool(conn, conn))
	if err != nil {
		t.Fatalf("new user store: %v", err)
	}
	return store
}

func newUserStoreSQLite(t *testing.T) *sqlx.DB {
	t.Helper()
	conn, err := sqlx.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	conn.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}
