package canvas

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/auth/authn"
)

func TestRestoringCanvasEnforcesActiveLimit(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvases := make([]*Canvas, 0, MaxActiveCanvases+1)
	for index := 0; index < MaxActiveCanvases; index++ {
		canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{
			WorkspaceID: "ws-a",
			Title:       fmt.Sprintf("Canvas %d", index),
		})
		if err != nil {
			t.Fatalf("create canvas %d: %v", index, err)
		}
		canvases = append(canvases, canvas)
	}
	if _, err := svc.SetCanvasArchived(ctx, canvases[0].ID, true); err != nil {
		t.Fatalf("archive canvas: %v", err)
	}
	replacement, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Replacement"})
	if err != nil {
		t.Fatalf("create replacement canvas: %v", err)
	}
	if replacement.ArchivedAt != nil {
		t.Fatal("replacement canvas is archived")
	}

	_, err = svc.SetCanvasArchived(ctx, canvases[0].ID, false)
	if !errors.Is(err, ErrCanvasLimit) {
		t.Fatalf("restore error = %v, want canvas limit", err)
	}
	current, err := svc.GetCanvas(ctx, canvases[0].ID)
	if err != nil {
		t.Fatalf("get archived canvas: %v", err)
	}
	if current.ArchivedAt == nil {
		t.Fatal("canvas was restored despite the active limit")
	}
}

func TestConcurrentCanvasRestoresAllowOnlyOneAtActiveLimit(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvases := make([]*Canvas, 0, MaxActiveCanvases)
	for index := 0; index < MaxActiveCanvases; index++ {
		canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{
			WorkspaceID: "ws-a",
			Title:       fmt.Sprintf("Canvas %d", index),
		})
		if err != nil {
			t.Fatalf("create canvas %d: %v", index, err)
		}
		canvases = append(canvases, canvas)
	}
	for _, canvas := range canvases[:2] {
		if _, err := svc.SetCanvasArchived(ctx, canvas.ID, true); err != nil {
			t.Fatalf("archive canvas %s: %v", canvas.ID, err)
		}
	}
	if _, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Replacement"}); err != nil {
		t.Fatalf("create replacement canvas: %v", err)
	}

	results := make(chan error, 2)
	var wait sync.WaitGroup
	for _, canvas := range canvases[:2] {
		wait.Add(1)
		go func(canvasID string) {
			defer wait.Done()
			_, restoreErr := svc.SetCanvasArchived(ctx, canvasID, false)
			results <- restoreErr
		}(canvas.ID)
	}
	wait.Wait()
	close(results)

	var restored, limited int
	for err := range results {
		switch {
		case err == nil:
			restored++
		case errors.Is(err, ErrCanvasLimit):
			limited++
		default:
			t.Fatalf("unexpected concurrent restore error: %v", err)
		}
	}
	if restored != 1 || limited != 1 {
		t.Fatalf("concurrent restores = %d successful, %d limited; want one of each", restored, limited)
	}
}

func TestCanvasStructuredItemLimitIsAggregatedAcrossBlocks(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Items"})
	if err != nil {
		t.Fatal(err)
	}
	first, err := addCanvasBlock(t, svc, canvas.ID, 0, "first", BlockTypeChecklist, structuredItemsState(249, "a"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := addCanvasBlock(t, svc, canvas.ID, 1, "second", BlockTypeChecklist, structuredItemsState(250, "b"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "items-over-limit-create", BaseRevision: second.Revision,
		Action: ActionBlockCreate, Input: blockInput(BlockTypeChecklist, structuredItemsState(2, "c")),
	})
	if !errors.Is(err, ErrCanvasLimit) {
		t.Fatalf("aggregate block create error = %v, want canvas limit", err)
	}

	_, err = svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "items-over-limit-update", BaseRevision: second.Revision,
		Action: ActionBlockUpdate, TargetID: first.Canvas.Blocks[0].ID,
		Input: json.RawMessage(fmt.Sprintf(`{"expected_block_revision":0,"state":%s}`, structuredItemsState(251, "a"))),
	})
	if !errors.Is(err, ErrCanvasLimit) {
		t.Fatalf("aggregate block update error = %v, want canvas limit", err)
	}
}

