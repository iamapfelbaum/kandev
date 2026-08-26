package canvas

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"

	"github.com/kandev/kandev/internal/agentctl/types/streams"
	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/common/logger"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
)

type WorkspaceAuthorizer func(context.Context, string) error
type TaskWorkspaceResolver func(context.Context, string) (string, error)
type EventPublisher func(string, *CanvasEvent)

type Service struct {
	repo                 *Repository
	authorizeWorkspace   WorkspaceAuthorizer
	resolveTaskWorkspace TaskWorkspaceResolver
	publish              EventPublisher
}

func NewService(repo *Repository, _ *logger.Logger) *Service {
	return &Service{repo: repo}
}

func (s *Service) SetWorkspaceAuthorizer(authorizer WorkspaceAuthorizer) {
	s.authorizeWorkspace = authorizer
}

func (s *Service) SetTaskWorkspaceResolver(resolver TaskWorkspaceResolver) {
	s.resolveTaskWorkspace = resolver
}

func (s *Service) SetEventPublisher(publisher EventPublisher) {
	s.publish = publisher
}

func (s *Service) CreateCanvas(ctx context.Context, req CreateCanvasRequest) (*Canvas, error) {
	if err := validateTitle(req.Title); err != nil {
		return nil, err
	}
	if err := s.authorizeWorkspaceAccess(ctx, req.WorkspaceID); err != nil {
		return nil, err
	}
	now := s.repo.nowUTC()
	canvas := &Canvas{
		ID: newID(), OwnerUserID: callerID(ctx), WorkspaceID: req.WorkspaceID,
		Title: strings.TrimSpace(req.Title), SchemaVersion: CanvasSchemaVersion,
		Blocks: []Block{}, TaskLinks: []TaskLink{}, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.createCanvasRecord(ctx, canvas, ""); err != nil {
		return nil, err
	}
	return canvas, nil
}

func (s *Service) CreateCanvasForTask(ctx context.Context, req CreateCanvasRequest, taskID string) (*Canvas, error) {
	if err := s.assertTaskWorkspace(ctx, taskID, req.WorkspaceID); err != nil {
		return nil, err
	}
	if err := validateTitle(req.Title); err != nil {
		return nil, err
	}
	if err := s.authorizeWorkspaceAccess(ctx, req.WorkspaceID); err != nil {
		return nil, err
	}
	now := s.repo.nowUTC()
	canvas := &Canvas{
		ID: newID(), OwnerUserID: callerID(ctx), WorkspaceID: req.WorkspaceID,
		Title: strings.TrimSpace(req.Title), SchemaVersion: CanvasSchemaVersion,
		Blocks: []Block{}, TaskLinks: []TaskLink{}, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.createCanvasRecord(ctx, canvas, taskID); err != nil {
		return nil, err
	}
	return s.repo.GetCanvas(ctx, canvas.ID)
}

func (s *Service) createCanvasRecord(ctx context.Context, canvas *Canvas, taskID string) error {
	s.repo.mu.Lock()
	defer s.repo.mu.Unlock()
	tx, err := s.repo.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	active, err := countActiveCanvases(ctx, tx, canvas.WorkspaceID)
	if err != nil {
		return err
	}
	if active >= MaxActiveCanvases {
		return fmt.Errorf("%w: a workspace can have at most %d active canvases", ErrCanvasLimit, MaxActiveCanvases)
	}
	if err := insertCanvas(ctx, tx, canvas); err != nil {
		return err
	}
	if taskID != "" {
		link := TaskLink{CanvasID: canvas.ID, TaskID: taskID, LinkedBy: callerID(ctx), CreatedAt: canvas.CreatedAt}
		if _, err := tx.ExecContext(ctx, tx.Rebind(`
INSERT INTO canvas_task_links (canvas_id, task_id, linked_by, created_at) VALUES (?, ?, ?, ?)`),
			link.CanvasID, link.TaskID, link.LinkedBy, link.CreatedAt); err != nil {
			return err
		}
		canvas.TaskLinks = []TaskLink{link}
	}
	return tx.Commit()
}

func (s *Service) ListCanvases(ctx context.Context, workspaceID string, includeArchived bool) ([]*Canvas, error) {
	if err := s.authorizeWorkspaceAccess(ctx, workspaceID); err != nil {
		return nil, err
	}
	return s.repo.ListCanvases(ctx, workspaceID, includeArchived)
}

func (s *Service) ListCanvasesForTask(ctx context.Context, workspaceID, taskID string) ([]*Canvas, error) {
	if err := s.assertTaskWorkspace(ctx, taskID, workspaceID); err != nil {
		return nil, err
	}
	items, err := s.ListCanvases(ctx, workspaceID, false)
	if err != nil {
		return nil, err
	}
	linked := make([]*Canvas, 0, len(items))
	for _, item := range items {
		if canvasHasTask(item, taskID) {
			linked = append(linked, item)
		}
	}
	return linked, nil
}

func (s *Service) SubscribeCanvas(ctx context.Context, canvasID string, afterRevision int64) ([]byte, error) {
	canvas, err := s.GetCanvas(ctx, canvasID)
	if err != nil {
		return nil, err
	}
	recovery := "events"
	if afterRevision < canvas.CompactedThroughRevision {
		recovery = "snapshot"
		recordCanvasRecovery(recovery)
		return marshalJSON(map[string]any{"canvas": canvas, "events": []CanvasEvent{}, "recovery": recovery})
	}
	events, err := s.repo.EventsAfter(ctx, canvasID, afterRevision)
	if err != nil {
		return nil, err
	}
	if events == nil {
		events = []CanvasEvent{}
	}
	recordCanvasRecovery(recovery)
	return marshalJSON(map[string]any{"canvas": canvas, "events": events, "recovery": recovery})
}

func (s *Service) GetCanvas(ctx context.Context, canvasID string) (*Canvas, error) {
	canvas, err := s.repo.GetCanvas(ctx, canvasID)
	if err != nil {
		return nil, err
	}
	if err := s.authorizeWorkspaceAccess(ctx, canvas.WorkspaceID); err != nil {
		return nil, ErrCanvasNotFound
	}
	return canvas, nil
}

func (s *Service) GetCanvasForTask(ctx context.Context, canvasID, taskID string) (*Canvas, error) {
	canvas, err := s.GetCanvas(ctx, canvasID)
	if err != nil {
		return nil, err
	}
	if !canvasHasTask(canvas, taskID) {
		return nil, ErrCanvasNotFound
	}
	return canvas, nil
}

func (s *Service) RenameCanvas(ctx context.Context, canvasID, title string) (*Canvas, error) {
	if err := validateTitle(title); err != nil {
		return nil, err
	}
	canvas, err := s.GetCanvas(ctx, canvasID)
	if err != nil {
		return nil, err
	}
	input, _ := json.Marshal(map[string]string{"title": strings.TrimSpace(title)})
	result, err := s.ApplyCommand(ctx, canvasID, ApplyCanvasCommandRequest{
		CommandID: newID(), BaseRevision: canvas.Revision, Action: ActionCanvasRename, Input: input,
	})
	if err != nil {
		return nil, err
	}
	return result.Canvas, nil
}

func (s *Service) SetCanvasArchived(ctx context.Context, canvasID string, archived bool) (*Canvas, error) {
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
	if !archived && canvas.ArchivedAt != nil {
		active, err := countActiveCanvases(ctx, tx, canvas.WorkspaceID)
		if err != nil {
			return nil, err
		}
		if active >= MaxActiveCanvases {
			return nil, fmt.Errorf("%w: a workspace can have at most %d active canvases", ErrCanvasLimit, MaxActiveCanvases)
		}
	}
	var archivedAt *time.Time
	if archived {
		now := s.repo.nowUTC()
		archivedAt = &now
	}
	updatedAt := s.repo.nowUTC()
	result, err := tx.ExecContext(ctx, tx.Rebind(
		`UPDATE canvases SET archived_at = ?, updated_at = ? WHERE id = ?`), archivedAt, updatedAt, canvasID)
	if err != nil {
		return nil, err
	}
	if err := requireOneRow(result, ErrCanvasNotFound); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	canvas.ArchivedAt = archivedAt
	canvas.UpdatedAt = updatedAt
	return canvas, nil
}

func (s *Service) RemoveCanvas(ctx context.Context, canvasID string) error {
	if _, err := s.GetCanvas(ctx, canvasID); err != nil {
		return err
	}
	return s.repo.DeleteCanvas(ctx, canvasID)
}

func (s *Service) AddTaskLink(ctx context.Context, canvasID, taskID string) error {
	canvas, err := s.GetCanvas(ctx, canvasID)
	if err != nil {
		return err
	}
	if s.resolveTaskWorkspace == nil {
		return fmt.Errorf("%w: task lookup is not configured", ErrTaskNotFound)
	}
	workspaceID, err := s.resolveTaskWorkspace(ctx, taskID)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrTaskNotFound, err)
	}
	if workspaceID != canvas.WorkspaceID {
		return ErrTaskWorkspaceMismatch
	}
	link := TaskLink{
		CanvasID: canvasID, TaskID: taskID, LinkedBy: callerID(ctx), CreatedAt: s.repo.nowUTC(),
	}
	return s.repo.AddTaskLink(ctx, link)
}

