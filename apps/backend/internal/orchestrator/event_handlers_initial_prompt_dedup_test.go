package orchestrator

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/orchestrator/executor"
	"github.com/kandev/kandev/internal/task/models"
	sqliterepo "github.com/kandev/kandev/internal/task/repository/sqlite"
	wfmodels "github.com/kandev/kandev/internal/workflow/models"
	v1 "github.com/kandev/kandev/pkg/api/v1"
)

func TestWorkflowAutoStartEmptyPrompt(t *testing.T) {
	t.Run("prompted session suppresses task description", func(t *testing.T) {
		fixture := newInitialPromptDedupFixture(t, true, false)
		beforeTurns := countSessionTurns(t, fixture.repo, fixture.sessionID)

		fixture.svc.launchAfterOnEnterDispatch(
			context.Background(), fixture.taskID, fixture.session, fixture.step,
			fixture.taskDescription, false, true, false,
		)

		if got := len(fixture.agent.capturedPrompts); got != 0 {
			t.Fatalf("captured prompts = %d, want 0", got)
		}
		if got := len(fixture.messages.userMessages); got != 0 {
			t.Fatalf("recorded user messages = %d, want 0", got)
		}
		if got := countSessionTurns(t, fixture.repo, fixture.sessionID); got != beforeTurns {
			t.Fatalf("session turns = %d, want unchanged count %d", got, beforeTurns)
		}
	})

	t.Run("unprompted session uses task description once", func(t *testing.T) {
		fixture := newInitialPromptDedupFixture(t, false, false)

		fixture.svc.launchAfterOnEnterDispatch(
			context.Background(), fixture.taskID, fixture.session, fixture.step,
			fixture.taskDescription, false, true, false,
		)

		if got := fixture.agent.capturedPrompts; len(got) != 1 || got[0] != fixture.taskDescription {
			t.Fatalf("captured prompts = %#v, want [%q]", got, fixture.taskDescription)
		}
		if got := len(fixture.messages.userMessages); got != 1 {
			t.Fatalf("recorded user messages = %d, want 1", got)
		}
	})

	t.Run("passthrough session uses the same suppression decision", func(t *testing.T) {
		fixture := newInitialPromptDedupFixture(t, true, true)

		fixture.svc.launchAfterOnEnterDispatch(
			context.Background(), fixture.taskID, fixture.session, fixture.step,
			fixture.taskDescription, false, true, false,
		)

		if got := len(fixture.agent.passthroughStdinCalls); got != 0 {
			t.Fatalf("passthrough writes = %d, want 0", got)
		}
	})

	t.Run("prompt-history errors stop automatic dispatch", func(t *testing.T) {
		fixture := newInitialPromptDedupFixture(t, false, false)
		fixture.svc.repo = promptHistoryErrorRepo{
			repoStore: fixture.repo,
			err:       errors.New("history unavailable"),
		}

		fixture.svc.launchAfterOnEnterDispatch(
			context.Background(), fixture.taskID, fixture.session, fixture.step,
			fixture.taskDescription, false, true, false,
		)

		if got := len(fixture.agent.capturedPrompts); got != 0 {
			t.Fatalf("captured prompts = %d, want 0", got)
		}
		updated, err := fixture.repo.GetTaskSession(context.Background(), fixture.sessionID)
		if err != nil {
			t.Fatalf("reload session: %v", err)
		}
		if updated.State != models.TaskSessionStateWaitingForInput {
			t.Fatalf("session state = %q, want %q", updated.State, models.TaskSessionStateWaitingForInput)
		}
	})

	t.Run("queued handoff survives task-description suppression", func(t *testing.T) {
		fixture := newInitialPromptDedupFixture(t, true, false)
		if _, err := fixture.svc.messageQueue.QueueMessage(
			context.Background(), fixture.sessionID, fixture.taskID, "Finish the handoff", "", "user", false, nil,
		); err != nil {
			t.Fatalf("queue handoff: %v", err)
		}

		fixture.svc.launchAfterOnEnterDispatch(
			context.Background(), fixture.taskID, fixture.session, fixture.step,
			fixture.taskDescription, false, true, false,
		)

		if got := fixture.agent.capturedPrompts; len(got) != 1 || !strings.Contains(got[0], "Finish the handoff") || strings.Contains(got[0], fixture.taskDescription) {
			t.Fatalf("captured prompts = %#v, want handoff only", got)
		}
	})
}

func TestWorkflowAutoStartNonEmptyPrompt(t *testing.T) {
	fixture := newInitialPromptDedupFixture(t, true, false)
	fixture.step.Prompt = "Continue with validation."

	fixture.svc.launchAfterOnEnterDispatch(
		context.Background(), fixture.taskID, fixture.session, fixture.step,
		fixture.taskDescription, false, true, false,
	)

	if got := fixture.agent.capturedPrompts; len(got) != 1 || got[0] != fixture.step.Prompt {
		t.Fatalf("captured prompts = %#v, want [%q]", got, fixture.step.Prompt)
	}
	if got := len(fixture.messages.userMessages); got != 1 {
		t.Fatalf("recorded user messages = %d, want 1", got)
	}
}