func TestCanvasItemMutationAndImportEnforceAggregateItemLimit(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Items"})
	if err != nil {
		t.Fatal(err)
	}
	created, err := addCanvasBlock(t, svc, canvas.ID, 0, "items", BlockTypeChecklist, structuredItemsState(MaxItems, "item"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "item-over-limit", BaseRevision: created.Revision, Action: ActionChecklistAdd,
		TargetID: created.Canvas.Blocks[0].ID,
		Input:    json.RawMessage(`{"item_id":"new-item","item":{"label":"new item"},"expected_item_revision":0}`),
	})
	if !errors.Is(err, ErrCanvasLimit) {
		t.Fatalf("aggregate item mutation error = %v, want canvas limit", err)
	}

	file := portableFileWithBlocks(t, []PortableBlock{
		{Type: BlockTypeChecklist, Position: 0, State: structuredItemsState(250, "a")},
		{Type: BlockTypeChecklist, Position: 1, State: structuredItemsState(251, "b")},
	})
	data, err := json.Marshal(file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ImportCanvas(ctx, "ws-a", "", data); !errors.Is(err, ErrInvalidPortableFile) {
		t.Fatalf("aggregate import error = %v, want invalid portable file", err)
	}
}

func TestMarkdownRejectsRemoteImagesDuringCreateUpdateAndImport(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Markdown"})
	if err != nil {
		t.Fatal(err)
	}
	remoteState := json.RawMessage(`{"markdown":"![tracker](https://tracker.example/pixel)"}`)
	_, err = svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "remote-markdown-create", BaseRevision: 0, Action: ActionBlockCreate,
		Input: json.RawMessage(fmt.Sprintf(`{"type":"markdown","state":%s}`, remoteState)),
	})
	if !errors.Is(err, ErrCanvasValidation) {
		t.Fatalf("remote markdown create error = %v, want validation", err)
	}

	created, err := addCanvasBlock(t, svc, canvas.ID, 0, "markdown", BlockTypeMarkdown, json.RawMessage(`{"markdown":"safe"}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AcquireMarkdownLease(ctx, canvas.ID, created.Canvas.Blocks[0].ID, "holder"); err != nil {
		t.Fatal(err)
	}
	_, err = svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "remote-markdown-update", BaseRevision: created.Revision, Action: ActionBlockUpdate,
		TargetID: created.Canvas.Blocks[0].ID, LeaseHolderID: "holder",
		Input: json.RawMessage(fmt.Sprintf(`{"expected_block_revision":0,"state":%s}`, remoteState)),
	})
	if !errors.Is(err, ErrCanvasValidation) {
		t.Fatalf("remote markdown update error = %v, want validation", err)
	}

	file := portableFileWithBlocks(t, []PortableBlock{{
		Type: BlockTypeMarkdown, Position: 0, State: remoteState,
	}})
	data, err := json.Marshal(file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ImportCanvas(ctx, "ws-a", "", data); !errors.Is(err, ErrInvalidPortableFile) {
		t.Fatalf("remote markdown import error = %v, want invalid portable file", err)
	}
}

func TestMarkdownRejectsRemoteReferenceImages(t *testing.T) {
	remoteState := json.RawMessage(`{"markdown":"![tracker][pixel]\n\n[pixel]: https://tracker.example/pixel"}`)
	if err := validateBlock(BlockTypeMarkdown, remoteState); !errors.Is(err, ErrCanvasValidation) {
		t.Fatalf("remote markdown reference validation = %v, want validation", err)
	}

	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Markdown references"})
	if err != nil {
		t.Fatal(err)
	}
	created, err := addCanvasBlock(t, svc, canvas.ID, 0, "markdown", BlockTypeMarkdown, json.RawMessage(`{"markdown":"safe"}`))
	if err != nil {
		t.Fatal(err)
	}
	blockID := created.Canvas.Blocks[0].ID
	if _, err := svc.AcquireMarkdownLease(ctx, canvas.ID, blockID, "holder"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "remote-reference-update", BaseRevision: created.Revision, Action: ActionBlockUpdate,
		TargetID: blockID, LeaseHolderID: "holder",
		Input: json.RawMessage(fmt.Sprintf(`{"expected_block_revision":0,"state":%s}`, remoteState)),
	}); !errors.Is(err, ErrCanvasValidation) {
		t.Fatalf("remote markdown reference update = %v, want validation", err)
	}

	file := portableFileWithBlocks(t, []PortableBlock{{
		Type: BlockTypeMarkdown, Position: 0, State: remoteState,
	}})
	data, err := json.Marshal(file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ImportCanvas(ctx, "ws-a", "", data); !errors.Is(err, ErrInvalidPortableFile) {
		t.Fatalf("remote markdown reference import = %v, want invalid portable file", err)
	}
}

func TestAuthenticatedOpaqueLeaseHoldersAreScopedToTheirCaller(t *testing.T) {
	tabID := "tab-1"
	first := authn.WithIdentity(context.Background(), authn.Identity{
		UserID: "user-a", SessionID: "session-a",
	})
	second := authn.WithIdentity(context.Background(), authn.Identity{
		UserID: "user-b", SessionID: "session-b",
	})
	firstResolved, err := resolveLeaseHolder(first, tabID)
	if err != nil {
		t.Fatal(err)
	}
	repeatResolved, err := resolveLeaseHolder(first, tabID)
	if err != nil {
		t.Fatal(err)
	}
	secondResolved, err := resolveLeaseHolder(second, tabID)
	if err != nil {
		t.Fatal(err)
	}
	if firstResolved == tabID || firstResolved != repeatResolved || firstResolved == secondResolved {
		t.Fatalf("scoped lease holders = %q, %q, %q; want stable per-caller values", firstResolved, repeatResolved, secondResolved)
	}
}

func TestKanbanCardIDsAreUniqueAcrossColumns(t *testing.T) {
	duplicateState := json.RawMessage(`{"columns":[{"id":"todo","cards":[{"id":"card-1","title":"Todo","revision":1}]},{"id":"done","cards":[{"id":"card-1","title":"Done","revision":1}]}]}`)
	if err := validateBlock(BlockTypeKanban, duplicateState); !errors.Is(err, ErrCanvasValidation) {
		t.Fatalf("duplicate kanban create validation = %v, want validation", err)
	}

	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Kanban"})
	if err != nil {
		t.Fatal(err)
	}
	created, err := addCanvasBlock(t, svc, canvas.ID, 0, "kanban", BlockTypeKanban, json.RawMessage(`{"columns":[{"id":"todo","cards":[{"id":"card-1","title":"Todo","revision":1}]},{"id":"done","cards":[]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	_, err = svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "duplicate-kanban-update", BaseRevision: created.Revision, Action: ActionBlockUpdate,
		TargetID: created.Canvas.Blocks[0].ID,
		Input:    json.RawMessage(fmt.Sprintf(`{"expected_block_revision":0,"state":%s}`, duplicateState)),
	})
	if !errors.Is(err, ErrCanvasValidation) {
		t.Fatalf("duplicate kanban update validation = %v, want validation", err)
	}

	file := portableFileWithBlocks(t, []PortableBlock{{Type: BlockTypeKanban, Position: 0, State: duplicateState}})
	data, err := json.Marshal(file)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ImportCanvas(ctx, "ws-a", "", data); !errors.Is(err, ErrInvalidPortableFile) {
		t.Fatalf("duplicate kanban import validation = %v, want invalid portable file", err)
	}
}

func TestCanvasImportPreviewValidatesBeforeReturningMetadata(t *testing.T) {
	svc := newCanvasTestService(t)
	data, err := json.Marshal(portableFileWithBlocks(t, []PortableBlock{
		{Type: BlockTypeChecklist, Position: 0, State: json.RawMessage(`{"items":[]}`)},
		{Type: BlockTypeTimeline, Position: 1, State: json.RawMessage(`{"events":[]}`)},
	}))
	if err != nil {
		t.Fatal(err)
	}
	preview, err := svc.PreviewCanvasImport(context.Background(), "ws-a", "task-a", data)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Title != "Imported" || preview.BlockCount != 2 || preview.SizeBytes != len(data) || !preview.Independent || preview.TaskID != "task-a" {
		t.Fatalf("import preview = %+v", preview)
	}
	if fmt.Sprint(preview.BlockTypes) != "[checklist timeline]" {
		t.Fatalf("preview block types = %v", preview.BlockTypes)
	}

	invalid := append([]byte(nil), data...)
	invalid[len(invalid)-2] = 'x'
	if _, err := svc.PreviewCanvasImport(context.Background(), "ws-a", "", invalid); !errors.Is(err, ErrInvalidPortableFile) {
		t.Fatalf("invalid preview error = %v, want invalid portable file", err)
	}
}

func addCanvasBlock(t *testing.T, svc *Service, canvasID string, revision int64, name, blockType string, state json.RawMessage) (*ApplyCanvasCommandResult, error) {
	t.Helper()
	return svc.ApplyCommand(context.Background(), canvasID, ApplyCanvasCommandRequest{
		CommandID: name, BaseRevision: revision, Action: ActionBlockCreate, Input: blockInput(blockType, state),
	})
}

func blockInput(blockType string, state json.RawMessage) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"type":%q,"state":%s}`, blockType, state))
}

func structuredItemsState(count int, prefix string) json.RawMessage {
	items := make([]map[string]any, count)
	for index := range items {
		items[index] = map[string]any{
			"id": fmt.Sprintf("%s-%d", prefix, index), "label": "item", "revision": 1,
		}
	}
	data, _ := json.Marshal(map[string]any{"items": items})
	return data
}

func portableFileWithBlocks(t *testing.T, blocks []PortableBlock) PortableCanvasFile {
	t.Helper()
	return PortableCanvasFile{
		Format: PortableFormat, FormatVersion: PortableVersion, ExportID: "export-id",
		ExportedAt: time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC),
		Canvas:     PortableCanvas{Title: "Imported", SchemaVersion: CanvasSchemaVersion, Blocks: blocks},
	}
}
