package canvas

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

const (
	PortableFormat      = "kandev.canvas"
	PortableVersion     = 1
	CanvasSchemaVersion = 1
	MaxTitleLength      = 200
	MaxItemLength       = 200
	MaxActiveCanvases   = 100
	MaxBlocks           = 50
	MaxItems            = 500
	MaxCanvasBytes      = 256 * 1024
	MaxCommandBytes     = 32 * 1024
	MaxFileBytes        = 512 * 1024
	MaxEventCount       = 1000
	LeaseDuration       = 30 * time.Second
)

const (
	BlockTypeMarkdown  = "markdown"
	BlockTypeChecklist = "checklist"
	BlockTypeKanban    = "kanban"
	BlockTypeMetrics   = "metrics"
	BlockTypeTimeline  = "timeline"
)

const (
	ActionCanvasRename  = "canvas.rename"
	ActionBlockCreate   = "block.create"
	ActionBlockUpdate   = "block.update"
	ActionBlockDelete   = "block.delete"
	ActionBlockReorder  = "block.reorder"
	ActionItemUpsert    = "item.upsert"
	ActionItemDelete    = "item.delete"
	ActionItemMove      = "item.move"
	ActionCanvasCompact = "canvas.compact"
)

const (
	ActionChecklistAdd     = "checklist.add"
	ActionChecklistEdit    = "checklist.edit"
	ActionChecklistToggle  = "checklist.toggle"
	ActionChecklistMove    = "checklist.move"
	ActionChecklistRemove  = "checklist.remove"
	ActionKanbanCardAdd    = "kanban.card.add"
	ActionKanbanCardEdit   = "kanban.card.edit"
	ActionKanbanCardMove   = "kanban.card.move"
	ActionKanbanCardRemove = "kanban.card.remove"
	ActionMetricsSet       = "metrics.set"
	ActionMetricsRemove    = "metrics.remove"
	ActionMetricsReorder   = "metrics.reorder"
	ActionTimelineAdd      = "timeline.add"
	ActionTimelineEdit     = "timeline.edit"
	ActionTimelineMove     = "timeline.move"
	ActionTimelineRemove   = "timeline.remove"
)

var (
	ErrCanvasNotFound        = errors.New("canvas not found")
	ErrCanvasValidation      = errors.New("canvas validation failed")
	ErrRevisionConflict      = errors.New("canvas revision conflict")
	ErrCommandConflict       = errors.New("canvas command conflict")
	ErrTaskWorkspaceMismatch = errors.New("task belongs to another workspace")
	ErrTaskNotFound          = errors.New("task not found")
	ErrCanvasLimit           = errors.New("canvas limit exceeded")
	ErrInvalidPortableFile   = errors.New("invalid portable canvas file")
	ErrCanvasArchived        = errors.New("canvas is archived")
	ErrLeaseUnavailable      = errors.New("markdown lease unavailable")
)

type Canvas struct {
	ID                       string     `json:"id" db:"id"`
	OwnerUserID              string     `json:"owner_user_id" db:"owner_user_id"`
	WorkspaceID              string     `json:"workspace_id" db:"workspace_id"`
	Title                    string     `json:"title" db:"title"`
	SchemaVersion            int        `json:"schema_version" db:"schema_version"`
	Revision                 int64      `json:"revision" db:"revision"`
	CompactedThroughRevision int64      `json:"compacted_through_revision" db:"compacted_through_revision"`
	SourceExportID           *string    `json:"source_export_id,omitempty" db:"source_export_id"`
	ImportedAt               *time.Time `json:"imported_at,omitempty" db:"imported_at"`
	ArchivedAt               *time.Time `json:"archived_at,omitempty" db:"archived_at"`
	CreatedAt                time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt                time.Time  `json:"updated_at" db:"updated_at"`
	Blocks                   []Block    `json:"blocks" db:"-"`
	TaskLinks                []TaskLink `json:"task_links" db:"-"`
}

