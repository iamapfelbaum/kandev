package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"

	canvasdomain "github.com/kandev/kandev/internal/canvas"
	ws "github.com/kandev/kandev/pkg/websocket"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func (s *Server) registerCanvasTools() {
	s.mcpServer.AddTool(
		mcp.NewTool("list_canvases_kandev",
			mcp.WithDescription("List declarative canvases in a workspace."),
			mcp.WithString("workspace_id", mcp.Required(), mcp.Description("The workspace ID")),
		),
		s.wrapHandler("list_canvases_kandev", s.listCanvasesHandler()),
	)
	s.mcpServer.AddTool(
		mcp.NewTool("create_canvas_kandev",
			mcp.WithDescription("Create a canvas in a workspace. A task-bound agent links the new canvas to its current task."),
			mcp.WithString("workspace_id", mcp.Required(), mcp.Description("The workspace ID")),
			mcp.WithString("title", mcp.Required(), mcp.Description("The canvas title")),
		),
		s.wrapHandler("create_canvas_kandev", s.createCanvasHandler()),
	)
	s.mcpServer.AddTool(
		mcp.NewTool("get_canvas_kandev",
			mcp.WithDescription("Get a canvas snapshot and its task links."),
			mcp.WithString("canvas_id", mcp.Required(), mcp.Description("The canvas ID")),
		),
		s.wrapHandler("get_canvas_kandev", s.getCanvasHandler()),
	)
	s.mcpServer.AddTool(
		mcp.NewTool("apply_canvas_action_kandev",
			mcp.WithDescription("Apply one idempotent, revision-checked action to a canvas. Canvas actions are declarative and cannot execute code or fetch remote resources."),
			mcp.WithString("canvas_id", mcp.Required(), mcp.Description("The canvas ID")),
			mcp.WithString("command_id", mcp.Required(), mcp.Description("A stable unique command ID")),
			mcp.WithNumber("base_revision", mcp.Required(), mcp.Description("The revision from the latest canvas snapshot")),
			mcp.WithString("action", mcp.Required(), mcp.Description("The declarative action name")),
			mcp.WithString("target_id", mcp.Description("The target block ID for block actions")),
			mcp.WithObject("input", mcp.Description("Action-specific JSON input")),
		),
		s.wrapHandler("apply_canvas_action_kandev", s.applyCanvasActionHandler()),
	)
}

func (s *Server) listCanvasesHandler() server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		workspaceID, err := req.RequireString("workspace_id")
		if err != nil {
			return mcp.NewToolResultError("workspace_id is required"), nil
		}
		payload := map[string]string{"workspace_id": workspaceID}
		if s.taskID != "" {
			payload["task_id"] = s.taskID
		}
		var result []canvasdomain.Canvas
		if err := s.backend.RequestPayload(ctx, ws.ActionCanvasList, payload, &result); err != nil {
			return canvasToolError(err), nil
		}
		return canvasToolResult(result)
	}
}

func (s *Server) createCanvasHandler() server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		workspaceID, err := req.RequireString("workspace_id")
		if err != nil {
			return mcp.NewToolResultError("workspace_id is required"), nil
		}
		title, err := req.RequireString("title")
		if err != nil {
			return mcp.NewToolResultError("title is required"), nil
		}
		payload := map[string]any{"workspace_id": workspaceID, "title": title}
		if s.taskID != "" {
			payload["task_id"] = s.taskID
		}
		var result canvasdomain.Canvas
		if err := s.backend.RequestPayload(ctx, ws.ActionCanvasCreate, payload, &result); err != nil {
			return canvasToolError(err), nil
		}
		return canvasToolResult(result)
	}
}

func (s *Server) getCanvasHandler() server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		canvasID, err := req.RequireString("canvas_id")
		if err != nil {
			return mcp.NewToolResultError("canvas_id is required"), nil
		}
		var result canvasdomain.Canvas
		payload := map[string]string{"id": canvasID}
		if s.taskID != "" {
			payload["task_id"] = s.taskID
		}
		if err := s.backend.RequestPayload(ctx, ws.ActionCanvasGet, payload, &result); err != nil {
			return canvasToolError(err), nil
		}
		return canvasToolResult(result)
	}
}

func (s *Server) applyCanvasActionHandler() server.ToolHandlerFunc {
	return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		canvasID, err := req.RequireString("canvas_id")
		if err != nil {
			return mcp.NewToolResultError("canvas_id is required"), nil
		}
		commandID, err := req.RequireString("command_id")
		if err != nil {
			return mcp.NewToolResultError("command_id is required"), nil
		}
		action, err := req.RequireString("action")
		if err != nil {
			return mcp.NewToolResultError("action is required"), nil
		}
		input := req.GetArguments()["input"]
		if input == nil {
			input = map[string]any{}
		}
		baseRevision, err := canvasRevision(req)
		if err != nil {
			return mcp.NewToolResultError(err.Error()), nil
		}
		payload := map[string]any{
			"canvas_id": canvasID, "command_id": commandID,
			"base_revision": baseRevision,
			"action":        action, "target_id": req.GetString("target_id", ""), "input": input,
		}
		if s.taskID != "" {
			payload["task_id"] = s.taskID
		}
		var result canvasdomain.ApplyCanvasCommandResult
		if err := s.backend.RequestPayload(ctx, ws.ActionCanvasCommand, payload, &result); err != nil {
			return canvasToolError(err), nil
		}
		return canvasToolResult(result)
	}
}

func canvasRevision(req mcp.CallToolRequest) (int64, error) {
	value, ok := req.GetArguments()["base_revision"]
	if !ok {
		return 0, fmt.Errorf("base_revision is required")
	}
	switch number := value.(type) {
	case int:
		return checkedCanvasRevision(int64(number))
	case int64:
		return checkedCanvasRevision(number)
	case json.Number:
		parsed, err := number.Int64()
		if err != nil {
			return 0, invalidCanvasRevision()
		}
		return checkedCanvasRevision(parsed)
	case float64:
		return checkedCanvasFloatRevision(number)
	default:
		return 0, invalidCanvasRevision()
	}
}

func checkedCanvasRevision(revision int64) (int64, error) {
	if revision < 0 {
		return 0, invalidCanvasRevision()
	}
	return revision, nil
}

func checkedCanvasFloatRevision(revision float64) (int64, error) {
	if math.IsNaN(revision) || math.IsInf(revision, 0) || revision < 0 || math.Trunc(revision) != revision || revision >= float64(1<<63) {
		return 0, invalidCanvasRevision()
	}
	return int64(revision), nil
}

func invalidCanvasRevision() error {
	return fmt.Errorf("base_revision must be a non-negative integer")
}

func canvasToolResult(value any) (*mcp.CallToolResult, error) {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	return mcp.NewToolResultText(string(data)), nil
}

func canvasToolError(err error) *mcp.CallToolResult {
	var backendErr *BackendError
	if !errors.As(err, &backendErr) || backendErr == nil || backendErr.Code == "" {
		return mcp.NewToolResultError(err.Error())
	}
	structured := map[string]any{
		"code":    backendErr.Code,
		"message": backendErr.Message,
	}
	if len(backendErr.Details) > 0 {
		structured["details"] = backendErr.Details
	}
	result := mcp.NewToolResultStructured(structured, err.Error())
	result.IsError = true
	return result
}
