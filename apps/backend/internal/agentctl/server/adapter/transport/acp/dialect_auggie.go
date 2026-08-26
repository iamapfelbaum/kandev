package acp

import "strings"

const (
	auggieAgentID          = "auggie"
	auggieKandevToolSuffix = "_kandev"
)

func newAuggieACPDialect() acpDialect {
	return acpDialect{mcpToolCall: parseAuggieMCPToolCall}
}

// parseAuggieMCPToolCall recognizes Auggie's title-based MCP tool calls.
// Auggie appends the server name to an already suffixed Kandev tool name, so
// remove one of the two trailing server suffixes and retain its flat input.
func parseAuggieMCPToolCall(_ map[string]any, title string, rawInput any) (mcpToolCallFrame, bool) {
	arguments, ok := rawInput.(map[string]any)
	if !ok || !strings.HasSuffix(title, auggieKandevToolSuffix) {
		return mcpToolCallFrame{}, false
	}

	name := title
	doubleSuffix := auggieKandevToolSuffix + auggieKandevToolSuffix
	if strings.HasSuffix(name, doubleSuffix) {
		name = strings.TrimSuffix(name, auggieKandevToolSuffix)
	}
	if name == auggieKandevToolSuffix {
		return mcpToolCallFrame{}, false
	}
	return mcpToolCallFrame{name: name, arguments: arguments}, true
}