type Block struct {
	ID            string          `json:"id" db:"id"`
	CanvasID      string          `json:"canvas_id" db:"canvas_id"`
	Type          string          `json:"type" db:"block_type"`
	Position      int             `json:"position" db:"position"`
	State         json.RawMessage `json:"state" db:"state_json"`
	BlockRevision int64           `json:"block_revision" db:"block_revision"`
	CreatedAt     time.Time       `json:"created_at" db:"created_at"`
	UpdatedAt     time.Time       `json:"updated_at" db:"updated_at"`
}

type TaskLink struct {
	CanvasID  string    `json:"canvas_id" db:"canvas_id"`
	TaskID    string    `json:"task_id" db:"task_id"`
	LinkedBy  string    `json:"linked_by" db:"linked_by"`
	CreatedAt time.Time `json:"created_at" db:"created_at"`
}

type CanvasEvent struct {
	CanvasID  string          `json:"canvas_id" db:"canvas_id"`
	Revision  int64           `json:"revision" db:"revision"`
	CommandID string          `json:"command_id" db:"command_id"`
	ActorKind string          `json:"actor_kind" db:"actor_kind"`
	ActorID   string          `json:"actor_id" db:"actor_id"`
	Action    string          `json:"action" db:"action"`
	TargetID  string          `json:"target_id,omitempty" db:"target_id"`
	Payload   json.RawMessage `json:"payload" db:"payload_json"`
	CreatedAt time.Time       `json:"created_at" db:"created_at"`
}

type CreateCanvasRequest struct {
	WorkspaceID string `json:"workspace_id"`
	Title       string `json:"title"`
}

type UpdateCanvasRequest struct {
	Title *string `json:"title,omitempty"`
}

type ApplyCanvasCommandRequest struct {
	CommandID     string          `json:"command_id"`
	BaseRevision  int64           `json:"base_revision"`
	Action        string          `json:"action"`
	TargetID      string          `json:"target_id,omitempty"`
	Input         json.RawMessage `json:"input,omitempty"`
	LeaseHolderID string          `json:"lease_holder_id,omitempty"`
}

type ApplyCanvasCommandResult struct {
	Canvas    *Canvas      `json:"canvas"`
	Event     *CanvasEvent `json:"event,omitempty"`
	Revision  int64        `json:"revision"`
	Duplicate bool         `json:"duplicate,omitempty"`
}

type Actor struct {
	Kind string
	ID   string
}

type PortableCanvasFile struct {
	Format        string         `json:"format"`
	FormatVersion int            `json:"format_version"`
	ExportID      string         `json:"export_id"`
	ExportedAt    time.Time      `json:"exported_at"`
	Canvas        PortableCanvas `json:"canvas"`
}

type PortableCanvas struct {
	Title         string          `json:"title"`
	SchemaVersion int             `json:"schema_version"`
	Blocks        []PortableBlock `json:"blocks"`
}

type PortableBlock struct {
	Type     string          `json:"type"`
	Position int             `json:"position"`
	State    json.RawMessage `json:"state"`
}

func validateTitle(title string) error {
	title = strings.TrimSpace(title)
	if title == "" || len([]rune(title)) > MaxTitleLength {
		return fmt.Errorf("%w: title must contain 1-%d characters", ErrCanvasValidation, MaxTitleLength)
	}
	return nil
}

func validateBlock(blockType string, state json.RawMessage) error {
	switch blockType {
	case BlockTypeMarkdown, BlockTypeChecklist, BlockTypeKanban, BlockTypeMetrics, BlockTypeTimeline:
	default:
		return fmt.Errorf("%w: unsupported block type %q", ErrCanvasValidation, blockType)
	}
	if len(state) == 0 {
		return fmt.Errorf("%w: block state is required", ErrCanvasValidation)
	}
	var value any
	if err := json.Unmarshal(state, &value); err != nil {
		return fmt.Errorf("%w: block state must be JSON: %v", ErrCanvasValidation, err)
	}
	if _, ok := value.(map[string]any); !ok {
		return fmt.Errorf("%w: block state must be a JSON object", ErrCanvasValidation)
	}
	if err := validateStateValue(value); err != nil {
		return err
	}
	if err := validateTypedBlockState(blockType, value); err != nil {
		return err
	}
	if countItems(state) > MaxItems {
		return fmt.Errorf("%w: item count exceeds %d", ErrCanvasLimit, MaxItems)
	}
	return nil
}

