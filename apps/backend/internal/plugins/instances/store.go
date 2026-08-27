// Package instances stores scoped plugin instances, immutable release
// metadata, grants, storage reservations, and cleanup inventory. Native
// installed plugins keep their existing filesystem records; this package is
// the durable authority for isolated web-application instances.
package instances

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/db"
)

const (
	SourceInstalled   = "installed"
	SourceLocalCanvas = "local_canvas"

	ScopeInstance   = "instance"
	ScopeWorkspace  = "workspace"
	ScopeTask       = "task"
	ScopeSession    = "session"
	ScopeRepository = "repository"

	StatusPending  = "pending"
	StatusActive   = "active"
	StatusDisabled = "disabled"
	StatusArchived = "archived"
	StatusError    = "error"
	StatusRemoved  = "removed"

	ValidationValid             = "valid"
	ValidationPendingPermission = "pending_permission"
	ValidationInvalid           = "invalid"
	ValidationUnavailable       = "plugin_release_unavailable"

	MaxTaskInstances      = 10
	MaxWorkspaceInstances = 100

	WorkspaceArtifactLimitBytes    int64 = 2 << 30
	InstallationArtifactLimitBytes int64 = 10 << 30
)

var (
	ErrNotFound                 = errors.New("plugin instance not found")
	ErrInvalidScope             = errors.New("invalid plugin instance scope")
	ErrTaskCanvasLimit          = errors.New("canvas task limit exceeded")
	ErrWorkspaceCanvasLimit     = errors.New("canvas workspace limit exceeded")
	ErrWorkspaceStorageLimit    = errors.New("canvas workspace storage limit exceeded")
	ErrInstallationStorageLimit = errors.New("canvas installation storage limit exceeded")
	ErrInvalidRelease           = errors.New("invalid plugin release")
)

// ScopeIdentifiers contains only the trusted identifiers required by a scope.
// Empty strings represent SQL NULL for optional identifiers.
type ScopeIdentifiers struct {
	WorkspaceID  string
	TaskID       string
	SessionID    string
	RepositoryID string
}

// ValidateScope rejects incomplete and mixed scopes before persistence.
func ValidateScope(kind string, ids ScopeIdentifiers) error {
	allowed := scopeIdentifiersFor(kind)
	if allowed == nil {
		return ErrInvalidScope
	}
	values := map[string]string{
		"workspace":  ids.WorkspaceID,
		"task":       ids.TaskID,
		"session":    ids.SessionID,
		"repository": ids.RepositoryID,
	}
	for name, value := range values {
		if allowed[name] != (value != "") {
			return ErrInvalidScope
		}
	}
	return nil
}

func scopeIdentifiersFor(kind string) map[string]bool {
	switch kind {
	case ScopeInstance:
		return map[string]bool{}
	case ScopeWorkspace:
		return map[string]bool{"workspace": true}
	case ScopeTask:
		return map[string]bool{"workspace": true, "task": true}
	case ScopeSession:
		return map[string]bool{"workspace": true, "session": true}
	case ScopeRepository:
		return map[string]bool{"workspace": true, "repository": true}
	default:
		return nil
	}
}

