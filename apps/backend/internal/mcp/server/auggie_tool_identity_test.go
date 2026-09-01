package mcp

import (
	"encoding/json"
	"testing"

	mcpprofile "github.com/kandev/kandev/internal/mcp/profile"
	ws "github.com/kandev/kandev/pkg/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const testAuggieAgentType = "auggie"

func newAuggieTaskModeServer(t *testing.T, backend BackendClient) *Server {
	t.Helper()
	return NewWithProfileForAgent(
		backend,
		"test-session",
		"test-task",
		10005,
		newTestLogger(t),
		"",
		false,
		mcpprofile.Legacy(ModeTask, false, []string{"github", "gitlab"}),
		testAuggieAgentType,
	)
}

func toolInputSchemaMap(t *testing.T, s *Server, toolName string) map[string]any {
	t.Helper()
	registered, ok := s.mcpServer.ListTools()[toolName]
	require.True(t, ok, "tool %q must be registered", toolName)

	var schema map[string]any
	require.NoError(t, json.Unmarshal(mcpToolInputSchema(registered.Tool), &schema))
	return schema
}

func TestAuggieRendererToolsAdvertiseStableACPTitleCarrier(t *testing.T) {
	t.Parallel()

	s := newAuggieTaskModeServer(t, &testBackend{})
	for _, toolName := range []string{
		richOutputToolName,
		"show_walkthrough_kandev",
		"publish_review_findings_kandev",
	} {
		t.Run(toolName, func(t *testing.T) {
			schema := toolInputSchemaMap(t, s, toolName)
			properties, ok := schema["properties"].(map[string]any)
			require.True(t, ok)
			carrier, ok := properties["summary"].(map[string]any)
			require.True(t, ok)
			assert.Equal(t, toolName, carrier["const"])
			assert.Contains(t, schema["required"], "summary")
		})
	}

	reviewSchema := toolInputSchemaMap(t, s, "publish_review_findings_kandev")
	reviewProperties := reviewSchema["properties"].(map[string]any)
	assert.Contains(t, reviewProperties, "review_summary")
}

func TestAuggieTitleCarrierIsNotAdvertisedToOtherAgents(t *testing.T) {
	t.Parallel()

	s := newTaskModeServer(t, &testBackend{}, "test-task")
	richSchema := toolInputSchemaMap(t, s, richOutputToolName)
	richProperties := richSchema["properties"].(map[string]any)
	assert.NotContains(t, richProperties, "summary")

	reviewSchema := toolInputSchemaMap(t, s, "publish_review_findings_kandev")
	reviewProperties := reviewSchema["properties"].(map[string]any)
	assert.Contains(t, reviewProperties, "summary")
	assert.NotContains(t, reviewProperties, "review_summary")
}

func TestAuggieReviewTitleCarrierPreservesSemanticSummary(t *testing.T) {
	t.Parallel()

	backend := &testBackend{response: map[string]any{"published": 0}}
	s := newAuggieTaskModeServer(t, backend)
	result := callTool(t, s, "publish_review_findings_kandev", map[string]any{
		"summary":        "publish_review_findings_kandev",
		"review_summary": "No actionable findings.",
		"findings":       []any{},
	})

	require.False(t, result.IsError)
	assert.Equal(t, ws.ActionMCPPublishReviewFindings, backend.lastAction)
	payload, ok := backend.lastPayload.(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "No actionable findings.", payload["summary"])
}

func TestAuggieRichOutputAcceptsStableTitleCarrier(t *testing.T) {
	t.Parallel()

	s := newAuggieTaskModeServer(t, &testBackend{})
	result := callTool(t, s, richOutputToolName, map[string]any{
		"summary": "show_rich_output_kandev",
		"version": float64(1),
		"title":   "Probe",
		"blocks": []any{
			map[string]any{
				"type": "metrics",
				"items": []any{
					map[string]any{"label": "Passed", "value": "1"},
				},
			},
		},
	})

	assert.False(t, result.IsError)
}

func TestAuggieRendererToolRejectsMissingTitleCarrier(t *testing.T) {
	t.Parallel()

	backend := &testBackend{}
	s := newAuggieTaskModeServer(t, backend)
	result := callTool(t, s, "show_walkthrough_kandev", map[string]any{
		"steps": []any{
			map[string]any{"file": "main.go", "line": float64(1), "text": "Entry point."},
		},
	})

	assert.True(t, result.IsError)
	assert.Empty(t, backend.lastAction)
}