func (s *Service) RemoveTaskLink(ctx context.Context, canvasID, taskID string) error {
	if _, err := s.GetCanvas(ctx, canvasID); err != nil {
		return err
	}
	return s.repo.DeleteTaskLink(ctx, canvasID, taskID)
}

func (s *Service) ApplyCommand(ctx context.Context, canvasID string, req ApplyCanvasCommandRequest) (result *ApplyCanvasCommandResult, err error) {
	defer func() {
		if err == nil && result != nil && result.Duplicate {
			recordCanvasOperation("command", "duplicate")
			return
		}
		if err == nil {
			recordCanvasOperation("command", "accepted")
			return
		}
		recordCanvasOperation("command", canvasOperationResult(err))
	}()
	if err := validateCommand(req); err != nil {
		return nil, err
	}
	if _, err := s.GetCanvas(ctx, canvasID); err != nil {
		return nil, err
	}
	return s.applyCommandTransaction(ctx, canvasID, req)
}

func (s *Service) applyCommandTransaction(
	ctx context.Context,
	canvasID string,
	req ApplyCanvasCommandRequest,
) (*ApplyCanvasCommandResult, error) {
	s.repo.mu.Lock()
	defer s.repo.mu.Unlock()
	tx, err := s.repo.db.BeginTxx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	storedResult, found, err := readReceipt(ctx, tx, req.CommandID, canvasID)
	if err != nil {
		return nil, err
	}
	if found {
		storedResult.Duplicate = true
		return storedResult, nil
	}
	result, err := s.applyNewCommand(ctx, tx, canvasID, req)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if s.publish != nil {
		s.publish(canvasID, result.Event)
	}
	return result, nil
}

