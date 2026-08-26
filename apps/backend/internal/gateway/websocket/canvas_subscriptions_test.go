package websocket

import (
	"testing"
	"time"

	"github.com/kandev/kandev/internal/auth/authn"
	"github.com/kandev/kandev/internal/common/logger"
)

func TestCanvasSubscriptionReplayBlocksConcurrentBroadcast(t *testing.T) {
	log, err := logger.NewLogger(logger.LoggingConfig{Level: "error", Format: "json"})
	if err != nil {
		t.Fatal(err)
	}
	hub := NewHub(nil, log)
	client := NewClient("client-1", authn.Identity{}, nil, hub, log)
	replayEntered := make(chan struct{})
	releaseReplay := make(chan struct{})
	subscribeDone := make(chan error, 1)

	go func() {
		_, replayErr := hub.SubscribeCanvasWithReplay(client, "canvas-1", func() ([]byte, error) {
			close(replayEntered)
			<-releaseReplay
			return []byte(`{"canvas":{},"events":[]}`), nil
		})
		subscribeDone <- replayErr
	}()
	<-replayEntered

	broadcastDone := make(chan struct{})
	go func() {
		hub.BroadcastToCanvas("canvas-1", map[string]string{"canvas_id": "canvas-1"})
		close(broadcastDone)
	}()
	select {
	case <-broadcastDone:
		t.Fatal("broadcast crossed the replay registration boundary")
	case <-time.After(50 * time.Millisecond):
	}

	close(releaseReplay)
	if err := <-subscribeDone; err != nil {
		t.Fatal(err)
	}
	select {
	case <-broadcastDone:
	case <-time.After(time.Second):
		t.Fatal("broadcast did not complete after replay")
	}
	if len(hub.getSubscribersLocked(hub.canvasSubscribers, "canvas-1")) != 1 {
		t.Fatal("client was not registered for canvas events")
	}
}