type Instance struct {
	ID              string
	PluginID        string
	SourceKind      string
	ScopeKind       string
	WorkspaceID     string
	TaskID          string
	SessionID       string
	RepositoryID    string
	Status          string
	ActiveReleaseID string
	GrantGeneration int64
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type Release struct {
	ID                      string
	PluginID                string
	InstanceID              string
	PackageDigest           string
	SourceKind              string
	SourceActorKind         string
	SourceUserID            string
	SourceTaskID            string
	SourceSessionID         string
	ManifestJSON            json.RawMessage
	DeclaredPermissionsJSON json.RawMessage
	ArtifactPath            string
	ArtifactBytes           int64
	ProtocolVersion         int
	ValidationStatus        string
	ValidationError         string
	CreatedAt               time.Time
}

type Grant struct {
	InstanceID     string
	PermissionKind string
	Resource       string
	NetworkOrigin  string
	ScopeCeiling   string
	ApprovedBy     string
	ApprovedAt     time.Time
}

type Reservation struct {
	ID          string
	WorkspaceID string
	Bytes       int64
	Status      string
	CreatedAt   time.Time
	ExpiresAt   time.Time
}

type CleanupJob struct {
	ID            string
	WorkspaceID   string
	InstanceID    string
	ArtifactPath  string
	Status        string
	Attempts      int
	LastError     string
	CreatedAt     time.Time
	NextAttemptAt time.Time
}

// ArtifactCheck is the content-free result returned by startup artifact
// reconciliation.
type ArtifactCheck struct {
	Available bool
	Reason    string
}

type Store struct {
	db        *sqlx.DB
	ro        *sqlx.DB
	admission sync.Mutex
}

func NewStore(pool *db.Pool) (*Store, error) {
	if pool == nil || pool.Writer() == nil || pool.Reader() == nil {
		return nil, errors.New("plugin instances: database pool is nil")
	}
	s := &Store{db: pool.Writer(), ro: pool.Reader()}
	if err := s.initSchema(); err != nil {
		return nil, fmt.Errorf("plugin instances schema: %w", err)
	}
	return s, nil
}

// SchemaSQL is exported for migration replay tests and backup tooling. Each
// statement is idempotent and uses only the common SQLite/PostgreSQL subset.
const SchemaSQL = `
CREATE TABLE IF NOT EXISTS plugin_instances (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  task_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  repository_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  active_release_id TEXT NOT NULL DEFAULT '',
  grant_generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_instances_workspace ON plugin_instances(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_plugin_instances_task ON plugin_instances(task_id, status);
CREATE TABLE IF NOT EXISTS plugin_releases (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  package_digest TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_actor_kind TEXT NOT NULL,
  source_user_id TEXT NOT NULL DEFAULT '',
  source_task_id TEXT NOT NULL DEFAULT '',
  source_session_id TEXT NOT NULL DEFAULT '',
  manifest_json TEXT NOT NULL,
  declared_permissions_json TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  artifact_bytes INTEGER NOT NULL DEFAULT 0,
  protocol_version INTEGER NOT NULL DEFAULT 1,
  validation_status TEXT NOT NULL,
  validation_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_releases_instance ON plugin_releases(instance_id, created_at);
CREATE TABLE IF NOT EXISTS plugin_instance_grants (
  plugin_instance_id TEXT NOT NULL,
  permission_kind TEXT NOT NULL,
  resource TEXT NOT NULL,
  network_origin TEXT NOT NULL DEFAULT '',
  scope_ceiling TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (plugin_instance_id, permission_kind, resource, network_origin)
);
CREATE TABLE IF NOT EXISTS plugin_storage_reservations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_storage_reservations_scope ON plugin_storage_reservations(workspace_id, status);
CREATE TABLE IF NOT EXISTS plugin_artifact_cleanup_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT '',
  instance_id TEXT NOT NULL DEFAULT '',
  artifact_path TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_artifact_cleanup_jobs_due ON plugin_artifact_cleanup_jobs(status, next_attempt_at);
`

func (s *Store) initSchema() error {
	for _, statement := range strings.Split(SchemaSQL, ";") {
		if strings.TrimSpace(statement) == "" {
			continue
		}
		if _, err := s.db.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) Create(ctx context.Context, instance Instance) error {
	if instance.ID == "" || instance.PluginID == "" || instance.SourceKind == "" || instance.Status == "" {
		return ErrInvalidScope
	}
	if err := ValidateScope(instance.ScopeKind, ScopeIdentifiers{WorkspaceID: instance.WorkspaceID, TaskID: instance.TaskID, SessionID: instance.SessionID, RepositoryID: instance.RepositoryID}); err != nil {
		return err
	}
	s.admission.Lock()
	defer s.admission.Unlock()
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.checkAdmission(ctx, tx, instance.ScopeKind, instance.WorkspaceID, instance.TaskID); err != nil {
		return err
	}
	now := time.Now().UTC()
	createdAt, updatedAt := instance.CreatedAt, instance.UpdatedAt
	if createdAt.IsZero() {
		createdAt = now
	}
	if updatedAt.IsZero() {
		updatedAt = createdAt
	}
	_, err = tx.ExecContext(ctx, tx.Rebind(`
INSERT INTO plugin_instances (id, plugin_id, source_kind, scope_kind, workspace_id, task_id, session_id, repository_id, status, active_release_id, grant_generation, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`), instance.ID, instance.PluginID, instance.SourceKind, instance.ScopeKind, instance.WorkspaceID, instance.TaskID, instance.SessionID, instance.RepositoryID, instance.Status, instance.ActiveReleaseID, instance.GrantGeneration, createdAt.Format(time.RFC3339Nano), updatedAt.Format(time.RFC3339Nano))
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) checkAdmission(ctx context.Context, tx *sqlx.Tx, scopeKind, workspaceID, taskID string) error {
	var count int
	if scopeKind == ScopeTask {
		if err := tx.GetContext(ctx, &count, tx.Rebind(`SELECT COUNT(*) FROM plugin_instances WHERE task_id = ? AND status <> ?`), taskID, StatusRemoved); err != nil {
			return err
		}
		if count >= MaxTaskInstances {
			return ErrTaskCanvasLimit
		}
	}
	if workspaceID != "" {
		if err := tx.GetContext(ctx, &count, tx.Rebind(`SELECT COUNT(*) FROM plugin_instances WHERE workspace_id = ? AND status <> ?`), workspaceID, StatusRemoved); err != nil {
			return err
		}
		if count >= MaxWorkspaceInstances {
			return ErrWorkspaceCanvasLimit
		}
	}
	return nil
}

func (s *Store) Get(ctx context.Context, id string) (Instance, error) {
	var row instanceRow
	err := s.ro.GetContext(ctx, &row, s.ro.Rebind(`SELECT id, plugin_id, source_kind, scope_kind, workspace_id, task_id, session_id, repository_id, status, active_release_id, grant_generation, created_at, updated_at FROM plugin_instances WHERE id = ?`), id)
	if errors.Is(err, sql.ErrNoRows) {
		return Instance{}, ErrNotFound
	}
	if err != nil {
		return Instance{}, err
	}
	return row.instance()
}

func (s *Store) List(ctx context.Context, workspaceID string, includeRemoved bool) ([]Instance, error) {
	query := `SELECT id, plugin_id, source_kind, scope_kind, workspace_id, task_id, session_id, repository_id, status, active_release_id, grant_generation, created_at, updated_at FROM plugin_instances WHERE workspace_id = ?`
	args := []any{workspaceID}
	if !includeRemoved {
		query += ` AND status <> ?`
		args = append(args, StatusRemoved)
	}
	query += ` ORDER BY created_at, id`
	rows, err := s.ro.QueryxContext(ctx, s.ro.Rebind(query), args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var result []Instance
	for rows.Next() {
		var row instanceRow
		if err := rows.StructScan(&row); err != nil {
			return nil, err
		}
		instance, err := row.instance()
		if err != nil {
			return nil, err
		}
		result = append(result, instance)
	}
	return result, rows.Err()
}

func (s *Store) CountActive(ctx context.Context, scopeKind, scopeID string) (int, error) {
	column := map[string]string{ScopeTask: "task_id", ScopeWorkspace: "workspace_id", ScopeSession: "session_id", ScopeRepository: "repository_id"}[scopeKind]
	if column == "" || scopeID == "" {
		return 0, ErrInvalidScope
	}
	var count int
	err := s.ro.GetContext(ctx, &count, s.ro.Rebind(`SELECT COUNT(*) FROM plugin_instances WHERE `+column+` = ? AND status <> ?`), scopeID, StatusRemoved)
	return count, err
}

func (s *Store) Archive(ctx context.Context, id string) error {
	return s.updateStatus(ctx, id, StatusArchived)
}

func (s *Store) Restore(ctx context.Context, id string) error {
	s.admission.Lock()
	defer s.admission.Unlock()
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var row instanceRow
	if err := tx.GetContext(ctx, &row, tx.Rebind(`SELECT id, plugin_id, source_kind, scope_kind, workspace_id, task_id, session_id, repository_id, status, active_release_id, grant_generation, created_at, updated_at FROM plugin_instances WHERE id = ?`), id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if row.Status != StatusArchived {
		return fmt.Errorf("%w: instance is %s", ErrInvalidScope, row.Status)
	}
	if err := s.checkAdmission(ctx, tx, row.ScopeKind, row.WorkspaceID, row.TaskID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, tx.Rebind(`UPDATE plugin_instances SET status = ?, updated_at = ? WHERE id = ? AND status = ?`), StatusActive, time.Now().UTC().Format(time.RFC3339Nano), id, StatusArchived)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) updateStatus(ctx context.Context, id, status string) error {
	result, err := s.db.ExecContext(ctx, s.db.Rebind(`UPDATE plugin_instances SET status = ?, updated_at = ? WHERE id = ?`), status, time.Now().UTC().Format(time.RFC3339Nano), id)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetScope(ctx context.Context, id, scopeKind string, ids ScopeIdentifiers) error {
	if err := ValidateScope(scopeKind, ids); err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, s.db.Rebind(`UPDATE plugin_instances SET scope_kind = ?, workspace_id = ?, task_id = ?, session_id = ?, repository_id = ?, grant_generation = grant_generation + 1, updated_at = ? WHERE id = ? AND status <> ?`), scopeKind, ids.WorkspaceID, ids.TaskID, ids.SessionID, ids.RepositoryID, time.Now().UTC().Format(time.RFC3339Nano), id, StatusRemoved)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetActiveRelease(ctx context.Context, instanceID, releaseID string) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var exists int
	if err := tx.GetContext(ctx, &exists, tx.Rebind(`SELECT COUNT(*) FROM plugin_releases WHERE id = ? AND instance_id = ? AND validation_status = ?`), releaseID, instanceID, ValidationValid); err != nil {
		return err
	}
	if exists == 0 {
		return ErrInvalidRelease
	}
	if _, err := tx.ExecContext(ctx, tx.Rebind(`UPDATE plugin_instances SET active_release_id = ?, updated_at = ? WHERE id = ? AND status <> ?`), releaseID, time.Now().UTC().Format(time.RFC3339Nano), instanceID, StatusRemoved); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) CreateRelease(ctx context.Context, release Release) error {
	if release.ID == "" {
		release.ID = uuid.NewString()
	}
	if release.InstanceID == "" || release.PluginID == "" || release.PackageDigest == "" || release.ArtifactPath == "" || release.ValidationStatus == "" {
		return ErrInvalidRelease
	}
	if len(release.ManifestJSON) == 0 {
		release.ManifestJSON = json.RawMessage(`{}`)
	}
	if len(release.DeclaredPermissionsJSON) == 0 {
		release.DeclaredPermissionsJSON = json.RawMessage(`[]`)
	}
	created := release.CreatedAt
	if created.IsZero() {
		created = time.Now().UTC()
	}
	_, err := s.db.ExecContext(ctx, s.db.Rebind(`INSERT INTO plugin_releases (id, plugin_id, instance_id, package_digest, source_kind, source_actor_kind, source_user_id, source_task_id, source_session_id, manifest_json, declared_permissions_json, artifact_path, artifact_bytes, protocol_version, validation_status, validation_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`), release.ID, release.PluginID, release.InstanceID, release.PackageDigest, release.SourceKind, release.SourceActorKind, release.SourceUserID, release.SourceTaskID, release.SourceSessionID, string(release.ManifestJSON), string(release.DeclaredPermissionsJSON), release.ArtifactPath, release.ArtifactBytes, release.ProtocolVersion, release.ValidationStatus, release.ValidationError, created.Format(time.RFC3339Nano))
	return err
}

func (s *Store) ListReleases(ctx context.Context, instanceID string) ([]Release, error) {
	rows, err := s.ro.QueryxContext(ctx, s.ro.Rebind(`SELECT id, plugin_id, instance_id, package_digest, source_kind, source_actor_kind, source_user_id, source_task_id, source_session_id, manifest_json, declared_permissions_json, artifact_path, artifact_bytes, protocol_version, validation_status, validation_error, created_at FROM plugin_releases WHERE instance_id = ? ORDER BY created_at DESC, id DESC`), instanceID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var releases []Release
	for rows.Next() {
		var row releaseRow
		if err := rows.StructScan(&row); err != nil {
			return nil, err
		}
		release, err := row.release()
		if err != nil {
			return nil, err
		}
		releases = append(releases, release)
	}
	return releases, rows.Err()
}

func (s *Store) GetRelease(ctx context.Context, id string) (Release, error) {
	var row releaseRow
	err := s.ro.GetContext(ctx, &row, s.ro.Rebind(`SELECT id, plugin_id, instance_id, package_digest, source_kind, source_actor_kind, source_user_id, source_task_id, source_session_id, manifest_json, declared_permissions_json, artifact_path, artifact_bytes, protocol_version, validation_status, validation_error, created_at FROM plugin_releases WHERE id = ?`), id)
	if errors.Is(err, sql.ErrNoRows) {
		return Release{}, ErrNotFound
	}
	if err != nil {
		return Release{}, err
	}
	return row.release()
}

// ReconcileArtifacts checks retained release metadata before runtime routes
// are registered. The checker must not execute package code. Unavailable
// artifacts remain in the database for recovery and are marked with a stable
// validation status.
func (s *Store) ReconcileArtifacts(ctx context.Context, checker func(path, digest string, bytes int64) (ArtifactCheck, error)) (int, error) {
	if checker == nil {
		return 0, errors.New("artifact checker is nil")
	}
	rows, err := s.ro.QueryxContext(ctx, s.ro.Rebind(`SELECT id, package_digest, artifact_path, artifact_bytes FROM plugin_releases WHERE validation_status IN (?, ?)`), ValidationValid, ValidationPendingPermission)
	if err != nil {
		return 0, err
	}
	type candidate struct {
		id, digest, path string
		bytes            int64
	}
	var candidates []candidate
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.id, &item.digest, &item.path, &item.bytes); err != nil {
			_ = rows.Close()
			return 0, err
		}
		candidates = append(candidates, item)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	marked := 0
	for _, item := range candidates {
		check, err := checker(item.path, item.digest, item.bytes)
		if err != nil {
			return marked, err
		}
		if check.Available {
			continue
		}
		status := ValidationUnavailable
		if check.Reason == "" {
			check.Reason = "artifact_unavailable"
		}
		if _, err := s.db.ExecContext(ctx, s.db.Rebind(`UPDATE plugin_releases SET validation_status = ?, validation_error = ? WHERE id = ? AND validation_status IN (?, ?)`), status, check.Reason, item.id, ValidationValid, ValidationPendingPermission); err != nil {
			return marked, err
		}
		marked++
	}
	return marked, nil
}

func (s *Store) AddGrant(ctx context.Context, grant Grant) error {
	if grant.InstanceID == "" || grant.PermissionKind == "" || grant.ScopeCeiling == "" || grant.ApprovedBy == "" {
		return ErrInvalidScope
	}
	if grant.ApprovedAt.IsZero() {
		grant.ApprovedAt = time.Now().UTC()
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var exists int
	if err := tx.GetContext(ctx, &exists, tx.Rebind(`SELECT COUNT(*) FROM plugin_instances WHERE id = ? AND status <> ?`), grant.InstanceID, StatusRemoved); err != nil {
		return err
	}
	if exists == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, tx.Rebind(`INSERT INTO plugin_instance_grants (plugin_instance_id, permission_kind, resource, network_origin, scope_ceiling, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(plugin_instance_id, permission_kind, resource, network_origin) DO UPDATE SET scope_ceiling = excluded.scope_ceiling, approved_by = excluded.approved_by, approved_at = excluded.approved_at`), grant.InstanceID, grant.PermissionKind, grant.Resource, grant.NetworkOrigin, grant.ScopeCeiling, grant.ApprovedBy, grant.ApprovedAt.Format(time.RFC3339Nano)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, tx.Rebind(`UPDATE plugin_instances SET grant_generation = grant_generation + 1, updated_at = ? WHERE id = ? AND status <> ?`), time.Now().UTC().Format(time.RFC3339Nano), grant.InstanceID, StatusRemoved); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ListGrants(ctx context.Context, instanceID string) ([]Grant, error) {
	rows, err := s.ro.QueryxContext(ctx, s.ro.Rebind(`SELECT plugin_instance_id, permission_kind, resource, network_origin, scope_ceiling, approved_by, approved_at FROM plugin_instance_grants WHERE plugin_instance_id = ? ORDER BY permission_kind, resource, network_origin`), instanceID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var grants []Grant
	for rows.Next() {
		var row struct {
			InstanceID     string `db:"plugin_instance_id"`
			PermissionKind string `db:"permission_kind"`
			Resource       string `db:"resource"`
			NetworkOrigin  string `db:"network_origin"`
			ScopeCeiling   string `db:"scope_ceiling"`
			ApprovedBy     string `db:"approved_by"`
			ApprovedAt     string `db:"approved_at"`
		}
		if err := rows.StructScan(&row); err != nil {
			return nil, err
		}
		approvedAt, err := time.Parse(time.RFC3339Nano, row.ApprovedAt)
		if err != nil {
			return nil, err
		}
		grants = append(grants, Grant{InstanceID: row.InstanceID, PermissionKind: row.PermissionKind, Resource: row.Resource, NetworkOrigin: row.NetworkOrigin, ScopeCeiling: row.ScopeCeiling, ApprovedBy: row.ApprovedBy, ApprovedAt: approvedAt})
	}
	return grants, rows.Err()
}

func (s *Store) ReserveBytes(ctx context.Context, workspaceID string, bytes, workspaceLimit, installationLimit int64) (Reservation, error) {
	if bytes <= 0 || workspaceLimit <= 0 || installationLimit <= 0 {
		return Reservation{}, ErrInvalidRelease
	}
	s.admission.Lock()
	defer s.admission.Unlock()
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return Reservation{}, err
	}
	defer func() { _ = tx.Rollback() }()
	now := time.Now().UTC()
	_, _ = tx.ExecContext(ctx, tx.Rebind(`DELETE FROM plugin_storage_reservations WHERE status = ? AND expires_at < ?`), "reserved", now.Format(time.RFC3339Nano))
	var workspaceBytes, installationBytes int64
	if err := tx.GetContext(ctx, &workspaceBytes, tx.Rebind(`SELECT COALESCE(SUM(bytes), 0) FROM plugin_storage_reservations WHERE workspace_id = ? AND status = ?`), workspaceID, "reserved"); err != nil {
		return Reservation{}, err
	}
	if err := tx.GetContext(ctx, &installationBytes, tx.Rebind(`SELECT COALESCE(SUM(bytes), 0) FROM plugin_storage_reservations WHERE status = ?`), "reserved"); err != nil {
		return Reservation{}, err
	}
	if workspaceBytes > workspaceLimit-bytes {
		return Reservation{}, ErrWorkspaceStorageLimit
	}
	if installationBytes > installationLimit-bytes {
		return Reservation{}, ErrInstallationStorageLimit
	}
	reservation := Reservation{ID: uuid.NewString(), WorkspaceID: workspaceID, Bytes: bytes, Status: "reserved", CreatedAt: now, ExpiresAt: now.Add(30 * time.Minute)}
	_, err = tx.ExecContext(ctx, tx.Rebind(`INSERT INTO plugin_storage_reservations (id, workspace_id, bytes, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`), reservation.ID, reservation.WorkspaceID, reservation.Bytes, reservation.Status, reservation.CreatedAt.Format(time.RFC3339Nano), reservation.ExpiresAt.Format(time.RFC3339Nano))
	if err != nil {
		return Reservation{}, err
	}
	if err := tx.Commit(); err != nil {
		return Reservation{}, err
	}
	return reservation, nil
}

func (s *Store) ReleaseBytes(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, s.db.Rebind(`UPDATE plugin_storage_reservations SET status = ? WHERE id = ? AND status = ?`), "released", id, "reserved")
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) AddCleanupJob(ctx context.Context, job CleanupJob) error {
	if job.ID == "" {
		job.ID = uuid.NewString()
	}
	if job.ArtifactPath == "" {
		return ErrInvalidRelease
	}
	now := time.Now().UTC()
	if job.CreatedAt.IsZero() {
		job.CreatedAt = now
	}
	if job.NextAttemptAt.IsZero() {
		job.NextAttemptAt = now
	}
	if job.Status == "" {
		job.Status = "pending"
	}
	_, err := s.db.ExecContext(ctx, s.db.Rebind(`INSERT INTO plugin_artifact_cleanup_jobs (id, workspace_id, instance_id, artifact_path, status, attempts, last_error, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`), job.ID, job.WorkspaceID, job.InstanceID, job.ArtifactPath, job.Status, job.Attempts, job.LastError, job.CreatedAt.Format(time.RFC3339Nano), job.NextAttemptAt.Format(time.RFC3339Nano))
	return err
}

func (s *Store) RemoveInstance(ctx context.Context, id string) error {
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var workspaceID string
	if err := tx.GetContext(ctx, &workspaceID, tx.Rebind(`SELECT workspace_id FROM plugin_instances WHERE id = ?`), id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	var paths []string
	rows, err := tx.QueryxContext(ctx, tx.Rebind(`SELECT artifact_path FROM plugin_releases WHERE instance_id = ?`), id)
	if err != nil {
		return err
	}
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			_ = rows.Close()
			return err
		}
		paths = append(paths, path)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, artifactPath := range paths {
		job := CleanupJob{ID: uuid.NewString(), WorkspaceID: workspaceID, InstanceID: id, ArtifactPath: artifactPath, Status: "pending", CreatedAt: time.Now().UTC(), NextAttemptAt: time.Now().UTC()}
		if _, err := tx.ExecContext(ctx, tx.Rebind(`INSERT INTO plugin_artifact_cleanup_jobs (id, workspace_id, instance_id, artifact_path, status, attempts, last_error, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`), job.ID, job.WorkspaceID, job.InstanceID, job.ArtifactPath, job.Status, 0, "", job.CreatedAt.Format(time.RFC3339Nano), job.NextAttemptAt.Format(time.RFC3339Nano)); err != nil {
			return err
		}
	}
	result, err := tx.ExecContext(ctx, tx.Rebind(`UPDATE plugin_instances SET status = ?, active_release_id = '', updated_at = ? WHERE id = ? AND status <> ?`), StatusRemoved, time.Now().UTC().Format(time.RFC3339Nano), id, StatusRemoved)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, tx.Rebind(`DELETE FROM plugin_instance_grants WHERE plugin_instance_id = ?`), id); err != nil {
		return err
	}
	return tx.Commit()
}

type instanceRow struct {
	ID              string `db:"id"`
	PluginID        string `db:"plugin_id"`
	SourceKind      string `db:"source_kind"`
	ScopeKind       string `db:"scope_kind"`
	WorkspaceID     string `db:"workspace_id"`
	TaskID          string `db:"task_id"`
	SessionID       string `db:"session_id"`
	RepositoryID    string `db:"repository_id"`
	Status          string `db:"status"`
	ActiveReleaseID string `db:"active_release_id"`
	GrantGeneration int64  `db:"grant_generation"`
	CreatedAt       string `db:"created_at"`
	UpdatedAt       string `db:"updated_at"`
}

func (r instanceRow) instance() (Instance, error) {
	created, err := time.Parse(time.RFC3339Nano, r.CreatedAt)
	if err != nil {
		return Instance{}, err
	}
	updated, err := time.Parse(time.RFC3339Nano, r.UpdatedAt)
	if err != nil {
		return Instance{}, err
	}
	return Instance{ID: r.ID, PluginID: r.PluginID, SourceKind: r.SourceKind, ScopeKind: r.ScopeKind, WorkspaceID: r.WorkspaceID, TaskID: r.TaskID, SessionID: r.SessionID, RepositoryID: r.RepositoryID, Status: r.Status, ActiveReleaseID: r.ActiveReleaseID, GrantGeneration: r.GrantGeneration, CreatedAt: created, UpdatedAt: updated}, nil
}

type releaseRow struct {
	ID                      string `db:"id"`
	PluginID                string `db:"plugin_id"`
	InstanceID              string `db:"instance_id"`
	PackageDigest           string `db:"package_digest"`
	SourceKind              string `db:"source_kind"`
	SourceActorKind         string `db:"source_actor_kind"`
	SourceUserID            string `db:"source_user_id"`
	SourceTaskID            string `db:"source_task_id"`
	SourceSessionID         string `db:"source_session_id"`
	ManifestJSON            string `db:"manifest_json"`
	DeclaredPermissionsJSON string `db:"declared_permissions_json"`
	ArtifactPath            string `db:"artifact_path"`
	ArtifactBytes           int64  `db:"artifact_bytes"`
	ProtocolVersion         int    `db:"protocol_version"`
	ValidationStatus        string `db:"validation_status"`
	ValidationError         string `db:"validation_error"`
	CreatedAt               string `db:"created_at"`
}

func (r releaseRow) release() (Release, error) {
	created, err := time.Parse(time.RFC3339Nano, r.CreatedAt)
	if err != nil {
		return Release{}, err
	}
	return Release{ID: r.ID, PluginID: r.PluginID, InstanceID: r.InstanceID, PackageDigest: r.PackageDigest, SourceKind: r.SourceKind, SourceActorKind: r.SourceActorKind, SourceUserID: r.SourceUserID, SourceTaskID: r.SourceTaskID, SourceSessionID: r.SourceSessionID, ManifestJSON: json.RawMessage(r.ManifestJSON), DeclaredPermissionsJSON: json.RawMessage(r.DeclaredPermissionsJSON), ArtifactPath: r.ArtifactPath, ArtifactBytes: r.ArtifactBytes, ProtocolVersion: r.ProtocolVersion, ValidationStatus: r.ValidationStatus, ValidationError: r.ValidationError, CreatedAt: created}, nil
}
