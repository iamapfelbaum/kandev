package sqlite

import (
	"context"
	"testing"

	"github.com/kandev/kandev/internal/task/models"
)

type promptHistoryReader interface {
	HasUserPromptHistory(context.Context, string) (bool, error)
}

func TestHasUserPromptHistory(t *testing.T) {
	repo := newRepoForSessionTests(t)
	ctx := context.Background()
	seedForMsgTest(t, repo, "task-history-a", "session-history-a", "turn-history-a")
	seedForMsgTest(t, repo, "task-history-b", "session-history-b", "turn-history-b")

	reader, ok := any(repo).(promptHistoryReader)
	if !ok {
		t.Fatal("repository does not expose HasUserPromptHistory")
	}

	hasHistory, err := reader.HasUserPromptHistory(ctx, "session-history-a")
	if err != nil {
		t.Fatalf("empty session history: %v", err)
	}
	if hasHistory {
		t.Fatal("empty session reports user prompt history")
	}

	if err := repo.CreateMessage(ctx, &models.Message{
		ID:            "history-agent",
		TaskSessionID: "session-history-a",
		TurnID:        "turn-history-a",
		AuthorType:    models.MessageAuthorAgent,
		Content:       "agent output",
	}); err != nil {
		t.Fatalf("create agent message: %v", err)
	}
	hasHistory, err = reader.HasUserPromptHistory(ctx, "session-history-a")
	if err != nil {
		t.Fatalf("agent-only session history: %v", err)
	}
	if hasHistory {
		t.Fatal("agent-only session reports user prompt history")
	}

	if err := repo.CreateMessage(ctx, &models.Message{
		ID:            "history-user",
		TaskSessionID: "session-history-a",
		TurnID:        "turn-history-a",
		AuthorType:    models.MessageAuthorUser,
		Content:       "first user prompt",
	}); err != nil {
		t.Fatalf("create user message: %v", err)
	}
	hasHistory, err = reader.HasUserPromptHistory(ctx, "session-history-a")
	if err != nil {
		t.Fatalf("session history after user message: %v", err)
	}
	if !hasHistory {
		t.Fatal("session with a user message reports no history")
	}

	if err := repo.DeleteMessage(ctx, "history-user"); err != nil {
		t.Fatalf("delete user message: %v", err)
	}
	hasHistory, err = reader.HasUserPromptHistory(ctx, "session-history-a")
	if err != nil {
		t.Fatalf("session history after deletion: %v", err)
	}
	if !hasHistory {
		t.Fatal("deleting a user message made prompt history eligible again")
	}

	hasHistory, err = reader.HasUserPromptHistory(ctx, "session-history-b")
	if err != nil {
		t.Fatalf("other session history: %v", err)
	}
	if hasHistory {
		t.Fatal("prompt history leaked between sessions")
	}
}
