package canvas

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/db"
	plugininstances "github.com/kandev/kandev/internal/plugins/instances"
	"github.com/kandev/kandev/internal/plugins/manifest"
	"github.com/kandev/kandev/internal/plugins/webapp"
)

func TestPublishPackageFirstReleaseRequiresMatchingGrants(t *testing.T) {
	tests := []struct {
		name          string
		reads         []string
		wantActivated bool
		wantStatus    string
	}{
		{
			name:          "zero permissions activate",
			wantActivated: true,
			wantStatus:    plugininstances.ValidationValid,
		},
		{
			name:          "declared permissions require grants",
			reads:         []string{"tasks"},
			wantActivated: false,
			wantStatus:    plugininstances.ValidationPendingPermission,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			service, instanceStore, _ := newCanvasService(t)
			canvas := createCanvas(t, service, CreateCanvasRequest{
				WorkspaceID: "workspace-1",
				TaskID:      "task-1",
				Title:       "First release",
			})

			result := publishTestPackage(t, service, canvas.ID, "first-release", tt.reads)
			if result.Activated != tt.wantActivated {
				t.Fatalf("activated = %t, want %t", result.Activated, tt.wantActivated)
			}
			if result.Release.ValidationStatus != tt.wantStatus {
				t.Fatalf("release status = %q, want %q", result.Release.ValidationStatus, tt.wantStatus)
			}

			instance, err := instanceStore.Get(context.Background(), canvas.PluginInstanceID)
			if err != nil {
				t.Fatalf("get instance: %v", err)
			}
			if tt.wantActivated {
				if instance.ActiveReleaseID != result.Release.ID {
					t.Fatalf("active release = %q, want %q", instance.ActiveReleaseID, result.Release.ID)
				}
			} else if instance.ActiveReleaseID != "" {
				t.Fatalf("active release = %q, want no active release", instance.ActiveReleaseID)
			}
		})
	}
}

func TestPermissionsFitHonorsInstanceScope(t *testing.T) {
	permissions := PermissionSummary{Reads: []string{"tasks"}}
	grants := []plugininstances.Grant{{
		PermissionKind: "api_read",
		Resource:       "tasks",
		ScopeCeiling:   plugininstances.ScopeTask,
	}}
	if permissionsFit(permissions, plugininstances.ScopeTask, grants) != true {
		t.Fatal("task grant did not cover task-scoped release")
	}
	if permissionsFit(permissions, plugininstances.ScopeWorkspace, grants) {
		t.Fatal("task grant covered workspace-scoped release")
	}
}

