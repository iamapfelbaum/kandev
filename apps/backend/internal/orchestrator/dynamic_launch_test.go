package orchestrator

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/orchestrator/watcher"
	"github.com/kandev/kandev/internal/task/models"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

func TestRelaunchDynamicTaskAfterFailure_DoesNotLaunchSuccessorWhenStopFails(t *testing.T) {
	ctx := context.Background()
	const (
		taskID      = "task-dynamic-stop-failure"
		sessionID   = "session-dynamic-stop-failure"
		executionID = "execution-dynamic-stop-failure"
	)

	repo := setupTestRepo(t)
	seedTaskAndSession(t, repo, taskID, sessionID, models.TaskSessionStateRunning)
	seedExecutorRunning(t, repo, sessionID, taskID, executionID)
	taskRepo := newMockTaskRepo()
	seedMockTaskState(taskRepo, taskID, v1.TaskStateInProgress)
	stopErr := errors.New("runtime teardown failed")
	agentManager := &mockAgentManager{
		stopAgentWithReasonErr: stopErr,
	}
	svc := createTestServiceWithScheduler(repo, newMockStepGetter(), taskRepo, agentManager)
	svc.lastTurnPrompt.Store(sessionID, capturedPrompt{text: "retry the task"})

	relaunched := svc.relaunchDynamicTaskAfterFailure(
		ctx,
		watcher.AgentEventData{
			TaskID:           taskID,
			SessionID:        sessionID,
			AgentExecutionID: executionID,
		},
		"fallback-profile",
	)

	if relaunched {
		t.Fatal("relaunchDynamicTaskAfterFailure returned success after predecessor stop failed")
	}
	session, err := repo.GetTaskSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if session.State != models.TaskSessionStateRunning {
		t.Fatalf("session state = %q, want RUNNING while predecessor teardown is unresolved", session.State)
	}
	if len(agentManager.startAgentProcessCalls) != 0 {
		t.Fatalf("successor launch started %d processes after stop failure", len(agentManager.startAgentProcessCalls))
	}
	if len(agentManager.stopAgentWithReasonArgs) != 1 {
		t.Fatalf("stop calls = %d, want 1", len(agentManager.stopAgentWithReasonArgs))
	}
	if agentManager.stopAgentWithReasonArgs[0] != (stopAgentCall{
		ExecutionID: executionID,
		Reason:      "dynamic route fallback",
		Force:       true,
	}) {
		t.Fatalf("unexpected stop call: %#v", agentManager.stopAgentWithReasonArgs[0])
	}
}

// The agent.failed event that selects a fallback route is dispatched on the
// lifecycle completion goroutine while it holds the execution's prompt
// lifecycle lock. Stopping the predecessor needs that lock again, so the
// successor launch must leave the dispatch before the stop runs.
func TestLaunchDynamicSuccessorDetached_ReturnsWhileStopIsBlocked(t *testing.T) {
	ctx := context.Background()
	const (
		taskID      = "task-dynamic-detached"
		sessionID   = "session-dynamic-detached"
		executionID = "execution-dynamic-detached"
	)

	repo := setupTestRepo(t)
	seedTaskAndSession(t, repo, taskID, sessionID, models.TaskSessionStateRunning)
	seedExecutorRunning(t, repo, sessionID, taskID, executionID)
	taskRepo := newMockTaskRepo()
	seedMockTaskState(taskRepo, taskID, v1.TaskStateInProgress)

	stopEntered := make(chan struct{})
	releaseStop := make(chan struct{})
	stopErr := errors.New("runtime teardown failed")
	var firstStop sync.Once
	agentManager := &mockAgentManager{
		// Only the fallback stop blocks; the recoverable-failure cleanup that
		// follows a failed launch stops the same execution again and must not.
		stopAgentWithReasonFunc: func(context.Context, string, string, bool) error {
			firstStop.Do(func() {
				close(stopEntered)
				<-releaseStop
			})
			return stopErr
		},
	}
	svc := createTestServiceWithScheduler(repo, newMockStepGetter(), taskRepo, agentManager)
	svc.lastTurnPrompt.Store(sessionID, capturedPrompt{text: "retry the task"})
	data := watcher.AgentEventData{
		TaskID:           taskID,
		SessionID:        sessionID,
		AgentExecutionID: executionID,
	}

	returned := make(chan struct{})
	go func() {
		svc.launchDynamicSuccessorDetached(ctx, data, "fallback-profile")
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(2 * time.Second):
		t.Fatal("launchDynamicSuccessorDetached blocked on the predecessor stop")
	}
	select {
	case <-stopEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("predecessor stop never started after the dispatch returned")
	}
	session, err := repo.GetTaskSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if session.State != models.TaskSessionStateRunning {
		t.Fatalf("session state = %q before the stop resolved, want RUNNING", session.State)
	}

	close(releaseStop)
	waitForSessionState(t, repo, sessionID, models.TaskSessionStateWaitingForInput)
	if len(agentManager.startAgentProcessCalls) != 0 {
		t.Fatalf("successor launch started %d processes after stop failure", len(agentManager.startAgentProcessCalls))
	}
}

func TestRunDetachedDynamicSuccessorLaunch_ParksSessionWhenRelaunchFails(t *testing.T) {
	ctx := context.Background()
	const (
		taskID      = "task-dynamic-detached-failure"
		sessionID   = "session-dynamic-detached-failure"
		executionID = "execution-dynamic-detached-failure"
	)

	repo := setupTestRepo(t)
	seedTaskAndSession(t, repo, taskID, sessionID, models.TaskSessionStateRunning)
	seedExecutorRunning(t, repo, sessionID, taskID, executionID)
	taskRepo := newMockTaskRepo()
	seedMockTaskState(taskRepo, taskID, v1.TaskStateInProgress)
	agentManager := &mockAgentManager{
		stopAgentWithReasonErr: errors.New("runtime teardown failed"),
	}
	svc := createTestServiceWithScheduler(repo, newMockStepGetter(), taskRepo, agentManager)
	svc.lastTurnPrompt.Store(sessionID, capturedPrompt{text: "retry the task"})

	svc.runDetachedDynamicSuccessorLaunch(ctx, watcher.AgentEventData{
		TaskID:           taskID,
		SessionID:        sessionID,
		AgentExecutionID: executionID,
		ErrorMessage:     "provider quota exhausted",
	}, "fallback-profile")

	session, err := repo.GetTaskSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if session.State != models.TaskSessionStateWaitingForInput {
		t.Fatalf("session state = %q, want WAITING_FOR_INPUT so the user can resume", session.State)
	}
	if len(agentManager.startAgentProcessCalls) != 0 {
		t.Fatalf("successor launch started %d processes after stop failure", len(agentManager.startAgentProcessCalls))
	}
}

func waitForSessionState(t *testing.T, repo taskSessionStateReader, sessionID string, want models.TaskSessionState) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		session, err := repo.GetTaskSession(context.Background(), sessionID)
		if err != nil {
			t.Fatalf("get session: %v", err)
		}
		if session.State == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("session state = %q, want %q", session.State, want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

type taskSessionStateReader interface {
	GetTaskSession(ctx context.Context, id string) (*models.TaskSession, error)
}
