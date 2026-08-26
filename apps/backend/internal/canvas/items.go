package canvas

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
)

const (
	itemCollectionItems   = "items"
	itemCollectionCards   = "cards"
	itemCollectionEvents  = "events"
	itemCollectionMetrics = "metrics"
)

type itemCommandInput struct {
	BlockID               string         `json:"block_id,omitempty"`
	ItemID                string         `json:"item_id,omitempty"`
	Item                  map[string]any `json:"item,omitempty"`
	Patch                 map[string]any `json:"patch,omitempty"`
	Collection            string         `json:"collection,omitempty"`
	ExpectedItemRevision  *int64         `json:"expected_item_revision,omitempty"`
	ExpectedBlockRevision *int64         `json:"expected_block_revision,omitempty"`
}

type itemRevisionConflictError struct {
	ItemID  string
	Current int64
}

func (e *itemRevisionConflictError) Error() string {
	return fmt.Sprintf("%s: item %q is at revision %d", ErrRevisionConflict, e.ItemID, e.Current)
}

func (e *itemRevisionConflictError) Unwrap() error { return ErrRevisionConflict }

type structuredItemActionSpec struct {
	operation  string
	collection string
}

var structuredItemActions = map[string]structuredItemActionSpec{
	ActionChecklistAdd:     {operation: ActionItemUpsert, collection: itemCollectionItems},
	ActionChecklistEdit:    {operation: ActionItemUpsert, collection: itemCollectionItems},
	ActionChecklistToggle:  {operation: ActionItemUpsert, collection: itemCollectionItems},
	ActionChecklistMove:    {operation: ActionItemUpsert, collection: itemCollectionItems},
	ActionChecklistRemove:  {operation: ActionItemDelete, collection: itemCollectionItems},
	ActionKanbanCardAdd:    {operation: ActionItemUpsert, collection: itemCollectionCards},
	ActionKanbanCardEdit:   {operation: ActionItemUpsert, collection: itemCollectionCards},
	ActionKanbanCardMove:   {operation: ActionItemUpsert, collection: itemCollectionCards},
	ActionKanbanCardRemove: {operation: ActionItemDelete, collection: itemCollectionCards},
	ActionMetricsSet:       {operation: ActionItemUpsert, collection: itemCollectionMetrics},
	ActionMetricsRemove:    {operation: ActionItemDelete, collection: itemCollectionMetrics},
	ActionMetricsReorder:   {operation: ActionItemUpsert, collection: itemCollectionMetrics},
	ActionTimelineAdd:      {operation: ActionItemUpsert, collection: itemCollectionEvents},
	ActionTimelineEdit:     {operation: ActionItemUpsert, collection: itemCollectionEvents},
	ActionTimelineMove:     {operation: ActionItemUpsert, collection: itemCollectionEvents},
	ActionTimelineRemove:   {operation: ActionItemDelete, collection: itemCollectionEvents},
}

func isStructuredItemAction(action string) bool {
	if action == ActionItemUpsert || action == ActionItemDelete {
		return true
	}
	_, ok := structuredItemActions[action]
	return ok
}

func normalizeStructuredItemCommand(req ApplyCanvasCommandRequest) (ApplyCanvasCommandRequest, error) {
	spec, ok := structuredItemActions[req.Action]
	if !ok {
		return req, nil
	}
	raw, err := decodeStructuredItemInput(req.Input)
	if err != nil {
		return req, err
	}
	if err := validateStructuredCollection(raw, spec.collection); err != nil {
		return req, err
	}
	output := structuredItemMetadata(raw, spec.collection)
	if spec.operation == ActionItemDelete {
		if err := requireStructuredItemID(output); err != nil {
			return req, err
		}
	} else if err := addStructuredUpsertPayload(output, raw); err != nil {
		return req, err
	}
	req.Action = spec.operation
	input, err := json.Marshal(output)
	if err != nil {
		return req, fmt.Errorf("%w: invalid structured item input", ErrCanvasValidation)
	}
	req.Input = input
	return req, nil
}

func decodeStructuredItemInput(input json.RawMessage) (map[string]any, error) {
	var raw map[string]any
	if err := decodeStrictJSON(input, &raw); err != nil || raw == nil {
		return nil, fmt.Errorf("%w: invalid structured item input", ErrCanvasValidation)
	}
	return raw, nil
}

func validateStructuredCollection(raw map[string]any, expected string) error {
	collection, ok := raw["collection"].(string)
	if ok && collection != "" && collection != expected {
		return fmt.Errorf("%w: item collection does not match action", ErrCanvasValidation)
	}
	return nil
}

