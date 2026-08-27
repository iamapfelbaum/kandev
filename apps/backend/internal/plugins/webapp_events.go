package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/kandev/kandev/internal/events/bus"
	"github.com/kandev/kandev/internal/plugins/instances"
	"github.com/kandev/kandev/internal/plugins/webapp"
)

const webAppEventValidationTimeout = 2 * time.Second

// subscribeWebAppEvents connects the public web-app transport to the existing
// Kandev event bus. The hub remains an in-process bounded projection, so a
// restart creates a new generation and never pretends that old events are
// replayable.
func (s *Service) subscribeWebAppEvents() {
	if s == nil || s.eventBus == nil {
		return
	}
	s.mu.Lock()
	if s.eventSubscription != nil {
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	subscription, err := s.eventBus.Subscribe(">", s.forwardWebAppEvent)
	if err != nil {
		return
	}
	s.mu.Lock()
	if s.eventSubscription == nil {
		s.eventSubscription = subscription
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	_ = subscription.Unsubscribe()
}

func (s *Service) closeWebAppEvents() {
	if s == nil {
		return
	}
	s.mu.Lock()
	subscription := s.eventSubscription
	s.eventSubscription = nil
	hub := s.eventHub
	s.mu.Unlock()
	if subscription != nil {
		_ = subscription.Unsubscribe()
	}
	if hub != nil {
		hub.Close()
	}
}

func (s *Service) forwardWebAppEvent(ctx context.Context, source *bus.Event) error {
	if source == nil {
		return nil
	}
	hub := s.WebAppEventHub()
	store := s.Instances()
	if hub == nil || store == nil {
		return nil
	}
	scope := webAppScopeFromBusEvent(source)
	if scope.WorkspaceID == "" && scope.TaskID != "" {
		if taskData := s.taskData; taskData != nil {
			task, err := taskData.GetTask(ctx, scope.TaskID)
			if err == nil && task != nil {
				scope.WorkspaceID = task.WorkspaceID
			}
		}
	}
	if scope.WorkspaceID == "" {
		return nil
	}
	items, err := store.List(ctx, scope.WorkspaceID, false)
	if err != nil {
		return err
	}
	for _, item := range items {
		if !webAppBusEventMatchesInstance(item, scope) {
			continue
		}
		scope.InstanceID = item.ID
		if _, err := hub.Publish(item.ID, webapp.EventInput{
			Type:  source.Type,
			Scope: scope,
			Data:  source.Data,
		}); err != nil && !errors.Is(err, webapp.ErrEventHubClosed) {
			return err
		}
	}
	return nil
}

func webAppBusEventMatchesInstance(item instances.Instance, scope webapp.EventScope) bool {
	if item.Status == instances.StatusRemoved {
		return false
	}
	if scope.WorkspaceID != "" && item.WorkspaceID != scope.WorkspaceID {
		return false
	}
	switch item.ScopeKind {
	case instances.ScopeInstance:
		return true
	case instances.ScopeWorkspace:
		return scope.WorkspaceID == item.WorkspaceID
	case instances.ScopeTask:
		return scope.TaskID == item.TaskID
	case instances.ScopeSession:
		return scope.SessionID == item.SessionID
	case instances.ScopeRepository:
		return scope.RepositoryID == item.RepositoryID
	default:
		return false
	}
}

func webAppScopeFromBusEvent(source *bus.Event) webapp.EventScope {
	scope := webapp.EventScope{}
	if source == nil {
		return scope
	}
	var value any
	encoded, err := json.Marshal(source.Data)
	if err == nil {
		_ = json.Unmarshal(encoded, &value)
	}
	for _, key := range []string{"workspace_id", "workspaceId"} {
		scope.WorkspaceID = webAppNestedString(value, key, 0)
		if scope.WorkspaceID != "" {
			break
		}
	}
	for _, key := range []string{"task_id", "taskId"} {
		scope.TaskID = webAppNestedString(value, key, 0)
		if scope.TaskID != "" {
			break
		}
	}
	for _, key := range []string{"session_id", "sessionId"} {
		scope.SessionID = webAppNestedString(value, key, 0)
		if scope.SessionID != "" {
			break
		}
	}
	for _, key := range []string{"repository_id", "repositoryId"} {
		scope.RepositoryID = webAppNestedString(value, key, 0)
		if scope.RepositoryID != "" {
			break
		}
	}
	return scope
}

func webAppNestedString(value any, key string, depth int) string {
	if depth > 3 {
		return ""
	}
	switch typed := value.(type) {
	case map[string]any:
		if raw, ok := typed[key].(string); ok {
			return strings.TrimSpace(raw)
		}
		for _, nested := range typed {
			if found := webAppNestedString(nested, key, depth+1); found != "" {
				return found
			}
		}
	case []any:
		for _, nested := range typed {
			if found := webAppNestedString(nested, key, depth+1); found != "" {
				return found
			}
		}
	}
	return ""
}

func (s *Service) webAppEventFilter(binding webapp.CapabilityBinding) webapp.EventFilter {
	return func(event webapp.Event) bool {
		if !webAppEventMatchesBinding(event.Scope, binding) {
			return false
		}
		ctx, cancel := context.WithTimeout(context.Background(), webAppEventValidationTimeout)
		defer cancel()
		return s.validateWebAppBinding(ctx, binding) == nil
	}
}

func webAppEventMatchesBinding(scope webapp.EventScope, binding webapp.CapabilityBinding) bool {
	if scope.InstanceID != "" && scope.InstanceID != binding.InstanceID {
		return false
	}
	switch binding.ScopeKind {
	case instances.ScopeInstance:
		return true
	case instances.ScopeWorkspace:
		return scope.WorkspaceID == binding.WorkspaceID
	case instances.ScopeTask:
		return scope.TaskID == binding.TaskID
	case instances.ScopeSession:
		return scope.SessionID == binding.SessionID
	case instances.ScopeRepository:
		return scope.RepositoryID == binding.RepositoryID
	default:
		return false
	}
}
