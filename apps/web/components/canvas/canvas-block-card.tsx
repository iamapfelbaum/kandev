"use client";

import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@kandev/ui/card";
import { MarkdownPreviewRenderer } from "@/components/task/markdown-preview-content";
import type { CanvasBlock } from "@/lib/types/canvas";
import { asStateRecord, blockItems, blockLabelKey, blockText } from "./canvas-utils";

export function CanvasBlockCard({ block }: { block: CanvasBlock }) {
  const { t } = useTranslation();
  const text = blockText(block);
  const items = blockItems(block);
  const state = asStateRecord(block.state);
  const values = Object.entries(state).filter(
    ([key, value]) => key !== "items" && typeof value !== "object" && value !== "undefined",
  );

  return (
    <Card data-testid={`canvas-block-${block.id}`} className="min-w-0">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/60">
        <CardTitle>{t(blockLabelKey(block.type))}</CardTitle>
        <span className="text-[10px] text-muted-foreground">
          {t("canvases:canvasRevision", { revision: block.block_revision })}
        </span>
      </CardHeader>
      <CardContent className="min-w-0 space-y-3">
        {text &&
          (block.type === "markdown" ? (
            <div className="prose prose-sm max-w-none break-words dark:prose-invert">
              <MarkdownPreviewRenderer content={text} />
            </div>
          ) : (
            <p className="whitespace-pre-wrap break-words text-sm leading-6">{text}</p>
          ))}
        {items.length > 0 && (
          <ul className="space-y-2 text-sm">
            {items.map((item) => (
              <li key={item.id} className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.completed ? "bg-emerald-500" : "bg-muted-foreground/50"}`}
                />
                <span className={item.completed ? "text-muted-foreground line-through" : undefined}>
                  {item.label}
                </span>
                {item.detail && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {item.detail}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {values.length > 0 && (
          <dl className="grid min-w-0 grid-cols-2 gap-2 text-sm sm:grid-cols-3">
            {values.map(([key, value]) => (
              <div key={key} className="min-w-0 rounded-md bg-muted/40 p-2">
                <dt className="truncate text-xs text-muted-foreground">{key}</dt>
                <dd className="break-words font-medium">{String(value)}</dd>
              </div>
            ))}
          </dl>
        )}
        {!text && items.length === 0 && values.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("canvases:emptyBlock")}</p>
        )}
      </CardContent>
    </Card>
  );
}