func structuredItemMetadata(raw map[string]any, collection string) map[string]any {
	output := make(map[string]any)
	for _, key := range []string{"block_id", "item_id", "expected_item_revision", "expected_block_revision"} {
		if value, ok := raw[key]; ok {
			output[key] = value
		}
	}
	output["collection"] = collection
	return output
}

func requireStructuredItemID(output map[string]any) error {
	if _, ok := output["item_id"]; !ok {
		return fmt.Errorf("%w: item_id is required", ErrCanvasValidation)
	}
	return nil
}

func addStructuredUpsertPayload(output, raw map[string]any) error {
	patch := make(map[string]any)
	if value, ok := raw["patch"].(map[string]any); ok {
		for key, child := range value {
			patch[key] = child
		}
	}
	if value, ok := raw["item"].(map[string]any); ok {
		output["item"] = value
	}
	for key, value := range raw {
		if isStructuredItemControlField(key) {
			continue
		}
		patch[key] = value
	}
	if len(patch) > 0 {
		output["patch"] = patch
	}
	if _, hasItem := output["item"]; !hasItem && len(patch) == 0 {
		return fmt.Errorf("%w: item or patch is required", ErrCanvasValidation)
	}
	return nil
}

func isStructuredItemControlField(key string) bool {
	switch key {
	case "block_id", "item_id", "expected_item_revision", "expected_block_revision", "collection", "item", "patch":
		return true
	default:
		return false
	}
}

func applyItemAction(ctx context.Context, tx *sqlx.Tx, canvas *Canvas, req ApplyCanvasCommandRequest, nowTime time.Time) error {
	payload, err := decodeItemCommand(req)
	if err != nil {
		return err
	}
	block, err := loadItemBlock(ctx, tx, canvas.ID, req.TargetID)
	if err != nil {
		return err
	}
	if err := validateItemBlock(block, payload); err != nil {
		return err
	}
	state, err := decodeStateObject(block.State)
	if err != nil {
		return err
	}

	if req.Action == ActionItemDelete {
		return applyItemDelete(ctx, tx, canvas, block, state, payload, nowTime)
	}
	return applyItemUpsert(ctx, tx, canvas, block, state, payload, nowTime)
}

func decodeItemCommand(req ApplyCanvasCommandRequest) (itemCommandInput, error) {
	if req.TargetID == "" {
		return itemCommandInput{}, fmt.Errorf("%w: target_id is required", ErrCanvasValidation)
	}
	var payload itemCommandInput
	if err := decodeStrictJSON(req.Input, &payload); err != nil {
		return itemCommandInput{}, fmt.Errorf("%w: invalid item input", ErrCanvasValidation)
	}
	if payload.BlockID != "" && payload.BlockID != req.TargetID {
		return itemCommandInput{}, fmt.Errorf("%w: block_id does not match target_id", ErrCanvasValidation)
	}
	if !validItemCollection(payload.Collection) {
		return itemCommandInput{}, fmt.Errorf("%w: unsupported item collection", ErrCanvasValidation)
	}
	return payload, nil
}

func loadItemBlock(ctx context.Context, tx *sqlx.Tx, canvasID, blockID string) (Block, error) {
	var block Block
	if err := tx.GetContext(ctx, &block, tx.Rebind(`
SELECT block_id AS id, canvas_id, block_type, position, state_json,
 block_revision, created_at, updated_at FROM canvas_blocks
WHERE canvas_id = ? AND block_id = ?`), canvasID, blockID); err != nil {
		return Block{}, ErrCanvasNotFound
	}
	return block, nil
}

func validateItemBlock(block Block, payload itemCommandInput) error {
	if block.Type == BlockTypeMarkdown {
		return fmt.Errorf("%w: markdown blocks do not contain structured items", ErrCanvasValidation)
	}
	if payload.ExpectedBlockRevision != nil && block.BlockRevision != *payload.ExpectedBlockRevision {
		return fmt.Errorf("%w: block revision is %d", ErrRevisionConflict, block.BlockRevision)
	}
	return nil
}

func applyItemDelete(
	ctx context.Context,
	tx *sqlx.Tx,
	canvas *Canvas,
	block Block,
	state map[string]any,
	payload itemCommandInput,
	nowTime time.Time,
) error {
	if payload.ItemID == "" {
		return fmt.Errorf("%w: item_id is required", ErrCanvasValidation)
	}
	current, found := findItem(state, payload.Collection, payload.ItemID)
	if !found {
		return ErrCanvasNotFound
	}
	if err := validateExpectedItemRevision(current, payload.ExpectedItemRevision, payload.ItemID); err != nil {
		return err
	}
	deleted, _ := deleteItem(state, payload.Collection, payload.ItemID, nil)
	if !deleted {
		return ErrCanvasNotFound
	}
	return persistItemState(ctx, tx, canvas, block, state, nowTime)
}

