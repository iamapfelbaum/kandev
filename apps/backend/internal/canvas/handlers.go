package canvas

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/kandev/kandev/internal/common/logger"
	ws "github.com/kandev/kandev/pkg/websocket"
)

// RegisterRoutes adds the canvas HTTP and WebSocket RPC handlers.
func RegisterRoutes(router *gin.Engine, dispatcher *ws.Dispatcher, svc *Service, _ *logger.Logger) {
	registerHTTPRoutes(router, svc)
	registerWSHandlers(dispatcher, svc)
}

func registerHTTPRoutes(router *gin.Engine, svc *Service) {
	router.GET("/api/v1/canvases", func(c *gin.Context) {
		listCanvasesHTTP(c, svc, c.Query("workspace_id"))
	})
	router.POST("/api/v1/canvases/import", func(c *gin.Context) {
		importCanvasHTTP(c, svc, c.Query("workspace_id"), c.Query("task_id"))
	})
	router.POST("/api/v1/workspaces/:id/canvases", func(c *gin.Context) {
		createCanvasHTTP(c, svc, c.Param("id"), c.Query("task_id"))
	})
	router.GET("/api/v1/workspaces/:id/canvases", func(c *gin.Context) {
		listCanvasesHTTP(c, svc, c.Param("id"))
	})
	router.POST("/api/v1/workspaces/:id/canvases/import", func(c *gin.Context) {
		importCanvasHTTP(c, svc, c.Param("id"), c.Query("task_id"))
	})
	router.GET("/api/v1/canvases/:id", func(c *gin.Context) { getCanvasHTTP(c, svc) })
	router.GET("/api/v1/canvases/:id/snapshot", func(c *gin.Context) { getCanvasHTTP(c, svc) })
	router.GET("/api/v1/canvases/:id/export", func(c *gin.Context) { exportCanvasHTTP(c, svc) })
	router.GET("/api/v1/canvases/:id/events", func(c *gin.Context) { listEventsHTTP(c, svc) })
	router.PATCH("/api/v1/canvases/:id", func(c *gin.Context) { renameCanvasHTTP(c, svc) })
	router.POST("/api/v1/canvases/:id/archive", func(c *gin.Context) { archiveCanvasHTTP(c, svc, true) })
	router.POST("/api/v1/canvases/:id/restore", func(c *gin.Context) { archiveCanvasHTTP(c, svc, false) })
	router.DELETE("/api/v1/canvases/:id", func(c *gin.Context) { removeCanvasHTTP(c, svc) })
	router.POST("/api/v1/canvases/:id/commands", func(c *gin.Context) { commandHTTP(c, svc) })
	router.GET("/api/v1/canvases/:id/tasks", func(c *gin.Context) { taskLinksHTTP(c, svc) })
	router.POST("/api/v1/canvases/:id/tasks/:taskId", func(c *gin.Context) { addTaskLinkHTTP(c, svc) })
	router.DELETE("/api/v1/canvases/:id/tasks/:taskId", func(c *gin.Context) { removeTaskLinkHTTP(c, svc) })
	router.POST("/api/v1/canvases/:id/blocks/:blockId/lease", func(c *gin.Context) { acquireLeaseHTTP(c, svc) })
	router.DELETE("/api/v1/canvases/:id/blocks/:blockId/lease", func(c *gin.Context) { releaseLeaseHTTP(c, svc) })
}

func registerWSHandlers(dispatcher *ws.Dispatcher, svc *Service) {
	dispatcher.RegisterFunc(ws.ActionCanvasList, wsList(svc))
	dispatcher.RegisterFunc(ws.ActionCanvasCreate, wsCreate(svc))
	dispatcher.RegisterFunc(ws.ActionCanvasGet, wsGet(svc))
	dispatcher.RegisterFunc(ws.ActionCanvasSubscribe, wsSubscribe(svc))
	dispatcher.RegisterFunc(ws.ActionCanvasCommand, wsCommand(svc))
}

