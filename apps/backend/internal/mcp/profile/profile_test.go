package profile

import "testing"

func TestLegacyTaskTitleProfile(t *testing.T) {
	ctx := Legacy("task-title-pending", false, []string{"gitlab", "gitlab", "github"})
	if ctx.Surface != SurfaceKanbanTask {
		t.Fatalf("surface = %q, want %q", ctx.Surface, SurfaceKanbanTask)
	}
	if !ctx.HasCapability(CapabilityTaskTitle) || !ctx.HasCapability(CapabilityUserQuestion) {
		t.Fatalf("capabilities = %#v, want title and user question", ctx.Capabilities)
	}
	if got, want := ctx.Providers, []string{"github", "gitlab"}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("providers = %#v, want %#v", got, want)
	}
}

func TestAutopilotQuestionCapabilitiesCanBeSwapped(t *testing.T) {
	ctx := New(SurfaceKanbanTask, []Capability{CapabilityParentQuestion}, nil)
	if !ctx.HasCapability(CapabilityParentQuestion) {
		t.Fatal("parent-question capability missing")
	}
	ctx = ctx.WithoutCapability(CapabilityParentQuestion).WithCapability(CapabilityUserQuestion)
	if ctx.HasCapability(CapabilityParentQuestion) || !ctx.HasCapability(CapabilityUserQuestion) {
		t.Fatalf("capabilities = %#v, want only user-question", ctx.Capabilities)
	}
}

func TestLegacyExternalHasNoQuestionCapability(t *testing.T) {
	ctx := Legacy("external", false, nil)
	if ctx.HasCapability(CapabilityUserQuestion) || ctx.HasCapability(CapabilityParentQuestion) {
		t.Fatalf("external capabilities = %#v, want no question capability", ctx.Capabilities)
	}
}
