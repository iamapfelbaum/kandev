package websocket

import (
	"context"
	"encoding/json"
	"expvar"

	ws "github.com/kandev/kandev/pkg/websocket"
	"go.uber.org/zap"
)

var canvasSubscriptionsActive = expvar.NewInt("canvas_subscriptions_active")

// CanvasSubscriptionProvider supplies an authorized canvas snapshot and event
// replay for a WebSocket subscription. Authorization remains in the domain
// service, while the gateway owns connection membership and fan-out.
type CanvasSubscriptionProvider interface {
	SubscribeCanvas(context.Context, string, int64) ([]byte, error)
}

func (h *Hub) SetCanvasSubscriptionProvider(provider CanvasSubscriptionProvider) {
	h.mu.Lock()
	h.canvasProvider = provider
	h.mu.Unlock()
}

func (h *Hub) canvasSubscriptionProvider() CanvasSubscriptionProvider {
	h.mu.RLock()
	provider := h.canvasProvider
	h.mu.RUnlock()
	return provider
}

func (h *Hub) SubscribeToCanvas(client *Client, canvasID string) {
	h.mu.Lock()
	if _, ok := h.canvasSubscribers[canvasID]; !ok {
		h.canvasSubscribers[canvasID] = make(map[*Client]bool)
	}
	if !h.canvasSubscribers[canvasID][client] {
		canvasSubscriptionsActive.Add(1)
	}
	h.canvasSubscribers[canvasID][client] = true
	client.canvasSubscriptions[canvasID] = true
	h.mu.Unlock()
}

func (h *Hub) UnsubscribeFromCanvas(client *Client, canvasID string) {
	h.mu.Lock()
	delete(client.canvasSubscriptions, canvasID)
	if clients := h.canvasSubscribers[canvasID]; clients != nil && clients[client] {
		canvasSubscriptionsActive.Add(-1)
	}
	removeClientFromSubscriberMap(h.canvasSubscribers, canvasID, client)
	h.mu.Unlock()
}

// BroadcastToCanvas publishes a committed canvas event to subscribed clients.
func (h *Hub) BroadcastToCanvas(canvasID string, event any) {
	payload, err := json.Marshal(event)
	if err != nil {
		h.logger.Error("failed to marshal canvas event", zap.Error(err))
		return
	}
	message, err := ws.NewNotification("canvas.event", json.RawMessage(payload))
	if err != nil {
		return
	}
	data, err := json.Marshal(message)
	if err != nil {
		return
	}
	clients := h.getSubscribersLocked(h.canvasSubscribers, canvasID)
	h.sendToClients(data, clients, message.Action)
}
