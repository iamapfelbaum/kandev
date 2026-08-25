package sqlite

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db"
)

func newPlacementRepo(t *testing.T) (*Repository, *sqlx.DB) {
	t.Helper()
	conn, err := db.OpenSQLite(filepath.Join(t.TempDir(), "placement.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlxDB := sqlx.NewDb(conn, "sqlite3")
	t.Cleanup(func() { _ = sqlxDB.Close() })
	repo, err := NewWithDB(sqlxDB, sqlxDB, nil)
	if err != nil {
		t.Fatalf("new repository: %v", err)
	}
	return repo, sqlxDB
}

// The placement column is what ties a workspace to the unit tree. Losing it
// leaves every workspace unplaced, which resolves as unreachable rather than
// as an error, so the symptom is silence.
func TestWorkspaceUnitColumnExistsAfterInit(t *testing.T) {
	_, sqlxDB := newPlacementRepo(t)

	var count int
	if err := sqlxDB.Get(&count, `
		SELECT COUNT(*) FROM pragma_table_info('workspaces') WHERE name = 'unit_id'
	`); err != nil {
		t.Fatalf("inspect workspaces schema: %v", err)
	}
	if count != 1 {
		t.Fatal("workspaces.unit_id missing after schema init")
	}
}

// The occupancy count is the only thing standing between a delete and a
// stranded workspace, so it has to count the unit asked about and nothing else.
func TestCountWorkspacesInUnit(t *testing.T) {
	ctx := context.Background()
	repo, sqlxDB := newPlacementRepo(t)

	for _, row := range []struct{ id, unit string }{
		{"ws-1", "unit-a"},
		{"ws-2", "unit-a"},
		{"ws-3", "unit-b"},
		{"ws-4", ""},
	} {
		if _, err := sqlxDB.Exec(
			`INSERT INTO workspaces (id, name, owner_id, unit_id, created_at, updated_at)
			 VALUES (?, ?, '', ?, datetime('now'), datetime('now'))`,
			row.id, row.id, row.unit); err != nil {
			t.Fatalf("insert %s: %v", row.id, err)
		}
	}

	for unit, want := range map[string]int{"unit-a": 2, "unit-b": 1, "unit-c": 0} {
		got, err := repo.CountWorkspacesInUnit(ctx, unit)
		if err != nil {
			t.Fatalf("count %s: %v", unit, err)
		}
		if got != want {
			t.Fatalf("count(%s) = %d, want %d", unit, got, want)
		}
	}
}
