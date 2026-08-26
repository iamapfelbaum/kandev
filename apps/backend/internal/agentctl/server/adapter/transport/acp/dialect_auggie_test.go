package acp

import (
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
	"github.com/kandev/kandev/internal/agentctl/types/streams"
	"github.com/stretchr/testify/require"
)

func TestAuggieMCPToolCallUsesTitleAndFlatInput(t *testing.T) {
	t.Parallel()

	a := newTestAdapter()
	t.Cleanup(func() { require.NoError(t, a.Close()) })
	a.agentID = auggieAgentID
	a.normalizer = NewNormalizer(auggieAgentID)
	a.dialect = newACPDialect(auggieAgentID)

	arguments := map[string]any{
		"version": float64(1),
		"title":   "Failed requests",
		"blocks":  []any{},
	}
	event := a.convertToolCallUpdate("session-1", &acpsdk.SessionUpdateToolCall{
		Kind:          acpsdk.ToolKind("other"),
		RawInput:      arguments,
		SessionUpdate: "tool_call",
		Status:        acpsdk.ToolCallStatus("in_progress"),
		Title:         "show_rich_output_kandev_kandev",
		ToolCallId:    acpsdk.ToolCallId("call-auggie-1"),
	})

	require.NotNil(t, event)
	require.Equal(t, streams.EventTypeToolCall, event.Type)
	require.True(t, event.NormalizedPayload.IsMCPTool())
	require.Equal(t, "show_rich_output_kandev", event.ToolName)
	require.Equal(t, "show_rich_output_kandev", event.NormalizedPayload.Generic().Name)
	require.Equal(t, arguments, event.NormalizedPayload.Generic().Input)
}

// Contract coverage for the three renderer-bearing Kandev tools observed in
// captured Auggie frames. Auggie may emit either the canonical suffix or append
// its server suffix a second time; both normalize to the canonical tool name.
func TestParseAuggieMCPToolCallNormalizesKandevTitles(t *testing.T) {
	t.Parallel()

	arguments := map[string]any{"version": float64(1)}
	tests := []struct {
		title string
		want  string
	}{
		{title: "show_rich_output_kandev_kandev", want: "show_rich_output_kandev"},
		{title: "ask_user_question_kandev_kandev", want: "ask_user_question_kandev"},
		{title: "show_walkthrough_kandev_kandev", want: "show_walkthrough_kandev"},
		{title: "show_rich_output_kandev", want: "show_rich_output_kandev"},
	}

	for _, test := range tests {
		t.Run(test.title, func(t *testing.T) {
			frame, ok := parseAuggieMCPToolCall(nil, test.title, arguments)
			require.True(t, ok)
			require.Equal(t, test.want, frame.name)
			require.Equal(t, arguments, frame.arguments)
		})
	}
}

// Contract coverage for captured non-MCP Auggie calls and malformed input.
func TestParseAuggieMCPToolCallRejectsNonMCPFrames(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		title    string
		rawInput any
	}{
		{
			name:  "human title",
			title: "augpool credential pool plan",
			rawInput: map[string]any{
				"content": "plan contents",
				"title":   "augpool credential pool plan",
			},
		},
		{name: "non-object input", title: "show_rich_output_kandev_kandev", rawInput: "invalid"},
		{name: "empty tool stem", title: "_kandev_kandev", rawInput: map[string]any{}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, ok := parseAuggieMCPToolCall(nil, test.title, test.rawInput)
			require.False(t, ok)
		})
	}
}