func (s *Service) applyNewCommand(
	ctx context.Context,
	tx *sqlx.Tx,
	canvasID string,
	req ApplyCanvasCommandRequest,
) (*ApplyCanvasCommandResult, error) {
	canvas, err := scanCanvas(ctx, tx, canvasID)
	if err != nil {
		return nil, err
	}
	if err := s.repo.loadChildren(ctx, tx, canvas); err != nil {
		return nil, err
	}
	if err := s.checkRevisionAndState(canvas, req); err != nil {
		return nil, err
	}
	if err := applyCommand(ctx, tx, canvas, req, s.repo.nowUTC()); err != nil {
		return nil, err
	}
	canvas, err = scanCanvas(ctx, tx, canvasID)
	if err != nil {
		return nil, err
	}
	if err := s.repo.loadChildren(ctx, tx, canvas); err != nil {
		return nil, err
	}
	event := &CanvasEvent{
		CanvasID: canvasID, Revision: canvas.Revision, CommandID: req.CommandID,
		ActorKind: actorKind(ctx), ActorID: actorID(ctx), Action: req.Action,
		TargetID: req.TargetID, Payload: cloneJSON(req.Input), CreatedAt: s.repo.nowUTC(),
	}
	if err := insertEvent(ctx, tx, event); err != nil {
		return nil, err
	}
	if err := compactEvents(ctx, tx, canvas); err != nil {
		return nil, err
	}
	result := &ApplyCanvasCommandResult{Canvas: canvas, Event: event, Revision: canvas.Revision}
	resultJSON, err := marshalJSON(result)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, tx.Rebind(`
INSERT INTO canvas_command_receipts (command_id, canvas_id, result_json, resulting_revision, created_at)
VALUES (?, ?, ?, ?, ?)`), req.CommandID, canvasID, resultJSON, result.Revision, s.repo.nowUTC()); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Service) ApplyCommandForTask(ctx context.Context, canvasID, taskID string, req ApplyCanvasCommandRequest) (*ApplyCanvasCommandResult, error) {
	if _, err := s.GetCanvasForTask(ctx, canvasID, taskID); err != nil {
		return nil, err
	}
	return s.ApplyCommand(ctx, canvasID, req)
}

func (s *Service) checkRevisionAndState(canvas *Canvas, req ApplyCanvasCommandRequest) error {
	if canvas.ArchivedAt != nil {
		return ErrCanvasArchived
	}
	if req.BaseRevision != canvas.Revision && !staleStructuredCommandMayApply(req) {
		cause := fmt.Errorf("%w: expected %d, current %d", ErrRevisionConflict, req.BaseRevision, canvas.Revision)
		return newCanvasConflictError(CanvasConflictCode, cause, canvas, canvasBlock(canvas, req.TargetID), nil, nil)
	}
	return nil
}

