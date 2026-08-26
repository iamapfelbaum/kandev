package canvas

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/agentctl/types/streams"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	_ "github.com/mattn/go-sqlite3"
)

func newCanvasTestService(t *testing.T) *Service {
	t.Helper()
	db, err := sqlx.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`
		CREATE TABLE workspaces (id TEXT PRIMARY KEY);
		CREATE TABLE tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
		INSERT INTO workspaces (id) VALUES ('ws-a'), ('ws-b');
		INSERT INTO tasks (id, workspace_id) VALUES ('task-a', 'ws-a'), ('task-b', 'ws-b');
	`); err != nil {
		t.Fatal(err)
	}
	repo, err := NewRepository(db, db, nil)
	if err != nil {
		t.Fatal(err)
	}
	svc := NewService(repo, nil)
	svc.SetTaskWorkspaceResolver(func(_ context.Context, taskID string) (string, error) {
		var workspaceID string
		err := db.Get(&workspaceID, "SELECT workspace_id FROM tasks WHERE id = ?", taskID)
		return workspaceID, err
	})
	return svc
}

func TestCanvasCommandsAreRevisionCheckedAndIdempotent(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Roadmap"})
	if err != nil {
		t.Fatal(err)
	}

	input, err := json.Marshal(map[string]any{
		"type":  BlockTypeMarkdown,
		"state": map[string]string{"markdown": "hello"},
	})
	if err != nil {
		t.Fatal(err)
	}
	command := ApplyCanvasCommandRequest{
		CommandID:    "cmd-1",
		BaseRevision: 0,
		Action:       ActionBlockCreate,
		Input:        input,
	}
	result, err := svc.ApplyCommand(ctx, canvas.ID, command)
	if err != nil {
		t.Fatal(err)
	}
	if result.Revision != 1 || len(result.Canvas.Blocks) != 1 {
		t.Fatalf("expected revision 1 with one block, got revision %d and %d blocks", result.Revision, len(result.Canvas.Blocks))
	}

	duplicate, err := svc.ApplyCommand(ctx, canvas.ID, command)
	if err != nil {
		t.Fatal(err)
	}
	if !duplicate.Duplicate || duplicate.Revision != result.Revision {
		t.Fatalf("expected duplicate receipt at revision %d, got %+v", result.Revision, duplicate)
	}

	_, err = svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID:    "cmd-stale",
		BaseRevision: 0,
		Action:       ActionBlockDelete,
		TargetID:     result.Canvas.Blocks[0].ID,
	})
	if !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("expected revision conflict, got %v", err)
	}
}

func TestCanvasTaskLinksMustShareWorkspace(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Links"})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.AddTaskLink(ctx, canvas.ID, "task-a"); err != nil {
		t.Fatal(err)
	}
	if err := svc.AddTaskLink(ctx, canvas.ID, "task-b"); !errors.Is(err, ErrTaskWorkspaceMismatch) {
		t.Fatalf("expected cross-workspace link rejection, got %v", err)
	}
}

func TestPortableCanvasRejectsUnknownFieldsAndDoesNotExportInternalIDs(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Portable"})
	if err != nil {
		t.Fatal(err)
	}
	input := json.RawMessage(`{"type":"markdown","state":{"markdown":"safe"}}`)
	result, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID:    "portable-block",
		BaseRevision: 0,
		Action:       ActionBlockCreate,
		Input:        input,
	})
	if err != nil {
		t.Fatal(err)
	}
	exported, err := svc.ExportCanvas(ctx, canvas.ID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(exported), result.Canvas.Blocks[0].ID) {
		t.Fatalf("portable export leaked internal block id: %s", exported)
	}
	if _, err := DecodePortableCanvas([]byte(`{"format":"kandev.canvas","format_version":1,"export_id":"x","exported_at":"2026-01-01T00:00:00Z","canvas":{"title":"x","schema_version":1,"blocks":[],"unexpected":true}}`)); !errors.Is(err, ErrInvalidPortableFile) {
		t.Fatalf("expected unknown portable field rejection, got %v", err)
	}
}

