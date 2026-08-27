package orchestrator

import (
	"context"
	"errors"
	"testing"

	"github.com/kandev/kandev/internal/task/models"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

type queuedEnsureSessionLookupTracker struct {
	sessionExecutorStore
	getTaskSessionCalls int
}

func (r *queuedEnsureSessionLookupTracker) GetTaskSession(ctx context.Context, id string) (*models.TaskSession, error) {
	r.getTaskSessionCalls++
	return nil, errors.New("execution lookup should not happen")
}

func TestEnsureSession_QueuedTaskSkipsSessionCreation(t *testing.T) {
	ctx := context.Background()
	const taskID = "queued-without-session"
	repo := setupTestRepo(t)
	seedTaskWithoutSession(t, repo, taskID, "destination-step")

	task, err := repo.GetTask(ctx, taskID)
	if err != nil {
		t.Fatalf("load task: %v", err)
	}
	task.QueuedForStepID = "destination-step"
	if err := repo.UpdateTask(ctx, task); err != nil {
		t.Fatalf("queue task: %v", err)
	}

	taskRepo := newMockTaskRepo()
	taskRepo.tasks[taskID] = &v1.Task{ID: taskID, State: v1.TaskStateInProgress}
	svc := createTestServiceWithScheduler(repo, newMockStepGetter(), taskRepo, &mockAgentManager{})
	resp, err := svc.EnsureSession(ctx, taskID)
	if err != nil {
		t.Fatalf("ensure queued task: %v", err)
	}
	if resp == nil {
		t.Fatal("ensure queued task returned no response")
	}
	if !resp.Success {
		t.Fatal("expected queued task ensure to succeed")
	}
	if resp.SessionID != "" {
		t.Fatalf("session id = %q, want no session", resp.SessionID)
	}
	if resp.Source != "skipped_wip_queue" {
		t.Fatalf("source = %q, want skipped_wip_queue", resp.Source)
	}
	if resp.NewlyCreated {
		t.Fatal("queued task ensure must not report a new session")
	}
	if got := sessionCount(t, repo, taskID); got != 0 {
		t.Fatalf("session count = %d, want zero", got)
	}
}

func TestEnsureSession_QueuedTaskSkipsExistingExecutionResume(t *testing.T) {
	ctx := context.Background()
	const taskID = "queued-with-existing-session"
	repo := setupTestRepo(t)
	seedTaskAndSession(t, repo, taskID, "existing-session", models.TaskSessionStateWaitingForInput)

	task, err := repo.GetTask(ctx, taskID)
	if err != nil {
		t.Fatalf("load task: %v", err)
	}
	task.QueuedForStepID = "destination-step"
	if err := repo.UpdateTask(ctx, task); err != nil {
		t.Fatalf("queue task: %v", err)
	}

	tracker := &queuedEnsureSessionLookupTracker{sessionExecutorStore: repo}
	svc := createTestServiceWithAgent(repo, newMockStepGetter(), newMockTaskRepo(), &mockAgentManager{})
	svc.repo = tracker
	resp, err := svc.EnsureSession(ctx, taskID, EnsureSessionOptions{EnsureExecution: true})
	if err != nil {
		t.Fatalf("ensure queued task: %v", err)
	}
	if resp.Source != "skipped_wip_queue" || resp.SessionID != "" {
		t.Fatalf("response = %#v, want skipped_wip_queue without a session", resp)
	}
	if tracker.getTaskSessionCalls != 0 {
		t.Fatalf("existing session was inspected %d time(s), want no execution resume", tracker.getTaskSessionCalls)
	}
}