func validateTypedBlockState(blockType string, value any) error {
	state, ok := value.(map[string]any)
	if !ok {
		return fmt.Errorf("%w: block state must be a JSON object", ErrCanvasValidation)
	}
	switch blockType {
	case BlockTypeMarkdown:
		return validateMarkdownState(state)
	case BlockTypeChecklist:
		return validateCollectionState(state, "items", "checklist")
	case BlockTypeKanban:
		return validateKanbanState(state)
	case BlockTypeMetrics:
		return validateCollectionState(state, "metrics", "metric")
	case BlockTypeTimeline:
		return validateCollectionState(state, "events", "timeline event")
	}
	return nil
}

func validateMarkdownState(state map[string]any) error {
	if _, ok := state["markdown"].(string); !ok {
		return fmt.Errorf("%w: markdown state requires a markdown string", ErrCanvasValidation)
	}
	return nil
}

func validateCollectionState(state map[string]any, key, label string) error {
	items, err := requiredStateCollection(state, key)
	if err != nil {
		return err
	}
	return validateTypedItems(items, label)
}

func validateKanbanState(state map[string]any) error {
	columns, err := requiredStateCollection(state, "columns")
	if err != nil {
		return err
	}
	seenColumns := make(map[string]struct{}, len(columns))
	for _, rawColumn := range columns {
		column, ok := rawColumn.(map[string]any)
		if !ok {
			return fmt.Errorf("%w: kanban columns must be objects", ErrCanvasValidation)
		}
		columnID, err := requiredStateString(column, "id", "kanban column")
		if err != nil {
			return err
		}
		if _, exists := seenColumns[columnID]; exists {
			return fmt.Errorf("%w: duplicate kanban column id %q", ErrCanvasValidation, columnID)
		}
		seenColumns[columnID] = struct{}{}
		if err := validateCollectionState(column, "cards", "kanban card"); err != nil {
			return fmt.Errorf("%w: kanban column cards are required", ErrCanvasValidation)
		}
	}
	return nil
}

func requiredStateCollection(state map[string]any, key string) ([]any, error) {
	items, ok := state[key].([]any)
	if !ok {
		return nil, fmt.Errorf("%w: state requires a %s collection", ErrCanvasValidation, key)
	}
	return items, nil
}

func requiredStateString(state map[string]any, key, label string) (string, error) {
	value, ok := state[key].(string)
	if !ok || strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("%w: %s requires a non-empty %s", ErrCanvasValidation, label, key)
	}
	return value, nil
}

func validateTypedItems(items []any, label string) error {
	seen := make(map[string]struct{}, len(items))
	for _, rawItem := range items {
		item, ok := rawItem.(map[string]any)
		if !ok {
			return fmt.Errorf("%w: %s must be an object", ErrCanvasValidation, label)
		}
		id, ok := item["id"].(string)
		if !ok || strings.TrimSpace(id) == "" {
			return fmt.Errorf("%w: %s requires a stable id", ErrCanvasValidation, label)
		}
		if _, exists := seen[id]; exists {
			return fmt.Errorf("%w: duplicate %s id %q", ErrCanvasValidation, label, id)
		}
		seen[id] = struct{}{}
		revision, ok := stateInteger(item["revision"])
		if !ok || revision < 1 {
			return fmt.Errorf("%w: %s revision must be a positive integer", ErrCanvasValidation, label)
		}
		if err := validateTypedItemFields(item, label); err != nil {
			return err
		}
	}
	return nil
}

