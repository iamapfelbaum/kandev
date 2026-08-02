package websocket

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kandev/kandev/internal/common/logger"
	"github.com/kandev/kandev/internal/events"
	"github.com/kandev/kandev/internal/events/bus"
	ws "github.com/kandev/kandev/pkg/websocket"
)

// pluginUserStateTestEvent mirrors internal/plugins' unexported
// pluginUserStateUpdatedEvent: a struct implementing GetUserID() so
// UserEventBroadcaster.subscribe's type-switch routes it without a plugins
// package import (avoiding a gateway/websocket -> plugins dependency this
// package doesn't otherwise have).
type pluginUserStateTestEvent struct {
	userID   string
	PluginID string `json:"pluginId"`
	Key      string `json:"key"`
}

func (e pluginUserStateTestEvent) GetUserID() string { return e.userID }

func testLoggerForUserNotifications(t *testing.T) *logger.Logger {
	t.Helper()
	log, err := logger.NewLogger(logger.LoggingConfig{Level: "error", Format: "json"})
	if err != nil {
		t.Fatalf("logger: %v", err)
	}
	return log
}

// TestRegisterUserNotifications_PluginUserStateReachesOnlyWriter pins AC24:
// a plugin.user-state.updated bus event reaches only the writing user's WS
// connections; a second, differently-identified user's client receives
// nothing.
func TestRegisterUserNotifications_PluginUserStateReachesOnlyWriter(t *testing.T) {
	h := newTestHub(t)
	writer := newTestClient("writer-conn")
	other := newTestClient("other-conn")
	registerTestClient(h, writer)
	registerTestClient(h, other)
	h.SubscribeToUser(writer, "user_1")
	h.SubscribeToUser(other, "user_2")

	eventBus := bus.NewMemoryEventBus(testLoggerForUserNotifications(t))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	RegisterUserNotifications(ctx, eventBus, h, testLoggerForUserNotifications(t))

	payload := pluginUserStateTestEvent{userID: "user_1", PluginID: "kandev-plugin-notes", Key: "note"}
	if err := eventBus.Publish(ctx, events.PluginUserStateUpdated,
		bus.NewEvent(events.PluginUserStateUpdated, "test", payload)); err != nil {
		t.Fatalf("publish: %v", err)
	}

	if !clientReceived(writer) {
		t.Fatal("expected the writing user's client to receive the notification")
	}
	if clientReceived(other) {
		t.Fatal("expected a different user's client to receive nothing")
	}
}

// TestRegisterUserNotifications_PluginUserStatePayloadShape pins that the WS
// notification payload carries exactly the plugin/scope/key fields (AC24) —
// no user_id leaks into the message the client receives.
func TestRegisterUserNotifications_PluginUserStatePayloadShape(t *testing.T) {
	h := newTestHub(t)
	writer := newTestClient("writer-conn")
	registerTestClient(h, writer)
	h.SubscribeToUser(writer, "user_1")

	eventBus := bus.NewMemoryEventBus(testLoggerForUserNotifications(t))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	RegisterUserNotifications(ctx, eventBus, h, testLoggerForUserNotifications(t))

	payload := pluginUserStateTestEvent{userID: "user_1", PluginID: "kandev-plugin-notes", Key: "note"}
	if err := eventBus.Publish(ctx, events.PluginUserStateUpdated,
		bus.NewEvent(events.PluginUserStateUpdated, "test", payload)); err != nil {
		t.Fatalf("publish: %v", err)
	}

	select {
	case raw := <-writer.send:
		var msg ws.Message
		if err := json.Unmarshal(raw, &msg); err != nil {
			t.Fatalf("unmarshal envelope: %v", err)
		}
		if msg.Action != "plugin.user-state.updated" {
			t.Fatalf("Action = %q, want %q", msg.Action, "plugin.user-state.updated")
		}
		var got map[string]any
		if err := json.Unmarshal(msg.Payload, &got); err != nil {
			t.Fatalf("unmarshal payload: %v", err)
		}
		if got["pluginId"] != "kandev-plugin-notes" || got["key"] != "note" {
			t.Fatalf("payload = %+v, missing expected fields", got)
		}
		if _, leaked := got["userID"]; leaked {
			t.Fatalf("payload leaked userID: %+v", got)
		}
	default:
		t.Fatal("expected a message on writer.send")
	}
}