func TestCanvasTitleLimit(t *testing.T) {
	svc := newCanvasTestService(t)
	_, err := svc.CreateCanvas(context.Background(), CreateCanvasRequest{
		WorkspaceID: "ws-a",
		Title:       strings.Repeat("x", MaxTitleLength+1),
	})
	if !errors.Is(err, ErrCanvasValidation) {
		t.Fatalf("expected title validation error, got %v", err)
	}
}

func TestBlockValidationRequiresTypedCollectionsAndItemRevisions(t *testing.T) {
	tests := []struct {
		name      string
		blockType string
		state     string
	}{
		{name: "checklist item object", blockType: BlockTypeChecklist, state: `{"items":["not an item"]}`},
		{name: "checklist item revision", blockType: BlockTypeChecklist, state: `{"items":[{"id":"item-a","label":"A","revision":1.5}]}`},
		{name: "kanban columns", blockType: BlockTypeKanban, state: `{"columns":[{"id":"todo"}]}`},
		{name: "metrics collection", blockType: BlockTypeMetrics, state: `{"items":[]}`},
		{name: "timeline item id", blockType: BlockTypeTimeline, state: `{"events":[{"label":"Started","revision":1}]}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := validateBlock(test.blockType, json.RawMessage(test.state)); !errors.Is(err, ErrCanvasValidation) {
				t.Fatalf("validation error = %v, want canvas validation", err)
			}
		})
	}
}

func TestStructuredItemCommandsAllowIndependentStaleWriters(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Items"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "items-block", BaseRevision: 0, Action: ActionBlockCreate,
		Input: json.RawMessage(`{"type":"checklist","state":{"items":[{"id":"item-a","label":"A","revision":1},{"id":"item-b","label":"B","revision":1}]}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	blockID := result.Canvas.Blocks[0].ID
	first, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "item-a-update", BaseRevision: 1, Action: ActionChecklistToggle, TargetID: blockID,
		Input: json.RawMessage(`{"item_id":"item-a","completed":true,"expected_item_revision":1}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 2 {
		t.Fatalf("first item update revision = %d, want 2", first.Revision)
	}
	second, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "item-b-update", BaseRevision: 1, Action: ActionItemUpsert, TargetID: blockID,
		Input: json.RawMessage(`{"collection":"items","item_id":"item-b","patch":{"completed":true},"expected_item_revision":1}`),
	})
	if err != nil {
		t.Fatalf("independent stale item update failed: %v", err)
	}
	if second.Revision != 3 {
		t.Fatalf("second item update revision = %d, want 3", second.Revision)
	}
	_, err = svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "item-a-stale", BaseRevision: 1, Action: ActionItemUpsert, TargetID: blockID,
		Input: json.RawMessage(`{"collection":"items","item_id":"item-a","patch":{"completed":false},"expected_item_revision":1}`),
	})
	if !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("same-item stale update error = %v, want revision conflict", err)
	}
}

func TestMarkdownCommandsRequireTheCurrentLease(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Markdown"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "markdown-block", BaseRevision: 0, Action: ActionBlockCreate,
		Input: json.RawMessage(`{"type":"markdown","state":{"markdown":"safe"}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	blockID := result.Canvas.Blocks[0].ID
	if _, err := svc.AcquireMarkdownLease(ctx, canvas.ID, blockID, "holder-a"); err != nil {
		t.Fatal(err)
	}
	_, err = svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "markdown-denied", BaseRevision: 1, Action: ActionBlockUpdate, TargetID: blockID,
		LeaseHolderID: "holder-b", Input: json.RawMessage(`{"expected_block_revision":0,"state":{"markdown":"blocked"}}`),
	})
	if !errors.Is(err, ErrLeaseUnavailable) {
		t.Fatalf("wrong lease error = %v, want lease unavailable", err)
	}
	if _, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "markdown-allowed", BaseRevision: 1, Action: ActionBlockUpdate, TargetID: blockID,
		LeaseHolderID: "holder-a", Input: json.RawMessage(`{"expected_block_revision":0,"state":{"markdown":"updated"}}`),
	}); err != nil {
		t.Fatal(err)
	}
}

func TestCanvasCompactsEventsAndReturnsSnapshotForOldSubscribers(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "History"})
	if err != nil {
		t.Fatal(err)
	}
	var revision int64
	for index := 0; index < MaxEventCount+1; index++ {
		result, applyErr := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
			CommandID: fmt.Sprintf("history-%d", index), BaseRevision: revision,
			Action: ActionCanvasRename, Input: json.RawMessage(fmt.Sprintf(`{"title":"History %d"}`, index)),
		})
		if applyErr != nil {
			t.Fatal(applyErr)
		}
		revision = result.Revision
	}
	current, err := svc.GetCanvas(ctx, canvas.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.CompactedThroughRevision != 1 {
		t.Fatalf("compacted through revision = %d, want 1", current.CompactedThroughRevision)
	}
	events, err := svc.ListEvents(ctx, canvas.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != MaxEventCount {
		t.Fatalf("retained event count = %d, want %d", len(events), MaxEventCount)
	}
	snapshot, err := svc.SubscribeCanvas(ctx, canvas.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Recovery string        `json:"recovery"`
		Events   []CanvasEvent `json:"events"`
	}
	if err := json.Unmarshal(snapshot, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Recovery != "snapshot" || len(payload.Events) != 0 {
		t.Fatalf("old subscriber recovery = %q with %d events, want snapshot with no events", payload.Recovery, len(payload.Events))
	}
}

func TestCanvasAccessHidesForeignWorkspace(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	foreign, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-b", Title: "Private"})
	if err != nil {
		t.Fatal(err)
	}
	svc.SetWorkspaceAuthorizer(func(_ context.Context, workspaceID string) error {
		if workspaceID != "ws-a" {
			return repoerrors.ErrWorkspaceNotFound
		}
		return nil
	})
	if _, err := svc.GetCanvas(ctx, foreign.ID); !errors.Is(err, ErrCanvasNotFound) {
		t.Fatalf("foreign canvas error = %v, want canvas not found", err)
	}
}

func TestCanvasSubscriptionUsesAnEmptyEventArray(t *testing.T) {
	svc := newCanvasTestService(t)
	canvas, err := svc.CreateCanvas(context.Background(), CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Empty"})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := svc.SubscribeCanvas(context.Background(), canvas.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Events json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(snapshot, &payload); err != nil {
		t.Fatal(err)
	}
	if string(payload.Events) != "[]" {
		t.Fatalf("empty canvas events = %s, want []", payload.Events)
	}
}

func TestPortableCanvasImportPreservesPositionOrder(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	source, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Portable"})
	if err != nil {
		t.Fatal(err)
	}
	first, err := svc.ApplyCommand(ctx, source.ID, ApplyCanvasCommandRequest{
		CommandID: "portable-checklist", BaseRevision: 0, Action: ActionBlockCreate,
		Input: json.RawMessage(`{"type":"checklist","state":{"items":[]}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.ApplyCommand(ctx, source.ID, ApplyCanvasCommandRequest{
		CommandID: "portable-markdown", BaseRevision: 1, Action: ActionBlockCreate,
		Input: json.RawMessage(`{"type":"markdown","state":{"markdown":"notes"}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	exported, err := svc.ExportCanvas(ctx, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	file, err := DecodePortableCanvas(exported)
	if err != nil {
		t.Fatal(err)
	}
	file.Canvas.Blocks[0], file.Canvas.Blocks[1] = file.Canvas.Blocks[1], file.Canvas.Blocks[0]
	shuffled, err := json.Marshal(file)
	if err != nil {
		t.Fatal(err)
	}
	imported, err := svc.ImportCanvas(ctx, "ws-a", "", shuffled)
	if err != nil {
		t.Fatal(err)
	}
	if len(imported.Blocks) != 2 || imported.Blocks[0].Type != first.Canvas.Blocks[0].Type || imported.Blocks[1].Type != second.Canvas.Blocks[1].Type {
		t.Fatalf("imported block order = %+v, want checklist then markdown", imported.Blocks)
	}
	if imported.Blocks[0].ID == first.Canvas.Blocks[0].ID || imported.Blocks[1].ID == second.Canvas.Blocks[0].ID {
		t.Fatal("import reused internal block identifiers")
	}
}

func TestMarkdownTypeConversionRequiresLease(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Lease"})
	if err != nil {
		t.Fatal(err)
	}
	created, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "lease-markdown", BaseRevision: 0, Action: ActionBlockCreate,
		Input: json.RawMessage(`{"type":"markdown","state":{"markdown":"notes"}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	blockID := created.Canvas.Blocks[0].ID
	if _, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "lease-conversion-denied", BaseRevision: 1, Action: ActionBlockUpdate,
		TargetID: blockID, Input: json.RawMessage(`{"type":"checklist","expected_block_revision":0,"state":{"items":[]}}`),
	}); !errors.Is(err, ErrLeaseUnavailable) {
		t.Fatalf("markdown conversion error = %v, want lease unavailable", err)
	}
}

func TestStructuredItemMoveRelocatesTheItem(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Move"})
	if err != nil {
		t.Fatal(err)
	}
	created, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "move-block", BaseRevision: 0, Action: ActionBlockCreate,
		Input: json.RawMessage(`{"type":"checklist","state":{"items":[{"id":"a","label":"A","revision":1},{"id":"b","label":"B","revision":1},{"id":"c","label":"C","revision":1}]}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	moved, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "move-a", BaseRevision: 1, Action: ActionChecklistMove, TargetID: created.Canvas.Blocks[0].ID,
		Input: json.RawMessage(`{"item_id":"a","position":2,"expected_item_revision":1}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		Items []struct {
			ID       string `json:"id"`
			Revision int64  `json:"revision"`
		} `json:"items"`
	}
	if err := json.Unmarshal(moved.Canvas.Blocks[0].State, &state); err != nil {
		t.Fatal(err)
	}
	if got := []string{state.Items[0].ID, state.Items[1].ID, state.Items[2].ID}; fmt.Sprint(got) != "[b c a]" {
		t.Fatalf("moved item order = %v, want [b c a]", got)
	}
	if state.Items[2].Revision != 2 {
		t.Fatalf("moved item revision = %d, want 2", state.Items[2].Revision)
	}
}

func TestKanbanMoveChangesTheDestinationColumn(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Kanban move"})
	if err != nil {
		t.Fatal(err)
	}
	created, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "kanban-block", BaseRevision: 0, Action: ActionBlockCreate,
		Input: json.RawMessage(`{"type":"kanban","state":{"columns":[{"id":"todo","cards":[{"id":"a","title":"A","revision":1}]},{"id":"doing","cards":[{"id":"b","title":"B","revision":1}]}]}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	moved, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "kanban-move-a", BaseRevision: 1, Action: ActionKanbanCardMove,
		TargetID: created.Canvas.Blocks[0].ID,
		Input:    json.RawMessage(`{"item_id":"a","destination_column_id":"doing","position":0,"expected_item_revision":1}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	var state struct {
		Columns []struct {
			ID    string `json:"id"`
			Cards []struct {
				ID       string `json:"id"`
				Revision int64  `json:"revision"`
			} `json:"cards"`
		} `json:"columns"`
	}
	if err := json.Unmarshal(moved.Canvas.Blocks[0].State, &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Columns[0].Cards) != 0 || len(state.Columns[1].Cards) != 2 {
		t.Fatalf("kanban columns after move = %+v", state.Columns)
	}
	if state.Columns[1].Cards[0].ID != "a" || state.Columns[1].Cards[0].Revision != 2 {
		t.Fatalf("moved card = %+v, want card a at revision 2", state.Columns[1].Cards[0])
	}
}

func TestCanvasEventsAttributeTrustedMCPSession(t *testing.T) {
	ctx := streams.WithMCPExecutionContext(context.Background(), streams.MCPExecutionContext{
		ExecutionID: "execution-1", TaskID: "task-a", SessionID: "session-a",
	})
	svc := newCanvasTestService(t)
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Agent"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "agent-command", BaseRevision: 0, Action: ActionBlockCreate,
		Input: json.RawMessage(`{"type":"markdown","state":{"markdown":"agent"}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Event.ActorKind != "agent" || result.Event.ActorID != "session-a" {
		t.Fatalf("event actor = %s/%s, want agent/session-a", result.Event.ActorKind, result.Event.ActorID)
	}
}