func listCanvasesHTTP(c *gin.Context, svc *Service, workspaceID string) {
	var (
		items []*Canvas
		err   error
	)
	if taskID := c.Query("task_id"); taskID != "" {
		items, err = svc.ListCanvasesForTask(c.Request.Context(), workspaceID, taskID)
	} else {
		items, err = svc.ListCanvases(c.Request.Context(), workspaceID, c.Query("include_archived") == "true")
	}
	if writeCanvasError(c, err) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"canvases": items})
}

func createCanvasHTTP(c *gin.Context, svc *Service, workspaceID, taskID string) {
	var req CreateCanvasRequest
	if err := decodeBody(c, &req, MaxCommandBytes); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid canvas payload"})
		return
	}
	req.WorkspaceID = workspaceID
	var canvas *Canvas
	var err error
	if taskID != "" {
		canvas, err = svc.CreateCanvasForTask(c.Request.Context(), req, taskID)
	} else {
		canvas, err = svc.CreateCanvas(c.Request.Context(), req)
	}
	if writeCanvasError(c, err) {
		return
	}
	c.JSON(http.StatusCreated, canvas)
}

func getCanvasHTTP(c *gin.Context, svc *Service) {
	canvas, err := svc.GetCanvas(c.Request.Context(), c.Param("id"))
	if writeCanvasError(c, err) {
		return
	}
	c.JSON(http.StatusOK, canvas)
}

func renameCanvasHTTP(c *gin.Context, svc *Service) {
	var req UpdateCanvasRequest
	if err := decodeBody(c, &req, MaxCommandBytes); err != nil || req.Title == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "title is required"})
		return
	}
	canvas, err := svc.RenameCanvas(c.Request.Context(), c.Param("id"), *req.Title)
	if writeCanvasError(c, err) {
		return
	}
	c.JSON(http.StatusOK, canvas)
}

func archiveCanvasHTTP(c *gin.Context, svc *Service, archived bool) {
	canvas, err := svc.SetCanvasArchived(c.Request.Context(), c.Param("id"), archived)
	if writeCanvasError(c, err) {
		return
	}
	c.JSON(http.StatusOK, canvas)
}

func removeCanvasHTTP(c *gin.Context, svc *Service) {
	if err := svc.RemoveCanvas(c.Request.Context(), c.Param("id")); writeCanvasError(c, err) {
		return
	}
	c.Status(http.StatusNoContent)
}

func commandHTTP(c *gin.Context, svc *Service) {
	var req ApplyCanvasCommandRequest
	if err := decodeBody(c, &req, MaxCommandBytes); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid command payload"})
		return
	}
	result, err := svc.ApplyCommand(c.Request.Context(), c.Param("id"), req)
	if writeCanvasError(c, err) {
		return
	}
	c.JSON(http.StatusOK, result)
}

func listEventsHTTP(c *gin.Context, svc *Service) {
	after, _ := strconv.ParseInt(c.Query("after_revision"), 10, 64)
	events, err := svc.ListEvents(c.Request.Context(), c.Param("id"), after)
	if writeCanvasError(c, err) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"events": events})
}

func taskLinksHTTP(c *gin.Context, svc *Service) {
	canvas, err := svc.GetCanvas(c.Request.Context(), c.Param("id"))
	if writeCanvasError(c, err) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"task_links": canvas.TaskLinks})
}

func addTaskLinkHTTP(c *gin.Context, svc *Service) {
	if err := svc.AddTaskLink(c.Request.Context(), c.Param("id"), c.Param("taskId")); writeCanvasError(c, err) {
		return
	}
	c.Status(http.StatusCreated)
}

func removeTaskLinkHTTP(c *gin.Context, svc *Service) {
	if err := svc.RemoveTaskLink(c.Request.Context(), c.Param("id"), c.Param("taskId")); writeCanvasError(c, err) {
		return
	}
	c.Status(http.StatusNoContent)
}

func exportCanvasHTTP(c *gin.Context, svc *Service) {
	data, err := svc.ExportCanvas(c.Request.Context(), c.Param("id"))
	if writeCanvasError(c, err) {
		return
	}
	c.Header("Content-Type", "application/vnd.kandev.canvas+json")
	c.Header("Content-Disposition", `attachment; filename="canvas.kandev-canvas"`)
	c.Data(http.StatusOK, "application/vnd.kandev.canvas+json", data)
}