func applyItemUpsert(
	ctx context.Context,
	tx *sqlx.Tx,
	canvas *Canvas,
	block Block,
	state map[string]any,
	payload itemCommandInput,
	nowTime time.Time,
) error {
	item, itemID, err := itemForUpsert(payload)
	if err != nil {
		return err
	}
	current, found := findItem(state, payload.Collection, itemID)
	if found {
		if err := validateExpectedItemRevision(current, payload.ExpectedItemRevision, itemID); err != nil {
			return err
		}
		updated, _ := upsertItem(state, payload.Collection, itemID, item, payload.Patch, nil)
		if !updated {
			return ErrCanvasNotFound
		}
		return persistItemState(ctx, tx, canvas, block, state, nowTime)
	}
	if err := validateNewItemRevision(payload.ExpectedItemRevision, itemID); err != nil {
		return err
	}
	if err := appendItem(state, payload.Collection, item); err != nil {
		return err
	}
	return persistItemState(ctx, tx, canvas, block, state, nowTime)
}

func validateExpectedItemRevision(current map[string]any, expected *int64, itemID string) error {
	if expected != nil && itemRevision(current) != *expected {
		return &itemRevisionConflictError{ItemID: itemID, Current: itemRevision(current)}
	}
	return nil
}

func validateNewItemRevision(expected *int64, itemID string) error {
	if expected != nil && *expected != 0 {
		return &itemRevisionConflictError{ItemID: itemID, Current: 0}
	}
	return nil
}

func persistItemState(
	ctx context.Context,
	tx *sqlx.Tx,
	canvas *Canvas,
	block Block,
	state map[string]any,
	nowTime time.Time,
) error {
	if err := validateStateAfterItemChange(state); err != nil {
		return err
	}
	return updateBlockState(ctx, tx, canvas, block, state, nowTime)
}

func decodeStateObject(raw json.RawMessage) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var state map[string]any
	if err := decoder.Decode(&state); err != nil || state == nil {
		return nil, fmt.Errorf("%w: block state must be a JSON object", ErrCanvasValidation)
	}
	return state, nil
}

func itemForUpsert(payload itemCommandInput) (map[string]any, string, error) {
	item := payload.Item
	if item == nil {
		item = payload.Patch
	}
	if item == nil {
		return nil, "", fmt.Errorf("%w: item or patch is required", ErrCanvasValidation)
	}
	copyItem := make(map[string]any, len(item)+1)
	for key, value := range item {
		copyItem[key] = value
	}
	itemID := strings.TrimSpace(payload.ItemID)
	if itemID == "" {
		if value, ok := copyItem["id"].(string); ok {
			itemID = strings.TrimSpace(value)
		}
	}
	if itemID == "" {
		itemID = newID()
	}
	copyItem["id"] = itemID
	return copyItem, itemID, nil
}

func upsertItem(
	state map[string]any,
	collection, itemID string,
	item, patch map[string]any,
	expectedRevision *int64,
) (updated, found bool) {
	found = visitItem(state, collection, itemID, func(current map[string]any) map[string]any {
		found = true
		currentRevision := itemRevision(current)
		if expectedRevision != nil && currentRevision != *expectedRevision {
			return current
		}
		result := item
		if patch != nil {
			result = mergeItem(current, patch)
		}
		result["id"] = itemID
		result["revision"] = currentRevision + 1
		updated = true
		return result
	})
	return updated, found
}

func deleteItem(state map[string]any, collection, itemID string, expectedRevision *int64) (bool, bool) {
	var deleted bool
	found := visitItem(state, collection, itemID, func(current map[string]any) map[string]any {
		currentRevision := itemRevision(current)
		if expectedRevision != nil && currentRevision != *expectedRevision {
			return current
		}
		deleted = true
		return nil
	})
	return deleted, found
}

func findItem(state map[string]any, collection, itemID string) (map[string]any, bool) {
	var found map[string]any
	visitItem(state, collection, itemID, func(current map[string]any) map[string]any {
		found = current
		return current
	})
	return found, found != nil
}

func visitItem(
	value any,
	collection, itemID string,
	replace func(map[string]any) map[string]any,
) bool {
	switch typed := value.(type) {
	case map[string]any:
		if visitMapItems(typed, collection, itemID, replace) {
			return true
		}
		return visitMapChildren(typed, collection, itemID, replace)
	case []any:
		return visitSliceItems(typed, collection, itemID, replace)
	}
	return false
}

