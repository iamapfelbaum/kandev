package canvas

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"
)

func EncodePortableCanvas(canvas *Canvas) ([]byte, error) {
	if canvas == nil {
		return nil, fmt.Errorf("%w: canvas is required", ErrCanvasValidation)
	}
	if err := validateTitle(canvas.Title); err != nil {
		return nil, err
	}
	if len(canvas.Blocks) > MaxBlocks {
		return nil, ErrCanvasLimit
	}
	blocks := make([]PortableBlock, 0, len(canvas.Blocks))
	stateBytes := 0
	itemCount := 0
	for _, block := range canvas.Blocks {
		if err := validateBlock(block.Type, block.State); err != nil {
			return nil, err
		}
		stateBytes += len(block.State)
		if stateBytes > MaxCanvasBytes {
			return nil, ErrCanvasLimit
		}
		itemCount += countItems(block.State)
		if itemCount > MaxItems {
			return nil, ErrCanvasLimit
		}
		blocks = append(blocks, PortableBlock{
			Type: block.Type, Position: block.Position, State: cloneJSON(block.State),
		})
	}
	file := PortableCanvasFile{
		Format: PortableFormat, FormatVersion: PortableVersion, ExportID: newID(),
		ExportedAt: time.Now().UTC(), Canvas: PortableCanvas{
			Title: strings.TrimSpace(canvas.Title), SchemaVersion: canvas.SchemaVersion,
			Blocks: blocks,
		},
	}
	data, err := json.Marshal(file)
	if err != nil {
		return nil, fmt.Errorf("encode portable canvas: %w", err)
	}
	if len(data) > MaxFileBytes {
		return nil, ErrCanvasLimit
	}
	return data, nil
}

func DecodePortableCanvas(data []byte) (PortableCanvasFile, error) {
	if len(data) == 0 || len(data) > MaxFileBytes {
		return PortableCanvasFile{}, fmt.Errorf("%w: file size must be at most %d bytes", ErrInvalidPortableFile, MaxFileBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var file PortableCanvasFile
	if err := decoder.Decode(&file); err != nil {
		return PortableCanvasFile{}, fmt.Errorf("%w: %v", ErrInvalidPortableFile, err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return PortableCanvasFile{}, fmt.Errorf("%w: trailing JSON data", ErrInvalidPortableFile)
	}
	if err := validatePortableFile(file); err != nil {
		return PortableCanvasFile{}, err
	}
	return file, nil
}

func validatePortableFile(file PortableCanvasFile) error {
	if file.Format != PortableFormat || file.FormatVersion != PortableVersion || file.ExportID == "" {
		return fmt.Errorf("%w: unsupported format or version", ErrInvalidPortableFile)
	}
	if file.ExportedAt.IsZero() {
		return fmt.Errorf("%w: exported_at is required", ErrInvalidPortableFile)
	}
	if err := validateTitle(file.Canvas.Title); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidPortableFile, err)
	}
	if file.Canvas.SchemaVersion != CanvasSchemaVersion || len(file.Canvas.Blocks) > MaxBlocks {
		return fmt.Errorf("%w: unsupported schema or block count", ErrInvalidPortableFile)
	}
	seenPositions := make(map[int]bool, len(file.Canvas.Blocks))
	stateBytes := 0
	itemCount := 0
	for _, block := range file.Canvas.Blocks {
		if seenPositions[block.Position] || block.Position < 0 {
			return fmt.Errorf("%w: block positions must be unique and non-negative", ErrInvalidPortableFile)
		}
		seenPositions[block.Position] = true
		if err := validateBlock(block.Type, block.State); err != nil {
			return fmt.Errorf("%w: %v", ErrInvalidPortableFile, err)
		}
		stateBytes += len(block.State)
		if stateBytes > MaxCanvasBytes {
			return fmt.Errorf("%w: canvas state exceeds %d bytes", ErrInvalidPortableFile, MaxCanvasBytes)
		}
		itemCount += countItems(block.State)
		if itemCount > MaxItems {
			return fmt.Errorf("%w: item count exceeds %d", ErrInvalidPortableFile, MaxItems)
		}
	}
	return nil
}

func countItems(data json.RawMessage) int {
	var value any
	if json.Unmarshal(data, &value) != nil {
		return MaxItems + 1
	}
	return countItemsValue(value)
}

func countItemsValue(value any) int {
	switch typed := value.(type) {
	case []any:
		count := 0
		for _, child := range typed {
			count += countItemsValue(child)
		}
		return count
	case map[string]any:
		count := 0
		for key, child := range typed {
			if key == "items" || key == "cards" || key == "events" || key == "metrics" {
				if items, ok := child.([]any); ok {
					count += len(items)
				}
			}
			count += countItemsValue(child)
		}
		return count
	default:
		return 0
	}
}