func importCanvasHTTP(c *gin.Context, svc *Service, workspaceID, taskID string) {
	data, err := io.ReadAll(io.LimitReader(c.Request.Body, MaxFileBytes+1))
	if err != nil || len(data) > MaxFileBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": "canvas file is too large"})
		return
	}
	canvas, err := svc.ImportCanvas(c.Request.Context(), workspaceID, taskID, data)
	if writeCanvasError(c, err) {
		return
	}
	c.JSON(http.StatusCreated, canvas)
}

func acquireLeaseHTTP(c *gin.Context, svc *Service) {
	var req struct {
		HolderID string `json:"holder_id"`
	}
	if err := decodeBody(c, &req, MaxCommandBytes); err != nil || req.HolderID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "holder_id is required"})
		return
	}
	lease, err := svc.AcquireMarkdownLease(c.Request.Context(), c.Param("id"), c.Param("blockId"), req.HolderID)
	if writeCanvasError(c, err) {
		return
	}
	c.JSON(http.StatusOK, lease)
}

func releaseLeaseHTTP(c *gin.Context, svc *Service) {
	holderID := c.Query("holder_id")
	if err := svc.ReleaseMarkdownLease(c.Request.Context(), c.Param("id"), c.Param("blockId"), holderID); writeCanvasError(c, err) {
		return
	}
	c.Status(http.StatusNoContent)
}

func decodeBody(c *gin.Context, destination any, limit int64) error {
	data, err := io.ReadAll(io.LimitReader(c.Request.Body, limit+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > limit {
		return errors.New("request body exceeds limit")
	}
	return decodeStrictJSON(json.RawMessage(data), destination)
}

func writeCanvasError(c *gin.Context, err error) bool {
	if err == nil {
		return false
	}
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, ErrCanvasNotFound), errors.Is(err, ErrTaskNotFound):
		status = http.StatusNotFound
	case errors.Is(err, ErrRevisionConflict), errors.Is(err, ErrCommandConflict), errors.Is(err, ErrLeaseUnavailable):
		status = http.StatusConflict
	case errors.Is(err, ErrCanvasValidation), errors.Is(err, ErrTaskWorkspaceMismatch), errors.Is(err, ErrCanvasArchived):
		status = http.StatusBadRequest
	case errors.Is(err, ErrCanvasLimit):
		status = http.StatusRequestEntityTooLarge
	case errors.Is(err, ErrInvalidPortableFile):
		status = http.StatusBadRequest
	}
	c.JSON(status, gin.H{"error": err.Error()})
	return true
}

func wsList(svc *Service) ws.HandlerFunc {
	return func(ctx context.Context, msg *ws.Message) (*ws.Message, error) {
		var req struct {
			WorkspaceID string `json:"workspace_id"`
			TaskID      string `json:"task_id"`
		}
		if err := msg.ParsePayload(&req); err != nil || req.WorkspaceID == "" {
			return ws.NewError(msg.ID, msg.Action, ws.ErrorCodeBadRequest, "workspace_id required", nil)
		}
		var items []*Canvas
		var err error
		if req.TaskID != "" {
			items, err = svc.ListCanvasesForTask(ctx, req.WorkspaceID, req.TaskID)
		} else {
			items, err = svc.ListCanvases(ctx, req.WorkspaceID, false)
		}
		if err != nil {
			return canvasWSError(msg, err)
		}
		return ws.NewResponse(msg.ID, msg.Action, items)
	}
}

