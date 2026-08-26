package websocket

import (
	"encoding/json"

	ws "github.com/kandev/kandev/pkg/websocket"
)

type canvasSubscriptionRequest struct {
	CanvasID      string `json:"canvas_id"`
	AfterRevision int64  `json:"after_revision"`
}

func (c *Client) handleCanvasSubscribe(msg *ws.Message) {
	var req canvasSubscriptionRequest
	if err := msg.ParsePayload(&req); err != nil || req.CanvasID == "" {
		c.sendError(msg.ID, msg.Action, ws.ErrorCodeBadRequest, "canvas_id is required", nil)
		return
	}
	provider := c.hub.canvasSubscriptionProvider()
	if provider == nil {
		c.sendError(msg.ID, msg.Action, ws.ErrorCodeInternalError, "canvas subscriptions unavailable", nil)
		return
	}
	// Capture the dispatch context before SubscribeCanvasWithReplay takes the
	// hub lock. dispatchContext reads that same lock, so resolving it from the
	// replay callback would deadlock the subscription handler.
	ctx := c.dispatchContext()
	if _, err := provider.SubscribeCanvas(ctx, req.CanvasID, req.AfterRevision); err != nil {
		c.sendError(msg.ID, msg.Action, ws.ErrorCodeNotFound, "canvas not found", nil)
		return
	}
	payload, err := c.hub.SubscribeCanvasWithReplay(c, req.CanvasID, func() ([]byte, error) {
		return provider.SubscribeCanvas(ctx, req.CanvasID, req.AfterRevision)
	})
	if err != nil {
		c.sendError(msg.ID, msg.Action, ws.ErrorCodeNotFound, "canvas not found", nil)
		return
	}
	response, err := ws.NewResponse(msg.ID, msg.Action, json.RawMessage(payload))
	if err != nil {
		c.sendError(msg.ID, msg.Action, ws.ErrorCodeInternalError, "failed to encode canvas snapshot", nil)
		return
	}
	c.sendMessage(response)
}

func (c *Client) handleCanvasUnsubscribe(msg *ws.Message) {
	var req canvasSubscriptionRequest
	if err := msg.ParsePayload(&req); err != nil || req.CanvasID == "" {
		c.sendError(msg.ID, msg.Action, ws.ErrorCodeBadRequest, "canvas_id is required", nil)
		return
	}
	c.hub.UnsubscribeFromCanvas(c, req.CanvasID)
	response, _ := ws.NewResponse(msg.ID, msg.Action, map[string]any{
		"success": true, "canvas_id": req.CanvasID,
	})
	c.sendMessage(response)
}