func TestStartSessionForWorkflowStepEmptyPrompt(t *testing.T) {
	fixture := newInitialPromptDedupFixture(t, true, false)
	beforeTurns := countSessionTurns(t, fixture.repo, fixture.sessionID)

	if err := fixture.svc.StartSessionForWorkflowStep(
		context.Background(), fixture.taskID, fixture.sessionID, fixture.step.ID,
	); err != nil {
		t.Fatalf("StartSessionForWorkflowStep returned error: %v", err)
	}

	if got := len(fixture.agent.capturedPrompts); got != 0 {
		t.Fatalf("captured prompts = %d, want 0", got)
	}
	if got := countSessionTurns(t, fixture.repo, fixture.sessionID); got != beforeTurns {
		t.Fatalf("session turns = %d, want unchanged count %d", got, beforeTurns)
	}
}

type initialPromptDedupFixture struct {
	repo            *sqliterepo.Repository
	svc             *Service
	agent           *mockAgentManager
	messages        *mockMessageCreator
	taskID          string
	sessionID       string
	taskDescription string
	session         *models.TaskSession
	step            *wfmodels.WorkflowStep
}

type promptHistoryErrorRepo struct {
	repoStore
	err error
}

func (r promptHistoryErrorRepo) HasUserPromptHistory(context.Context, string) (bool, error) {
	return false, r.err
}

func newInitialPromptDedupFixture(t *testing.T, prompted, passthrough bool) initialPromptDedupFixture {
	t.Helper()
	ctx := context.Background()
	const (
		taskID    = "task-initial-prompt-dedup"
		sessionID = "session-initial-prompt-dedup"
		stepID    = "step-initial-prompt-dedup"
		execID    = "exec-initial-prompt-dedup"
	)

	repo := setupTestRepo(t)
	seedSession(t, repo, taskID, sessionID, stepID)
	session, err := repo.GetTaskSession(ctx, sessionID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	session.State = models.TaskSessionStateWaitingForInput
	session.AgentExecutionID = execID
	if err := repo.UpdateTaskSession(ctx, session); err != nil {
		t.Fatalf("update session: %v", err)
	}
	seedExecutorRunning(t, repo, sessionID, taskID, execID)

	if err := repo.CreateTurn(ctx, &models.Turn{
		ID:            "turn-initial-prompt-dedup",
		TaskSessionID: sessionID,
		TaskID:        taskID,
		CompletedAt:   completedAt(),
	}); err != nil {
		t.Fatalf("create history turn: %v", err)
	}
	if prompted {
		if err := repo.CreateMessage(ctx, &models.Message{
			ID:            "message-initial-prompt-dedup",
			TaskSessionID: sessionID,
			TaskID:        taskID,
			TurnID:        "turn-initial-prompt-dedup",
			AuthorType:    models.MessageAuthorUser,
			Content:       "already prompted",
		}); err != nil {
			t.Fatalf("create prompt history: %v", err)
		}
	}

	stepGetter := newMockStepGetter()
	step := &wfmodels.WorkflowStep{
		ID:         stepID,
		WorkflowID: "wf1",
		Name:       "Initial prompt dedup",
		Events: wfmodels.StepEvents{
			OnEnter: []wfmodels.OnEnterAction{{Type: wfmodels.OnEnterAutoStartAgent}},
		},
	}
	stepGetter.steps[stepID] = step
	taskRepo := newMockTaskRepo()
	taskRepo.tasks[taskID] = &v1.Task{
		ID: taskID, WorkflowID: "wf1", State: v1.TaskStateInProgress,
	}
	agent := &mockAgentManager{
		isAgentRunning:         true,
		isPassthrough:          passthrough,
		repoForExecutionLookup: repo,
	}
	messages := &mockMessageCreator{}
	svc := createTestServiceWithAgent(repo, stepGetter, taskRepo, agent)
	svc.executor = executor.NewExecutor(agent, repo, testLogger(), executor.ExecutorConfig{})
	svc.messageCreator = messages

	return initialPromptDedupFixture{
		repo:            repo,
		svc:             svc,
		agent:           agent,
		messages:        messages,
		taskID:          taskID,
		sessionID:       sessionID,
		taskDescription: "Test",
		session:         session,
		step:            step,
	}
}

func completedAt() *time.Time {
	completed := time.Now().UTC()
	return &completed
}

func countSessionTurns(t *testing.T, repo *sqliterepo.Repository, sessionID string) int {
	t.Helper()
	turns, err := repo.ListTurnsBySession(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("list session turns: %v", err)
	}
	return len(turns)
}