func wsCreate(svc *Service) ws.HandlerFunc {
	return func(ctx context.Context, msg *ws.Message) (*ws.Message, error) {
		var req CreateCanvasRequest
		var envelope struct {
			CreateCanvasRequest
			TaskID string `json:"task_id"`
		}
		if err := msg.ParsePayload(&envelope); err != nil {
			return ws.NewError(msg.ID, msg.Action, ws.ErrorCodeBadRequest, "invalid payload", nil)
		}
		req = envelope.CreateCanvasRequest
		var canvas *Canvas
		var err error
		if envelope.TaskID != "" {
			canvas, err = svc.CreateCanvasForTask(ctx, req, envelope.TaskID)
		} else {
			canvas, err = svc.CreateCanvas(ctx, req)
		}
		if err != nil {
			return canvasWSError(msg, err)
		}
		return ws.NewResponse(msg.ID, msg.Action, canvas)
	}
}

func wsGet(svc *Service) ws.HandlerFunc {
	return func(ctx context.Context, msg *ws.Message) (*ws.Message, error) {
		var req struct {
			ID     string `json:"id"`
			TaskID string `json:"task_id"`
		}
		if err := msg.ParsePayload(&req); err != nil || req.ID == "" {
			return ws.NewError(msg.ID, msg.Action, ws.ErrorCodeBadRequest, "id required", nil)
		}
		var canvas *Canvas
		var err error
		if req.TaskID != "" {
			canvas, err = svc.GetCanvasForTask(ctx, req.ID, req.TaskID)
		} else {
			canvas, err = svc.GetCanvas(ctx, req.ID)
		}
		if err != nil {
			return canvasWSError(msg, err)
		}
		return ws.NewResponse(msg.ID, msg.Action, canvas)
	}
}

func wsSubscribe(svc *Service) ws.HandlerFunc {
	return func(ctx context.Context, msg *ws.Message) (*ws.Message, error) {
		var req struct {
			CanvasID      string `json:"canvas_id"`
			AfterRevision int64  `json:"after_revision"`
		}
		if err := msg.ParsePayload(&req); err != nil || req.CanvasID == "" {
			return ws.NewError(msg.ID, msg.Action, ws.ErrorCodeBadRequest, "canvas_id required", nil)
		}
		canvas, err := svc.GetCanvas(ctx, req.CanvasID)
		if err != nil {
			return canvasWSError(msg, err)
		}
		events, err := svc.ListEvents(ctx, req.CanvasID, req.AfterRevision)
		if err != nil {
			return canvasWSError(msg, err)
		}
		return ws.NewResponse(msg.ID, msg.Action, map[string]any{"canvas": canvas, "events": events})
	}
}

func wsCommand(svc *Service) ws.HandlerFunc {
	return func(ctx context.Context, msg *ws.Message) (*ws.Message, error) {
		var req struct {
			CanvasID string `json:"canvas_id"`
			TaskID   string `json:"task_id"`
			ApplyCanvasCommandRequest
		}
		if err := msg.ParsePayload(&req); err != nil || req.CanvasID == "" {
			return ws.NewError(msg.ID, msg.Action, ws.ErrorCodeBadRequest, "canvas_id required", nil)
		}
		var result *ApplyCanvasCommandResult
		var err error
		if req.TaskID != "" {
			result, err = svc.ApplyCommandForTask(ctx, req.CanvasID, req.TaskID, req.ApplyCanvasCommandRequest)
		} else {
			result, err = svc.ApplyCommand(ctx, req.CanvasID, req.ApplyCanvasCommandRequest)
		}
		if err != nil {
			return canvasWSError(msg, err)
		}
		return ws.NewResponse(msg.ID, msg.Action, result)
	}
}

func canvasWSError(msg *ws.Message, err error) (*ws.Message, error) {
	code := ws.ErrorCodeInternalError
	switch {
	case errors.Is(err, ErrCanvasNotFound) || errors.Is(err, ErrTaskNotFound):
		code = ws.ErrorCodeNotFound
	case errors.Is(err, ErrCanvasValidation) || errors.Is(err, ErrTaskWorkspaceMismatch):
		code = ws.ErrorCodeBadRequest
	case errors.Is(err, ErrRevisionConflict) || errors.Is(err, ErrCommandConflict) || errors.Is(err, ErrLeaseUnavailable):
		code = ws.ErrorCodeConflict
	}
	return ws.NewError(msg.ID, msg.Action, code, err.Error(), nil)
}
