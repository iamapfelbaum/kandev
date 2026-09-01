package mcp

import (
	"encoding/json"
	"fmt"
	"slices"

	"github.com/mark3labs/mcp-go/mcp"
	"go.uber.org/zap"
)

const (
	auggieAgentType             = "auggie"
	auggieTitleCarrierArgument  = "summary"
	auggieReviewSummaryArgument = "review_summary"
)

type auggieTitleCarrierSpec struct {
	toolName           string
	semanticSummaryArg string
}

var auggieTitleCarrierSpecs = []auggieTitleCarrierSpec{
	{toolName: richOutputToolName},
	{toolName: "show_walkthrough_kandev"},
	{
		toolName:           "publish_review_findings_kandev",
		semanticSummaryArg: auggieReviewSummaryArgument,
	},
}

// Auggie replaces an ACP tool call's title with the first non-empty top-level
// summary, description, or title argument. A required constant summary keeps
// the canonical tool identity on the wire. The ACP dialect removes it again.
func (s *Server) applyAuggieToolTitleCompatibility() {
	if s.agentType != auggieAgentType {
		return
	}
	tools := s.mcpServer.ListTools()
	for _, spec := range auggieTitleCarrierSpecs {
		registered, ok := tools[spec.toolName]
		if !ok {
			continue
		}
		tool, err := withAuggieTitleCarrier(registered.Tool, spec.semanticSummaryArg)
		if err != nil {
			s.logger.Error("failed to add Auggie MCP title carrier",
				zap.String("tool", spec.toolName), zap.Error(err))
			continue
		}
		s.mcpServer.AddTool(tool, registered.Handler)
	}
}

func withAuggieTitleCarrier(tool mcp.Tool, semanticSummaryArg string) (mcp.Tool, error) {
	if tool.RawInputSchema != nil {
		return withAuggieRawTitleCarrier(tool, semanticSummaryArg)
	}

	properties := make(map[string]any, len(tool.InputSchema.Properties)+1)
	for name, property := range tool.InputSchema.Properties {
		properties[name] = property
	}
	if semanticSummaryArg != "" {
		semanticSummary, ok := properties[auggieTitleCarrierArgument]
		if !ok {
			return tool, fmt.Errorf("semantic summary property is missing")
		}
		properties[semanticSummaryArg] = semanticSummary
	}
	properties[auggieTitleCarrierArgument] = auggieTitleCarrierProperty(tool.Name)
	tool.InputSchema.Properties = properties
	tool.InputSchema.Required = appendRequired(tool.InputSchema.Required, auggieTitleCarrierArgument)
	return tool, nil
}

func withAuggieRawTitleCarrier(tool mcp.Tool, semanticSummaryArg string) (mcp.Tool, error) {
	var schema map[string]any
	if err := json.Unmarshal(tool.RawInputSchema, &schema); err != nil {
		return tool, fmt.Errorf("decode raw input schema: %w", err)
	}
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		return tool, fmt.Errorf("raw input schema properties are missing")
	}
	if semanticSummaryArg != "" {
		semanticSummary, exists := properties[auggieTitleCarrierArgument]
		if !exists {
			return tool, fmt.Errorf("semantic summary property is missing")
		}
		properties[semanticSummaryArg] = semanticSummary
	}
	properties[auggieTitleCarrierArgument] = auggieTitleCarrierProperty(tool.Name)
	schema["required"] = appendRequiredStrings(schema["required"], auggieTitleCarrierArgument)

	encoded, err := json.Marshal(schema)
	if err != nil {
		return tool, fmt.Errorf("encode raw input schema: %w", err)
	}
	tool.RawInputSchema = encoded
	return tool, nil
}

func auggieTitleCarrierProperty(toolName string) map[string]any {
	return map[string]any{
		typeKey:        stringType,
		"const":        toolName,
		descriptionArg: "ACP compatibility identity. Use this exact fixed value.",
	}
}

func appendRequired(required []string, property string) []string {
	if slices.Contains(required, property) {
		return required
	}
	return append(slices.Clone(required), property)
}

func appendRequiredStrings(raw any, property string) []string {
	required := make([]string, 0)
	if values, ok := raw.([]any); ok {
		for _, value := range values {
			if text, textOK := value.(string); textOK {
				required = append(required, text)
			}
		}
	}
	return appendRequired(required, property)
}

func (s *Server) reviewSummaryArgument() string {
	if s.agentType == auggieAgentType {
		return auggieReviewSummaryArgument
	}
	return auggieTitleCarrierArgument
}
