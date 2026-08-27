package orchestrator

import (
	"context"
	"errors"
	"testing"

	"github.com/kandev/kandev/internal/orchestrator/watcher"
	"github.com/kandev/kandev/internal/task/models"
	wfmodels "github.com/kandev/kandev/internal/workflow/models"
)

type queuePromotionSessionLookupErrorRepo struct {
	sessionExecutorStore
	err error
}

func (r *queuePromotionSessionLookupErrorRepo) GetActiveTaskSessionByTaskID(context.Context, string) (*models.TaskSession, error) {
	return nil, r.err
}

func TestQueuePromotionWithoutSessionLaunchesDeferredTask(t *testing.T) {
	ctx := context.Background()
	repo := setupTestRepo(t)
	seedChainStepTask(t, repo, deferredChainTaskID)

	task, err := repo.GetTask(ctx, deferredChainTaskID)
	if err != nil {
		t.Fatalf("load task: %v", err)
	}
	task.WorkflowStepID = "destination-step"
	task.WIPAdmitted = true
	task.Metadata[models.MetaKeyQueuePromotionPending] = true
	if err := repo.UpdateTask(ctx, task); err != nil {
		t.Fatalf("promote task: %v", err)
	}

	counter := newLaunchCounter()
	svc := newDeferredLaunchTestService(t, repo, counter)
	steps := svc.workflowStepGetter.(*mockStepGetter)
	steps.steps["destination-step"] = &wfmodels.WorkflowStep{
		ID: "destination-step", WorkflowID: "wf1", Name: "Destination",
	}

	svc.handleTaskQueuePromoted(ctx, watcher.TaskEventData{TaskID: deferredChainTaskID})
	if !counter.awaitLaunch(0) {
		t.Fatal("promotion did not launch the deferred task")
	}
	awaitLaunchedSession(t, repo, deferredChainTaskID)

	if got := sessionCount(t, repo, deferredChainTaskID); got != 1 {
		t.Fatalf("session count = %d, want exactly one", got)
	}
	stored, err := repo.GetTask(ctx, deferredChainTaskID)
	if err != nil {
		t.Fatalf("reload promoted task: %v", err)
	}
	if _, pending := stored.Metadata[models.MetaKeyQueuePromotionPending]; pending {
		t.Fatal("queue promotion token remained after deferred launch")
	}
}

func TestQueuePromotionSessionLookupFailureKeepsToken(t *testing.T) {
	ctx := context.Background()
	const taskID = "promotion-session-lookup-failure"
	repo := setupTestRepo(t)
	seedChainStepTask(t, repo, taskID)

	task, err := repo.GetTask(ctx, taskID)
	if err != nil {
		t.Fatalf("load task: %v", err)
	}
	task.WorkflowStepID = "destination-step"
	task.WIPAdmitted = true
	task.Metadata[models.MetaKeyQueuePromotionPending] = true
	if err := repo.UpdateTask(ctx, task); err != nil {
		t.Fatalf("promote task: %v", err)
	}

	steps := newMockStepGetter()
	steps.steps["destination-step"] = &wfmodels.WorkflowStep{
		ID: "destination-step", WorkflowID: "wf1", Name: "Destination",
	}
	svc := createTestService(repo, steps, newMockTaskRepo())
	svc.repo = &queuePromotionSessionLookupErrorRepo{
		sessionExecutorStore: repo,
		err:                  errors.New("active session lookup failed"),
	}

	svc.handleTaskQueuePromoted(ctx, watcher.TaskEventData{TaskID: taskID})

	stored, err := repo.GetTask(ctx, taskID)
	if err != nil {
		t.Fatalf("reload task: %v", err)
	}
	if _, pending := stored.Metadata[models.MetaKeyQueuePromotionPending]; !pending {
		t.Fatal("queue promotion token was consumed after an active-session lookup failure")
	}
}
