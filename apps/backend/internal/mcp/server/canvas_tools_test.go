package mcp

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestApplyCanvasActionRejectsFractionalBaseRevision(t *testing.T) {
	backend := &testBackend{}
	server := New(backend, "test-session", "test-task", 10005, newTestLogger(t), "", false, ModeTask)

	result := callTool(t, server, "apply_canvas_action_kandev", map[string]interface{}{
		"canvas_id": "canvas-1", "command_id": "command-1", "base_revision": 4.5,
		"action": "canvas.rename", "input": map[string]interface{}{"title": "Updated"},
	})

	assert.True(t, result.IsError)
	assert.Empty(t, backend.lastAction)
}

func TestApplyCanvasActionPreservesIntegerBaseRevision(t *testing.T) {
	backend := &testBackend{}
	server := New(backend, "test-session", "test-task", 10005, newTestLogger(t), "", false, ModeTask)

	_ = callTool(t, server, "apply_canvas_action_kandev", map[string]interface{}{
		"canvas_id": "canvas-1", "command_id": "command-1", "base_revision": 4,
		"action": "canvas.rename", "input": map[string]interface{}{"title": "Updated"},
	})

	require.Equal(t, "canvas.command", backend.lastAction)
	payload, ok := backend.lastPayload.(map[string]any)
	require.True(t, ok)
	assert.Equal(t, int64(4), payload["base_revision"])
}
