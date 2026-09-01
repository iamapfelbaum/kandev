"use client";

import { Button } from "@kandev/ui/button";
import { IconColumnInsertRight, IconRowInsertBottom } from "@tabler/icons-react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useResponsiveBreakpoint } from "@/hooks/use-responsive-breakpoint";
import { MarkdownTableResizeHandles, useHybridTableResize } from "./hybrid-markdown-table-resize";
import type {
  TableEdgeGeometry,
  TableEdgePointerMode,
} from "./hybrid-markdown-table-edge-geometry";

export type HybridMarkdownTableEdgeChromeProps = {
  host: HTMLDivElement | null;
  tableKey: string | null;
  onInsertColumn: (columnIndex: number) => void;
  onInsertRow: (rowIndex: number) => void;
};

export function HybridMarkdownTableEdgeChrome({
  host,
  tableKey,
  onInsertColumn,
  onInsertRow,
}: HybridMarkdownTableEdgeChromeProps) {
  const { t } = useTranslation();
  const { isFinePointer } = useResponsiveBreakpoint();
  const pointerMode: TableEdgePointerMode = isFinePointer ? "fine" : "coarse";
  const resize = useHybridTableResize(host, tableKey, pointerMode);
  const geometry = resize.geometry;
  if (!host || !geometry) return null;

  const layerStyle: CSSProperties = {
    height: geometry.layerHeight,
    width: geometry.layerWidth,
  };

  return createPortal(
    <div
      className="kandev-markdown-table-edge-layer"
      data-pointer-mode={pointerMode}
      data-testid="markdown-table-edge-layer"
      style={layerStyle}
    >
      <MarkdownTableEdgeActions
        geometry={geometry}
        onInsertColumn={onInsertColumn}
        onInsertRow={onInsertRow}
        prepareColumnInsertion={resize.prepareColumnInsertion}
        t={t}
      />
      <MarkdownTableResizeHandles geometry={geometry} resize={resize} t={t} />
    </div>,
    host,
  );
}

function MarkdownTableEdgeActions({
  geometry,
  onInsertColumn,
  onInsertRow,
  prepareColumnInsertion,
  t,
}: {
  geometry: TableEdgeGeometry;
  onInsertColumn: (columnIndex: number) => void;
  onInsertRow: (rowIndex: number) => void;
  prepareColumnInsertion: (columnIndex: number) => void;
  t: (key: string) => string;
}) {
  return (
    <div
      className="kandev-markdown-table-edge-actions"
      role="toolbar"
      aria-label={t("common:tableEditingActions")}
    >
      {geometry.rowActions.map(({ index, left, top }) => (
        <Button
          key={`row-${index}`}
          type="button"
          variant="secondary"
          size="icon-sm"
          className="kandev-markdown-table-edge-action kandev-markdown-table-row-action cursor-pointer"
          aria-label={`${t("common:addTableRowBelow")} ${index + 1}`}
          title={t("common:addTableRowBelow")}
          data-testid={`markdown-table-row-insert-${index}`}
          style={{ left, top }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onInsertRow(index);
          }}
        >
          <IconRowInsertBottom />
        </Button>
      ))}
      {geometry.columnActions.map(({ index, left, top }) => (
        <Button
          key={`column-${index}`}
          type="button"
          variant="secondary"
          size="icon-sm"
          className="kandev-markdown-table-edge-action kandev-markdown-table-column-action cursor-pointer"
          aria-label={`${t("common:addTableColumnRight")} ${index + 1}`}
          title={t("common:addTableColumnRight")}
          data-testid={`markdown-table-column-insert-${index}`}
          style={{ left, top }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            prepareColumnInsertion(index);
            onInsertColumn(index);
          }}
        >
          <IconColumnInsertRight />
        </Button>
      ))}
    </div>
  );
}
