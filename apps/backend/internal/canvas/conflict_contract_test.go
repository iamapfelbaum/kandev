package canvas

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/kandev/kandev/internal/auth/authn"
	ws "github.com/kandev/kandev/pkg/websocket"
)

func TestCanvasItemConflictIncludesRecoverySnapshot(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Conflict"})
	if err != nil {
		t.Fatal(err)
	}
	created, err := addCanvasBlock(t, svc, canvas.ID, 0, "conflict-block", BlockTypeChecklist,
		json.RawMessage(`{"items":[{"id":"item-a","label":"A","revision":1}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "first-item-update", BaseRevision: created.Revision, Action: ActionChecklistToggle,
		TargetID: created.Canvas.Blocks[0].ID,
		Input:    json.RawMessage(`{"item_id":"item-a","completed":true,"expected_item_revision":1}`),
	}); err != nil {
		t.Fatal(err)
	}

	_, err = svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "stale-item-update", BaseRevision: created.Revision, Action: ActionChecklistToggle,
		TargetID: created.Canvas.Blocks[0].ID,
		Input:    json.RawMessage(`{"item_id":"item-a","completed":false,"expected_item_revision":1}`),
	})
	if !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale item error = %v, want revision conflict", err)
	}
	var conflict *CanvasConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("stale item error = %T, want CanvasConflictError", err)
	}
	if conflict.Code != CanvasConflictCode {
		t.Fatalf("conflict code = %q, want %q", conflict.Code, CanvasConflictCode)
	}
	if conflict.Details == nil || conflict.Details.CanvasRevision != 2 || conflict.Details.BlockRevision != 1 {
		t.Fatalf("conflict revisions = %+v, want canvas 2 and block 1", conflict.Details)
	}
	if conflict.Details.CurrentBlock == nil {
		t.Fatal("conflict omitted current block")
	}
	if conflict.Details.CurrentItem["completed"] != true {
		t.Fatalf("current item = %+v, want completed item", conflict.Details.CurrentItem)
	}
}

func TestCanvasLeaseConflictIncludesSafeLeaseState(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := context.Background()
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Lease"})
	if err != nil {
		t.Fatal(err)
	}
	created, err := addCanvasBlock(t, svc, canvas.ID, 0, "lease-block", BlockTypeMarkdown,
		json.RawMessage(`{"markdown":"safe"}`))
	if err != nil {
		t.Fatal(err)
	}
	blockID := created.Canvas.Blocks[0].ID
	if _, err := svc.AcquireMarkdownLease(ctx, canvas.ID, blockID, "holder-a"); err != nil {
		t.Fatal(err)
	}
	_, err = svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "lease-conflict", BaseRevision: 1, Action: ActionBlockUpdate,
		TargetID: blockID, LeaseHolderID: "holder-b",
		Input: json.RawMessage(`{"expected_block_revision":0,"state":{"markdown":"blocked"}}`),
	})
	if !errors.Is(err, ErrLeaseUnavailable) {
		t.Fatalf("lease error = %v, want lease unavailable", err)
	}
	var conflict *CanvasConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("lease error = %T, want CanvasConflictError", err)
	}
	if conflict.Code != CanvasBusyCode {
		t.Fatalf("lease conflict code = %q, want %q", conflict.Code, CanvasBusyCode)
	}
	if conflict.Details == nil || conflict.Details.Lease == nil {
		t.Fatal("lease conflict omitted lease state")
	}
	if !conflict.Details.Lease.Active || conflict.Details.Lease.Holder != "other" {
		t.Fatalf("lease state = %+v, want active lease held by other", conflict.Details.Lease)
	}
	if conflict.Details.Lease.Holder == "holder-a" {
		t.Fatal("lease conflict leaked the current holder identifier")
	}
}

func TestAuthenticatedOpaqueLeaseHolderCanRenewAndUpdate(t *testing.T) {
	svc := newCanvasTestService(t)
	ctx := authn.WithIdentity(context.Background(), authn.Identity{
		UserID: "user-a", SessionID: "session-a",
	})
	canvas, err := svc.CreateCanvas(ctx, CreateCanvasRequest{WorkspaceID: "ws-a", Title: "Lease scope"})
	if err != nil {
		t.Fatal(err)
	}
	created, err := addCanvasBlock(t, svc, canvas.ID, 0, "lease-scope-block", BlockTypeMarkdown,
		json.RawMessage(`{"markdown":"safe"}`))
	if err != nil {
		t.Fatal(err)
	}
	blockID := created.Canvas.Blocks[0].ID
	if _, err := svc.AcquireMarkdownLease(ctx, canvas.ID, blockID, "tab-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AcquireMarkdownLease(ctx, canvas.ID, blockID, "tab-a"); err != nil {
		t.Fatalf("same authenticated tab could not renew its lease: %v", err)
	}
	if _, err := svc.ApplyCommand(ctx, canvas.ID, ApplyCanvasCommandRequest{
		CommandID: "authenticated-markdown-update", BaseRevision: created.Revision,
		Action: ActionBlockUpdate, TargetID: blockID, LeaseHolderID: "tab-a",
		Input: json.RawMessage(`{"expected_block_revision":0,"state":{"markdown":"updated"}}`),
	}); err != nil {
		t.Fatalf("same authenticated tab could not update markdown: %v", err)
	}
}

func TestCanvasConflictDetailsArePreservedByHTTPAndWebSocket(t *testing.T) {
	block := &Block{ID: "block-1", BlockRevision: 4, State: json.RawMessage(`{"markdown":"current"}`)}
	conflict := &CanvasConflictError{
		Code:  CanvasConflictCode,
		Cause: ErrRevisionConflict,
		Details: &CanvasConflictDetails{
			CanvasRevision: 8, BlockRevision: 4, CurrentBlock: block,
			CurrentItem: map[string]any{"id": "item-1", "revision": 3},
		},
	}

	recorder := httptest.NewRecorder()
	ginCtx, _ := gin.CreateTestContext(recorder)
	ginCtx.Request = httptest.NewRequest("GET", "/", nil)
	if !writeCanvasError(ginCtx, conflict) {
		t.Fatal("writeCanvasError did not write a conflict")
	}
	var httpPayload struct {
		Code      string                `json:"code"`
		ErrorCode string                `json:"error_code"`
		Details   CanvasConflictDetails `json:"details"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &httpPayload); err != nil {
		t.Fatal(err)
	}
	if httpPayload.Code != CanvasConflictCode || httpPayload.ErrorCode != CanvasConflictCode || httpPayload.Details.CanvasRevision != 8 {
		t.Fatalf("HTTP conflict payload = %+v", httpPayload)
	}

	message, err := canvasWSError(&ws.Message{ID: "request", Action: "canvas.command"}, conflict)
	if err != nil {
		t.Fatal(err)
	}
	var wsPayload ws.ErrorPayload
	if err := message.ParsePayload(&wsPayload); err != nil {
		t.Fatal(err)
	}
	if wsPayload.Code != CanvasConflictCode || wsPayload.Details["canvas_revision"] != float64(8) {
		t.Fatalf("WebSocket conflict payload = %+v", wsPayload)
	}
}