func TestPublishPackagePrunesSupersededPendingReleasesWithoutChangingActive(t *testing.T) {
	service, instanceStore, pool := newCanvasService(t)
	canvas := createCanvas(t, service, CreateCanvasRequest{
		WorkspaceID: "workspace-1",
		TaskID:      "task-1",
		Title:       "Pending releases",
	})
	setAuthoringTestClock(service)

	active := publishTestPackage(t, service, canvas.ID, "active-release", nil)
	pendingOne := publishTestPackage(t, service, canvas.ID, "pending-one", []string{"tasks"})
	pendingTwo := publishTestPackage(t, service, canvas.ID, "pending-two", []string{"workflows"})

	instance, err := instanceStore.Get(context.Background(), canvas.PluginInstanceID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if instance.ActiveReleaseID != active.Release.ID {
		t.Fatalf("active release = %q, want %q", instance.ActiveReleaseID, active.Release.ID)
	}

	releases, err := instanceStore.ListReleases(context.Background(), canvas.PluginInstanceID)
	if err != nil {
		t.Fatalf("list releases: %v", err)
	}
	assertReleaseStatus(t, releases, active.Release.ID, plugininstances.ValidationValid, "")
	assertReleaseAbsent(t, releases, pendingOne.Release.ID)
	assertReleaseStatus(t, releases, pendingTwo.Release.ID, plugininstances.ValidationPendingPermission, "permission_review_required")
	if got := countReleaseStatus(releases, plugininstances.ValidationPendingPermission); got != 1 {
		t.Fatalf("pending releases = %d, want 1", got)
	}
	if got := cleanupArtifactPaths(t, pool, canvas.PluginInstanceID); len(got) != 1 || got[0] != "releases/pending-one" {
		t.Fatalf("cleanup paths = %v, want [releases/pending-one]", got)
	}
}

func TestPublishPackageRetainsPriorValidReleaseForRollback(t *testing.T) {
	service, instanceStore, pool := newCanvasService(t)
	canvas := createCanvas(t, service, CreateCanvasRequest{
		WorkspaceID: "workspace-1",
		TaskID:      "task-1",
		Title:       "Valid releases",
	})
	setAuthoringTestClock(service)
	active := publishTestPackage(t, service, canvas.ID, "active-release", nil)

	if err := instanceStore.AddGrant(context.Background(), plugininstances.Grant{
		InstanceID:     canvas.PluginInstanceID,
		PermissionKind: "api_read",
		Resource:       "tasks",
		ScopeCeiling:   plugininstances.ScopeTask,
		ApprovedBy:     "user-1",
	}); err != nil {
		t.Fatalf("add grant: %v", err)
	}
	prior := publishTestPackage(t, service, canvas.ID, "prior-release", []string{"tasks"})
	latest := publishTestPackage(t, service, canvas.ID, "latest-release", []string{"tasks"})

	instance, err := instanceStore.Get(context.Background(), canvas.PluginInstanceID)
	if err != nil {
		t.Fatalf("get instance: %v", err)
	}
	if instance.ActiveReleaseID != latest.Release.ID {
		t.Fatalf("active release = %q, want %q", instance.ActiveReleaseID, latest.Release.ID)
	}

	releases, err := instanceStore.ListReleases(context.Background(), canvas.PluginInstanceID)
	if err != nil {
		t.Fatalf("list releases: %v", err)
	}
	assertReleaseAbsent(t, releases, active.Release.ID)
	assertReleaseStatus(t, releases, prior.Release.ID, plugininstances.ValidationValid, "")
	assertReleaseStatus(t, releases, latest.Release.ID, plugininstances.ValidationValid, "")
	if got := countReleaseStatus(releases, plugininstances.ValidationValid); got != 2 {
		t.Fatalf("valid releases = %d, want active plus one prior", got)
	}
	if got := cleanupArtifactPaths(t, pool, canvas.PluginInstanceID); len(got) != 1 || got[0] != "releases/active-release" {
		t.Fatalf("cleanup paths = %v, want [releases/active-release]", got)
	}
	if err := instanceStore.ActivateRelease(context.Background(), canvas.PluginInstanceID, active.Release.ID); !errors.Is(err, plugininstances.ErrInvalidRelease) {
		t.Fatalf("activate superseded release = %v, want ErrInvalidRelease", err)
	}

	rolledBack, err := service.RollbackRelease(context.Background(), canvas.ID, "")
	if err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if rolledBack.ActiveReleaseID != prior.Release.ID {
		t.Fatalf("rollback active release = %q, want %q", rolledBack.ActiveReleaseID, prior.Release.ID)
	}
	if rolledBack.PluginInstanceID != canvas.PluginInstanceID || rolledBack.ScopeKind != plugininstances.ScopeTask {
		t.Fatalf("rollback changed canvas identity or scope: %+v", rolledBack)
	}
}

func publishTestPackage(t *testing.T, service *Service, canvasID, digest string, reads []string) *PublishResult {
	t.Helper()
	pkg := &webapp.Package{
		Manifest: &manifest.Manifest{
			ID:         "canvas-board",
			APIVersion: manifest.CurrentAPIVersion,
			Version:    digest,
			UI: manifest.UISection{WebApps: []manifest.WebApp{{
				Key:        "main",
				Title:      "Board",
				Entry:      "index.html",
				Placements: []string{manifest.WebAppPlacementTask},
			}}},
			Capabilities: manifest.Capabilities{APIRead: reads},
		},
		Digest: digest,
	}
	result, err := service.PublishPackage(context.Background(), PublishRequest{
		CanvasID:        canvasID,
		Package:         pkg,
		Artifact:        webapp.Artifact{Digest: digest, RelativePath: "releases/" + digest, Bytes: 1},
		SourceActorKind: "agent",
	})
	if err != nil {
		t.Fatalf("publish %s: %v", digest, err)
	}
	return result
}

func setAuthoringTestClock(service *Service) {
	base := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	tick := 0
	service.clock = func() time.Time {
		tick++
		return base.Add(time.Duration(tick) * time.Second)
	}
}

func assertReleaseStatus(t *testing.T, releases []plugininstances.Release, id, status, validationError string) {
	t.Helper()
	for _, release := range releases {
		if release.ID != id {
			continue
		}
		if release.ValidationStatus != status || release.ValidationError != validationError {
			t.Fatalf("release %q = status %q, error %q; want status %q, error %q", id, release.ValidationStatus, release.ValidationError, status, validationError)
		}
		return
	}
	t.Fatalf("release %q not found in %+v", id, releases)
}

func assertReleaseAbsent(t *testing.T, releases []plugininstances.Release, id string) {
	t.Helper()
	for _, release := range releases {
		if release.ID == id {
			t.Fatalf("release %q is still retained: %+v", id, release)
		}
	}
}

func countReleaseStatus(releases []plugininstances.Release, status string) int {
	count := 0
	for _, release := range releases {
		if release.ValidationStatus == status {
			count++
		}
	}
	return count
}

func cleanupArtifactPaths(t *testing.T, pool *db.Pool, instanceID string) []string {
	t.Helper()
	rows, err := pool.Reader().Queryx(pool.Reader().Rebind(
		"SELECT artifact_path FROM plugin_artifact_cleanup_jobs WHERE instance_id = ? ORDER BY artifact_path",
	), instanceID)
	if err != nil {
		t.Fatalf("list cleanup jobs: %v", err)
	}
	defer func() { _ = rows.Close() }()
	var paths []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			t.Fatalf("scan cleanup job: %v", err)
		}
		paths = append(paths, path)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate cleanup jobs: %v", err)
	}
	return paths
}
