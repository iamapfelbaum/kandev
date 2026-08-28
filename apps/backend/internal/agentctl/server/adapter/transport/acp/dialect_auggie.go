package acp

import (
	"regexp"
	"strings"
)

const (
	auggieAgentID          = "auggie"
	auggieMCPToolKind      = "other"
	auggieKandevToolSuffix = "_kandev"
)

var auggieKandevToolTitlePattern = regexp.MustCompile(`^[a-z0-9_]+_kandev(_kandev)?$`)

func newAuggieACPDialect() acpDialect {
	return acpDialect{mcpToolCall: parseAuggieMCPToolCall}
}

// parseAuggieMCPToolCall recognizes Auggie's title-based MCP tool calls.
// Auggie appends the server name to an already suffixed Kandev tool name, so
// remove one of the two trailing server suffixes and retain its flat input.
func parseAuggieMCPToolCall(
	_ map[string]any,
	kind string,
	title string,
	rawInput any,
) (mcpToolCallFrame, bool) {
	arguments, ok := rawInput.(map[string]any)
	tripleSuffix := strings.Repeat(auggieKandevToolSuffix, 3)
	if kind != auggieMCPToolKind || !ok || !auggieKandevToolTitlePattern.MatchString(title) ||
		strings.HasSuffix(title, tripleSuffix) {
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