func visitMapItems(
	values map[string]any,
	collection, itemID string,
	replace func(map[string]any) map[string]any,
) bool {
	for _, key := range sortedKeys(values) {
		items, ok := values[key].([]any)
		if !ok || !matchesCollection(key, collection) {
			continue
		}
		updated, found := replaceItemInSlice(items, itemID, replace)
		if found {
			values[key] = updated
			return true
		}
	}
	return false
}

func replaceItemInSlice(
	items []any,
	itemID string,
	replace func(map[string]any) map[string]any,
) ([]any, bool) {
	for index, rawItem := range items {
		item, ok := rawItem.(map[string]any)
		if !ok || item["id"] != itemID {
			continue
		}
		replacement := replace(item)
		if replacement == nil {
			items = append(items[:index], items[index+1:]...)
		} else {
			items[index] = replacement
		}
		return items, true
	}
	return items, false
}

func visitMapChildren(
	values map[string]any,
	collection, itemID string,
	replace func(map[string]any) map[string]any,
) bool {
	for _, key := range sortedKeys(values) {
		if visitItem(values[key], collection, itemID, replace) {
			return true
		}
	}
	return false
}

func visitSliceItems(
	values []any,
	collection, itemID string,
	replace func(map[string]any) map[string]any,
) bool {
	for _, child := range values {
		if visitItem(child, collection, itemID, replace) {
			return true
		}
	}
	return false
}

func appendItem(state map[string]any, collection string, item map[string]any) error {
	if appendToCollection(state, collection, item) {
		return nil
	}
	if collection != "" {
		return fmt.Errorf("%w: item collection %q was not found", ErrCanvasValidation, collection)
	}
	state["items"] = []any{item}
	return nil
}

func appendToCollection(value any, collection string, item map[string]any) bool {
	switch typed := value.(type) {
	case map[string]any:
		for _, key := range sortedKeys(typed) {
			items, ok := typed[key].([]any)
			if ok && matchesCollection(key, collection) {
				typed[key] = append(items, item)
				return true
			}
		}
		for _, key := range sortedKeys(typed) {
			if appendToCollection(typed[key], collection, item) {
				return true
			}
		}
	case []any:
		for _, child := range typed {
			if appendToCollection(child, collection, item) {
				return true
			}
		}
	}
	return false
}

func mergeItem(current, patch map[string]any) map[string]any {
	merged := make(map[string]any, len(current)+len(patch))
	for key, value := range current {
		merged[key] = value
	}
	for key, value := range patch {
		merged[key] = value
	}
	return merged
}

func itemRevision(item map[string]any) int64 {
	switch value := item["revision"].(type) {
	case json.Number:
		result, _ := value.Int64()
		return result
	case float64:
		return int64(value)
	case int64:
		return value
	case int:
		return int64(value)
	default:
		return 0
	}
}

func validateStateAfterItemChange(state map[string]any) error {
	encoded, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("%w: invalid item state", ErrCanvasValidation)
	}
	return validateBlockStateSizeAndContent(encoded)
}

func updateBlockState(
	ctx context.Context,
	tx *sqlx.Tx,
	canvas *Canvas,
	block Block,
	state map[string]any,
	now time.Time,
) error {
	encoded, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("%w: invalid item state", ErrCanvasValidation)
	}
	if canvasStateBytes(canvas.Blocks)-len(block.State)+len(encoded) > MaxCanvasBytes {
		return ErrCanvasLimit
	}
	result, err := tx.ExecContext(ctx, tx.Rebind(`
UPDATE canvas_blocks SET state_json = ?, block_revision = block_revision + 1, updated_at = ?
WHERE canvas_id = ? AND block_id = ?`), encoded, now, canvas.ID, block.ID)
	if err != nil {
		return err
	}
	return requireOneRow(result, ErrCanvasNotFound)
}

func validateBlockStateSizeAndContent(state json.RawMessage) error {
	if len(state) > MaxCanvasBytes {
		return ErrCanvasLimit
	}
	return validateBlock(BlockTypeChecklist, state)
}

func validItemCollection(collection string) bool {
	switch collection {
	case "", itemCollectionItems, itemCollectionCards, itemCollectionEvents, itemCollectionMetrics:
		return true
	default:
		return false
	}
}

func matchesCollection(key, collection string) bool {
	if collection != "" {
		return key == collection
	}
	switch key {
	case itemCollectionItems, itemCollectionCards, itemCollectionEvents, itemCollectionMetrics:
		return true
	default:
		return false
	}
}

func sortedKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