func canvasBlock(canvas *Canvas, blockID string) *Block {
	if canvas == nil || blockID == "" {
		return nil
	}
	for index := range canvas.Blocks {
		if canvas.Blocks[index].ID == blockID {
			return &canvas.Blocks[index]
		}
	}
	return nil
}

func staleStructuredCommandMayApply(req ApplyCanvasCommandRequest) bool {
	if !isStructuredItemAction(req.Action) {
		return false
	}
	if req.Action != ActionItemUpsert && req.Action != ActionItemDelete {
		var err error
		req, err = normalizeStructuredItemCommand(req)
		if err != nil {
			return false
		}
	}
	var input itemCommandInput
	if err := decodeStrictJSON(req.Input, &input); err != nil {
		return false
	}
	return input.ExpectedItemRevision != nil
}

func (s *Service) ExportCanvas(ctx context.Context, canvasID string) (data []byte, err error) {
	defer func() {
		if err == nil {
			recordCanvasOperation("export", "exported")
		} else {
			recordCanvasOperation("export", canvasOperationResult(err))
		}
	}()
	canvas, err := s.GetCanvas(ctx, canvasID)
	if err != nil {
		return nil, err
	}
	return EncodePortableCanvas(canvas)
}

func (s *Service) ImportCanvas(ctx context.Context, workspaceID, taskID string, data []byte) (canvas *Canvas, err error) {
	defer func() {
		if err == nil {
			recordCanvasOperation("import", "imported")
		} else {
			recordCanvasOperation("import", "rejected_import")
		}
	}()
	if err := s.authorizeWorkspaceAccess(ctx, workspaceID); err != nil {
		return nil, err
	}
	file, err := DecodePortableCanvas(data)
	if err != nil {
		return nil, err
	}
	if taskID != "" {
		if err := s.assertTaskWorkspace(ctx, taskID, workspaceID); err != nil {
			return nil, err
		}
	}
	now := s.repo.nowUTC()
	canvas = &Canvas{
		ID: newID(), OwnerUserID: callerID(ctx), WorkspaceID: workspaceID,
		Title: file.Canvas.Title, SchemaVersion: file.Canvas.SchemaVersion,
		SourceExportID: &file.ExportID, ImportedAt: &now,
		Blocks: []Block{}, TaskLinks: []TaskLink{}, CreatedAt: now, UpdatedAt: now,
	}
	if err := s.createImported(ctx, canvas, file.Canvas.Blocks, taskID); err != nil {
		return nil, err
	}
	return s.repo.GetCanvas(ctx, canvas.ID)
}

func (s *Service) PreviewCanvasImport(ctx context.Context, workspaceID, taskID string, data []byte) (*CanvasImportPreview, error) {
	if err := s.authorizeWorkspaceAccess(ctx, workspaceID); err != nil {
		return nil, err
	}
	file, err := DecodePortableCanvas(data)
	if err != nil {
		return nil, err
	}
	if taskID != "" {
		if err := s.assertTaskWorkspace(ctx, taskID, workspaceID); err != nil {
			return nil, err
		}
	}
	blockTypes := make([]string, 0, len(file.Canvas.Blocks))
	for _, block := range file.Canvas.Blocks {
		blockTypes = append(blockTypes, block.Type)
	}
	return &CanvasImportPreview{
		Format: PortableFormat, FormatVersion: file.FormatVersion,
		SchemaVersion: file.Canvas.SchemaVersion, Title: file.Canvas.Title,
		BlockCount: len(file.Canvas.Blocks), BlockTypes: blockTypes,
		SizeBytes: len(data), TaskID: taskID, Independent: true,
	}, nil
}

func canvasOperationResult(err error) string {
	switch {
	case errors.Is(err, ErrRevisionConflict), errors.Is(err, ErrCommandConflict):
		return "conflicted"
	case errors.Is(err, ErrCanvasNotFound), errors.Is(err, ErrTaskWorkspaceMismatch):
		return "denied"
	default:
		return "rejected"
	}
}

func (s *Service) assertTaskWorkspace(ctx context.Context, taskID, workspaceID string) error {
	if s.resolveTaskWorkspace == nil {
		return fmt.Errorf("%w: task lookup is not configured", ErrTaskNotFound)
	}
	taskWorkspace, err := s.resolveTaskWorkspace(ctx, taskID)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrTaskNotFound, err)
	}
	if taskWorkspace != workspaceID {
		return ErrTaskWorkspaceMismatch
	}
	return nil
}