func validateTypedItemFields(item map[string]any, label string) error {
	for key, value := range item {
		switch key {
		case "id", "revision":
			continue
		case "label", "name", "title", "status", "unit", "timestamp", "time", "created_at", "updated_at":
			if _, ok := value.(string); !ok {
				return fmt.Errorf("%w: %s field %q must be a string", ErrCanvasValidation, label, key)
			}
		case "completed", "done":
			if _, ok := value.(bool); !ok {
				return fmt.Errorf("%w: %s field %q must be a boolean", ErrCanvasValidation, label, key)
			}
		case "value":
			switch value.(type) {
			case string, bool, float64, json.Number:
			default:
				return fmt.Errorf("%w: %s field %q must be a scalar", ErrCanvasValidation, label, key)
			}
		}
	}
	return nil
}

func stateInteger(value any) (int64, bool) {
	switch number := value.(type) {
	case json.Number:
		parsed, err := number.Int64()
		return parsed, err == nil
	case float64:
		if math.IsNaN(number) || math.IsInf(number, 0) || number < -float64(1<<63) || number >= float64(1<<63) || math.Trunc(number) != number {
			return 0, false
		}
		return int64(number), true
	case int64:
		return number, true
	case int:
		return int64(number), true
	default:
		return 0, false
	}
}

var forbiddenStateKeys = map[string]bool{
	"code": true, "command": true, "endpoint": true, "exec": true, "executable": true,
	"file": true, "html": true, "href": true, "iframe": true, "javascript": true,
	"remote": true, "script": true, "secret": true, "server": true, "src": true,
	"token": true, "url": true,
}

func validateStateValue(value any) error {
	switch typed := value.(type) {
	case map[string]any:
		return validateStateMap(typed)
	case []any:
		return validateStateSlice(typed)
	case string:
		return validateStateString(typed)
	}
	return nil
}

func validateStateMap(values map[string]any) error {
	for key, child := range values {
		normalized := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(key), "-", "_"))
		if forbiddenStateKeys[normalized] || strings.HasPrefix(normalized, "on_") {
			return fmt.Errorf("%w: state field %q is not allowed", ErrCanvasValidation, key)
		}
		if err := validateItemLabel(normalized, child); err != nil {
			return err
		}
		if err := validateStateValue(child); err != nil {
			return err
		}
	}
	return nil
}

func validateStateSlice(values []any) error {
	for _, child := range values {
		if err := validateStateValue(child); err != nil {
			return err
		}
	}
	return nil
}

func validateItemLabel(key string, value any) error {
	if !itemLabelKeys[key] {
		return nil
	}
	label, ok := value.(string)
	if ok && len([]rune(label)) > MaxItemLength {
		return fmt.Errorf("%w: item label must contain at most %d characters", ErrCanvasLimit, MaxItemLength)
	}
	return nil
}

func validateStateString(value string) error {
	lowered := strings.ToLower(value)
	if strings.Contains(lowered, "javascript:") || strings.Contains(lowered, "data:text/html") || containsHTMLTag(value) {
		return fmt.Errorf("%w: executable or raw HTML content is not allowed", ErrCanvasValidation)
	}
	return nil
}

var itemLabelKeys = map[string]bool{
	"label": true,
	"name":  true,
	"title": true,
}

func containsHTMLTag(value string) bool {
	for offset := 0; offset < len(value); offset++ {
		if value[offset] != '<' || offset+1 >= len(value) {
			continue
		}
		next := value[offset+1]
		if next == '/' && offset+2 < len(value) {
			next = value[offset+2]
		}
		if (next < 'a' || next > 'z') && (next < 'A' || next > 'Z') {
			continue
		}
		if strings.IndexByte(value[offset+1:], '>') >= 0 {
			return true
		}
	}
	return false
}

func validateCommand(req ApplyCanvasCommandRequest) error {
	if strings.TrimSpace(req.CommandID) == "" || strings.TrimSpace(req.Action) == "" {
		return fmt.Errorf("%w: command_id and action are required", ErrCanvasValidation)
	}
	if len(req.Input) > MaxCommandBytes {
		return fmt.Errorf("%w: command input exceeds %d bytes", ErrCanvasLimit, MaxCommandBytes)
	}
	return nil
}
