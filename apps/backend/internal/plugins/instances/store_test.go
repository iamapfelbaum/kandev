package instances

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"
	_ "github.com/mattn/go-sqlite3"

	"github.com/kandev/kandev/internal/db"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	conn, err := sql.Open("sqlite3", filepath.Join(t.TempDir(), "instances.db"))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	conn.SetMaxOpenConns(1)
	pool := db.NewPool(sqlx.NewDb(conn, "sqlite3"), sqlx.NewDb(conn, "sqlite3"))
	t.Cleanup(func() { _ = pool.Close() })
	store, err := NewStore(pool)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return store
}

func TestValidateScopeRequiresOnlyIdentifiersForScope(t *testing.T) {
	if err := ValidateScope(ScopeTask, ScopeIdentifiers{WorkspaceID: "workspace-1", TaskID: "task-1"}); err != nil {
		t.Fatalf("task scope unexpectedly invalid: %v", err)
	}
	if err := ValidateScope(ScopeTask, ScopeIdentifiers{TaskID: "task-1"}); !errors.Is(err, ErrInvalidScope) {
		t.Fatalf("missing workspace error = %v, want ErrInvalidScope", err)
	}
	if err := ValidateScope(ScopeWorkspace, ScopeIdentifiers{WorkspaceID: "workspace-1", TaskID: "task-1"}); !errors.Is(err, ErrInvalidScope) {
		t.Fatalf("mixed workspace error = %v, want ErrInvalidScope", err)
	}
}

func TestCreateInstanceAdmissionIsAtomicAtTaskAndWorkspaceLimits(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		created int
		lastErr error
	)
	for i := 0; i < MaxTaskInstances+5; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			instance := Instance{
				ID:          "instance-" + time.Now().Format("150405.000000000") + "-" + string(rune('a'+i)),
				PluginID:    "canvas-board",
				SourceKind:  SourceLocalCanvas,
				ScopeKind:   ScopeTask,
				WorkspaceID: "workspace-1",
				TaskID:      "task-1",
				Status:      StatusActive,
			}
			if err := store.Create(ctx, instance); err != nil {
				mu.Lock()
				lastErr = err
				mu.Unlock()
				return
			}
			mu.Lock()
			created++
			mu.Unlock()
		}(i)
	}
	wg.Wait()
	if created != MaxTaskInstances {
		t.Fatalf("created = %d, want %d (last error %v)", created, MaxTaskInstances, lastErr)
	}
	count, err := store.CountActive(ctx, ScopeTask, "task-1")
	if err != nil {
		t.Fatalf("CountActive: %v", err)
	}
	if count != MaxTaskInstances {
		t.Fatalf("task count = %d, want %d", count, MaxTaskInstances)
	}
}

func TestArchiveRestoreUsesTheSameAdmission(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	for i := 0; i < MaxTaskInstances-1; i++ {
		if err := store.Create(ctx, Instance{ID: "instance-" + string(rune('a'+i)), PluginID: "p", SourceKind: SourceLocalCanvas, ScopeKind: ScopeTask, WorkspaceID: "w", TaskID: "t", Status: StatusActive}); err != nil {
			t.Fatalf("Create(%d): %v", i, err)
		}
	}
	if err := store.Archive(ctx, "instance-a"); err != nil {
		t.Fatalf("Archive: %v", err)
	}
	if err := store.Restore(ctx, "instance-a"); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if err := store.Create(ctx, Instance{ID: "instance-z", PluginID: "p", SourceKind: SourceLocalCanvas, ScopeKind: ScopeTask, WorkspaceID: "w", TaskID: "t", Status: StatusActive}); err != nil {
		t.Fatalf("fill task limit: %v", err)
	}
	if err := store.Archive(ctx, "instance-b"); err != nil {
		t.Fatalf("second Archive: %v", err)
	}
	if err := store.Restore(ctx, "instance-b"); !errors.Is(err, ErrTaskCanvasLimit) {
		t.Fatalf("second Restore = %v, want ErrTaskCanvasLimit", err)
	}
}

func TestReserveBytesRejectsWorkspaceAndInstallationOverages(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	first, err := store.ReserveBytes(ctx, "workspace-1", 8, 10, 100)
	if err != nil {
		t.Fatalf("first reservation: %v", err)
	}
	if _, err := store.ReserveBytes(ctx, "workspace-1", 3, 10, 100); !errors.Is(err, ErrWorkspaceStorageLimit) {
		t.Fatalf("workspace overage = %v, want ErrWorkspaceStorageLimit", err)
	}
	if _, err := store.ReserveBytes(ctx, "workspace-2", 93, 100, 100); !errors.Is(err, ErrInstallationStorageLimit) {
		t.Fatalf("installation overage = %v, want ErrInstallationStorageLimit", err)
	}
	if err := store.ReleaseBytes(ctx, first.ID); err != nil {
		t.Fatalf("release reservation: %v", err)
	}
}

func TestReconcileArtifactsMarksRetainedReleaseUnavailable(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, Instance{ID: "instance-1", PluginID: "canvas-board", SourceKind: SourceLocalCanvas, ScopeKind: ScopeWorkspace, WorkspaceID: "workspace-1", Status: StatusActive}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := store.CreateRelease(ctx, Release{ID: "release-1", PluginID: "canvas-board", InstanceID: "instance-1", PackageDigest: "digest-1", SourceKind: SourceLocalCanvas, SourceActorKind: "agent", ArtifactPath: "releases/digest-1", ValidationStatus: ValidationValid}); err != nil {
		t.Fatalf("CreateRelease: %v", err)
	}
	marked, err := store.ReconcileArtifacts(ctx, func(path, digest string, bytes int64) (ArtifactCheck, error) {
		if path != "releases/digest-1" || digest != "digest-1" || bytes != 0 {
			t.Fatalf("checker arguments = %q, %q, %d", path, digest, bytes)
		}
		return ArtifactCheck{Reason: "missing"}, nil
	})
	if err != nil || marked != 1 {
		t.Fatalf("ReconcileArtifacts() = %d, %v; want one mark", marked, err)
	}
	release, err := store.GetRelease(ctx, "release-1")
	if err != nil {
		t.Fatalf("GetRelease: %v", err)
	}
	if release.ValidationStatus != ValidationUnavailable || release.ValidationError != "missing" {
		t.Fatalf("release after reconcile = %+v", release)
	}
}