func (s *Service) createImported(ctx context.Context, canvas *Canvas, blocks []PortableBlock, taskID string) error {
	s.repo.mu.Lock()
	defer s.repo.mu.Unlock()
	tx, err := s.repo.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	active, err := countActiveCanvases(ctx, tx, canvas.WorkspaceID)
	if err != nil {
		return err
	}
	if active >= MaxActiveCanvases {
		return fmt.Errorf("%w: a workspace can have at most %d active canvases", ErrCanvasLimit, MaxActiveCanvases)
	}
	if err := insertCanvas(ctx, tx, canvas); err != nil {
		return err
	}
	orderedBlocks := append([]PortableBlock(nil), blocks...)
	sort.SliceStable(orderedBlocks, func(i, j int) bool {
		return orderedBlocks[i].Position < orderedBlocks[j].Position
	})
	for position, portable := range orderedBlocks {
		block := Block{ID: newID(), CanvasID: canvas.ID, Type: portable.Type,
			Position: position, State: cloneJSON(portable.State), CreatedAt: canvas.CreatedAt,
			UpdatedAt: canvas.UpdatedAt}
		if err := insertBlock(ctx, tx, block); err != nil {
			return err
		}
	}
	if taskID != "" {
		link := TaskLink{CanvasID: canvas.ID, TaskID: taskID, LinkedBy: callerID(ctx), CreatedAt: canvas.CreatedAt}
		if _, err := tx.ExecContext(ctx, tx.Rebind(`
INSERT INTO canvas_task_links (canvas_id, task_id, linked_by, created_at) VALUES (?, ?, ?, ?)`),
			link.CanvasID, link.TaskID, link.LinkedBy, link.CreatedAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Service) authorizeWorkspaceAccess(ctx context.Context, workspaceID string) error {
	if workspaceID == "" {
		return fmt.Errorf("%w: workspace_id is required", ErrCanvasValidation)
	}
	if s.authorizeWorkspace == nil {
		return nil
	}
	if err := s.authorizeWorkspace(ctx, workspaceID); err != nil {
		if errors.Is(err, repoerrors.ErrWorkspaceNotFound) {
			return ErrCanvasNotFound
		}
		return err
	}
	return nil
}

func canvasHasTask(canvas *Canvas, taskID string) bool {
	if canvas == nil || taskID == "" {
		return false
	}
	for _, link := range canvas.TaskLinks {
		if link.TaskID == taskID {
			return true
		}
	}
	return false
}

func callerID(ctx context.Context) string {
	identity, ok := authn.IdentityFromContext(ctx)
	if !ok {
		return ""
	}
	return identity.UserID
}

func actorKind(ctx context.Context) string {
	if _, ok := streams.MCPExecutionContextFromContext(ctx); ok {
		return "agent"
	}
	identity, ok := authn.IdentityFromContext(ctx)
	if !ok || identity.Synthetic {
		return "system"
	}
	return "user"
}

func actorID(ctx context.Context) string {
	if execution, ok := streams.MCPExecutionContextFromContext(ctx); ok {
		return execution.SessionID
	}
	return callerID(ctx)
}

func cloneJSON(data json.RawMessage) json.RawMessage {
	if len(data) == 0 {
		return json.RawMessage(`{}`)
	}
	return append(json.RawMessage(nil), data...)
}

func readReceipt(ctx context.Context, tx *sqlx.Tx, commandID, canvasID string) (*ApplyCanvasCommandResult, bool, error) {
	var storedCanvasID string
	var resultJSON []byte
	err := tx.QueryRowxContext(ctx, tx.Rebind(
		`SELECT canvas_id, result_json FROM canvas_command_receipts WHERE command_id = ?`), commandID).
		Scan(&storedCanvasID, &resultJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if storedCanvasID != canvasID {
		return nil, false, ErrCommandConflict
	}
	var result ApplyCanvasCommandResult
	if err := json.Unmarshal(resultJSON, &result); err != nil {
		return nil, false, err
	}
	return &result, true, nil
}

func insertEvent(ctx context.Context, tx *sqlx.Tx, event *CanvasEvent) error {
	_, err := tx.ExecContext(ctx, tx.Rebind(`
INSERT INTO canvas_events (canvas_id, revision, command_id, actor_kind, actor_id,
 action, target_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		event.CanvasID, event.Revision, event.CommandID, event.ActorKind, event.ActorID,
		event.Action, event.TargetID, event.Payload, event.CreatedAt)
	return err
}
